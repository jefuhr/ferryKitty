// Failure modes: missing never-seen vessels, duplicate identities, inactive/unrostered leakage,
// incorrect Boat metadata or heading/status/age, stale-source boundaries, private point leakage,
// yard slips in the public catalog, wrong trip/hull/landing matching, confidence/state gating,
// protobuf field loss or input mutation, and incompatibility with the Swift slip reader.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { offsetPoint } from "../lib/harbor-geo.js";
import { parseCsv } from "../lib/schedule-builder.js";
import { describeHarborVessels, encodeSlips, encodeTripUpdates } from "../lib/harbor-api.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const captured = fixture("ferry-rt-slips.json");
const rosterData = fixture("harbor/roster.json");
const stops = fixture("harbor/stops.json").stops;
const now = Date.parse("2026-11-11T15:00:00Z");
const point = offsetPoint(stops[0], 130, 75);
const roster = {
  ...rosterData,
  byId: new Map(rosterData.vessels.map(v => [v.id, v])),
  byMmsi: new Map(rosterData.vessels.filter(v => v.mmsi).map(v => [v.mmsi, { vesselId: v.id, source: "roster", at: null }]))
};
// The encoder consumes an index, not the parser under construction in a different worktree.
const labels = {
  "Slip 1": ["SLIP_1", "1"], "Slip 2": ["SLIP_2", "2"], "Slip B1": ["B1", "B1"],
  North: ["NORTH", "N"], South: ["SOUTH", "S"], East: ["NORTH", "E"], West: ["SOUTH", "W"],
  "DOCK #1": ["DOCK_1", "1"], "Dry Dock": ["DRY_DOCK", "DD"], "SLIP_25": ["SLIP_25", "25"],
  "Slip 27 Fuel Tanks": ["SLIP_27", "27"], "Slip 31 Annex": ["SLIP_31", "31"]
};
const slipsById = new Map();
for (const row of parseCsv(readFileSync(new URL("fixtures/harbor/slips.csv", import.meta.url), "utf8"))) {
  const stop = stops.find(s => s.name === row.landing);
  if (!stop && row.landing !== "Pier C") continue;
  const [token, platformCode] = labels[row.slip];
  const id = `NYCF_${stop?.stopId || "PIERC"}_${token}`;
  const slip = slipsById.get(id) || {
    id, name: row.slip, platformCode, landingStopId: stop?.stopId || "home-port",
    kind: stop ? "passenger" : row.slip === "Dry Dock" ? "drydock" : row.slip.includes("Fuel") ? "fuel" : "yard", points: []
  };
  slip.points.push({ latitude: Number(row.latitude), longitude: Number(row.longitude) });
  slipsById.set(id, slip);
}
const slipIndex = {
  slips: [...slipsById.values()].reverse(), byId: slipsById,
  landings: stops.map((s, i) => ({ ...s, landingStopId: s.stopId, landingId: i + 1,
    slipIds: [...slipsById.values()].filter(slip => slip.landingStopId === s.stopId).map(slip => slip.id) }))
};
const slipId = "NYCF_9001_SLIP_1";
const sources = {
  ais: { state: "open", connected: true, lastMessageAt: now - 1000, reconnects: 2, lastError: "private internal detail" },
  nycFerry: { available: true, stale: false, fetchedAt: new Date(now - 500).toISOString(), extra: "omit" }
};
function track(overrides = {}) {
  return {
    key: "367000001", mmsi: "367000001", vesselId: "test-ferry-one", identitySource: "roster",
    static: { name: "TEST FERRY ONE" },
    fix: { ...point, at: now - 12500, sogKnots: 2.34, headingDegrees: 42.4, cogDegrees: 90, source: "ais" },
    recent: [], state: "docked", stateSince: now - 60000, stale: false, moving: false,
    dock: { landingStopId: "9001", landingId: 1, slipId, confidence: 0.83, ambiguous: false,
      candidates: [{ slipId, p: 0.83, distanceMetres: 3 }], since: now - 60000, points: slipsById.get(slipId).points },
    trip: { tripId: "trip-1", routeId: "ER", serviceDate: "2026-11-11", source: "operator-rt", confidence: 1, nextSequence: 2 },
    ...overrides
  };
}
const routes = new Map([["ER", { id: "ER", shortName: "ER", name: "Test Route", color: "#00839C", mode: "ferry" }]]);
const serviceTrips = {
  timezone: "America/New_York", holidayDates: new Set(), calendars: [],
  exceptions: [{ serviceId: "day", date: "2026-11-11", added: true }],
  trips: new Map([["trip-1", [{ serviceId: "day", routeId: "ER", holiday: false, destination: "Test Point",
    stops: [{ sequence: 2, stopId: "9001", name: "Test Cove", ...point, arrivalSeconds: 36000 }] }]]])
};
const describe = (tracks = [track()], options = {}) => describeHarborVessels({ tracks, roster, slipIndex, routes, serviceTrips, sources, now, ...options });
const decode = bytes => FeedMessage.decode(bytes);
const plain = feed => JSON.parse(JSON.stringify(feed));
const encode = feed => FeedMessage.encode(FeedMessage.fromObject(feed)).finish();
function feedFor(tripId = "trip-1", vehicle = { label: "H901" }) {
  return decode(encode({ header: { gtfsRealtimeVersion: "2.0", timestamp: 100, incrementality: 0 }, entity: [
    { id: "update", tripUpdate: { trip: { tripId, routeId: "ER", startDate: "20261111" }, vehicle,
      timestamp: 101, delay: 10, stopTimeUpdate: [
        { stopSequence: 2, stopId: "9001", arrival: { delay: 3, time: 1794400000 }, departure: { uncertainty: 4 }, stopTimeProperties: { pickupType: 1 } },
        { stopSequence: 3, stopId: "9002", arrival: { delay: 8 }, scheduleRelationship: 1 }
      ] } },
    { id: "deleted", isDeleted: true },
    { id: "vehicle", vehicle: { trip: { tripId: "other" }, position: { ...point, speed: 1.5 } } }
  ] }));
}

// A direct port of Swift's field reader keeps this compatibility check independent of the
// protobuf library used by the encoder. Only the trip id and stop_id wire fields are consumed.
function fields(bytes, visit) {
  let index = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      assert.ok(index < bytes.length);
      const byte = bytes[index++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return Number(value);
    }
    assert.fail("invalid varint");
  };
  while (index < bytes.length) {
    const key = varint();
    switch (key & 7) {
      case 0: varint(); break;
      case 1: index += 8; break;
      case 2: {
        const length = varint();
        assert.ok(index + length <= bytes.length);
        const value = bytes.subarray(index, index + length);
        index += length;
        visit(key >>> 3, value);
        break;
      }
      case 5: index += 4; break;
      default: assert.fail("invalid wire type");
    }
    assert.ok(index <= bytes.length);
  }
}
function swiftSlips(bytes, catalog) {
  const known = new Map(catalog.slips.filter(s => s.landingStopId && s.landingStopId !== s.id).map(s => [s.id, s]));
  const result = {};
  fields(bytes, (field, entity) => {
    if (field !== 2) return;
    fields(entity, (field, update) => {
      if (field !== 3) return;
      let tripId;
      const stopIds = [];
      fields(update, (field, message) => {
        if (field === 1) fields(message, (field, text) => { if (field === 1) tripId = Buffer.from(text).toString("utf8"); });
        else if (field === 2) fields(message, (field, text) => { if (field === 4) stopIds.push(Buffer.from(text).toString("utf8")); });
      });
      if (!tripId) return;
      for (const id of stopIds) {
        const slip = known.get(id);
        if (slip) result[`${tripId}|${slip.landingStopId}`] = slip.name ?? slip.platformCode ?? slip.id;
      }
    });
  });
  return result;
}

test("every active roster vessel appears once, with complete Boat and harbor fields", () => {
  const result = describe(new Map([["mmsi", track()]]));
  assert.deepEqual(result.vessels.map(v => v.id), ["test-ferry-one", "test-ferry-two", "tst:partner-queen"]);
  const vessel = result.vessels[0];
  assert.equal(vessel.name, "Test Ferry One");
  assert.equal(vessel.vesselId, vessel.id);
  assert.equal(vessel.number, "H-901");
  assert.equal(vessel.bearing, 42);
  assert.equal(vessel.speedKnots, 2.3);
  assert.equal(vessel.ageSeconds, 12);
  assert.equal(vessel.reportedAt, new Date(now - 12500).toISOString());
  assert.equal(vessel.latitude, Math.round(point.latitude * 1e5) / 1e5);
  assert.equal(vessel.tripId, "trip-1");
  assert.equal(vessel.routeId, "ER");
  assert.equal(vessel.route, "ER");
  assert.equal(vessel.routeName, "Test Route");
  assert.equal(vessel.color, "#00839C");
  assert.equal(vessel.destination, "Test Point");
  assert.equal(vessel.stop.id, "9001");
  assert.equal(vessel.mode, "ferry");
  assert.deepEqual(vessel.landing, { id: 1, stopId: "9001", name: "Test Cove" });
  assert.deepEqual(vessel.slip, { id: slipId, name: "Slip 1", confidence: 0.83 });
  assert.deepEqual(vessel.slipCandidates, [{ id: slipId, name: "Slip 1", p: 0.83 }]);
  assert.equal(vessel.slipAmbiguous, false);
  assert.equal(vessel.positionSource, "ais");
  assert.equal(vessel.identitySource, "roster");
  assert.equal(vessel.tripSource, "operator-rt");
  assert.equal(vessel.tripConfidence, 1);
  const unseen = result.vessels[1];
  assert.equal(unseen.state, "unknown");
  assert.equal(unseen.rostered, true);
  for (const key of ["latitude", "longitude", "bearing", "speedKnots", "ageSeconds", "reportedAt", "tripId", "routeId", "route", "routeName", "color", "status", "stop", "destination", "positionSource", "identitySource", "landing", "slip", "tripSource", "tripConfidence"]) {
    assert.equal(unseen[key], null, key);
  }
  assert.deepEqual(unseen.slipCandidates, []);
});

test("metadata follows service-aware trip resolution, not a track's unverified route id", () => {
  const vessel = describe([track()], { serviceTrips: { ...serviceTrips, exceptions: [] } }).vessels[0];
  assert.equal(vessel.tripId, "trip-1");
  for (const key of ["routeId", "route", "routeName", "color", "destination", "stop"]) assert.equal(vessel[key], null);
});

test("unrostered vessels are opt-in and inactive vessels need a live track", () => {
  const retired = track({ vesselId: "test-ferry-retired", key: "367000009", mmsi: "367000009", stale: true });
  const unknown = track({ vesselId: null, key: "367999999", mmsi: "367999999", static: { name: "AIS NAME" }, trip: null, dock: null });
  assert.equal(describe([retired, unknown]).vessels.length, 4);
  const result = describe([retired, unknown], { includeUnrostered: true });
  const vessel = result.vessels.find(v => v.id === "mmsi:367999999");
  assert.equal(vessel.name, "AIS NAME");
  assert.equal(vessel.rostered, false);
  assert.equal(vessel.vesselId, null);
  assert.equal(describe([ { ...retired, state: "unknown" } ]).vessels.length, 3);
  assert.equal(describe([ { ...retired, fix: null } ]).vessels.length, 3);
  const byMmsi = describe([track({ vesselId: null })]).vessels;
  assert.equal(byMmsi.length, 3);
  assert.equal(byMmsi[0].mmsi, "367000001");
});

test("state/status and heading/course thresholds preserve nulls and pass source confidence through", () => {
  for (const [state, status] of Object.entries({ docked: "stopped", "laid-up": "stopped", arriving: "incoming", departing: "in-transit", underway: "in-transit", unknown: null })) {
    const t = track({ state, identitySource: "proximity", fix: { ...track().fix, source: "operator", headingDegrees: null, sogKnots: 1, cogDegrees: 99 } });
    const vessel = describe([t]).vessels[0];
    assert.equal(vessel.status, status);
    assert.equal(vessel.bearing, null);
    assert.equal(vessel.positionSource, "operator");
    assert.equal(vessel.identitySource, "proximity");
  }
  assert.equal(describe([track({ fix: { ...track().fix, headingDegrees: null } })]).vessels[0].bearing, 90);
  assert.equal(describe([track({ fix: { ...track().fix, headingDegrees: 0 } })]).vessels[0].bearing, 0);
  assert.equal(describe([track({ fix: { ...track().fix, at: now + 5000 } })]).vessels[0].ageSeconds, 0);
  const ambiguous = describe([track({ dock: { ...track().dock, slipId: null, ambiguous: true } })]).vessels[0];
  assert.equal(ambiguous.slip, null);
  assert.equal(ambiguous.slipAmbiguous, true);
  assert.equal(ambiguous.slipCandidates.length, 1);
});

test("the envelope whitelists public source fields and becomes stale at 120 seconds or when not open", () => {
  const result = describe();
  assert.deepEqual({ ...result, vessels: [] }, { available: true, stale: false, fetchedAt: new Date(now).toISOString(), error: null,
    sources: { ais: { state: "open", connected: true, lastMessageAt: now - 1000, reconnects: 2 },
      nycFerry: { available: true, stale: false, fetchedAt: sources.nycFerry.fetchedAt } }, vessels: [] });
  for (const ais of [{ ...sources.ais, lastMessageAt: now - 120000 }, { ...sources.ais, state: "waiting" }, { ...sources.ais, lastMessageAt: null }]) {
    assert.equal(describe([], { sources: { ...sources, ais } }).stale, true);
  }
  assert.equal(describe([], { sources: { ...sources, ais: { ...sources.ais, lastMessageAt: now - 119999 } } }).stale, false);
});

test("the catalog has exactly the Ferry RT fields, sorted and passenger-only by default", () => {
  const result = encodeSlips(slipIndex);
  assert.equal(result.slips.length, 8);
  assert.deepEqual(result.slips[0], { id: "NYCF_9001_B1", name: "Slip B1", platformCode: "B1", landingStopId: "9001" });
  assert.deepEqual(result.slips.map(s => `${s.landingStopId}|${s.id}`), result.slips.map(s => `${s.landingStopId}|${s.id}`).sort());
  assert.equal(encodeSlips(slipIndex, { includeYard: true }).slips.length, 12);
});

test("the captured feed decodes slip ids in both fields and round trips unchanged without tracks", () => {
  const bytes = Buffer.from(captured.feed, "base64");
  const feed = decode(bytes);
  const call = feed.entity.find(e => e.tripUpdate?.trip.tripId === "759").tripUpdate.stopTimeUpdate[0];
  assert.equal(call.stopId, "NYCF_138_SLIP_2");
  assert.equal(call.stopTimeProperties.assignedStopId, call.stopId);
  assert.deepEqual(swiftSlips(bytes, captured.slips), captured.expected);
  const encoded = encodeTripUpdates({ feed, tracks: [], roster, slipIndex, now });
  assert.ok(encoded instanceof Uint8Array);
  assert.deepEqual(plain(decode(encoded)), plain(feed));
  assert.deepEqual(swiftSlips(encoded, captured.slips), captured.expected);
});

test("only the vessel's present landing call changes, retaining all other protobuf fields and inputs", () => {
  const feed = feedFor();
  const t = track();
  const before = plain(feed);
  const trackBefore = structuredClone(t);
  const bytes = encodeTripUpdates({ feed, tracks: [t], roster, slipIndex, now });
  const expected = structuredClone(before);
  expected.entity[0].tripUpdate.stopTimeUpdate[0].stopId = slipId;
  expected.entity[0].tripUpdate.stopTimeUpdate[0].stopTimeProperties.assignedStopId = slipId;
  assert.deepEqual(plain(decode(bytes)), expected);
  assert.deepEqual(plain(feed), before);
  assert.deepEqual(t, trackBefore);
  assert.deepEqual(swiftSlips(bytes, encodeSlips(slipIndex)), { "trip-1|9001": "Slip 1" });
});

test("descriptor matching uses normalized roster hull numbers and does not override a different bound trip", () => {
  for (const label of ["H901", "HB0901", "H-901"]) {
    const bytes = encodeTripUpdates({ feed: feedFor("other", { label }), tracks: new Map([["one", track({ trip: null })]]), roster, fleet: [], slipIndex, now });
    assert.equal(decode(bytes).entity[0].tripUpdate.stopTimeUpdate[0].stopId, slipId);
  }
  const feed = feedFor("other");
  const bytes = encodeTripUpdates({ feed, tracks: [track()], roster, slipIndex, now });
  assert.deepEqual(plain(decode(bytes)), plain(feed));
});

test("state, confidence, slip identity and landing gate replacement", () => {
  const feed = feedFor();
  for (const t of [
    track({ state: "underway" }), track({ state: "departing" }), track({ state: "laid-up" }), track({ state: "unknown" }),
    track({ dock: null }), track({ dock: { ...track().dock, confidence: 0.7999 } }),
    track({ dock: { ...track().dock, slipId: null, ambiguous: true } }),
    track({ dock: { ...track().dock, slipId: "missing" } }),
    track({ dock: { ...track().dock, landingStopId: "9002" } })
  ]) assert.deepEqual(plain(decode(encodeTripUpdates({ feed, tracks: [t], roster, slipIndex, now }))), plain(feed));
  for (const state of ["docked", "arriving"]) {
    const t = track({ state, dock: { ...track().dock, confidence: 0.8 } });
    assert.equal(decode(encodeTripUpdates({ feed, tracks: [t], roster, slipIndex, now })).entity[0].tripUpdate.stopTimeUpdate[0].stopId, slipId);
  }
  const t = track({ dock: { ...track().dock, confidence: 0.6 } });
  assert.equal(decode(encodeTripUpdates({ feed, tracks: [t], roster, slipIndex, now, minConfidence: 0.6 })).entity[0].tripUpdate.stopTimeUpdate[0].stopId, slipId);
});

test("no feed produces a valid empty feed with the supplied current timestamp", () => {
  const feed = decode(encodeTripUpdates({ feed: null, tracks: [], roster, slipIndex, now }));
  assert.equal(feed.header.gtfsRealtimeVersion, "2.0");
  assert.equal(Number(feed.header.timestamp), Math.floor(now / 1000));
  assert.deepEqual(feed.entity, []);
});

test("vessel projection and catalog encoding do not mutate inputs or duplicate a bound hull", () => {
  const old = track({ fix: { ...track().fix, at: now - 50000, headingDegrees: 10 } });
  const recent = track({ fix: { ...track().fix, headingDegrees: 20, sogKnots: null } });
  const input = [recent, old];
  const before = structuredClone({ input, roster, slipIndex });
  const result = describe(input);
  assert.equal(result.vessels.length, 3);
  assert.equal(result.vessels[0].bearing, 20);
  assert.equal(result.vessels[0].speedKnots, null);
  assert.deepEqual(describe([...input].reverse()), result);
  encodeSlips(slipIndex);
  assert.deepEqual({ input, roster, slipIndex }, before);
});

test("a direct trip binding wins over a conflicting descriptor and creates missing stop-time properties", () => {
  const feed = feedFor("trip-1", { label: "H902" });
  delete feed.entity[0].tripUpdate.stopTimeUpdate[0].stopTimeProperties;
  const bytes = encodeTripUpdates({ feed, tracks: [track()], roster, slipIndex, now });
  const call = decode(bytes).entity[0].tripUpdate.stopTimeUpdate[0];
  assert.equal(call.stopId, slipId);
  assert.equal(call.stopTimeProperties.assignedStopId, slipId);
  const reassigned = encodeTripUpdates({ feed: decode(bytes), tracks: [track({ dock: { ...track().dock, slipId: "NYCF_9001_SLIP_2" } })], roster, slipIndex, now });
  assert.equal(decode(reassigned).entity[0].tripUpdate.stopTimeUpdate[0].stopId, "NYCF_9001_SLIP_2");
});

test("no output leaks any fixture slip or landing point coordinate", () => {
  const outputs = [describe(), encodeSlips(slipIndex, { includeYard: true }),
    plain(decode(encodeTripUpdates({ feed: feedFor(), tracks: [track()], roster, slipIndex, now })))];
  const forbidden = new Set([...slipIndex.slips.flatMap(s => s.points), ...slipIndex.landings].flatMap(p => [p.latitude, p.longitude]));
  for (const output of outputs) {
    const serialized = JSON.stringify(output);
    for (const coordinate of forbidden) {
      const value = String(coordinate).replaceAll(".", "\\.");
      assert.equal(new RegExp(`[:,\\[]${value}(?=[,}\\]])`).test(serialized), false, "coordinate leaked");
    }
  }
});
