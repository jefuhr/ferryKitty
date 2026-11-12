// Failure modes: ignored GTFS blocks, invalid turn windows, competing successors, stranded trips,
// duplicate or missing trips, shared landings, midnight and DST boundaries, unstable ids/signatures,
// date-specific trip lookup, duplicate/weak observations, mixed day types, insufficient evidence,
// confidence above the cap, cross-operator estimates, claimed runs, and mutation of caller data.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarborSchedule } from "../lib/harbor-schedule.js";
import { buildRuns, runOfTrip, tripsAfter, dayType, buildPatterns, estimateFromPatterns } from "../lib/harbor-runs.js";

const DAILY = {
  service_id: "daily", sunday: "1", monday: "1", tuesday: "1", wednesday: "1", thursday: "1",
  friday: "1", saturday: "1", start_date: "20260101", end_date: "20261231"
};
const trip = (id, from, to, departure, arrival, blockId = "", routeId = "R") => ({
  id, from, to, departure, arrival, blockId, routeId
});
async function scheduleFor(plans, reverse = false) {
  const tables = [{ operatorId: "waterway", prefix: "wtr:", calendar: [DAILY], calendarDates: [],
    trips: plans.map(plan => ({ trip_id: plan.id, route_id: plan.routeId, service_id: "daily", block_id: plan.blockId })),
    stopTimes: plans.flatMap(plan => [
      { trip_id: plan.id, stop_id: plan.from, stop_sequence: "1", arrival_time: plan.departure, departure_time: plan.departure },
      { trip_id: plan.id, stop_id: plan.to, stop_sequence: "2", arrival_time: plan.arrival, departure_time: plan.arrival }
    ]) }];
  if (reverse) {
    tables[0].trips.reverse();
    tables[0].stopTimes.reverse();
  }
  return buildHarborSchedule({ tables });
}
const runsOn = (schedule, serviceDate = "20261112", options = {}) =>
  buildRuns({ schedule, operatorId: "waterway", serviceDate, ...options });
const ids = runs => runs.map(run => run.trips.map(item => item.tripId));

test("published blocks keep their trips together even across routes, terminals, and long breaks", async () => {
  const schedule = await scheduleFor([
    trip("late", "C", "D", "12:00:00", "12:20:00", "boat-1", "OTHER"),
    trip("early", "A", "B", "07:10:00", "07:30:00", "boat-1"),
    trip("other", "B", "A", "07:32:00", "07:50:00", "boat-2"),
    trip("unblocked", "B", "E", "07:33:00", "08:00:00")
  ]);
  const runs = runsOn(schedule);
  assert.deepEqual(ids(runs), [["wtr:early", "wtr:late"], ["wtr:other"], ["wtr:unblocked"]]);
  assert.deepEqual(runs.map(run => run.source), ["block", "block", "synthesized"]);
  assert.equal(runs[0].signature, "wtr:A>07:10>wtr:R");
  assert.deepEqual(Object.keys(runs[0]).sort(), ["runId", "signature", "source", "trips"]);
  assert.deepEqual(Object.keys(runs[0].trips[0]).sort(), ["arrivesAt", "departsAt", "firstStopId", "lastStopId", "routeId", "tripId"]);
});

test("greedy synthesis takes the earliest eligible unclaimed successor and covers every trip once", async () => {
  const plans = [
    trip("first", "A", "B", "08:00:00", "08:20:00"),
    trip("too-short", "B", "C", "08:21:59", "08:30:00"),
    trip("earliest", "B", "D", "08:22:00", "08:40:00"),
    trip("later", "B", "E", "08:23:00", "08:45:00"),
    trip("too-long", "D", "F", "09:25:01", "09:40:00"),
    trip("stranded", "X", "Y", "06:00:00", "06:20:00")
  ];
  const runs = runsOn(await scheduleFor(plans));
  assert.deepEqual(ids(runs), [["wtr:stranded"], ["wtr:first", "wtr:earliest"], ["wtr:too-short"], ["wtr:later"], ["wtr:too-long"]]);
  const actual = runs.flatMap(run => run.trips.map(item => item.tripId)).sort();
  assert.deepEqual(actual, plans.map(plan => `wtr:${plan.id}`).sort());
  assert.equal(new Set(actual).size, actual.length);
  assert.ok(runs.every(run => run.source === "synthesized"));
});

test("both turn-window boundaries are inclusive and caller-supplied windows apply", async () => {
  const schedule = await scheduleFor([
    trip("first", "A", "B", "08:00:00", "08:20:00"),
    trip("next", "B", "C", "09:05:00", "09:20:00")
  ]);
  assert.deepEqual(ids(runsOn(schedule)), [["wtr:first", "wtr:next"]]);
  assert.equal(runsOn(schedule, "20261112", { maxTurnMs: 2_699_999 }).length, 2);
  assert.equal(runsOn(schedule, "20261112", { minTurnMs: 2_700_001, maxTurnMs: 3_000_000 }).length, 2);
});

test("shared landings chain only when the injected predicate identifies their stop ids", async () => {
  const schedule = await scheduleFor([
    trip("first", "A", "B1", "08:00:00", "08:20:00"),
    trip("next", "B2", "C", "08:22:00", "08:40:00")
  ]);
  assert.equal(runsOn(schedule).length, 2);
  const sameLanding = (a, b) => a === b || [a, b].every(id => ["wtr:B1", "wtr:B2"].includes(id));
  assert.deepEqual(ids(runsOn(schedule, "20261112", { sameLanding })), [["wtr:first", "wtr:next"]]);
});

test("trips across midnight keep their service date and use 24-plus-hour arrival/departure instants", async () => {
  const schedule = await scheduleFor([
    trip("evening", "A", "B", "23:40:00", "24:05:00"),
    trip("night", "B", "C", "24:10:00", "24:50:00"),
    trip("later", "C", "D", "25:10:00", "25:30:00")
  ]);
  const [run] = runsOn(schedule);
  assert.deepEqual(ids([run]), [["wtr:evening", "wtr:night", "wtr:later"]]);
  assert.equal(run.runId, "waterway:20261112:1");
  assert.equal(run.trips[2].departsAt, Date.parse("2026-11-13T06:10:00Z"));
  assert.equal(run.trips[0].arrivesAt, Date.parse("2026-11-13T05:05:00Z"));
  const [night] = runsOn(await scheduleFor([trip("night", "A", "B", "25:10:00", "25:30:00")]));
  assert.equal(night.signature, "wtr:A>01:10>wtr:R");
});

test("run ids, trip tie breaks, and signatures are deterministic regardless of input row order", async () => {
  const plans = [trip("z", "A", "B", "08:00:00", "08:20:00"), trip("a", "A", "C", "08:00:00", "08:20:00")];
  const schedule = await scheduleFor(plans);
  const original = structuredClone(schedule.tripsOn("waterway", "20261112"));
  const runs = runsOn(schedule);
  assert.deepEqual(runs, runsOn(schedule));
  assert.deepEqual(runs, runsOn(await scheduleFor(plans, true), "2026-11-12"));
  assert.deepEqual(runs.map(run => run.runId), ["waterway:20261112:1", "waterway:20261112:2"]);
  assert.deepEqual(ids(runs), [["wtr:a"], ["wtr:z"]]);
  assert.deepEqual(schedule.tripsOn("waterway", "20261112"), original);
  assert.deepEqual(runsOn(schedule, "20261113").map(run => run.signature), runs.map(run => run.signature));
  assert.deepEqual(buildRuns({ schedule, operatorId: "missing", serviceDate: "20261112" }), []);
});

test("runOfTrip and tripsAfter locate only the requested trip and preserve run order", async () => {
  const runs = runsOn(await scheduleFor([
    trip("first", "A", "B", "08:00:00", "08:20:00"), trip("next", "B", "C", "08:22:00", "08:40:00")
  ]));
  assert.equal(runOfTrip(runs, "wtr:first"), runs[0]);
  assert.equal(runOfTrip(runs, "missing"), null);
  assert.deepEqual(tripsAfter(runs[0], "wtr:first"), [runs[0].trips[1]]);
  assert.deepEqual(tripsAfter(runs[0], "wtr:next"), []);
  assert.deepEqual(tripsAfter(runs[0], "missing"), []);
  assert.deepEqual(tripsAfter(null, "missing"), []);
});

test("dayType accepts compact and dashed dates without depending on the machine timezone", () => {
  assert.equal(dayType("20261112"), "weekday");
  assert.equal(dayType("20261114"), "saturday");
  assert.equal(dayType("2026-11-15"), "sunday");
});

async function patternFixture() {
  const schedule = await scheduleFor([
    trip("first", "A", "B", "08:00:00", "08:20:00"), trip("next", "B", "C", "08:22:00", "08:40:00")
  ]);
  const dates = ["20261109", "20261110", "20261111", "20261112", "20261114", "20261115"];
  const runs = dates.flatMap(date => runsOn(schedule, date));
  const observation = (serviceDate, vesselId = "waterway:one", overrides = {}) => ({
    operatorId: "waterway", vesselId, serviceDate, tripId: "wtr:first", confidence: 0.9,
    source: "schedule", ...overrides
  });
  return { runs, observation };
}

test("patterns count qualifying dates once per vessel/signature and keep day types separate", async () => {
  const { runs, observation } = await patternFixture();
  const observations = [
    observation("20261109"), observation("2026-11-09", undefined, { tripId: "wtr:next" }),
    observation("20261110", undefined, { confidence: 0.89 }),
    observation("20261111", undefined, { confidence: 0, source: "operator-rt" }),
    observation("20261112", "waterway:two"), observation("20261114"), observation("20261115"),
    observation("20261112", null), observation("20261112", undefined, { tripId: "missing" }),
    observation("20261112", undefined, { operatorId: "another" }),
    observation("20261113"), observation("20261112", undefined, { confidence: null })
  ];
  const original = structuredClone({ observations, runs });
  const patterns = buildPatterns(observations, runs);
  const signature = runs[0].signature;
  assert.deepEqual(patterns, [
    { vesselId: "waterway:one", runSignature: signature, dayType: "saturday", count: 1, lastSeen: "20261114" },
    { vesselId: "waterway:one", runSignature: signature, dayType: "sunday", count: 1, lastSeen: "20261115" },
    { vesselId: "waterway:one", runSignature: signature, dayType: "weekday", count: 2, lastSeen: "20261111" },
    { vesselId: "waterway:two", runSignature: signature, dayType: "weekday", count: 1, lastSeen: "20261112" }
  ]);
  assert.deepEqual(buildPatterns([...observations].reverse(), [...runs].reverse()), patterns);
  assert.deepEqual({ observations, runs }, original);
});

test("patterns can resolve a stored run id but never reuse that run on another service date", async () => {
  const { runs, observation } = await patternFixture();
  const patterns = buildPatterns([
    observation("20261109", undefined, { tripId: null, runId: runs[0].runId }),
    observation("20261110", undefined, { tripId: null, runId: runs[0].runId })
  ], runs);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].count, 1);
  assert.equal(patterns[0].lastSeen, "20261109");
});

test("pattern estimates require three dates for this vessel and cap their observation share at 0.8", async () => {
  const { runs } = await patternFixture();
  const today = runs.filter(run => run.runId.includes(":20261112:"));
  const base = { vesselId: "waterway:one", runSignature: today[0].signature, dayType: "weekday", lastSeen: "20261111" };
  const estimate = patterns => estimateFromPatterns({ vesselId: base.vesselId, operatorId: "waterway", dayType: "weekday", patterns, runs: today });
  assert.equal(estimate([{ ...base, count: 2 }, { ...base, vesselId: "waterway:two", count: 20 }]), null);
  assert.deepEqual(estimate([{ ...base, count: 3 }]), {
    runId: today[0].runId, runSignature: base.runSignature, routeId: "wtr:R", confidence: 0.8,
    source: "pattern", evidence: { count: 3, total: 3, dayType: "weekday", lastSeen: "20261111" }
  });
  assert.equal(estimate([{ ...base, count: 3 }, { ...base, vesselId: "waterway:two", count: 2 }]).confidence, 0.6);
  assert.equal(estimate([{ ...base, count: 3, dayType: "saturday" }]), null);
  assert.equal(estimateFromPatterns({ vesselId: base.vesselId, operatorId: "other", dayType: "weekday", patterns: [{ ...base, count: 3 }], runs: today }), null);
});

test("claimed signatures are unavailable even when they are this vessel's strongest eligible pattern", async () => {
  const runs = runsOn(await scheduleFor([
    trip("first", "A", "B", "08:00:00", "08:20:00"), trip("second", "X", "Y", "09:00:00", "09:20:00")
  ]));
  const row = (run, vesselId, count) => ({ vesselId, runSignature: run.signature, dayType: "weekday", count, lastSeen: "20261111" });
  const patterns = [row(runs[0], "waterway:one", 4), row(runs[0], "waterway:two", 5),
    row(runs[1], "waterway:one", 3), row(runs[1], "waterway:two", 4)];
  const input = { vesselId: "waterway:one", operatorId: "waterway", dayType: "weekday", patterns, runs };
  assert.equal(estimateFromPatterns(input).runId, runs[0].runId);
  const claimed = new Set([runs[0].signature]);
  assert.equal(estimateFromPatterns({ ...input, claimed }).runId, runs[1].runId);
  assert.deepEqual([...claimed], [runs[0].signature]);
  claimed.add(runs[1].signature);
  assert.equal(estimateFromPatterns({ ...input, claimed }), null);
});
