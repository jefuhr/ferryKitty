import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { landingChoices, loadAllLandingData } from "../lib/landing-data.js";
import { loadHarborMap } from "../lib/fleet-map.js";
import { buildHarborSchedule } from "../lib/harbor-schedule.js";
import { buildRuns } from "../lib/harbor-runs.js";
import { PARTNER_FEEDS, parseCsv } from "../lib/schedule-builder.js";
import { activeServices } from "../public/assets/schedule.js";

const root = fileURLToPath(new URL("../", import.meta.url));
let startup;
async function serverSchedule() {
  startup ||= (async () => {
    const landings = JSON.parse(await readFile(new URL("../config/landings.json", import.meta.url), "utf8"));
    const boards = await loadAllLandingData({ root, choices: landingChoices(landings) });
    const harbor = await loadHarborMap({ root, landings: boards.available, byLanding: boards.byLanding });
    const schedule = await buildHarborSchedule({ root, serviceTrips: harbor.serviceTrips });
    return { schedule, boards };
  })();
  return startup;
}

// Exercise the server's board -> serviceTrips -> harbor path, not just raw GTFS lookups.
test("November 14 operator trip IDs resolve with stops through the server schedule", async () => {
  const { schedule } = await serverSchedule();
  for (const [id, route] of [["2395", "AS"], ["2307", "RS"]]) {
    const trip = schedule.trip(id, "2026-11-14");
    assert.ok(trip, `Live trip ${id} resolves`);
    assert.equal(trip.routeId, route);
    assert.ok(trip.stops.length > 1);
    assert.ok(trip.stops.every(stop => stop.stopId && Number.isFinite(stop.departureSeconds)));
  }
});

test("November 14 NYC Ferry runs include the live trips and start before 09:00 New York", async () => {
  const { schedule, boards } = await serverSchedule();
  const trips = buildRuns({ schedule, operatorId: "nycf", serviceDate: "2026-11-14" }).flatMap(run => run.trips);
  assert.ok(trips.some(trip => trip.tripId === "2395"));
  assert.ok(trips.some(trip => trip.tripId === "2307"));
  assert.ok(Math.min(...trips.map(trip => trip.departsAt)) < Date.parse("2026-11-14T09:00:00-05:00"));
  const publishedIds = new Set([...boards.byLanding.values()].flatMap(data => {
    const active = activeServices(data, "2026-11-14");
    return data.departures.filter(row => row.operator === "NYC Ferry" && row.mode === "ferry" &&
      !row.fromHomePort && !row.outOfService && !row.crewShuttle && active.has(row.serviceId))
      .map(row => row.liveTripIdsByDate?.["2026-11-14"] || row.liveTripId || row.tripId);
  }));
  assert.equal(publishedIds.size, 128);
  assert.deepEqual(new Set(trips.map(trip => trip.tripId)), publishedIds);
  assert.equal(schedule.ambiguousTripsOn("nycf", "2026-11-14"), 0);
  for (const id of publishedIds) assert.ok(schedule.trip(id, "2026-11-14")?.stops.length > 1, id);
});

test("November 16 weekday NYC Ferry runs retain their published count and departure bounds", async () => {
  const { schedule } = await serverSchedule();
  const trips = buildRuns({ schedule, operatorId: "nycf", serviceDate: "2026-11-16" }).flatMap(run => run.trips);
  assert.equal(trips.length, 259);
  assert.equal(Math.min(...trips.map(trip => trip.departsAt)), Date.parse("2026-11-16T05:03:00-05:00"));
  assert.equal(Math.max(...trips.map(trip => trip.departsAt)), Date.parse("2026-11-16T20:52:00-05:00"));
});

test("November Waterway harbor runs retain corrected ferries and exclude shuttle buses", async () => {
  const { schedule } = await serverSchedule();
  const routes = parseCsv(await readFile(new URL("../gtfs/waterway/routes.txt", import.meta.url), "utf8"));
  const corrections = PARTNER_FEEDS.waterway.ferryRouteIds;
  for (const date of ["2026-11-14", "2026-11-16"]) {
    const trips = buildRuns({ schedule, operatorId: "waterway", serviceDate: date }).flatMap(run => run.trips);
    assert.ok(trips.length > 0);
    for (const trip of trips) {
      const route = routes.find(row => `wtr:${row.route_id}` === trip.routeId);
      assert.ok(route);
      assert.ok(route.route_type === "4" || corrections.has(route.route_id), trip.routeId);
    }
  }
  for (const id of ["19750", "19751", "74376", "76080"]) {
    assert.ok(routes.some(route => route.route_id === id));
    assert.ok(schedule.tripsOn("waterway", "2026-11-16").some(trip => trip.routeId === `wtr:${id}`));
  }
});
