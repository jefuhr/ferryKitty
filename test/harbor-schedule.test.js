// Failure modes: overlapping operator ids, unsorted and sparse stop sequences, inactive services,
// calendar additions/removals, taken trips, early/late window edges, previous-day times past 24:00,
// DST clock changes, shared landings, skipped arrival calls, and the final arrival. Layered NYC
// coverage checks historical-base replacement, reused live ids, dated and holiday candidates,
// exception-only service, date-aware arrival lookup, and a real departure from the server's index.
// Bundled-feed coverage derives its service date from the data, so feed refreshes do not stale it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARTNER_FEEDS, parseCsv, timeToSeconds } from "../lib/schedule-builder.js";
import { activeServices, addDays, zonedParts } from "../public/assets/schedule.js";
import { landingChoices, loadAllLandingData } from "../lib/landing-data.js";
import { describedServiceTrip, loadHarborMap, serviceFrame } from "../lib/fleet-map.js";
import { buildHarborSchedule, matchDeparture, confirmArrival } from "../lib/harbor-schedule.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AT_EIGHT = Date.parse("2026-11-11T13:00:00Z");
const DAILY = {
  service_id: "daily", sunday: "1", monday: "1", tuesday: "1", wednesday: "1",
  thursday: "1", friday: "1", saturday: "1", start_date: "20260101", end_date: "20261231"
};

function later(time, seconds) {
  const value = timeToSeconds(time) + seconds;
  return `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function plan(tripId = "morning", time = "08:00:00", { serviceId = "daily", routeId = "R", stopId = "9001" } = {}) {
  return { tripId, routeId, serviceId, calls: [
    { stopId, sequence: 10, time },
    { stopId: "9002", sequence: 30, time: later(time, 600) },
    { stopId: "9003", sequence: 70, time: later(time, 1200) }
  ] };
}

function feed({ operatorId = "nycf", prefix = "", plans = [plan()], calendar = [DAILY], calendarDates = [] } = {}) {
  return {
    operatorId, prefix, calendar: structuredClone(calendar), calendarDates: structuredClone(calendarDates),
    trips: plans.map(item => ({ trip_id: item.tripId, route_id: item.routeId, service_id: item.serviceId })),
    // Reverse the calls to prove the index follows stop_sequence, not file order.
    stopTimes: plans.flatMap(item => item.calls.map(call => ({
      trip_id: item.tripId, stop_id: call.stopId, stop_sequence: String(call.sequence),
      arrival_time: call.time, departure_time: call.time
    })).reverse())
  };
}

const scheduleFor = (...feeds) => buildHarborSchedule({ tables: feeds.length ? feeds : [feed()] });
const depart = (schedule, overrides = {}) => matchDeparture({
  schedule, operatorId: "nycf", landingStopId: "9001", departedAt: AT_EIGHT, ...overrides
});

function liveCalendar(serviceId = "live", overrides = {}) {
  return { serviceId, weekdays: Array(7).fill(true), startDate: "2026-01-01", endDate: "2026-12-31", ...overrides };
}

function liveCandidate({ serviceId = "live", routeId = "R", time = "08:00:00", dates = null, holiday = false } = {}) {
  return { serviceId, routeId, dates, holiday, stops: plan("published-id", time).calls.map(call => ({
    stopId: call.stopId, sequence: call.sequence,
    arrivalSeconds: timeToSeconds(call.time), departureSeconds: timeToSeconds(call.time)
  })) };
}

function serviceIndex(overrides = {}) {
  return { timezone: "America/New_York", trips: new Map([["live-44", [liveCandidate()]]]),
    calendars: [liveCalendar()], exceptions: [], holidayDates: new Set(), ...overrides };
}

test("parsed feed tables build the contract index without changing their input", async () => {
  const tables = [feed(), feed({ operatorId: "waterway", prefix: "wtr:" })];
  const original = structuredClone(tables);
  const schedule = await buildHarborSchedule({ tables });
  assert.equal(schedule.timezone, "America/New_York");
  assert.deepEqual(schedule.operators, new Map([
    ["nycf", { prefix: "", tripCount: 1 }], ["waterway", { prefix: "wtr:", tripCount: 1 }]
  ]));
  assert.deepEqual(schedule.trip("wtr:morning"), {
    tripId: "wtr:morning", routeId: "wtr:R", serviceId: "wtr:daily", operatorId: "waterway",
    stops: [
      { stopId: "wtr:9001", sequence: 10, arrivalSeconds: 28800, departureSeconds: 28800 },
      { stopId: "wtr:9002", sequence: 30, arrivalSeconds: 29400, departureSeconds: 29400 },
      { stopId: "wtr:9003", sequence: 70, arrivalSeconds: 30000, departureSeconds: 30000 }
    ]
  });
  assert.deepEqual(schedule.departuresFrom("wtr:9001", "waterway"), [{
    tripId: "wtr:morning", routeId: "wtr:R", serviceId: "wtr:daily", sequence: 10,
    departureSeconds: 28800, nextStopId: "wtr:9002", nextSequence: 30
  }]);
  assert.deepEqual(schedule.departuresFrom("9001", "waterway"), []);
  assert.deepEqual(schedule.departuresFrom("9003", "nycf"), []);
  assert.equal(schedule.trip("absent"), null);
  assert.deepEqual(tables, original);
});

test("the nearest eligible departure wins, with schedule provenance and confidence", async () => {
  const schedule = await scheduleFor(feed({ plans: [plan("earlier", "07:55:00"), plan("nearest", "08:02:00"), plan("later", "08:03:00")] }));
  assert.deepEqual(depart(schedule), {
    tripId: "nearest", routeId: "R", serviceDate: "2026-11-11", nextSequence: 30,
    confidence: 0.5, source: "schedule"
  });
});

test("a nearer trip of another operator never wins at a shared landing", async () => {
  const schedule = await scheduleFor(
    feed({ plans: [plan("root", "08:03:00")] }),
    feed({ operatorId: "waterway", prefix: "wtr:", plans: [plan("partner")] })
  );
  const landingStopId = ["9001", "wtr:9001"];
  assert.equal(depart(schedule, { landingStopId }).tripId, "root");
  assert.equal(depart(schedule, { landingStopId, operatorId: "waterway" }).tripId, "wtr:partner");
  assert.equal(depart(schedule, { operatorId: "absent", landingStopId }), null);
  assert.equal(depart(schedule, { operatorId: "waterway" }), null);
});

for (const [seconds, expected] of [[-241, false], [-240, true], [1200, true], [1201, false]]) {
  test(`departure window ${seconds} seconds from the schedule is ${expected ? "included" : "excluded"}`, async () => {
    const schedule = await scheduleFor();
    assert.equal(depart(schedule, { departedAt: AT_EIGHT + seconds * 1000 })?.tripId ?? null, expected ? "morning" : null);
  });
}

test("a taken trip is skipped only for its own service date", async () => {
  const schedule = await scheduleFor(feed({ plans: [plan("nearest"), plan("available", "08:01:00")] }));
  const taken = new Set(["2026-11-11|nearest", "2026-11-10|available"]);
  assert.equal(depart(schedule, { taken }).tripId, "available");
  assert.deepEqual([...taken], ["2026-11-11|nearest", "2026-11-10|available"]);
  taken.add("2026-11-11|available");
  assert.equal(depart(schedule, { taken }), null);
});

test("weekday flags, service bounds, and exceptions control eligibility across namespaces", async () => {
  const tables = feed({
    plans: [plan("weekday"), plan("exception", "08:01:00", { serviceId: "special" })],
    calendar: [{ ...DAILY, sunday: "0", saturday: "0" }],
    calendarDates: [
      { service_id: "daily", date: "20261111", exception_type: "2" },
      { service_id: "special", date: "20261111", exception_type: "1" }
    ]
  });
  const schedule = await scheduleFor(tables, { ...structuredClone(tables), operatorId: "waterway", prefix: "wtr:" });
  assert.deepEqual(schedule.activeOn("2026-11-11"), new Set(["special", "wtr:special"]));
  assert.equal(depart(schedule).tripId, "exception");
  assert.equal(depart(schedule, { landingStopId: "wtr:9001", operatorId: "waterway" }).tripId, "wtr:exception");
  assert.deepEqual(schedule.activeOn("2026-11-14"), new Set());
  assert.deepEqual(schedule.activeOn("2027-01-01"), new Set());
  assert.equal(depart(schedule, { departedAt: Date.parse("2026-11-14T13:00:00Z") }), null);
  assert.equal(depart(schedule, { departedAt: Date.parse("2027-01-01T13:00:00Z") }), null);
});

test("a service absent from the calendar is not a candidate without an added exception", async () => {
  const schedule = await scheduleFor(feed({ calendar: [] }));
  assert.equal(depart(schedule), null);
});

test("a trip just after midnight uses yesterday's 24-plus time and service calendar", async () => {
  const schedule = await scheduleFor(feed({
    plans: [plan("overnight", "25:05:00")],
    calendar: [{ ...DAILY, start_date: "20261110", end_date: "20261110" }]
  }));
  const departedAt = Date.parse("2026-11-11T06:06:00Z");
  assert.deepEqual(depart(schedule, { departedAt }), {
    tripId: "overnight", routeId: "R", serviceDate: "2026-11-10", nextSequence: 30,
    confidence: 0.5, source: "schedule"
  });
  assert.equal(depart(schedule, { departedAt, taken: new Set(["2026-11-10|overnight"]) }), null);
});

test("today's active service cannot stand in for yesterday's inactive overnight service", async () => {
  const schedule = await scheduleFor(feed({
    plans: [plan("overnight", "25:05:00")],
    calendar: [{ ...DAILY, start_date: "20261111", end_date: "20261111" }]
  }));
  assert.equal(depart(schedule, { departedAt: Date.parse("2026-11-11T06:05:00Z") }), null);
});

for (const [label, instant, time, date] of [
  ["before spring forward", "2026-03-08T05:10:00Z", "24:10:00", "2026-03-07"],
  ["after spring forward", "2026-03-08T07:10:00Z", "27:10:00", "2026-03-07"],
  ["before fall back", "2026-11-01T04:10:00Z", "24:10:00", "2026-10-31"],
  ["first repeated hour", "2026-11-01T05:10:00Z", "25:10:00", "2026-10-31"],
  ["second repeated hour", "2026-11-01T06:10:00Z", "25:10:00", "2026-10-31"],
  ["after fall back", "2026-11-01T07:10:00Z", "26:10:00", "2026-10-31"]
]) {
  test(`New York service-day matching ${label} uses the board's wall clock`, async () => {
    const schedule = await scheduleFor(feed({ plans: [plan("night", time)] }));
    const result = depart(schedule, { departedAt: Date.parse(instant) });
    assert.equal(result?.tripId, "night");
    assert.equal(result?.serviceDate, date);
  });
}

test("arrival at the next call confirms the trip and advances to the actual next sequence", async () => {
  const schedule = await scheduleFor();
  const trip = depart(schedule);
  const original = structuredClone(trip);
  assert.deepEqual(confirmArrival({ schedule, trip, landingStopId: ["tst:other", "9002"] }), {
    ...trip, confidence: 0.9, nextSequence: 70
  });
  assert.deepEqual(trip, original);
});

test("arrival at a later call leaves the trip unchanged, and a call outside the remainder fails", async () => {
  const schedule = await scheduleFor();
  const trip = depart(schedule);
  assert.equal(confirmArrival({ schedule, trip, landingStopId: "9003" }), trip);
  assert.equal(confirmArrival({ schedule, trip, landingStopId: "9001" }), null);
  assert.equal(confirmArrival({ schedule, trip, landingStopId: "absent" }), null);
  assert.equal(confirmArrival({ schedule, trip: { ...trip, tripId: "absent" }, landingStopId: "9002" }), null);
});

test("the final arrival confirms the call and clears nextSequence", async () => {
  const schedule = await scheduleFor();
  const trip = confirmArrival({ schedule, trip: depart(schedule), landingStopId: "9002" });
  const final = confirmArrival({ schedule, trip, landingStopId: "9003" });
  assert.deepEqual(final, { ...trip, confidence: 0.9, nextSequence: null });
  assert.equal(confirmArrival({ schedule, trip: final, landingStopId: "9003" }), null);
});

test("the layered index replaces NYC base tables, preserves live ids, and leaves partners on GTFS", async () => {
  const serviceTrips = serviceIndex();
  serviceTrips.trips.set("wtr:shadow", [liveCandidate({ routeId: "wtr:R" })]);
  const original = structuredClone(serviceTrips);
  const schedule = await buildHarborSchedule({ serviceTrips, tables: [
    feed(), feed({ operatorId: "waterway", prefix: "wtr:" })
  ] });
  assert.deepEqual(schedule.operators.get("nycf"), { prefix: "", tripCount: 1 });
  assert.equal(schedule.trip("morning"), null);
  assert.equal(schedule.trip("wtr:shadow"), null);
  assert.equal(depart(schedule).tripId, "live-44");
  assert.equal(depart(schedule, { operatorId: "waterway", landingStopId: "wtr:9001" }).tripId, "wtr:morning");
  assert.deepEqual(schedule.activeOn("2026-11-11"), new Set(["live", "wtr:daily"]));
  assert.equal(schedule.trip("live-44", "2026-11-11").operatorId, "nycf");
  assert.deepEqual(serviceTrips, original);
});

test("reused live ids resolve the candidate for the supplied service date, including arrivals", async () => {
  const old = liveCandidate({ serviceId: "old", routeId: "OLD" });
  const current = liveCandidate({ serviceId: "current", routeId: "CURRENT" });
  current.stops[1].stopId = "9003";
  current.stops[2].stopId = "9002";
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["reused-live", [old, current]]]), calendars: [
      liveCalendar("old", { endDate: "2026-11-10" }),
      liveCalendar("current", { startDate: "2026-11-11" })
    ]
  }) });
  assert.equal(schedule.operators.get("nycf").tripCount, 1);
  assert.equal(schedule.trip("reused-live"), null);
  assert.equal(schedule.trip("reused-live", "2026-11-10").routeId, "OLD");
  assert.equal(schedule.trip("reused-live", "2026-11-11").routeId, "CURRENT");
  assert.deepEqual(schedule.departuresFrom("9001", "nycf", "2026-11-10").map(call => call.routeId), ["OLD"]);
  assert.deepEqual(schedule.departuresFrom("9001", "nycf", "2026-11-11").map(call => call.routeId), ["CURRENT"]);
  const trip = depart(schedule);
  assert.equal(trip.tripId, "reused-live");
  assert.equal(trip.routeId, "CURRENT");
  assert.deepEqual(confirmArrival({ schedule, trip, landingStopId: "9003" }), { ...trip, confidence: 0.9, nextSequence: 70 });
});

test("an unresolved dated lookup stays null while an already-matched route disambiguates arrivals", async () => {
  const earlier = liveCandidate({ routeId: "EARLIER", time: "07:30:00" });
  const current = liveCandidate({ routeId: "CURRENT" });
  current.stops[1].stopId = "9003";
  current.stops[2].stopId = "9002";
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["shared-live", [earlier, current]]])
  }) });
  assert.equal(schedule.trip("shared-live", "2026-11-11"), null);
  assert.equal(schedule.trip("shared-live", "2026-11-11", "CURRENT").routeId, "CURRENT");
  const trip = depart(schedule);
  assert.equal(trip.routeId, "CURRENT");
  assert.deepEqual(confirmArrival({ schedule, trip, landingStopId: "9003" }), { ...trip, confidence: 0.9, nextSequence: 70 });
});

test("a layered candidate's dates list further restricts its active calendar", async () => {
  const serviceTrips = serviceIndex({ trips: new Map([["dated-live", [liveCandidate({ dates: ["2026-11-12"] })]]]) });
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips });
  assert.equal(depart(schedule), null);
  assert.equal(schedule.trip("dated-live", "2026-11-11"), null);
  assert.deepEqual(schedule.departuresFrom("9001", "nycf", "2026-11-11"), []);
  assert.equal(depart(schedule, { departedAt: Date.parse("2026-11-12T13:00:00Z") }).tripId, "dated-live");
  assert.ok(schedule.trip("dated-live", "2026-11-12"));
});

test("an empty layered dates list never activates a candidate", async () => {
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["no-dates", [liveCandidate({ dates: [] })]]])
  }) });
  assert.equal(depart(schedule), null);
  assert.equal(schedule.trip("no-dates", "2026-11-11"), null);
});

test("holiday and ordinary candidates sharing a live id obey the service day's holiday flag", async () => {
  const ordinary = liveCandidate({ routeId: "ORDINARY" });
  const holiday = liveCandidate({ routeId: "HOLIDAY", holiday: true });
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["holiday-reused", [ordinary, holiday]]]), holidayDates: new Set(["2026-11-11"])
  }) });
  assert.equal(depart(schedule).routeId, "HOLIDAY");
  assert.equal(schedule.trip("holiday-reused", "2026-11-11").routeId, "HOLIDAY");
  assert.equal(depart(schedule, { departedAt: Date.parse("2026-11-12T13:00:00Z") }).routeId, "ORDINARY");
  assert.equal(schedule.trip("holiday-reused", "2026-11-12").routeId, "ORDINARY");
});

test("a layered holiday candidate cannot run on an ordinary day and ordinary service is withdrawn on a holiday", async () => {
  const holidayOnly = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["holiday-only", [liveCandidate({ holiday: true })]]])
  }) });
  assert.equal(depart(holidayOnly), null);
  const ordinaryOnly = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({ holidayDates: new Set(["2026-11-11"]) }) });
  assert.equal(depart(ordinaryOnly), null);
});

test("layered calendars and exceptions control service even when the old root calendar is active", async () => {
  const schedule = await buildHarborSchedule({ tables: [feed()], serviceTrips: serviceIndex({
    trips: new Map([["removed", [liveCandidate()]], ["added", [liveCandidate({ serviceId: "special" })]]]),
    exceptions: [
      { serviceId: "live", date: "2026-11-11", added: false },
      { serviceId: "special", date: "2026-11-11", added: true }
    ]
  }) });
  assert.deepEqual(schedule.activeOn("2026-11-11"), new Set(["special"]));
  assert.equal(depart(schedule).tripId, "added");
  assert.equal(schedule.trip("removed", "2026-11-11"), null);
});

test("layered overnight candidates use the previous service day's date and holiday rules", async () => {
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([["night-live", [liveCandidate({ time: "25:05:00", dates: ["2026-11-10"] })]]]),
    holidayDates: new Set(["2026-11-11"])
  }) });
  const trip = depart(schedule, { departedAt: Date.parse("2026-11-11T06:05:00Z") });
  assert.equal(trip?.tripId, "night-live");
  assert.equal(trip.serviceDate, "2026-11-10");
});

test("the layered index supplies its timezone", async () => {
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({ timezone: "America/Chicago" }) });
  assert.equal(schedule.timezone, "America/Chicago");
  assert.equal(depart(schedule, { departedAt: Date.parse("2026-11-11T14:00:00Z") }).tripId, "live-44");
});

test("every bundled GTFS directory yields namespaced trips and root-stop departures", async () => {
  const schedule = await buildHarborSchedule({ root: ROOT });
  assert.ok(schedule.operators.get("nycf").tripCount > 0);
  assert.ok(schedule.departuresFrom("87", "nycf").length > 0);
  for (const [operatorId, spec] of Object.entries(PARTNER_FEEDS)) {
    const directory = path.join(ROOT, spec.directory);
    if (!await stat(directory).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    })) continue;
    const rawRoutes = parseCsv(await readFile(path.join(directory, "routes.txt"), "utf8"));
    const busRoutes = new Set(rawRoutes.filter(route => route.route_type === "3" && !spec.ferryRouteIds?.has(route.route_id)).map(route => route.route_id));
    // Bus trips are covered by their own test; every remaining trip must be indexed.
    const rawTrips = parseCsv(await readFile(path.join(directory, "trips.txt"), "utf8")).filter(trip => !busRoutes.has(trip.route_id));
    assert.ok(rawTrips.length > 0, `${operatorId} has bundled trips`);
    assert.deepEqual(schedule.operators.get(operatorId), { prefix: spec.prefix, tripCount: rawTrips.length });
    for (const raw of rawTrips) {
      const trip = schedule.trip(`${spec.prefix}${raw.trip_id}`);
      assert.equal(trip?.operatorId, operatorId);
      assert.equal(trip?.routeId, `${spec.prefix}${raw.route_id}`);
      assert.equal(trip?.serviceId, `${spec.prefix}${raw.service_id}`);
      assert.ok(trip.stops.length > 0);
      assert.ok(trip.stops.every(call => call.stopId.startsWith(spec.prefix)));
    }
  }
});

test("the server's real layered index yields an active NYC departure beyond the historical base", async t => {
  const choices = landingChoices(JSON.parse(await readFile(path.join(ROOT, "config/landings.json"), "utf8")));
  const landingData = await loadAllLandingData({ root: ROOT, choices });
  assert.equal(landingData.failures.size, 0);
  const { serviceTrips } = await loadHarborMap({ root: ROOT, landings: landingData.available, byLanding: landingData.byLanding });
  const schedule = await buildHarborSchedule({ root: ROOT, serviceTrips });
  const rootStops = new Set(parseCsv(await readFile(path.join(ROOT, "gtfs/stops.txt"), "utf8")).map(stop => stop.stop_id));
  const nycCandidates = [...serviceTrips.trips.values()].flat().filter(trip => !trip.routeId.includes(":"));
  const serviceIds = new Set(nycCandidates.map(trip => trip.serviceId));
  const dates = [
    ...serviceTrips.calendars.filter(calendar => serviceIds.has(calendar.serviceId)).flatMap(calendar => [calendar.startDate, calendar.endDate]),
    ...serviceTrips.exceptions.filter(exception => exception.added && serviceIds.has(exception.serviceId)).map(exception => exception.date)
  ].filter(Boolean).sort();
  assert.ok(dates.length > 0);
  let selected = null;
  // Start at the latest service boundary, so this regression exercises the current supplement
  // rather than succeeding against an old root trip that happens to share its live id.
  for (let day = dates.at(-1); day >= dates[0] && !selected; day = addDays(day, -1)) {
    const active = activeServices(serviceTrips, day);
    const trip = nycCandidates.find(candidate => active.has(candidate.serviceId) &&
      (!candidate.dates || candidate.dates.includes(day)) && candidate.holiday === serviceTrips.holidayDates.has(day) &&
      candidate.stops.slice(0, -1).some(call => rootStops.has(call.stopId) && call.departureSeconds >= 8 * 3600 && call.departureSeconds < 20 * 3600));
    if (trip) selected = { day, call: trip.stops.slice(0, -1).find(call =>
      rootStops.has(call.stopId) && call.departureSeconds >= 8 * 3600 && call.departureSeconds < 20 * 3600) };
  }
  assert.ok(selected, "the layered index has an active daytime call at a root stop");
  const noonUtc = Date.parse(`${selected.day}T12:00:00Z`);
  const local = zonedParts(new Date(noonUtc), serviceTrips.timezone);
  const departedAt = noonUtc + (selected.call.departureSeconds - local.seconds) * 1000;
  assert.deepEqual(zonedParts(new Date(departedAt), serviceTrips.timezone), {
    dateKey: selected.day, seconds: selected.call.departureSeconds
  });
  const departures = schedule.departuresFrom(selected.call.stopId, "nycf", selected.day);
  assert.ok(departures.some(call => schedule.activeOn(selected.day).has(call.serviceId)));
  const trip = matchDeparture({ schedule, operatorId: "nycf", landingStopId: selected.call.stopId, departedAt });
  assert.ok(trip, "a real layered NYC departure matches at its scheduled time");
  assert.equal(trip.serviceDate, selected.day);
  assert.ok(serviceTrips.trips.has(trip.tripId));
  assert.equal(describedServiceTrip(serviceTrips, trip.tripId, trip.nextSequence, serviceFrame(serviceTrips, departedAt))?.routeId, trip.routeId);
  t.diagnostic(`matched live NYC trip ${trip.tripId} on ${trip.serviceDate}, route ${trip.routeId}, root stop ${selected.call.stopId}, scheduled seconds ${selected.call.departureSeconds}`);
});

test("a boat leaving a few minutes early is matched across tomorrow's service-day boundary", async () => {
  const schedule = await buildHarborSchedule({ tables: [{ operatorId: "nycf", prefix: "",
    trips: [{ trip_id: "LATE", route_id: "R", service_id: "daily" }],
    stopTimes: [
      { trip_id: "LATE", stop_id: "A", stop_sequence: "1", arrival_time: "00:01:00", departure_time: "00:01:00" },
      { trip_id: "LATE", stop_id: "B", stop_sequence: "2", arrival_time: "00:20:00", departure_time: "00:20:00" }],
    calendar: [{ service_id: "daily", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1", start_date: "20260101", end_date: "20271231" }],
    calendarDates: [] }] });
  const early = matchDeparture({ schedule, operatorId: "nycf", landingStopId: "A", departedAt: Date.parse("2026-11-11T23:59:00-05:00") });
  assert.equal(early?.tripId, "LATE");
  assert.equal(early.serviceDate, "2026-11-12");
  // Five minutes early is still outside the window, on either side of midnight.
  assert.equal(matchDeparture({ schedule, operatorId: "nycf", landingStopId: "A", departedAt: Date.parse("2026-11-11T23:55:00-05:00") }), null);
});

// Run-index failure modes: losing blocks or namespaces, inactive services, unsorted endpoint calls,
// overnight/DST epoch drift, ambiguous layered ids, and accidentally changing existing API shapes.
test("bus routes are left out of the harbor schedule, except the ferries a feed mistypes as buses", async () => {
  const plans = [plan("boat", "08:00:00", { routeId: "F" }), plan("shuttle", "08:01:00", { routeId: "B" }),
    plan("mistyped", "08:02:00", { routeId: "M" }), plan("untyped", "08:03:00", { routeId: "U" })];
  const routes = [{ route_id: "F", route_type: "4" }, { route_id: "B", route_type: "3" }, { route_id: "M", route_type: "3" }];
  const schedule = await scheduleFor({ ...feed({ operatorId: "partner", prefix: "p:", plans }), routes, ferryRouteIds: new Set(["M"]) });
  assert.equal(schedule.trip("p:shuttle"), null);
  assert.deepEqual(schedule.departuresFrom("p:9001", "partner").map(item => item.tripId), ["p:boat", "p:mistyped", "p:untyped"]);
  assert.deepEqual(schedule.tripsOn("partner", "20261111").map(item => item.tripId), ["p:boat", "p:mistyped", "p:untyped"]);
  assert.equal(schedule.operators.get("partner").tripCount, 3);
  // Feeds parsed without a routes table keep every trip, as before.
  const plain = await scheduleFor(feed({ operatorId: "partner", prefix: "p:", plans }));
  assert.equal(plain.operators.get("partner").tripCount, 4);
});

test("the bundled NY Waterway feed contributes its ferries and none of its buses", async () => {
  const read = async name => parseCsv(await readFile(path.join(ROOT, "gtfs/waterway", name), "utf8"));
  const [routes, trips] = await Promise.all([read("routes.txt"), read("trips.txt")]);
  const ferryRouteIds = PARTNER_FEEDS.waterway.ferryRouteIds;
  const busRoutes = new Set(routes.filter(route => route.route_type === "3" && !ferryRouteIds.has(route.route_id)).map(route => route.route_id));
  const buses = trips.filter(trip => busRoutes.has(trip.route_id));
  const boats = trips.filter(trip => !busRoutes.has(trip.route_id));
  assert.ok(buses.length > 0 && boats.length > 0);
  assert.ok(boats.some(trip => ferryRouteIds.has(trip.route_id)));
  const schedule = await buildHarborSchedule({ root: ROOT });
  assert.equal(schedule.operators.get("waterway").tripCount, boats.length);
  for (const trip of buses) assert.equal(schedule.trip(`wtr:${trip.trip_id}`), null, trip.trip_id);
  for (const trip of boats.filter(trip => ferryRouteIds.has(trip.route_id)).slice(0, 20)) {
    assert.equal(schedule.trip(`wtr:${trip.trip_id}`)?.routeId, `wtr:${trip.route_id}`);
  }
});

test("tripsOn exposes only active operator trips with blocks, endpoints, and epoch milliseconds", async () => {
  const partner = feed({ operatorId: "waterway", prefix: "wtr:", plans: [
    plan("night", "25:10:00"), plan("inactive", "08:00:00", { serviceId: "off" }),
    plan("early", "07:00:00")
  ] });
  partner.trips[0].block_id = "boat-2";
  const schedule = await scheduleFor(feed(), partner);
  const original = structuredClone(partner);
  assert.deepEqual(schedule.tripsOn("waterway", "20261112"), [
    { tripId: "wtr:early", routeId: "wtr:R", blockId: null, firstStopId: "wtr:9001", lastStopId: "wtr:9003",
      departsAt: Date.parse("2026-11-12T12:00:00Z"), arrivesAt: Date.parse("2026-11-12T12:20:00Z") },
    { tripId: "wtr:night", routeId: "wtr:R", blockId: "boat-2", firstStopId: "wtr:9001", lastStopId: "wtr:9003",
      departsAt: Date.parse("2026-11-13T06:10:00Z"), arrivesAt: Date.parse("2026-11-13T06:30:00Z") }
  ]);
  assert.deepEqual(schedule.tripsOn("waterway", "2026-11-12"), schedule.tripsOn("waterway", "20261112"));
  assert.deepEqual(schedule.tripsOn("missing", "20261112"), []);
  assert.deepEqual(schedule.tripsOn("waterway", "20270101"), []);
  assert.equal(Object.hasOwn(schedule.trip("wtr:night"), "blockId"), false);
  assert.equal(Object.hasOwn(schedule.departuresFrom("wtr:9001", "waterway")[0], "blockId"), false);
  assert.equal(schedule.ambiguousTripsOn("waterway", "20261112"), 0);
  assert.deepEqual(partner, original);
});

test("tripsOn follows calendar additions and removals without changing activeOn", async () => {
  const schedule = await scheduleFor(feed({ plans: [plan("removed"), plan("added", "09:00:00", { serviceId: "special" })],
    calendarDates: [
      { service_id: "daily", date: "20261112", exception_type: "2" },
      { service_id: "special", date: "20261112", exception_type: "1" }
    ] }));
  assert.deepEqual(schedule.tripsOn("nycf", "20261112").map(item => item.tripId), ["added"]);
  assert.deepEqual(schedule.activeOn("2026-11-12"), new Set(["special"]));
});

test("tripsOn respects layered dates and holidays while reporting ambiguous active ids", async () => {
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({
    trips: new Map([
      ["ambiguous", [liveCandidate({ routeId: "ONE" }), liveCandidate({ routeId: "TWO" })]],
      ["dated", [liveCandidate({ dates: ["2026-11-12"] })]],
      ["holiday", [liveCandidate({ holiday: true })]],
      ["reused", [liveCandidate({ dates: ["2026-11-11"] }), liveCandidate({ dates: ["2026-11-12"] })]]
    ]), holidayDates: new Set(["2026-11-13"])
  }) });
  assert.deepEqual(schedule.tripsOn("nycf", "20261112").map(item => item.tripId), ["dated", "reused"]);
  assert.equal(schedule.ambiguousTripsOn("nycf", "20261112"), 1);
  assert.equal(schedule.ambiguousTripsOn("nycf", "2026-11-12"), 1);
  assert.deepEqual(schedule.tripsOn("nycf", "20261113").map(item => item.tripId), ["holiday"]);
  assert.equal(schedule.ambiguousTripsOn("nycf", "20261113"), 0);
  assert.equal(schedule.tripsOn("nycf", "20261112")[0].blockId, null);
});

for (const [date, time, instant] of [
  ["20260307", "27:10:00", "2026-03-08T07:10:00Z"],
  ["20261031", "26:10:00", "2026-11-01T07:10:00Z"],
  ["20260308", "01:10:00", "2026-03-08T06:10:00Z"],
  ["20261101", "03:10:00", "2026-11-01T08:10:00Z"]
]) {
  test(`tripsOn converts ${date} ${time} with the schedule's local clock across DST`, async () => {
    const schedule = await scheduleFor(feed({ plans: [plan("dst", time)] }));
    assert.equal(schedule.tripsOn("nycf", date)[0].departsAt, Date.parse(instant));
  });
}

test("tripsOn honors the layered timezone for both ordinary and overnight endpoints", async () => {
  const schedule = await buildHarborSchedule({ tables: [], serviceTrips: serviceIndex({ timezone: "America/Chicago",
    trips: new Map([["night", [liveCandidate({ time: "25:10:00" })]]])
  }) });
  const [trip] = schedule.tripsOn("nycf", "20261112");
  assert.equal(trip.departsAt, Date.parse("2026-11-13T07:10:00Z"));
  assert.equal(trip.arrivesAt, Date.parse("2026-11-13T07:30:00Z"));
});
