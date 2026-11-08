// Generate native parity expectations from the actual bundled schedules and web renderer.
// Output is disposable build data; source schedules and web assets are never modified.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildDisplayData } from "../lib/schedule-builder.js";
import { activeServices, confirmedCrewCoverage, timelineDepartures, tripIdentityForDate } from "../public/assets/schedule.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] || "ios/DerivedData/ServiceParity");
const holiday = JSON.parse(await readFile(path.join(root, "schedules/sukkot-2026.json"), "utf8"));
const holidayLive = JSON.parse(await readFile(path.join(root, "schedules/sukkot-2026-live.json"), "utf8"));
const holidayCrew = JSON.parse(await readFile(path.join(root, "schedules/sukkot-2026-crew.json"), "utf8"));
const landings = JSON.parse(await readFile(path.join(root, "config/landings.json"), "utf8"));
const app = await readFile(path.join(root, "public/app.js"), "utf8");
const extract = (start, end) => {
  const first = app.indexOf(`function ${start}(`), last = app.indexOf(`function ${end}(`, first);
  assert.ok(first >= 0 && last > first, `Web timing function missing: ${start}`);
  return app.slice(first, last);
};
const pauseFunctions = extract("scheduleForDeparture", "tripAttrs") +
  extract("layoverMinutes", "turnaroundLabel") + extract("departureLayoverLabel", "tripStopName");
const fields = ["tripId", "routeId", "stopId", "serviceDate", "seconds", "delay", "hasLiveTiming", "boatAssignment",
  "boatName", "predictedBoatName", "endsShift", "endsDay", "fromHomePort", "outOfService", "crewShuttle", "arrival",
  "approximate", "scheduleOnly", "timetableOnly", "liveTripId", "predictTripId", "secondsEnd", "crewBoats"];
const controls = new Set([8, 11, 13, 16, 17, 18, 26, 27]);
const controlDates = ["2026-09-25", "2026-09-27", "2026-10-03", "2026-10-05", "2026-10-10", "2026-10-17", "2026-10-24",
  "2026-11-02", "2026-11-07", "2026-11-08", "2026-11-14", "2026-11-28"];
const manifest = { holidayDates: holiday.dates, sourceNote: holiday.note, schedules: [], cases: 0, departures: 0 };
await mkdir(output, { recursive: true });
for (const landingID of Object.keys(landings).map(Number).filter(id => !landings[id].unused).sort((a, b) => a - b)) {
  const schedule = await buildDisplayData({ root, landingNumber: landingID, busesEnabled: true });
  // Exercise both staff timing switches regardless of the deployed display preference.
  schedule.meta.showDwellTimes = true;
  schedule.meta.showLayoverTimes = true;
  const updates = new Map(), vehicles = [];
  for (const [index, departure] of schedule.departures.entries()) {
    for (const tripId of new Set([departure.liveTripId || departure.tripId, ...Object.values(departure.liveTripIdsByDate || {})])) {
      updates.set(`${tripId}|${departure.stopId}`, { tripId, stopId: departure.stopId,
        delaySeconds: index % 3 === 0 ? -60 : 480,
        arrivalDelaySeconds: index % 4 === 0 ? 300 : index % 3 === 0 ? -120 : 60,
        canceled: index % 11 === 0 });
      if (!departure.outOfService && !departure.fromHomePort && !departure.crewShuttle) {
        vehicles.push({ tripId, boat: departure.boatAssignment == null ? null : `${departure.routeId}${departure.boatAssignment}`,
          boatName: `Fixture vessel ${index}`, updatedAtEpochSeconds: index + 1 });
      }
    }
  }
  const realtime = { available: true, stale: false, updates: [...updates.values()], vehicles };
  const context = vm.createContext({ data: schedule, realtime, tripIdentityForDate, Math, Number });
  vm.runInContext(pauseFunctions, context);
  const project = row => {
    context.item = row;
    const label = vm.runInContext("departureLayoverLabel(item)", context);
    const dwell = /Dwell (-?\d+)m/.exec(label), layover = /Layover (-?\d+)m/.exec(label);
    return { ...Object.fromEntries(fields.map(field => [field, row[field] ?? null])),
      dwellMinutes: dwell ? Number(dwell[1]) : null, layoverMinutes: layover ? Number(layover[1]) : null,
      layoverLive: layover ? /Estimated layover/.test(label) : null };
  };
  const cases = [];
  const dates = [...holiday.dates, ...(controls.has(landingID) ? controlDates : [])];
  for (const date of dates) {
    const holidayDate = holiday.dates.includes(date);
    const active = activeServices(schedule, date);
    const activeRows = schedule.departures.filter(row => active.has(row.serviceId));
    if (holidayDate) {
      assert.ok(confirmedCrewCoverage(schedule, date), `${landingID}: holiday crew coverage missing`);
      for (const row of activeRows.filter(row => row.scheduleOnly)) {
        const match = holidayLive.matches[row.tripId];
        if (row.liveTripId) {
          assert.equal(row.liveTripId, match?.tripId, `${landingID}: unexpected holiday live trip`);
          assert.equal(row.boatAssignment, match?.boatAssignment ?? null, `${landingID}: unexpected holiday working`);
        } else assert.equal(row.boatAssignment, null, `${landingID}: unverified holiday working`);
      }
      if (landingID === 27) {
        assert.ok(activeRows.some(row => row.fromHomePort && row.boatAssignment), "Verified holiday Pier C pickups must be shown");
        assert.equal(activeRows.filter(row => row.crewShuttle).length, holidayCrew.shuttles.holiday.length);
      }
    }
    for (const mode of ["live", "stale", "browse"]) {
      const feed = { ...realtime, stale: mode === "stale" };
      const now = mode === "browse" ? "2026-09-24T04:00:00Z" : `${date}T${date >= "2026-11-01" ? "05" : "04"}:00:00Z`;
      const viewDate = mode === "browse" ? date : null;
      context.realtime = feed;
      const rows = timelineDepartures({ data: schedule, realtime: feed, viewDate, now: new Date(now) }).map(({ departure }) => departure);
      const expected = rows.map(project);
      cases.push({ name: `${landingID}/${date}/${mode}`, date, now, viewDate, stale: feed.stale,
        crewConfirmed: Boolean(confirmedCrewCoverage(schedule, date)), expected });
      manifest.departures += expected.length;
    }
  }
  const filename = `landing-${landingID}.json`;
  await writeFile(path.join(output, filename), JSON.stringify({ schedule, realtime, cases }));
  manifest.schedules.push(filename);
  manifest.cases += cases.length;
}
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated actual-data parity: ${manifest.schedules.length} landings, ${manifest.cases} cases, ${manifest.departures} departure projections.`);
console.log(`Sukkot source dates: ${holiday.dates.join(", ")}; verified feed ${holidayLive.feedVersion} with workbook-backed working and crew data.`);
console.log(path.join(output, "manifest.json"));
