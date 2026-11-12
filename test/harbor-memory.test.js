// Failure modes: a trip timed past midnight filed under the wrong service day (so the boat is shown
// tomorrow's sailings), a report far from any running of the trip being forced onto a day anyway,
// and a database that cannot be written taking the tracker down with it.
import assert from "node:assert/strict";
import test from "node:test";

import { createHarborMemory } from "../lib/harbor-memory.js";
import { buildHarborSchedule } from "../lib/harbor-schedule.js";

const everyDay = { monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1", start_date: "20260101", end_date: "20271231" };
const call = (trip_id, stop_id, stop_sequence, time) => ({ trip_id, stop_id, stop_sequence: String(stop_sequence), arrival_time: time, departure_time: time });
// Two late trips on one boat: N1 leaves A at 25:00 (1 am the next morning) and N2 leaves B at 25:30.
const schedule = await buildHarborSchedule({ tables: [{ operatorId: "nycf", prefix: "",
  trips: [{ trip_id: "N1", route_id: "R", service_id: "all" }, { trip_id: "N2", route_id: "R", service_id: "all" }],
  stopTimes: [call("N1", "A", 1, "25:00:00"), call("N1", "B", 2, "25:20:00"), call("N2", "B", 1, "25:30:00"), call("N2", "A", 2, "25:50:00")],
  calendar: [{ service_id: "all", ...everyDay }], calendarDates: [] }] });

function fakeStore(overrides = {}) {
  return { saveRuns() {}, listPatterns: () => [], listEstimates: () => [], listTripObservations: () => [], replacePatterns() {}, ...overrides };
}

const local = (iso) => Date.parse(iso);   // America/New_York is UTC-5 in November

test("a trip timed past midnight belongs to the service day it started on", () => {
  const at = local("2026-11-13T06:05:00Z");                 // 01:05 local on Friday 13 November
  const memory = createHarborMemory({ store: fakeStore(), schedule, now: () => at });
  assert.equal(memory.serviceDateOf("nycf", "N1", at), "20261112");
  const track = { key: "k", trip: { tripId: "N1", routeId: null, serviceDate: null, source: "operator-rt", confidence: 1, observedAt: at } };
  const assignment = memory.allocate([{ vesselId: "boat", operatorId: "nycf", track }], at).get("boat");
  assert.equal(assignment.runId, "nycf:20261112:1");
  assert.deepEqual(assignment.nextTrips.map((trip) => [trip.tripId, new Date(trip.departsAt).toISOString()]), [["N2", "2026-11-13T06:30:00.000Z"]]);
});

test("a report nowhere near any running of the trip is not forced onto a service day", () => {
  const memory = createHarborMemory({ store: fakeStore(), schedule, now: () => 0 });
  assert.equal(memory.serviceDateOf("nycf", "N1", local("2026-11-13T18:00:00Z")), null);
  assert.equal(memory.serviceDateOf("nycf", "no-such-trip", local("2026-11-13T06:05:00Z")), null);
});

test("a database that cannot be written or read costs the record, never the answer", () => {
  const warnings = [];
  const broken = () => { throw new Error("disk full"); };
  const memory = createHarborMemory({ store: fakeStore({ saveRuns: broken, listPatterns: broken, listEstimates: broken, recordSighting: broken, linkAis: broken }),
    schedule, now: () => local("2026-11-13T06:05:00Z"), warn: (message) => warnings.push(message) });
  memory.sighting({ mmsi: "367000001", fix: { at: 1, sogKnots: 0 } });
  assert.equal(memory.link({ mmsi: "367000001", vesselId: "boat", source: "ais-name", at: 1 }), false);
  assert.deepEqual([...memory.allocate([{ vesselId: "boat", operatorId: "nycf", track: null }])], []);
  assert.ok(warnings.length > 0);
});
