// Failure modes: missing/invalid fixes, speed/time units, missing timestamps, incorrect or
// ambiguous vessel identity, binding metadata versus vessel records, learned MMSIs, operator-only
// tracks, stale trip authority, and input mutation.
// Proximity failures are isolated: sample count, span, separation, speed, distance travelled,
// competing MMSIs, docked samples, existing bindings, duplicate reports, and side-by-side vessels.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { offsetPoint } from "../lib/harbor-geo.js";
import { operatorFix, joinOperatorPositions, proximityBindings } from "../lib/harbor-fusion.js";

const { stops } = JSON.parse(await readFile(new URL("fixtures/harbor/stops.json", import.meta.url), "utf8"));
const rosterFixture = JSON.parse(await readFile(new URL("fixtures/harbor/roster.json", import.meta.url), "utf8"));
const ORIGIN = stops[0];
const NOW = Date.parse("2026-11-11T15:00:00Z");
const MMSI = "367000002";
const OTHER_MMSI = "367000004";
const VESSEL = "test-ferry-two";

function roster() {
  const data = structuredClone(rosterFixture);
  return { ...data, byId: new Map(data.vessels.map(vessel => [vessel.id, { ...vessel, learned: null }])),
    byMmsi: new Map(data.vessels.filter(vessel => vessel.mmsi).map(vessel => [vessel.mmsi,
      { vesselId: vessel.id, source: "roster", at: null }])) };
}

function position(overrides = {}) {
  return { id: "operator-1", tripId: "test-trip", latitude: ORIGIN.latitude, longitude: ORIGIN.longitude,
    bearing: 90, speed: 10 * 1852 / 3600, status: "in-transit", stopSequence: 30,
    boatName: "Test Ferry One", vesselNumber: "H-901", updatedAtEpochSeconds: (NOW - 30_000) / 1000,
    ...overrides };
}

function samples({ count = 5, span = 180_000, distance = 600, vesselId = VESSEL, mmsi = MMSI } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const at = NOW - span + span * index / (count - 1);
    const point = offsetPoint(ORIGIN, 90, distance * index / (count - 1));
    return { at, vesselId, operator: { ...point, at },
      candidates: [{ mmsi, ...point, sogKnots: 5, docked: false }] };
  });
}

const bindings = (observations, overrides = {}) => proximityBindings({ samples: observations, now: NOW, ...overrides });
const expectedBinding = { mmsi: MMSI, vesselId: VESSEL, source: "proximity", at: NOW };

test("operator fixes convert metres per second and epoch seconds without inventing AIS fields", () => {
  const raw = position();
  const original = structuredClone(raw);
  const fix = operatorFix(raw);
  assert.ok(Math.abs(fix.sogKnots - 10) < 1e-10);
  assert.deepEqual({ ...fix, sogKnots: 10 }, {
    mmsi: null, latitude: ORIGIN.latitude, longitude: ORIGIN.longitude, sogKnots: 10,
    cogDegrees: 90, headingDegrees: null, navStatus: null, at: NOW - 30_000,
    source: "operator", aisClass: null
  });
  assert.deepEqual(raw, original);
});

test("operator fixes reject absent or unusable coordinates", () => {
  for (const overrides of [
    { latitude: null }, { longitude: undefined }, { latitude: NaN }, { longitude: Infinity },
    { latitude: 91 }, { longitude: 181 }
  ]) assert.equal(operatorFix(position(overrides)), null);
  assert.equal(operatorFix(null), null);
});

test("operator fixes keep unavailable speed and course null", () => {
  const unavailable = operatorFix(position({ speed: null, bearing: null }));
  assert.equal(unavailable.sogKnots, null);
  assert.equal(unavailable.cogDegrees, null);
  const invalid = operatorFix(position({ speed: -1, bearing: 360 }));
  assert.equal(invalid.sogKnots, null);
  assert.equal(invalid.cogDegrees, null);
  assert.equal(operatorFix(position({ speed: 0, bearing: 0 })).sogKnots, 0);
  assert.equal(operatorFix(position({ speed: 0, bearing: 0 })).cogDegrees, 0);
});

test("operator fixes use a supplied fallback only when the report has no timestamp", () => {
  const missing = position({ updatedAtEpochSeconds: null });
  assert.equal(operatorFix(missing), null);
  assert.equal(operatorFix(missing, { fallbackAt: NOW }).at, NOW);
  assert.equal(operatorFix(position(), { fallbackAt: NOW }).at, NOW - 30_000);
  assert.equal(operatorFix(position({ updatedAtEpochSeconds: 0 })).at, 0);
});

test("operator positions join the track of the same rostered vessel", () => {
  const tracks = new Map([
    ["367000001", { key: "367000001", mmsi: "367000001", vesselId: "test-ferry-one" }],
    [MMSI, { key: MMSI, mmsi: MMSI, vesselId: VESSEL }]
  ]);
  const raw = position({ boatName: "TEST FERRY ONE", vesselNumber: "H901" });
  assert.deepEqual(joinOperatorPositions({ tracks, positions: [raw], roster: roster(), now: NOW }), [{
    key: "367000001", vesselId: "test-ferry-one", tripId: "test-trip", stopSequence: 30,
    position: raw, ageSeconds: 30, authoritative: true
  }]);
});

test("rostered MMSIs join even before a track has its vesselId populated", () => {
  const tracks = [{ key: "367000001", mmsi: "367000001", vesselId: null }];
  const [joined] = joinOperatorPositions({ tracks, positions: [position()], roster: roster(), now: NOW });
  assert.equal(joined.key, "367000001");
  assert.equal(joined.vesselId, "test-ferry-one");
});

test("a learned MMSI joins through binding metadata and the effective vessel directory", () => {
  const data = roster();
  const learned = { vesselId: VESSEL, source: "proximity", at: NOW - 600_000 };
  data.byMmsi.set(MMSI, learned);
  data.byId.set(VESSEL, { ...data.byId.get(VESSEL), mmsi: MMSI, learned: { mmsi: MMSI, ...learned } });
  const tracks = new Map([[MMSI, { key: MMSI, mmsi: MMSI, vesselId: null }]]);
  const raw = position({ boatName: "Test Ferry Two", vesselNumber: "H-902" });
  const original = structuredClone({ tracks, roster: data });
  const [joined] = joinOperatorPositions({ tracks, positions: [raw], roster: data, now: NOW });
  assert.equal(joined.key, MMSI);
  assert.equal(joined.vesselId, VESSEL);
  assert.deepEqual({ tracks, roster: data }, original);
});

test("a rostered vessel without an AIS track still yields an operator-only key", () => {
  const raw = position({ boatName: "Test Ferry Two", vesselNumber: "H-902" });
  const [joined] = joinOperatorPositions({ tracks: [], positions: [raw], roster: roster(), now: NOW });
  assert.equal(joined.key, `vessel:${VESSEL}`);
  assert.equal(joined.vesselId, VESSEL);
  assert.equal(joined.position, raw);
});

test("an AIS track takes precedence when an operator-only track also exists", () => {
  const tracks = [
    { key: "vessel:test-ferry-one", vesselId: "test-ferry-one", mmsi: null },
    { key: "367000001", vesselId: "test-ferry-one", mmsi: "367000001" }
  ];
  assert.equal(joinOperatorPositions({ tracks, positions: [position()], roster: roster(), now: NOW })[0].key, "367000001");
});

test("unknown, substring-only, conflicting, and other-operator identities are not joined", () => {
  const data = roster();
  const positions = [
    position({ boatName: "Unknown Ferry", vesselNumber: null }),
    position({ boatName: "Test Ferry One Extra", vesselNumber: null }),
    position({ boatName: "Test Ferry Two", vesselNumber: "H-901" }),
    position({ boatName: "Partner Queen", vesselNumber: null })
  ];
  assert.deepEqual(joinOperatorPositions({ tracks: [], positions, roster: data, now: NOW }), []);
});

test("ambiguous exact roster identities are not joined", () => {
  const data = roster();
  const duplicate = { ...data.byId.get("test-ferry-one"), id: "duplicate-name", number: "H-999", mmsi: null };
  data.vessels.push(duplicate);
  data.byId.set(duplicate.id, duplicate);
  assert.deepEqual(joinOperatorPositions({ tracks: [], positions: [position({ vesselNumber: null })], roster: data, now: NOW }), []);
});

for (const [ageSeconds, authoritative] of [[179.999, true], [180, false], [181, false]]) {
  test(`an operator position aged ${ageSeconds} seconds has authoritative=${authoritative}`, () => {
    const raw = position({ updatedAtEpochSeconds: (NOW - ageSeconds * 1000) / 1000 });
    const [joined] = joinOperatorPositions({ tracks: [], positions: [raw], roster: roster(), now: NOW });
    assert.ok(Math.abs(joined.ageSeconds - ageSeconds) < 1e-6);
    assert.equal(joined.authoritative, authoritative);
    assert.equal(joined.tripId, authoritative ? raw.tripId : null);
    assert.equal(joined.stopSequence, authoritative ? raw.stopSequence : null);
    assert.equal(joined.position.tripId, raw.tripId);
  });
}

test("an untimed operator position joins without granting trip authority", () => {
  const raw = position({ updatedAtEpochSeconds: null });
  const [joined] = joinOperatorPositions({ tracks: [], positions: [raw], roster: roster(), now: NOW });
  assert.equal(joined.ageSeconds, null);
  assert.equal(joined.authoritative, false);
  assert.equal(joined.tripId, null);
  assert.equal(joined.stopSequence, null);
});

test("operator joins preserve their tracks, positions, and roster", () => {
  const input = { tracks: new Map([["367000001", { key: "367000001", mmsi: "367000001", vesselId: "test-ferry-one" }]]),
    positions: [position()], roster: roster(), now: NOW };
  const original = structuredClone(input);
  joinOperatorPositions(input);
  assert.deepEqual(input, original);
});

test("five close moving samples across three minutes propose a binding", () => {
  assert.deepEqual(bindings(samples()), [expectedBinding]);
});

test("the 75 metre and 500 metre proximity boundaries are included", () => {
  const observations = samples({ distance: 500 });
  for (const sample of observations) sample.operator = { ...offsetPoint(sample.candidates[0], 0, 75), at: sample.operator.at };
  assert.deepEqual(bindings(observations), [expectedBinding]);
});

test("too few samples alone suppresses proximity binding", () => {
  assert.deepEqual(bindings(samples({ count: 4 })), []);
});

test("too short a span alone suppresses proximity binding", () => {
  assert.deepEqual(bindings(samples({ span: 179_999 })), []);
});

test("one sample beyond 75 metres alone suppresses proximity binding", () => {
  const observations = samples();
  Object.assign(observations[2].candidates[0], offsetPoint(observations[2].operator, 0, 76));
  assert.deepEqual(bindings(observations), []);
});

test("one sample below five knots alone suppresses proximity binding", () => {
  const observations = samples();
  observations[2].candidates[0].sogKnots = 4.99;
  assert.deepEqual(bindings(observations), []);
});

test("too little ground covered alone suppresses proximity binding", () => {
  assert.deepEqual(bindings(samples({ distance: 499 })), []);
});

test("another unbound MMSI within 150 metres in one sample alone suppresses binding", () => {
  const observations = samples();
  observations[2].candidates.push({ mmsi: OTHER_MMSI, ...offsetPoint(observations[2].operator, 0, 149), sogKnots: 5, docked: false });
  assert.deepEqual(bindings(observations), []);
});

test("one docked sample alone suppresses proximity binding", () => {
  const observations = samples();
  observations[2].candidates[0].docked = true;
  assert.deepEqual(bindings(observations), []);
});

test("a distant or already-bound neighbor does not count as a competing unbound MMSI", () => {
  const observations = samples();
  for (const sample of observations) sample.candidates.push({
    mmsi: OTHER_MMSI, ...offsetPoint(sample.operator, 0, 151), sogKnots: 5, docked: false
  });
  assert.deepEqual(bindings(observations), [expectedBinding]);
  for (const sample of observations) Object.assign(sample.candidates[1], offsetPoint(sample.operator, 0, 50));
  assert.deepEqual(bindings(observations), []);
  assert.deepEqual(bindings(observations, { boundMmsis: new Set([OTHER_MMSI]) }), [expectedBinding]);
});

test("two vessels running side by side never bind", () => {
  const first = samples();
  const second = samples({ vesselId: "test-ferry-one", mmsi: OTHER_MMSI });
  for (let index = 0; index < first.length; index += 1) {
    const alongside = offsetPoint(first[index].operator, 0, 60);
    Object.assign(second[index].operator, alongside);
    Object.assign(second[index].candidates[0], alongside);
    first[index].candidates.push({ ...second[index].candidates[0] });
    second[index].candidates.push({ ...first[index].candidates[0] });
  }
  assert.deepEqual(bindings([...first, ...second]), []);
});

test("a single MMSI that fits two nearby operator vessels is not assigned twice", () => {
  const observations = samples();
  const second = observations.map(sample => ({ ...structuredClone(sample), vesselId: "test-ferry-one" }));
  assert.deepEqual(bindings([...observations, ...second]), []);
});

test("an already-bound MMSI is never proposed", () => {
  assert.deepEqual(bindings(samples(), { boundMmsis: new Set([MMSI]) }), []);
});

test("an already-bound vessel is never proposed", () => {
  assert.deepEqual(bindings(samples(), { boundVesselIds: new Set([VESSEL]) }), []);
});

test("polling one cached position repeatedly cannot manufacture five independent samples", () => {
  const observations = samples();
  for (const sample of observations) sample.operator.at = NOW - 180_000;
  assert.deepEqual(bindings(observations), []);
});

test("proximity evidence can arrive out of order and the input is preserved", () => {
  const observations = samples().reverse();
  const original = structuredClone(observations);
  assert.deepEqual(bindings(observations), [expectedBinding]);
  assert.deepEqual(observations, original);
});
