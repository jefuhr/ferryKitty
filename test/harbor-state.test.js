// Failure modes: noisy speed/position flapping; short, interrupted, or high-rate docking dwells;
// weak/reversed range trends; unavailable AIS fields; sparse moored reporting; stale/lost recovery;
// premature/late layup; landing-only docking; slip confidence/stickiness; duplicate departure events;
// out-of-order fixes; input mutation; and unbounded position history. All positions are invented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { angleDifference, distanceMetres, median, offsetPoint } from "../lib/harbor-geo.js";
import { advanceTrack, emptyTrack, refreshTrack, THRESHOLDS } from "../lib/harbor-state.js";

const START = Date.parse("2026-11-11T15:00:00Z");
const KEY = "367000001";
const NORTH_ID = "NYCF_9002_NORTH";
const SOUTH_ID = "NYCF_9002_SOUTH";
const YARD_ID = "NYCF_PIERC_DRY_DOCK";
const fixtures = new URL("./fixtures/harbor/", import.meta.url);
const stops = JSON.parse(readFileSync(new URL("stops.json", fixtures), "utf8")).stops;

// These stand-ins deliberately live here: the reducer must only depend on the shared index shape.
function fixtureIndex() {
  const slipsByLabel = new Map();
  const labels = {
    "Slip 1": ["SLIP_1", "1", "passenger"],
    "Slip 2": ["SLIP_2", "2", "passenger"],
    "Slip B1": ["B1", "B1", "passenger"],
    North: ["NORTH", "N", "passenger"],
    South: ["SOUTH", "S", "passenger"],
    East: ["NORTH", "E", "passenger"],
    West: ["SOUTH", "W", "passenger"],
    "DOCK #1": ["DOCK_1", "1", "passenger"],
    "Dry Dock": ["DRY_DOCK", "DD", "drydock"],
    SLIP_25: ["SLIP_25", "25", "yard"],
    "Slip 27 Fuel Tanks": ["SLIP_27", "27", "fuel"],
    "Slip 31 Annex": ["SLIP_31", "31", "yard"]
  };
  const rows = readFileSync(new URL("slips.csv", fixtures), "utf8").trim().split("\n").slice(1);
  for (const row of rows) {
    const [name, label, latitude, longitude] = row.split(",");
    const stop = stops.find((candidate) => candidate.name === name);
    if (!stop && name !== "Pier C") continue;
    const landingStopId = stop?.stopId ?? "home-port";
    const [token, platformCode, kind] = labels[label];
    const key = `${landingStopId}|${label}`;
    if (!slipsByLabel.has(key)) {
      slipsByLabel.set(key, {
        id: `NYCF_${stop?.stopId ?? "PIERC"}_${token}`,
        name: label, platformCode, landingStopId, kind, points: []
      });
    }
    slipsByLabel.get(key).points.push({ latitude: Number(latitude), longitude: Number(longitude) });
  }
  const slips = [...slipsByLabel.values()];
  const byId = new Map(slips.map((slip) => [slip.id, slip]));
  const landingIds = [...stops.map((stop) => stop.stopId), "home-port"];
  const landings = landingIds.map((landingStopId) => {
    const stop = stops.find((candidate) => candidate.stopId === landingStopId);
    const landingSlips = slips.filter((slip) => slip.landingStopId === landingStopId);
    const points = landingSlips.flatMap((slip) => slip.points);
    return {
      landingStopId,
      landingId: landingStopId === "9002" ? "test-point" : null,
      name: stop?.name ?? "Pier C",
      latitude: points.length ? points.reduce((sum, point) => sum + point.latitude, 0) / points.length : stop.latitude,
      longitude: points.length ? points.reduce((sum, point) => sum + point.longitude, 0) / points.length : stop.longitude,
      radiusMetres: 120,
      slipIds: landingSlips.map((slip) => slip.id),
      yard: landingStopId === "home-port"
    };
  });
  return {
    slips, byId, landings,
    nearestLanding(point) {
      return landings.map((landing) => ({ landing, distanceMetres: distanceMetres(point, landing) }))
        .sort((left, right) => left.distanceMetres - right.distanceMetres)[0] ?? null;
    },
    slipsNear(point, radiusMetres) {
      return slips.map((slip) => ({
        slip, distanceMetres: Math.min(...slip.points.map((position) => distanceMetres(point, position)))
      })).filter((candidate) => candidate.distanceMetres <= radiusMetres)
        .sort((left, right) => left.distanceMetres - right.distanceMetres);
    }
  };
}

function fixtureAssignSlip(points, index, { landingStopId, headingDegrees = null, slipHeadings = new Map() }) {
  const last = points.slice(-10);
  const point = { latitude: median(last.map((position) => position.latitude)), longitude: median(last.map((position) => position.longitude)) };
  const candidates = index.slipsNear(point, 60).filter(({ slip }) => {
    const difference = angleDifference(headingDegrees, slipHeadings.get(slip.id));
    return slip.landingStopId === landingStopId && (difference === null || difference <= 90);
  }).map(({ slip, distanceMetres: distance }) => ({ slipId: slip.id, distanceMetres: distance, weight: Math.exp(-(distance ** 2) / (2 * 12 ** 2)) }));
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, Math.exp(-(45 ** 2) / (2 * 12 ** 2)));
  const ranked = candidates.map(({ slipId, distanceMetres: distance, weight }) => ({ slipId, distanceMetres: distance, p: weight / total }))
    .sort((left, right) => right.p - left.p);
  const best = ranked[0];
  const pair = ranked.slice(0, 2).map((candidate) => index.byId.get(candidate.slipId));
  const ambiguous = pair.length === 2 && Math.min(...pair[0].points.flatMap((first) => pair[1].points.map((second) => distanceMetres(first, second)))) < 25;
  return {
    slipId: best && best.p >= 0.6 ? best.slipId : null,
    confidence: Math.min(best?.p ?? 0, ambiguous ? 0.6 : 1),
    ambiguous,
    candidates: ranked
  };
}

const slipIndex = fixtureIndex();
const context = { slipIndex, assignSlip: fixtureAssignSlip };
const north = slipIndex.byId.get(NORTH_ID).points[0];
const south = slipIndex.byId.get(SOUTH_ID).points[0];
const yard = slipIndex.byId.get(YARD_ID).points[0];
const pointLanding = slipIndex.landings.find((landing) => landing.landingStopId === "9002");
const partner = slipIndex.landings.find((landing) => landing.landingStopId === "tst:1");

function fixAt(seconds, point = north, sogKnots = 0.1, extra = {}) {
  return {
    mmsi: KEY, latitude: point.latitude, longitude: point.longitude, sogKnots, cogDegrees: 270, headingDegrees: 270,
    navStatus: 0, at: START + seconds * 1000, source: "ais", aisClass: "A", ...extra
  };
}

function advance(track, fix, extra = {}) {
  return advanceTrack(track, fix, { ...context, now: fix.at, ...extra });
}

function replay(fixes, initial = emptyTrack(KEY), extra = {}) {
  let track = initial;
  const events = [], tracks = [];
  for (const fix of fixes) {
    const result = advance(deepFreeze(track), deepFreeze(fix), extra);
    track = result.track;
    events.push(...result.events);
    tracks.push(track);
  }
  return { track, events, tracks };
}

function docked(point = north, extra = {}) {
  return replay([fixAt(0, point), fixAt(30, point)], emptyTrack(KEY), extra).track;
}

function arriving() {
  return replay([380, 320, 260].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 8))).track;
}

function departing() {
  return replay([fixAt(40, offsetPoint(north, 90, 10), 2), fixAt(50, offsetPoint(north, 90, 25), 2)], docked()).track;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("Thresholds expose every state, age, hysteresis, and history limit", () => {
  assert.deepEqual(THRESHOLDS, {
    dockMaxSpeedKnots: 0.5,
    dockRadiusMetres: 35,
    dockMinFixes: 2,
    dockMinSpanMs: 30_000,
    briefCallMinGapMs: 60_000,
    briefCallMaxGapMs: 600_000,
    mooredNavStatus: 5,
    departureMinSpeedKnots: 2,
    departureMinFixes: 2,
    departureRadiusMetres: 60,
    landingExitMarginMetres: 25,
    approachRadiusMetres: 400,
    arrivalMaxSpeedKnots: 12,
    rangeSamples: 3,
    rangeMinChangeMetres: 5,
    departingMaxMs: 180_000,
    nonPassengerLayupMs: 300_000,
    passengerLayupMs: 5_400_000,
    landingRadiusMetres: 120,
    movingMinSpeedKnots: 2,
    movingStaleMs: 90_000,
    stationaryStaleMs: 360_000,
    lostMs: 1_200_000,
    dockMaxPoints: 10,
    recentMaxFixes: 20,
    slipChangeMinP: 0.6
  });
  assert.ok(Object.isFrozen(THRESHOLDS));
});

test("Empty tracks have independent history and the contract shape", () => {
  assert.deepEqual(emptyTrack(KEY), {
    key: KEY, mmsi: KEY, vesselId: null, identitySource: null, static: null, fix: null,
    recent: [], state: "unknown", stateSince: 0, moving: false, stale: false,
    dock: null, lastDock: null, pending: null, trip: null
  });
  assert.equal(emptyTrack("vessel:example").mmsi, null);
  assert.notEqual(emptyTrack(KEY).recent, emptyTrack(KEY).recent);
  assert.deepEqual(refreshTrack(emptyTrack(KEY), { now: START }), { track: emptyTrack(KEY), events: [] });
});

test("The invented AIS replay arrives, dwells without flapping, and departs exactly once", () => {
  const fixes = readFileSync(new URL("ais-arrival.ndjson", fixtures), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((raw) => raw.MessageType === "PositionReport").map((raw) => {
      const body = raw.Message.PositionReport;
      return {
        mmsi: String(body.UserID), latitude: body.Latitude, longitude: body.Longitude,
        sogKnots: body.Sog >= 102.3 ? null : body.Sog,
        cogDegrees: body.Cog >= 360 ? null : body.Cog,
        headingDegrees: body.TrueHeading === 511 ? null : body.TrueHeading,
        navStatus: body.NavigationalStatus,
        at: Date.parse(`${raw.MetaData.time_utc.slice(0, 10)}T${raw.MetaData.time_utc.slice(11, 23)}Z`),
        source: "ais", aisClass: "A"
      };
    });
  const result = replay(fixes);
  const states = result.tracks.map((track) => track.state).filter((state, index, all) => index === 0 || state !== all[index - 1]);
  assert.deepEqual(states, ["underway", "arriving", "docked", "departing", "underway"]);
  const moored = result.tracks.filter((track) => track.state === "docked");
  assert.ok(moored.length > 5);
  assert.ok(moored.every((track) => track.dock.landingStopId === "9002" && track.dock.slipId === NORTH_ID));
  assert.equal(result.tracks.find((track) => track.fix.sogKnots === 0.6).state, "docked");
  assert.equal(result.tracks.find((track) => track.fix.headingDegrees === null).state, "docked");
  assert.equal(result.events.filter((event) => event.type === "docked").length, 1);
  assert.equal(result.events.filter((event) => event.type === "departed").length, 1);
  assert.equal(result.events.length, 2);
  assert.equal(result.track.lastDock.landingStopId, "9002");
  assert.equal(result.track.lastDock.slipId, NORTH_ID);
});

test("Arrival needs three strictly closing samples and at least five metres of progress", () => {
  const short = replay([310, 308, 306].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 8)));
  assert.ok(short.tracks.every((track) => track.state === "underway"));
  const result = replay([310, 308, 304.99].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 8)));
  assert.deepEqual(result.tracks.map((track) => track.state), ["underway", "underway", "arriving"]);
  assert.equal(result.track.stateSince, START + 20_000);
  const equal = replay([310, 310, 300].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 8)));
  assert.equal(equal.track.state, "underway");
});

test("Arrival only enters within 400 metres at a speed below twelve knots", () => {
  for (const speed of [12, 13, null]) {
    assert.equal(replay([480, 440, 399.99].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), speed))).track.state, "underway");
  }
  assert.equal(replay([480, 440, 400.01].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 8))).track.state, "underway");
  assert.equal(replay([480, 440, 399.99].map((range, index) => fixAt(index * 10, offsetPoint(pointLanding, 90, range), 11.99))).track.state, "arriving");
});

test("An arrival reverses after two increases totalling five metres and can approach again", () => {
  let track = arriving();
  track = advance(track, fixAt(30, offsetPoint(pointLanding, 90, 262), 8)).track;
  assert.equal(track.state, "arriving");
  track = advance(track, fixAt(40, offsetPoint(pointLanding, 90, 264), 8)).track;
  assert.equal(track.state, "arriving");
  track = advance(track, fixAt(50, offsetPoint(pointLanding, 90, 268), 8)).track;
  assert.equal(track.state, "underway");
  track = replay([250, 240, 230].map((range, index) => fixAt(60 + index * 10, offsetPoint(pointLanding, 90, range), 8)), track).track;
  assert.equal(track.state, "arriving");
});

test("Docking requires two stopped fixes spanning thirty seconds and keeps the first time", () => {
  let track = advance(emptyTrack(KEY), fixAt(0, north, 0.5)).track;
  assert.equal(track.state, "underway");
  assert.equal(track.dock, null);
  assert.equal(track.pending.since, START);
  track = advance(track, fixAt(29.999, north, 0.5)).track;
  assert.equal(track.dock, null);
  const result = advance(track, fixAt(30, north, 0.5));
  assert.equal(result.track.state, "docked");
  assert.equal(result.track.dock.since, START);
  assert.equal(result.track.stateSince, START + 30_000);
  assert.equal(result.track.pending, null);
  assert.equal(result.track.dock.kind, "passenger");
  assert.equal(result.track.dock.landingId, "test-point");
  assert.deepEqual(result.events, [{ type: "docked", key: KEY, at: START + 30_000, landingStopId: "9002", slipId: NORTH_ID, confidence: result.track.dock.confidence }]);
});

test("The dock entry radius is thirty-five metres and speed must not exceed half a knot", () => {
  assert.equal(docked(offsetPoint(north, 90, 34.99)).state, "docked");
  assert.equal(docked(offsetPoint(north, 90, 35.01)).state, "underway");
  assert.equal(replay([fixAt(0, north, 0.5001), fixAt(30, north, 0.5001)]).track.state, "underway");
});

test("Interrupted dwells and a different landing reset pending docking evidence", () => {
  for (const interruption of [fixAt(20, north, 0.6), fixAt(20, offsetPoint(north, 90, 36)), fixAt(20, north, null)]) {
    let track = advance(emptyTrack(KEY), fixAt(0)).track;
    track = advance(track, interruption).track;
    assert.equal(track.pending, null);
    const result = advance(track, fixAt(30));
    assert.equal(result.track.state, "underway");
    assert.equal(result.track.pending.since, START + 30_000);
  }
  const result = replay([fixAt(0), fixAt(30, yard)]);
  assert.equal(result.track.state, "underway");
  assert.equal(result.track.pending.landingStopId, "home-port");
  assert.equal(result.track.pending.since, START + 30_000);
});

test("One stopped fix followed minutes later by a fix under way counts as a short call", () => {
  const away = offsetPoint(north, 90, 600);
  const result = replay([fixAt(0), fixAt(180, away, 8)]);
  assert.deepEqual(result.events.map((event) => event.type), ["docked", "departed"]);
  const [arrived, left] = result.events;
  assert.equal(arrived.at, START);
  assert.equal(arrived.landingStopId, "9002");
  assert.equal(arrived.brief, true);
  assert.equal(left.landingStopId, "9002");
  assert.equal(left.dockedAt, START);
  assert.equal(left.brief, true);
  // 600 metres at eight knots is about 146 seconds, so the boat left roughly 34 seconds in.
  assert.ok(left.departedAt > START + 30_000 && left.departedAt < START + 40_000, String(left.departedAt - START));
  assert.equal(result.track.dock, null);
  assert.equal(result.track.pending, null);
  assert.notEqual(result.track.state, "docked");
  assert.equal(result.track.lastDock.landingStopId, "9002");
  assert.equal(result.track.lastDock.since, START);
  assert.equal(result.track.lastDock.until, left.departedAt);
});

test("A short call never starts before the stopped fix and falls back to the fix time without a usable speed", () => {
  const fast = replay([fixAt(0), fixAt(90, offsetPoint(north, 90, 2000), 8)]).events.at(-1);
  assert.equal(fast.departedAt, START);
  const slow = replay([fixAt(0), fixAt(180, offsetPoint(north, 90, 100), 0.3)]).events.at(-1);
  assert.equal(slow.type, "departed");
  assert.equal(slow.departedAt, START + 180_000);
});

test("A short call needs sparse reports, a recent stop, and a boat that has really left", () => {
  const away = offsetPoint(north, 90, 600);
  // Frequent reports can prove a dwell the ordinary way, so one stopped report among them is a pause.
  assert.deepEqual(replay([fixAt(0), fixAt(59.999, away, 8)]).events, []);
  assert.equal(replay([fixAt(0), fixAt(60, away, 8)]).events.length, 2);
  assert.equal(replay([fixAt(0), fixAt(600, away, 8)]).events.length, 2);
  assert.deepEqual(replay([fixAt(0), fixAt(600.001, away, 8)]).events, []);
  // Still beside the berth, or with nothing known about its speed there: not a departure.
  assert.deepEqual(replay([fixAt(0), fixAt(180, offsetPoint(north, 90, 36), 0.6)]).events, []);
  assert.deepEqual(replay([fixAt(0), fixAt(180, north, null)]).events, []);
  // A boat that never stopped at the landing made no call.
  assert.deepEqual(replay([fixAt(0, north, 0.6), fixAt(180, away, 8)]).events, []);
});

test("A short call at one landing leaves a stop at the next one pending", () => {
  const result = replay([fixAt(0), fixAt(240, yard)]);
  assert.deepEqual(result.events.map((event) => event.type), ["docked", "departed"]);
  assert.equal(result.events[1].landingStopId, "9002");
  assert.equal(result.track.pending.landingStopId, "home-port");
  assert.equal(result.track.pending.since, START + 240_000);
});

test("High-rate fixes preserve pending dwell time beyond the twenty-fix recent buffer", () => {
  const result = replay(Array.from({ length: 32 }, (_, seconds) => fixAt(seconds)));
  assert.equal(result.track.state, "docked");
  assert.equal(result.track.dock.since, START);
  assert.equal(result.track.dock.points.length, 10);
  assert.equal(result.track.recent.length, 20);
  assert.equal(result.events.filter((event) => event.type === "docked").length, 1);
});

test("A moored report shortcuts the dwell only while arriving and still needs berth and speed evidence", () => {
  const result = advance(arriving(), fixAt(30, north, 0.5, { navStatus: 5 }));
  assert.equal(result.track.state, "docked");
  assert.equal(result.track.dock.since, START + 30_000);
  assert.equal(result.events[0].type, "docked");
  assert.equal(advance(emptyTrack(KEY), fixAt(0, north, 0.1, { navStatus: 5 })).track.state, "underway");
  assert.equal(advance(arriving(), fixAt(30, north, 0.6, { navStatus: 5 })).track.dock, null);
  assert.equal(advance(arriving(), fixAt(30, offsetPoint(north, 90, 36), 0.1, { navStatus: 5 })).track.dock, null);
});

test("Drifting past a landing never docks and stopping in open water stays underway", () => {
  const drift = replay([120, 80, 40, 0, -40, -80, -120].map((range, index) => fixAt(index * 30, offsetPoint(north, 90, range), 0.6)));
  assert.ok(drift.tracks.every((track) => track.state !== "docked"));
  assert.equal(drift.events.filter((event) => event.type === "docked").length, 0);
  const openWater = offsetPoint(pointLanding, 90, 800);
  const stopped = replay([fixAt(0, openWater, 0), fixAt(30, openWater, 0)]).track;
  assert.equal(stopped.state, "underway");
  assert.equal(stopped.moving, false);
  assert.equal(stopped.dock, null);
});

test("A single 0.6 knot blip and a forty-metre position blip never undock", () => {
  const result = replay([fixAt(40, north, 0.6), fixAt(50, offsetPoint(north, 90, 40)), fixAt(60)], docked());
  assert.ok(result.tracks.every((track) => track.state === "docked"));
  assert.equal(result.events.length, 0);
  assert.equal(result.track.dock.since, START);
  assert.equal(result.track.dock.points.length, 5);
});

test("Departure needs two consecutive fixes at or above two knots, with null speed breaking the streak", () => {
  const result = replay([
    fixAt(40, offsetPoint(north, 90, 10), 2),
    fixAt(50, offsetPoint(north, 90, 15), 1.999),
    fixAt(60, offsetPoint(north, 90, 20), 2),
    fixAt(70, offsetPoint(north, 90, 25), null),
    fixAt(80, offsetPoint(north, 90, 30), 2),
    fixAt(90, offsetPoint(north, 90, 35), 2)
  ], docked());
  assert.ok(result.tracks.slice(0, -1).every((track) => track.state === "docked"));
  assert.equal(result.track.state, "departing");
  assert.equal(result.track.moving, true);
  assert.deepEqual(result.events, [{
    type: "departed", key: KEY, at: START + 90_000, landingStopId: "9002", slipId: NORTH_ID,
    dockedAt: START, departedAt: START + 90_000
  }]);
  assert.equal(result.track.dock, null);
  assert.equal(result.track.lastDock.since, START);
  assert.equal(result.track.lastDock.until, START + 90_000);
  assert.equal(result.track.lastDock.slipId, NORTH_ID);
});

test("Distance departure uses every slip in the landing, with a sixty-metre exit radius", () => {
  const atOtherSlip = advance(docked(), fixAt(40, south));
  assert.equal(atOtherSlip.track.state, "docked");
  const inside = advance(docked(), fixAt(40, offsetPoint(north, 90, 59.99)));
  assert.equal(inside.track.state, "docked");
  const outside = advance(docked(), fixAt(40, offsetPoint(north, 90, 60.01)));
  assert.notEqual(outside.track.state, "docked");
  assert.equal(outside.events.length, 1);
  assert.equal(outside.events[0].type, "departed");
});

test("Landing-only docking uses the 120 metre radius and a 25 metre exit margin", () => {
  const inside = offsetPoint(partner, 90, 119.99);
  const track = docked(inside);
  assert.equal(track.state, "docked");
  assert.equal(track.dock.landingStopId, "tst:1");
  assert.equal(track.dock.slipId, null);
  assert.equal(track.dock.kind, "passenger");
  assert.deepEqual(track.dock.candidates, []);
  assert.equal(docked(offsetPoint(partner, 90, 120.01)).dock, null);
  assert.equal(advance(track, fixAt(40, offsetPoint(partner, 90, 144.99))).track.state, "docked");
  const result = advance(track, fixAt(40, offsetPoint(partner, 90, 145.01)));
  assert.equal(result.events[0].type, "departed");
  assert.equal(result.events[0].slipId, null);
});

test("A departure needs opening range to enter departing and can acquire that evidence after leaving", () => {
  let track = replay([fixAt(40, north, 2), fixAt(50, north, 2)], docked()).track;
  assert.equal(track.state, "underway");
  track = advance(track, fixAt(60, offsetPoint(north, 90, 10), 2)).track;
  assert.equal(track.state, "underway");
  track = advance(track, fixAt(70, offsetPoint(north, 90, 30), 2)).track;
  assert.equal(track.state, "departing");
  assert.equal(track.stateSince, START + 70_000);
});

test("Departing ends beyond 400 metres and cannot restart after three minutes", () => {
  const track = departing();
  assert.equal(track.state, "departing");
  const inside = advance(track, fixAt(60, offsetPoint(pointLanding, 90, 399.99), 8)).track;
  assert.equal(inside.state, "departing");
  const outside = advance(inside, fixAt(70, offsetPoint(pointLanding, 90, 400.01), 8));
  assert.equal(outside.track.state, "underway");
  assert.equal(outside.events.length, 0);
  const expired = advance(track, fixAt(230, offsetPoint(pointLanding, 90, 100), 2));
  assert.equal(expired.track.state, "underway");
  assert.equal(expired.events.length, 0);
  assert.equal(expired.track.lastDock.until, START + 50_000);
});

test("Refresh expires departing at exactly three minutes without waiting for a fix", () => {
  const track = departing();
  assert.equal(refreshTrack(track, { now: START + 229_999 }).track.state, "departing");
  const result = refreshTrack(track, { now: START + 230_000 });
  assert.equal(result.track.state, "underway");
  assert.equal(result.track.stateSince, START + 230_000);
  assert.equal(result.track.lastDock.until, START + 50_000);
  assert.deepEqual(result.events, []);
  const withFix = advance(track, fixAt(230, offsetPoint(north, 90, 25), 2));
  assert.equal(withFix.track.state, result.track.state);
});

test("A departed vessel can dock again while keeping its previous dock for matching", () => {
  const track = departing();
  const result = replay([fixAt(80), fixAt(110)], track);
  assert.equal(result.track.state, "docked");
  assert.equal(result.track.dock.since, START + 80_000);
  assert.equal(result.track.lastDock.until, START + 50_000);
  assert.equal(result.events.filter((event) => event.type === "docked").length, 1);
  assert.equal(result.events.length, 1);
});

test("Freshness switches at two knots, after ninety seconds moving and six minutes otherwise", () => {
  for (const [speed, freshMs] of [[2, 90_000], [1.999, 360_000], [0, 360_000], [null, 360_000]]) {
    const track = advance(emptyTrack(KEY), fixAt(0, offsetPoint(pointLanding, 90, 800), speed)).track;
    assert.equal(track.moving, speed !== null && speed >= 2);
    assert.equal(refreshTrack(track, { now: START + freshMs }).track.stale, false);
    const stale = refreshTrack(track, { now: START + freshMs + 1 });
    assert.equal(stale.track.stale, true);
    assert.equal(stale.track.state, "underway");
    assert.deepEqual(stale.events, []);
    const fresh = advance(stale.track, fixAt((freshMs + 2) / 1000, offsetPoint(pointLanding, 90, 800), speed));
    assert.equal(fresh.track.stale, false);
    assert.equal(fresh.track.state, "underway");
  }
});

test("Three-minute moored reports stay docked, becoming stale only after six silent minutes", () => {
  let track = docked();
  for (let seconds = 210; seconds <= 1_110; seconds += 180) {
    const before = refreshTrack(track, { now: START + seconds * 1000 - 1 });
    assert.equal(before.track.state, "docked");
    assert.equal(before.track.stale, false);
    track = advance(before.track, fixAt(seconds, north, 0.1, { navStatus: 5 })).track;
    assert.equal(track.state, "docked");
    assert.equal(track.stale, false);
  }
  assert.equal(refreshTrack(track, { now: track.fix.at + 360_000 }).track.stale, false);
  const result = refreshTrack(track, { now: track.fix.at + 360_001 });
  assert.equal(result.track.stale, true);
  assert.equal(result.track.state, "docked");
  assert.deepEqual(result.events, []);
});

test("Every known state is lost after twenty silent minutes and recovers on a new fix", () => {
  const laidUp = refreshTrack(docked(yard), { now: START + 300_000 }).track;
  const underway = advance(emptyTrack(KEY), fixAt(0, offsetPoint(pointLanding, 90, 800), 8)).track;
  for (const track of [underway, arriving(), docked(), departing(), laidUp]) {
    assert.notEqual(track.state, "unknown");
    const now = track.fix.at + 1_200_001;
    const result = refreshTrack(deepFreeze(track), { now });
    assert.equal(result.track.state, "unknown");
    assert.equal(result.track.stateSince, now);
    assert.equal(result.track.stale, true);
    assert.equal(result.track.dock, null);
    assert.equal(result.track.pending, null);
    assert.deepEqual(result.events, [{ type: "lost", key: KEY, at: now }]);
    assert.deepEqual(refreshTrack(result.track, { now: now + 1 }).events, []);
    const recovered = advance(result.track, fixAt((now - START + 2) / 1000, offsetPoint(pointLanding, 90, 800), 8));
    assert.equal(recovered.track.state, "underway");
    assert.equal(recovered.track.stale, false);
    assert.equal(recovered.track.dock, null);
    assert.deepEqual(recovered.events, []);
  }
  assert.equal(refreshTrack(underway, { now: START + 1_200_000 }).track.state, "underway");
});

test("Lost tracks discard pending dwell evidence and retain the last confirmed departure", () => {
  const pending = advance(emptyTrack(KEY), fixAt(0)).track;
  const lost = refreshTrack(deepFreeze(pending), { now: START + 1_200_001 });
  assert.equal(lost.track.state, "unknown");
  assert.equal(lost.track.pending, null);
  const recovered = advance(lost.track, fixAt(1_201));
  assert.equal(recovered.track.state, "underway");
  assert.equal(recovered.track.pending.since, START + 1_201_000);
  const left = departing();
  const lostDeparture = refreshTrack(left, { now: left.fix.at + 1_200_001 });
  assert.deepEqual(lostDeparture.track.lastDock, left.lastDock);
  assert.equal(lostDeparture.events.length, 1);
  assert.equal(lostDeparture.events[0].type, "lost");
});

test("Advance computes the measured state before applying stale and lost ageing against now", () => {
  const fix = fixAt(0, offsetPoint(pointLanding, 90, 800), 8);
  const stale = advance(emptyTrack(KEY), fix, { now: START + 90_001 });
  assert.equal(stale.track.state, "underway");
  assert.equal(stale.track.stale, true);
  assert.deepEqual(stale.events, []);
  const lost = advance(emptyTrack(KEY), fix, { now: START + 1_200_001 });
  assert.equal(lost.track.state, "unknown");
  assert.equal(lost.track.stale, true);
  assert.equal(lost.events.filter((event) => event.type === "lost").length, 1);
  assert.equal(lost.track.fix.at, START);
});

test("Yard, fuel, and drydock slips lay up after five minutes with one event and leave as departed", () => {
  for (const id of [YARD_ID, "NYCF_PIERC_SLIP_25", "NYCF_PIERC_SLIP_27", "NYCF_PIERC_SLIP_31"]) {
    const slip = slipIndex.byId.get(id);
    const track = docked(slip.points[0]);
    assert.equal(track.dock.kind, slip.kind);
    assert.equal(refreshTrack(track, { now: START + 299_999 }).track.state, "docked");
    const result = refreshTrack(track, { now: START + 300_000 });
    assert.equal(result.track.state, "laid-up");
    assert.deepEqual(result.events, [{ type: "laid-up", key: KEY, at: START + 300_000, landingStopId: "home-port", slipId: id }]);
    assert.deepEqual(refreshTrack(result.track, { now: START + 300_001 }).events, []);
    const unchanged = advance(result.track, fixAt(301, slip.points[0]));
    assert.equal(unchanged.track.state, "laid-up");
    assert.deepEqual(unchanged.events, []);
    const left = replay([fixAt(310, slip.points[0], 2), fixAt(320, slip.points[0], 2)], unchanged.track);
    assert.equal(left.events.length, 1);
    assert.equal(left.events[0].type, "departed");
    assert.equal(left.events[0].dockedAt, START);
    assert.equal(left.events[0].departedAt, START + 320_000);
    assert.equal(left.track.lastDock.slipId, id);
    assert.equal(left.track.dock, null);
  }
});

test("Passenger and landing-only docks lay up at ninety minutes while regular reports stay fresh", () => {
  for (const point of [north, partner]) {
    let track = docked(point);
    for (let seconds = 180; seconds < 5_400; seconds += 180) {
      const result = advance(track, fixAt(seconds, point));
      assert.equal(result.track.state, "docked");
      assert.deepEqual(result.events, []);
      track = result.track;
    }
    assert.equal(refreshTrack(track, { now: START + 5_399_999 }).track.state, "docked");
    const result = refreshTrack(track, { now: START + 5_400_000 });
    assert.equal(result.track.state, "laid-up");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "laid-up");
    assert.deepEqual(refreshTrack(result.track, { now: START + 5_400_001 }).events, []);
    const leaving = advance(result.track, fixAt(5_410, offsetPoint(point, 90, 180)));
    assert.equal(leaving.events.length, 1);
    assert.equal(leaving.events[0].type, "departed");
  }
});

test("A laid-up vessel enters departing with sustained opening range and can dock again", () => {
  const laidUp = refreshTrack(docked(yard), { now: START + 300_000 }).track;
  const departure = replay([fixAt(310, offsetPoint(yard, 90, 10), 2), fixAt(320, offsetPoint(yard, 90, 30), 2)], laidUp);
  assert.equal(departure.track.state, "departing");
  assert.deepEqual(departure.events, [{
    type: "departed", key: KEY, at: START + 320_000, landingStopId: "home-port", slipId: YARD_ID,
    dockedAt: START, departedAt: START + 320_000
  }]);
  const returned = replay([fixAt(350, yard), fixAt(380, yard)], departure.track);
  assert.equal(returned.track.state, "docked");
  assert.equal(returned.track.dock.since, START + 350_000);
  assert.equal(returned.track.lastDock.until, START + 320_000);
  assert.equal(returned.events.length, 1);
  assert.equal(returned.events[0].type, "docked");
});

test("Advance and refresh share layup timing, including a yard without a confident slip", () => {
  const normal = docked(yard);
  const refreshed = refreshTrack(normal, { now: START + 300_000 });
  const advanced = advance(normal, fixAt(300, yard));
  assert.equal(advanced.track.state, refreshed.track.state);
  assert.deepEqual(advanced.events, refreshed.events);
  const unassigned = docked(yard, {
    assignSlip: () => ({ slipId: null, confidence: 0.4, ambiguous: true, candidates: [] })
  });
  assert.equal(unassigned.dock.slipId, null);
  assert.equal(unassigned.dock.kind, "yard");
  assert.equal(refreshTrack(unassigned, { now: START + 300_000 }).track.state, "laid-up");
});

test("Dock points roll over at ten and median evidence can change a sticky slip once", () => {
  const result = replay(Array.from({ length: 15 }, (_, index) => fixAt(40 + index * 10, south)), docked());
  assert.ok(result.tracks.every((track) => track.state === "docked"));
  assert.equal(result.tracks[0].dock.slipId, NORTH_ID);
  assert.equal(result.tracks[1].dock.slipId, NORTH_ID);
  assert.equal(result.track.dock.slipId, SOUTH_ID);
  assert.equal(result.track.dock.kind, "passenger");
  assert.deepEqual(result.track.dock.points.map((point) => point.at), Array.from({ length: 10 }, (_, index) => START + (90 + index * 10) * 1000));
  const changed = result.events.filter((event) => event.type === "slip-changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0].landingStopId, "9002");
  assert.equal(changed[0].slipId, SOUTH_ID);
  assert.ok(changed[0].confidence >= 0.6);
  assert.ok(result.track.dock.confidence > result.tracks[1].dock.confidence);
});

test("Reassignment updates slip kind and a laid-up vessel still accepts dock points and slip changes", () => {
  const laidUp = refreshTrack(docked(yard), { now: START + 300_000 }).track;
  const nextSlip = slipIndex.byId.get("NYCF_PIERC_SLIP_25");
  const result = replay([310, 320, 330, 340].map((seconds) => fixAt(seconds, nextSlip.points[0])), laidUp);
  assert.equal(result.track.state, "laid-up");
  assert.equal(result.track.dock.slipId, nextSlip.id);
  assert.equal(result.track.dock.kind, "yard");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "slip-changed");
  assert.equal(result.track.dock.since, START);
});

test("A different slip needs candidate probability of at least 0.6, rather than rounded confidence", () => {
  const track = docked();
  const assignment = (p) => ({
    slipId: p >= 0.6 ? SOUTH_ID : null,
    confidence: p,
    ambiguous: true,
    candidates: [{ slipId: SOUTH_ID, p, distanceMetres: 5 }, { slipId: NORTH_ID, p: 0.3, distanceMetres: 15 }]
  });
  const uncertain = advance(track, fixAt(40), { assignSlip: () => assignment(0.59999) });
  assert.equal(uncertain.track.dock.slipId, NORTH_ID);
  assert.deepEqual(uncertain.events, []);
  const certain = advance(uncertain.track, fixAt(50), { assignSlip: () => assignment(0.6) });
  assert.equal(certain.track.dock.slipId, SOUTH_ID);
  assert.deepEqual(certain.events, [{ type: "slip-changed", key: KEY, at: START + 50_000, landingStopId: "9002", slipId: SOUTH_ID, confidence: 0.6 }]);
});

test("A close pair remains ambiguous and a previously unassigned slip can gain confidence", () => {
  const first = slipIndex.byId.get("NYCF_9001_SLIP_1").points[0];
  const close = docked(first);
  assert.equal(close.dock.ambiguous, true);
  assert.ok(close.dock.confidence <= 0.6);
  const middle = offsetPoint(north, 180, distanceMetres(north, south) / 2);
  const unassigned = docked(middle);
  assert.equal(unassigned.dock.slipId, null);
  const result = replay([fixAt(40, north), fixAt(50, north), fixAt(60, north)], unassigned);
  assert.equal(result.track.dock.slipId, NORTH_ID);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "slip-changed");
});

test("The reducer forwards heading and learned slip headings without requiring either", () => {
  const slipHeadings = new Map([[NORTH_ID, 270]]);
  const calls = [];
  const assignSlip = (points, index, options) => {
    calls.push({ points, index, options });
    return fixtureAssignSlip(points, index, options);
  };
  const track = docked(north, { assignSlip, slipHeadings });
  const result = advance(track, fixAt(40, north, null, { headingDegrees: null, cogDegrees: null }), { assignSlip, slipHeadings });
  assert.equal(result.track.state, "docked");
  assert.equal(result.track.moving, false);
  assert.equal(calls.at(-1).index, slipIndex);
  assert.equal(calls.at(-1).options.headingDegrees, null);
  assert.equal(calls.at(-1).options.slipHeadings, slipHeadings);
  assert.equal(calls.at(-1).options.landingStopId, "9002");
  const unavailable = replay([fixAt(0, north, null, { headingDegrees: null, cogDegrees: null }), fixAt(30, north, null, { headingDegrees: null, cogDegrees: null })]);
  assert.equal(unavailable.track.state, "underway");
  assert.equal(unavailable.track.pending, null);
});

test("Duplicate and out-of-order fixes do not update or age the input track", () => {
  const track = deepFreeze(docked());
  for (const fix of [fixAt(30, yard, 8), fixAt(10, yard, 8)]) {
    const result = advance(track, deepFreeze(fix), { now: START + 10_000_000 });
    assert.equal(result.track, track);
    assert.deepEqual(result.events, []);
  }
});

test("Both reducers are pure and preserve service-owned identity, static data, and trip fields", () => {
  const track = deepFreeze({
    ...docked(), vesselId: "test-ferry", identitySource: "roster",
    static: { name: "TEST FERRY", dims: { a: 10, b: 16, c: 3, d: 4 } },
    trip: { tripId: "test-trip", routeId: "test-route", serviceDate: "20261111", source: "schedule", confidence: 0.5, nextSequence: 2 }
  });
  const fix = deepFreeze(fixAt(40, offsetPoint(north, 90, 4)));
  const snapshot = structuredClone(track);
  const fixSnapshot = structuredClone(fix);
  const first = advance(track, fix);
  const second = advance(track, fix);
  assert.deepEqual(first, second);
  assert.deepEqual(track, snapshot);
  assert.deepEqual(fix, fixSnapshot);
  assert.equal(first.track.vesselId, "test-ferry");
  assert.deepEqual(first.track.static, track.static);
  assert.deepEqual(first.track.trip, track.trip);
  const refreshed = refreshTrack(track, { now: START + 1_300_000 });
  assert.deepEqual(refreshed, refreshTrack(track, { now: START + 1_300_000 }));
  assert.deepEqual(track, snapshot);
  assert.deepEqual(refreshed.track.trip, track.trip);
  const result = replay(Array.from({ length: 100 }, (_, index) => deepFreeze(fixAt(50 + index, north))), track);
  assert.ok(result.tracks.every((value) => value.recent.length <= 20 && value.dock.points.length <= 10));
  assert.equal(result.track.recent[0].at, START + 130_000);
  assert.equal(result.track.recent.at(-1).at, START + 149_000);
});

test("Storage berths are offered to slip assignment only after a passenger-length dwell", () => {
  const seen = [];
  const spy = (points, index, options) => { seen.push(options.storage); return fixtureAssignSlip(points, index, options); };
  let track = docked(north, { assignSlip: spy });
  track = advance(track, fixAt(THRESHOLDS.passengerLayupMs / 1000 - 1), { assignSlip: spy }).track;
  assert.ok(seen.length > 0 && seen.every((storage) => storage === false));
  advance(track, fixAt(THRESHOLDS.passengerLayupMs / 1000), { assignSlip: spy });
  assert.equal(seen.at(-1), true);
});
