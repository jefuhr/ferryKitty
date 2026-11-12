import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAisMessage } from "../lib/ais-stream.js";
import { offsetPoint } from "../lib/harbor-geo.js";
import { openHarborDb, seedRoster } from "../lib/harbor-db.js";
import { buildHarborSchedule } from "../lib/harbor-schedule.js";
import { createHarborService } from "../lib/harbor-service.js";
import { createHarborStore } from "../lib/harbor-store.js";

// Failure modes covered here, all of them about the modules meeting each other:
// - a real message sequence must come out as one docked vessel in the right slip, then a trip
// - a restart must not forget where boats are, or who they are
// - AIS being down, or never configured, must be said plainly rather than shown as an empty harbor
// - a stranger must be remembered only if it could be a ferry, and never forever
// - a name match must become a lasting binding and must never displace the committed roster
// - the operator's feed must fill in for a hull AIS cannot see, and step back when AIS returns
// - a transponder beside an operator-reported boat for long enough must be learned as that boat
// - with no slip survey, docking still works at landing level and no slip is invented
// Every coordinate is invented (test/fixtures/harbor).

const FIXTURES = fileURLToPath(new URL("./fixtures/harbor/", import.meta.url));
const stops = JSON.parse(await readFile(path.join(FIXTURES, "stops.json"), "utf8")).stops;
const roster = JSON.parse(await readFile(path.join(FIXTURES, "roster.json"), "utf8"));
const arrival = (await readFile(path.join(FIXTURES, "ais-arrival.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const landings = stops.map((stop) => ({ landingStopId: stop.stopId, landingId: null, name: stop.name, latitude: stop.latitude, longitude: stop.longitude }));
const fleet = roster.vessels.filter((vessel) => vessel.operatorId === "nycf").map(({ id, name, number }) => ({ id, name, number }));
const POINT_NORTH = { latitude: 40.51018, longitude: -73.99 };

// One weekday trip that leaves Test Point at 10:08 local and calls at Test Cove next. The fixture
// boat pulls away at 10:09:50 on Wednesday 11 November 2026.
const schedule = await buildHarborSchedule({ tables: [{ operatorId: "nycf", prefix: "",
  trips: [{ trip_id: "T1", route_id: "TR", service_id: "wk" }],
  stopTimes: [
    { trip_id: "T1", stop_id: "9003", stop_sequence: "1", arrival_time: "09:50:00", departure_time: "09:50:00" },
    { trip_id: "T1", stop_id: "9002", stop_sequence: "2", arrival_time: "10:04:00", departure_time: "10:08:00" },
    { trip_id: "T1", stop_id: "9001", stop_sequence: "3", arrival_time: "10:20:00", departure_time: "10:20:00" }
  ],
  calendar: [{ service_id: "wk", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20260101", end_date: "20271231" }],
  calendarDates: [] }] });

async function harness(t, options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(os.tmpdir(), "harbor-service-"));
  if (!options.stateDir) t.after(() => rm(stateDir, { recursive: true, force: true }));
  const world = { clock: Date.UTC(2026, 10, 11, 15, 0, 0), status: { state: "open", connected: true, lastMessageAt: null, reconnects: 0 }, events: [], stream: null, stateDir };
  world.service = await createHarborService({
    stateDir, roster, fleet, stops, landings, schedule,
    slipsCsvPath: options.noSlips ? null : path.join(FIXTURES, "slips.csv"),
    apiKey: "apiKey" in options ? options.apiKey : "test-key",
    now: () => world.clock,
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    onEvent: (name) => world.events.push(name),
    createStream: (callbacks) => {
      world.stream = callbacks;
      return { start() {}, stop() {}, status: () => ({ ...world.status, state: callbacks.apiKey ? world.status.state : "disabled", lastMessageAt: world.status.lastMessageAt ?? world.clock }) };
    },
    ...options.extra
  });
  // Feeds messages through the same callbacks the live socket uses, with the clock following them.
  world.feed = (messages) => {
    for (const raw of messages) {
      // The clock follows the message's own timestamp, as if each were received when it was sent.
      const stamped = normalizeAisMessage(raw, Number.MAX_SAFE_INTEGER);
      if (stamped?.kind === "fix" && stamped.fix.at !== Number.MAX_SAFE_INTEGER) world.clock = Math.max(world.clock, stamped.fix.at);
      const record = normalizeAisMessage(raw, world.clock);
      if (record?.kind === "static") world.stream.onStatic(record.static);
      if (record?.kind === "fix") world.stream.onFix(record.fix);
    }
  };
  world.vessel = (id, query) => world.service.getCurrent(query).vessels.find((vessel) => vessel.id === id);
  return world;
}

function position(mmsi, point, at, { sog = 12, cog = 90, heading = 90 } = {}) {
  return { MessageType: "PositionReport", MetaData: { MMSI: Number(mmsi), time_utc: new Date(at).toISOString().replace("T", " ").replace("Z", "000000 +0000 UTC") },
    Message: { PositionReport: { UserID: Number(mmsi), Valid: true, Latitude: point.latitude, Longitude: point.longitude, Sog: sog, Cog: cog, TrueHeading: heading, NavigationalStatus: 0 } } };
}

function staticData(mmsi, name, type) {
  return { MessageType: "ShipStaticData", MetaData: { MMSI: Number(mmsi) },
    Message: { ShipStaticData: { UserID: Number(mmsi), Valid: true, Name: name, CallSign: "TEST", Type: type, ImoNumber: 0, Dimension: { A: 10, B: 15, C: 3, D: 3 } } } };
}

function vehicleFeed(entries) {
  return { entity: entries.map(({ label, point, at, speed = 8, tripId = null, sequence = null }, index) => ({ id: String(index), vehicle: {
    ...(tripId ? { trip: { tripId } } : {}), position: { latitude: point.latitude, longitude: point.longitude, speed },
    ...(sequence == null ? {} : { currentStopSequence: sequence }), vehicle: { id: label, label }, timestamp: Math.floor(at / 1000) } })) };
}

test("a message sequence becomes a docked vessel in the right slip, and then a trip", async (t) => {
  const world = await harness(t);
  const dwellEnds = arrival.findIndex((raw) => raw.Message.PositionReport?.Cog === 90);
  world.feed(arrival.slice(0, dwellEnds));

  const docked = world.vessel("test-ferry-one");
  assert.equal(docked.state, "docked");
  assert.equal(docked.status, "stopped");
  assert.equal(docked.operatorId, "nycf");
  assert.equal(docked.identitySource, "roster");
  assert.equal(docked.positionSource, "ais");
  assert.deepEqual(docked.landing, { id: null, stopId: "9002", name: "Test Point" });
  assert.equal(docked.slip.id, "NYCF_9002_NORTH");
  assert.equal(docked.slip.name, "North");
  assert.ok(docked.slip.confidence >= 0.8);
  assert.equal(docked.tripId, null);

  world.feed(arrival.slice(dwellEnds));
  const away = world.vessel("test-ferry-one");
  assert.equal(away.landing, null);
  assert.equal(away.slip, null);
  assert.equal(away.tripId, "T1");
  assert.equal(away.tripSource, "schedule");
  assert.equal(away.tripConfidence, 0.5);
  assert.deepEqual(world.events.filter((name) => name === "docked" || name === "departed"), ["docked", "departed"]);

  // Arriving where the timetable said it would go next turns a guess into a confirmed trip.
  let at = world.clock + 10 * 60_000;
  const cove = { latitude: 40.500063, longitude: -74 };
  world.feed([0, 40, 80].map((seconds) => position("367000001", cove, at + seconds * 1000, { sog: 0.1 })));
  const next = world.vessel("test-ferry-one");
  assert.equal(next.state, "docked");
  assert.equal(next.landing.stopId, "9001");
  assert.equal(next.tripId, "T1");
  assert.equal(next.tripConfidence, 0.9);
  // Two slips 14 m apart on one face: the tracker says so instead of pretending to know.
  assert.equal(next.slipAmbiguous, true);
  assert.ok(next.slipCandidates.length >= 2);
});

test("the service slip catalog serves the points in the slip file for each slip id", async (t) => {
  // Failure modes: points lost or changed in the service catalog, wrong kind, and yard leakage.
  const world = await harness(t);
  const { parseSlipCsv } = await import("../lib/harbor-slips.js");
  const csv = await readFile(path.join(FIXTURES, "slips.csv"), "utf8");
  const expected = new Map(parseSlipCsv(csv, { stops }).map(slip => [slip.id, slip]));
  const catalog = world.service.slips({ includeYard: true }).slips;
  assert.equal(catalog.length, expected.size);
  for (const slip of catalog) {
    assert.ok(expected.has(slip.id));
    assert.deepEqual(slip.points, expected.get(slip.id).points);
    assert.equal(slip.kind, expected.get(slip.id).kind);
  }
  assert.ok(world.service.slips().slips.every(slip => slip.kind === "passenger"));
  assert.ok(world.service.slips().slips.every(slip => slip.landingStopId !== "home-port"));
});

test("a restart remembers where boats are and who they are", async (t) => {
  const first = await harness(t);
  const dwellEnds = arrival.findIndex((raw) => raw.Message.PositionReport?.Cog === 90);
  first.feed(arrival.slice(0, dwellEnds));
  await first.service.stop();

  const second = await harness(t, { stateDir: first.stateDir });
  second.clock = first.clock + 60_000;
  const vessel = second.vessel("test-ferry-one");
  assert.equal(vessel.state, "docked");
  assert.equal(vessel.slip.id, "NYCF_9002_NORTH");
  assert.equal(vessel.name, "Test Ferry One");

  // Twenty minutes of silence across a restart is an unknown boat, not a docked one.
  second.clock = first.clock + 25 * 60_000;
  await second.service.tick();
  assert.equal(second.vessel("test-ferry-one").state, "unknown");
  assert.ok(second.events.includes("lost"));
});

test("AIS being down is reported as stale, and never configured as unavailable", async (t) => {
  const world = await harness(t);
  world.feed(arrival.slice(0, 10));
  assert.equal(world.service.getCurrent().stale, false);
  world.status = { ...world.status, state: "waiting", connected: false };
  const down = world.service.getCurrent();
  assert.equal(down.available, true);
  assert.equal(down.stale, true);
  assert.equal(down.sources.ais.connected, false);
  assert.ok(down.vessels.some((vessel) => vessel.id === "test-ferry-one" && vessel.latitude != null));

  const bare = await harness(t, { apiKey: null });
  const empty = bare.service.getCurrent();
  assert.equal(empty.available, false);
  assert.equal(empty.sources.ais.state, "disabled");
  assert.match(empty.error, /not configured/);
  // Every active rostered vessel is still listed, as unknown.
  assert.deepEqual(empty.vessels.map((vessel) => vessel.state), ["unknown", "unknown", "unknown"]);
});

test("strangers are remembered only when they could be ferries", async (t) => {
  const world = await harness(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  world.feed([staticData("367111111", "MYSTERY FERRY", 60), position("367111111", here, world.clock + 1000),
    staticData("367222222", "BIG TANKER", 80), position("367222222", here, world.clock + 2000)]);
  assert.equal(world.vessel("mmsi:367111111"), undefined);
  const stranger = world.vessel("mmsi:367111111", { includeUnrostered: true });
  assert.equal(stranger.name, "MYSTERY FERRY");
  assert.equal(stranger.rostered, false);
  assert.equal(world.vessel("mmsi:367222222", { includeUnrostered: true }), undefined);
  await world.service.stop();
  const saved = JSON.parse(await readFile(path.join(world.stateDir, "harbor-discovery.json"), "utf8"));
  assert.deepEqual(saved.vessels.map((entry) => entry.mmsi), ["367111111"]);
  assert.equal(saved.vessels[0].shipType, 60);
  const tracks = JSON.parse(await readFile(path.join(world.stateDir, "harbor-tracks.json"), "utf8"));
  assert.ok(!tracks.tracks.some((track) => track.key === "367222222"));
});

test("a name match becomes a lasting binding and never displaces the roster", async (t) => {
  const world = await harness(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  world.feed([staticData("367000002", "TEST FERRY 2@@@", 60), position("367000002", here, world.clock + 1000)]);
  const named = world.vessel("test-ferry-two");
  assert.equal(named.mmsi, "367000002");
  assert.equal(named.identitySource, "ais-name");

  // A second transponder using the same name does not get the hull.
  world.feed([staticData("367000022", "TEST FERRY 2", 60), position("367000022", here, world.clock + 1000)]);
  assert.equal(world.vessel("test-ferry-two").mmsi, "367000002");
  assert.equal(world.vessel("mmsi:367000022", { includeUnrostered: true }).rostered, false);

  // Nor does a transponder using a committed vessel's name displace its committed MMSI.
  world.feed([staticData("367000033", "TEST FERRY ONE", 60), position("367000033", here, world.clock + 1000)]);
  assert.notEqual(world.vessel("test-ferry-one").mmsi, "367000033");

  await world.service.stop();
  const identities = JSON.parse(await readFile(path.join(world.stateDir, "harbor-identities.json"), "utf8"));
  assert.deepEqual(identities.learned.map(({ mmsi, vesselId, source }) => ({ mmsi, vesselId, source })),
    [{ mmsi: "367000002", vesselId: "test-ferry-two", source: "ais-name" }]);
  const again = await harness(t, { stateDir: world.stateDir });
  assert.equal(again.vessel("test-ferry-two").mmsi, "367000002");
});

test("the operator feed fills in for a hull AIS cannot see, and steps back when AIS returns", async (t) => {
  const world = await harness(t);
  const start = { latitude: 40.55, longitude: -74.03 };
  world.service.observeOperatorFeed({ feed: null, now: world.clock,
    vehicleFeed: vehicleFeed([{ label: "H902", point: start, at: world.clock - 5000, tripId: "T1", sequence: 3 }]) });
  const seen = world.vessel("test-ferry-two");
  assert.equal(seen.positionSource, "operator");
  assert.equal(seen.mmsi, null);
  assert.equal(seen.tripId, "T1");
  assert.equal(seen.tripSource, "operator-rt");
  assert.equal(seen.state, "underway");
  assert.equal(world.service.getCurrent().sources.nycFerry.available, true);

  // A report three minutes old still places the boat but no longer vouches for its trip.
  world.clock += 200_000;
  world.service.observeOperatorFeed({ feed: null, now: world.clock,
    vehicleFeed: vehicleFeed([{ label: "H902", point: start, at: world.clock - 190_000, tripId: "T1", sequence: 3 }]) });
  assert.equal(world.vessel("test-ferry-two").tripId, null);

  // The same hull now turns up on AIS under a committed MMSI: AIS becomes the position of record.
  world.feed([position("367000001", start, world.clock + 1000)]);
  world.service.observeOperatorFeed({ feed: null, now: world.clock,
    vehicleFeed: vehicleFeed([{ label: "H901", point: offsetPoint(start, 0, 500), at: world.clock - 2000, tripId: "T1", sequence: 3 }]) });
  const one = world.vessel("test-ferry-one");
  assert.equal(one.positionSource, "ais");
  assert.equal(one.tripSource, "operator-rt");
  assert.ok(Math.abs(one.latitude - start.latitude) < 1e-4);

  // A broken feed is the operator's problem, not the board's.
  assert.doesNotThrow(() => world.service.observeOperatorFeed({ vehicleFeed: { entity: [{ vehicle: null }, null] }, now: world.clock }));
});

test("a transponder that keeps station with an operator-reported boat is learned as that boat", async (t) => {
  const world = await harness(t);
  const origin = { latitude: 40.58, longitude: -74.04 };
  world.feed([staticData("367000444", "UNNAMED", 60)]);
  for (let step = 0; step <= 8; step += 1) {
    const at = world.clock + 30_000;
    const point = offsetPoint(origin, 45, step * 180);
    world.feed([position("367000444", offsetPoint(point, 90, 20), at, { sog: 12, cog: 45, heading: 45 })]);
    world.clock = at + 2000;
    world.service.observeOperatorFeed({ feed: null, now: world.clock,
      vehicleFeed: vehicleFeed([{ label: "H902", point, at, speed: 6.2, tripId: "T1", sequence: 3 }]) });
  }
  const bound = world.vessel("test-ferry-two");
  assert.equal(bound.mmsi, "367000444");
  assert.equal(bound.identitySource, "proximity");
  assert.equal(bound.positionSource, "ais");
  assert.equal(bound.tripId, "T1");
  assert.ok(world.events.includes("identity-learned"));
  // One hull, one row.
  assert.equal(world.service.getCurrent({ includeUnrostered: true }).vessels.filter((vessel) => vessel.vesselId === "test-ferry-two" || vessel.mmsi === "367000444").length, 1);
});

test("with no slip survey, docking is reported by landing and no slip is invented", async (t) => {
  const world = await harness(t, { noSlips: true });
  const dwellEnds = arrival.findIndex((raw) => raw.Message.PositionReport?.Cog === 90);
  world.feed(arrival.slice(0, dwellEnds));
  const vessel = world.vessel("test-ferry-one");
  assert.equal(vessel.state, "docked");
  assert.equal(vessel.landing.stopId, "9002");
  assert.equal(vessel.slip, null);
  assert.deepEqual(world.service.slips().slips, []);
  assert.ok(distanceOk(vessel, POINT_NORTH));
});

function distanceOk(vessel, point) {
  return Math.abs(vessel.latitude - point.latitude) < 1e-3 && Math.abs(vessel.longitude - point.longitude) < 1e-3;
}

test("a capture can be replayed without a key, ending at the present moment", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harbor-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = path.join(directory, "capture.ndjson");
  await writeFile(capture, arrival.map((raw) => JSON.stringify(raw)).join("\n") + "\nnot json\n");
  const world = await harness(t, { apiKey: null, extra: { replayPath: capture } });
  world.clock = Date.UTC(2027, 0, 5, 12, 0, 0);
  await world.service.start();
  const current = world.service.getCurrent();
  assert.equal(current.available, true);
  const vessel = current.vessels.find((item) => item.id === "test-ferry-one");
  assert.equal(vessel.state, "underway");
  assert.ok(vessel.ageSeconds <= 1);
  await world.service.stop();
});

// Regressions from the adversarial review of the assembled tracker.

test("saved state that is valid JSON but the wrong shape is ignored rather than fatal", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "harbor-corrupt-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, "harbor-identities.json"), "null");
  await writeFile(path.join(stateDir, "harbor-tracks.json"), JSON.stringify({ tracks: "nope" }));
  await writeFile(path.join(stateDir, "harbor-discovery.json"), JSON.stringify({ vessels: [null, 4, { name: "no mmsi" }] }));
  await writeFile(path.join(stateDir, "harbor-dwells.json"), "{ half written");
  const world = await harness(t, { stateDir });
  assert.equal(world.service.getCurrent().vessels.length, 3);
  const mixed = await mkdtemp(path.join(os.tmpdir(), "harbor-corrupt-"));
  t.after(() => rm(mixed, { recursive: true, force: true }));
  await writeFile(path.join(mixed, "harbor-tracks.json"), JSON.stringify({ tracks: [null, 7, { nokey: true }, { key: 12 }, { key: "367000001", recent: "x", fix: 3 }] }));
  await writeFile(path.join(mixed, "harbor-identities.json"), JSON.stringify({ learned: [null, { mmsi: 5 }, { mmsi: "367000002", vesselId: "test-ferry-two", source: "ais-name", at: 1 }], static: [1, 2] }));
  const second = await harness(t, { stateDir: mixed });
  assert.equal(second.vessel("test-ferry-two").mmsi, "367000002");
  second.feed(arrival.slice(0, 5));
  assert.equal(second.vessel("test-ferry-one").state, "underway");
});

test("an operator's trip stops being vouched for once the operator stops reporting the boat", async (t) => {
  const world = await harness(t);
  const here = { latitude: 40.55, longitude: -74.03 };
  world.service.observeOperatorFeed({ feed: null, now: world.clock, vehicleFeed: vehicleFeed([{ label: "H902", point: here, at: world.clock - 2000, tripId: "T1", sequence: 3 }]) });
  assert.equal(world.vessel("test-ferry-two").tripId, "T1");
  // The boat drops out of the feed entirely.
  world.clock += 4 * 60_000;
  world.service.observeOperatorFeed({ feed: null, now: world.clock, vehicleFeed: vehicleFeed([]) });
  assert.equal(world.vessel("test-ferry-two").tripId, null);

  // Or the feed itself stops being read: the clock alone is enough.
  world.service.observeOperatorFeed({ feed: null, now: world.clock, vehicleFeed: vehicleFeed([{ label: "H902", point: here, at: world.clock - 2000, tripId: "T1", sequence: 3 }]) });
  assert.equal(world.vessel("test-ferry-two").tripId, "T1");
  world.clock += 4 * 60_000;
  await world.service.tick();
  assert.equal(world.vessel("test-ferry-two").tripId, null);
});

test("one trip is never given to two hulls, and the operator's word beats a timetable guess", async (t) => {
  const world = await harness(t);
  const dwellEnds = arrival.findIndex((raw) => raw.Message.PositionReport?.Cog === 90);
  world.feed(arrival.slice(0, dwellEnds));
  // The operator says another hull is running T1 just as this one leaves T1's stop on time.
  world.service.observeOperatorFeed({ feed: null, now: world.clock, vehicleFeed: vehicleFeed([{ label: "H902", point: { latitude: 40.55, longitude: -74.03 }, at: world.clock - 2000, tripId: "T1", sequence: 3 }]) });
  world.feed(arrival.slice(dwellEnds));
  assert.equal(world.vessel("test-ferry-two").tripId, "T1");
  assert.equal(world.vessel("test-ferry-one").tripId, null);

  // The other way round: a guess made first is withdrawn when the operator names a different hull.
  const other = await harness(t);
  other.feed(arrival);
  assert.equal(other.vessel("test-ferry-one").tripId, "T1");
  other.service.observeOperatorFeed({ feed: null, now: other.clock, vehicleFeed: vehicleFeed([{ label: "H902", point: { latitude: 40.55, longitude: -74.03 }, at: other.clock - 2000, tripId: "T1", sequence: 3 }]) });
  assert.equal(other.vessel("test-ferry-two").tripId, "T1");
  assert.equal(other.vessel("test-ferry-one").tripId, null);
});

test("what is remembered about passing ships is bounded", async (t) => {
  const world = await harness(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  for (let index = 0; index < 300; index += 1) {
    const mmsi = String(368000000 + index);
    world.feed([staticData(mmsi, `CARGO ${index}`, 70), position(mmsi, here, world.clock + 100)]);
  }
  world.feed([staticData("367111111", "MYSTERY FERRY", 60), position("367111111", here, world.clock + 100)]);
  assert.equal(world.service.status().tracks, 301);
  world.clock += 7 * 60 * 60_000;
  await world.service.tick();
  await world.service.stop();
  assert.equal(world.service.status().tracks, 0);
  const identities = JSON.parse(await readFile(path.join(world.stateDir, "harbor-identities.json"), "utf8"));
  // Only the one that could be a ferry, and so sits in the discovery log, is still remembered.
  assert.deepEqual(Object.keys(identities.static), ["367111111"]);
});

test("a fix dated in the future cannot freeze a vessel's track", async (t) => {
  const world = await harness(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  const receivedAt = world.clock;
  const future = normalizeAisMessage(position("367000001", here, receivedAt + 365 * 86_400_000), receivedAt);
  assert.equal(future.fix.at, receivedAt);
  world.stream.onFix(future.fix);
  world.clock += 60_000;
  const later = normalizeAisMessage(position("367000001", offsetPoint(here, 90, 300), world.clock - 1000), world.clock);
  world.stream.onFix(later.fix);
  const vessel = world.vessel("test-ferry-one");
  assert.ok(Math.abs(vessel.longitude - offsetPoint(here, 90, 300).longitude) < 1e-4);
  assert.ok(vessel.ageSeconds <= 2);
});

test("a partial static update after a restart adds to what was saved instead of erasing it", async (t) => {
  const first = await harness(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  first.feed([staticData("367111111", "MYSTERY FERRY", 60), position("367111111", here, first.clock + 100)]);
  await first.service.stop();
  const second = await harness(t, { stateDir: first.stateDir });
  second.clock = first.clock + 60_000;
  // Part A of a Class B report: a name and nothing else, as a freshly started stream delivers it.
  second.stream.onStatic({ mmsi: "367111111", name: "MYSTERY FERRY II", callSign: null, shipType: null, imo: null, dims: null, aisClass: "B", at: second.clock });
  const stranger = second.vessel("mmsi:367111111", { includeUnrostered: true });
  assert.ok(stranger, "the vessel is still recognised as a passenger type");
  assert.equal(stranger.name, "MYSTERY FERRY II");
});

test("a boat is recognised from the name on its position reports, before any static report", async (t) => {
  const world = await harness(t);
  const raw = position("367000002", { latitude: 40.6, longitude: -74.05 }, world.clock + 1000);
  raw.MetaData.ShipName = "TEST FERRY 2        ";
  world.service.ingest(raw, world.clock + 1000);
  const named = world.vessel("test-ferry-two");
  assert.equal(named.mmsi, "367000002");
  assert.equal(named.identitySource, "ais-name");
});

// With a database behind it, the tracker's long memory moves out of the JSON logs.
async function remembering(t, options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(os.tmpdir(), "harbor-memory-"));
  if (!options.stateDir) t.after(() => rm(stateDir, { recursive: true, force: true }));
  const db = openHarborDb({ databasePath: path.join(stateDir, "harbor.db") });
  t.after(() => db.close());
  seedRoster(db, roster);
  const store = createHarborStore(db);
  // The same object the harness keeps advancing, so its clock stays the one the feed moves.
  const world = await harness(t, { stateDir, extra: { store } });
  world.store = store;
  return world;
}

test("with a database, a dwell, a sighting and a matched trip are written down as they happen", async (t) => {
  const world = await remembering(t);
  world.feed(arrival);

  const terminals = world.store.listTerminals();
  assert.ok(terminals.some((terminal) => terminal.id === "9002" && terminal.slips.some((slip) => slip.id === "NYCF_9002_NORTH")));
  const [dwell] = world.store.listDwells({ vesselId: "test-ferry-one" });
  assert.equal(dwell.terminalId, "9002");
  assert.equal(dwell.slipId, "NYCF_9002_NORTH");
  assert.equal(dwell.mmsi, "367000001");
  const sighting = world.store.listSightings().find((item) => item.mmsi === "367000001");
  assert.ok(sighting.fixes > 5);
  assert.equal(sighting.name, "TEST FERRY ONE");
  assert.ok(sighting.terminals["9002"] >= 1);

  const [guess] = world.store.listTripObservations({ vesselId: "test-ferry-one" });
  assert.deepEqual({ tripId: guess.tripId, serviceDate: guess.serviceDate, confidence: guess.confidence, source: guess.source, terminalId: guess.terminalId },
    { tripId: "T1", serviceDate: "20261111", confidence: 0.5, source: "schedule", terminalId: "9002" });
  assert.ok(guess.runId);

  // The public row says which run the boat is on, and what the run does next.
  const away = world.vessel("test-ferry-one");
  assert.equal(away.operatorName, "NYC Ferry");
  assert.deepEqual({ tripId: away.assignment.tripId, runId: away.assignment.runId, source: away.assignment.source },
    { tripId: "T1", runId: guess.runId, source: "schedule" });

  // Reaching the next call confirms the trip, and the confirmation replaces the guess in the record.
  const at = world.clock + 10 * 60_000;
  world.feed([0, 40, 80].map((seconds) => position("367000001", { latitude: 40.500063, longitude: -74 }, at + seconds * 1000, { sog: 0.1 })));
  const observations = world.store.listTripObservations({ vesselId: "test-ferry-one" });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].confidence, 0.9);
  assert.equal(observations[0].arrivedTerminalId, "9001");

  await world.service.stop();
  await assert.rejects(readFile(path.join(world.stateDir, "harbor-dwells.json")));
  await assert.rejects(readFile(path.join(world.stateDir, "harbor-discovery.json")));
});

test("with a database, a learned link is recorded and a second claimant to the name becomes a conflict to review", async (t) => {
  const world = await remembering(t);
  const here = { latitude: 40.6, longitude: -74.05 };
  world.feed([staticData("367000002", "TEST FERRY 2@@@", 60), position("367000002", here, world.clock + 1000)]);
  assert.deepEqual(world.store.listAisLinks({ vesselId: "test-ferry-two" }).map(({ mmsi, source }) => ({ mmsi, source })),
    [{ mmsi: "367000002", source: "ais-name" }]);

  world.feed([staticData("367000022", "TEST FERRY 2", 60), position("367000022", here, world.clock + 1000)]);
  const conflicts = world.store.listConflicts();
  assert.equal(conflicts.length, 1);
  assert.deepEqual({ kind: conflicts[0].kind, mmsi: conflicts[0].mmsi, vesselId: conflicts[0].vesselId, heldBy: conflicts[0].detail.heldBy },
    { kind: "name-collision", mmsi: "367000022", vesselId: "test-ferry-two", heldBy: "367000002" });
  // Hearing it again does not file it again.
  world.feed([position("367000022", here, world.clock + 60_000)]);
  assert.equal(world.store.listConflicts().length, 1);
});

test("with a database, a vessel's page gathers identity, track, assignment and history, and the list can be filtered", async (t) => {
  const world = await remembering(t);
  world.feed(arrival);
  const detail = world.service.vesselDetail("test-ferry-one");
  assert.equal(detail.vessel.name, "Test Ferry One");
  assert.equal(detail.links[0].mmsi, "367000001");
  assert.equal(detail.track.id, "test-ferry-one");
  assert.equal(detail.assignment.tripId, "T1");
  assert.equal(detail.dwells.length, 1);
  assert.equal(detail.trips.length, 1);
  assert.equal(world.service.vesselDetail("no-such-boat"), null);

  const all = world.service.getCurrent().vessels;
  assert.ok(all.some((vessel) => vessel.operatorId === "tst"));
  assert.ok(world.service.getCurrent({ operatorId: "tst" }).vessels.every((vessel) => vessel.operatorId === "tst"));
  assert.ok(world.service.getCurrent({ state: "underway" }).vessels.every((vessel) => vessel.state === "underway"));
  assert.deepEqual(world.service.operators().operators.map(({ id, vessels }) => ({ id, vessels })), [{ id: "nycf", vessels: 2 }, { id: "tst", vessels: 1 }]);
});

test("with a database, repeated confirmed runs become a pattern that assigns a boat before it has sailed", async (t) => {
  const world = await remembering(t);
  const runs = world.store.listRuns("nycf", "20261111");
  assert.equal(runs.length, 0);
  // Three earlier Wednesdays on which this hull was confirmed on trip T1.
  for (const serviceDate of ["20261021", "20261028", "20261104"]) {
    world.store.recordTripObservation({ trackKey: "367000001", mmsi: "367000001", vesselId: "test-ferry-one", operatorId: "nycf", tripId: "T1",
      routeId: "TR", runId: null, serviceDate, terminalId: "9002", departedAt: 1, arrivedTerminalId: "9001", arrivedAt: 2, confidence: 0.9, source: "schedule" });
  }
  assert.deepEqual(world.service.learn(), { operators: 1, patterns: 1 });
  const idle = world.vessel("test-ferry-one");
  assert.equal(idle.assignment.source, "pattern");
  assert.equal(idle.assignment.tripId, null);
  assert.ok(idle.assignment.confidence > 0 && idle.assignment.confidence <= 0.8);
  assert.equal(idle.routeId, "TR");
});
