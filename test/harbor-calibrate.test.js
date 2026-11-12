// Failure modes: short, fast, unknown-speed or off-berth fixes inventing stops; interleaved
// MMSIs, landing changes and lost-boat gaps merging stops; names being erased by static
// patches; null assignments hiding flips; final counts, landing totals or cautious tie-breaks
// drifting; storage being enabled too early; gap buckets or percentiles being wrong; and
// CLI capture replay leaking coordinates, losing files or changing the default model;
// capture times collapsing against the machine clock; and untimed records polluting replay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { dwellSamples, evaluate, sweep, reportGaps } from "../lib/harbor-calibrate.js";
import { assignSlip, buildSlipIndex, parseSlipCsv, SLIP_MODEL } from "../lib/harbor-slips.js";
import { offsetPoint } from "../lib/harbor-geo.js";
import { parseCsv } from "../lib/schedule-builder.js";

const run = promisify(execFile);
const fixture = (name) => new URL(`./fixtures/harbor/${name}`, import.meta.url);
const { stops } = JSON.parse(readFileSync(fixture("stops.json"), "utf8"));
const slips = parseSlipCsv(readFileSync(fixture("slips.csv"), "utf8"), { stops });
const partner = stops.find((stop) => stop.stopId === "tst:1");
const slipIndex = buildSlipIndex(slips, { stops, landings: [{ ...partner, landingStopId: partner.stopId }] });
const first = slipIndex.byId.get("NYCF_9001_SLIP_1");
const second = slipIndex.byId.get("NYCF_9001_SLIP_2");
const model = { ...SLIP_MODEL, sigmaMetres: 4, ambiguity: { mode: "margin", p: 0.2 } };
const fix = (at, point = first.points[0], sogKnots = 0, mmsi = "367000001", name = "TEST FERRY") => ({
  kind: "fix", name, fix: { ...point, mmsi, at, sogKnots, headingDegrees: null, source: "ais", aisClass: "A" }
});
const sample = (points, landingStopId = "9001") => ({
  mmsi: "367000001", name: "TEST FERRY", landingStopId,
  points: points.map((point, i) => ({ ...point, at: i * 30000 })), since: 0, until: (points.length - 1) * 30000
});
const zero = { dwells: 0, named: 0, namedShare: 0, ambiguous: 0, flips: 0, meanConfidence: 0 };

test("dwell samples retain one complete stop per MMSI and landing with static names", () => {
  const records = [
    { kind: "static", static: { mmsi: "367000001", name: "STATIC NAME", at: 0 } },
    fix(0, first.points[0], 0, "367000001", null),
    fix(1000, partner, 0.5, "367000002", "PARTNER FERRY"),
    { kind: "static", static: { mmsi: "367000001", name: null, at: 2000 } },
    fix(30000, second.points[0], 0.5, "367000001", null),
    fix(31000, offsetPoint(partner, 90, 119), 0, "367000002", null),
    fix(32000, first.points[0], 2),
    fix(40000, stops[1]), fix(70000, stops[1])
  ];
  const before = structuredClone(records);
  const samples = dwellSamples({ records, slipIndex });
  assert.equal(samples.length, 3);
  const cove = samples.find((item) => item.landingStopId === "9001");
  assert.deepEqual({ ...cove, points: undefined }, {
    mmsi: "367000001", name: "STATIC NAME", landingStopId: "9001", points: undefined, since: 0, until: 30000
  });
  assert.deepEqual(cove.points.map((point) => point.at), [0, 30000]);
  assert.equal(samples.find((item) => item.landingStopId === "tst:1").name, "PARTNER FERRY");
  assert.deepEqual(records, before);
});

test("short, fast, unknown-speed and off-berth stops are ignored", () => {
  for (const records of [
    [fix(0)], [fix(0), fix(29999)],
    [fix(0, undefined, 0.51), fix(30000, undefined, 0.51)],
    [fix(0, undefined, null), fix(30000, undefined, null)],
    [fix(0, offsetPoint(first.points[0], 270, 36)), fix(30000, offsetPoint(first.points[0], 270, 36))],
    [fix(0, offsetPoint(partner, 90, 121)), fix(30000, offsetPoint(partner, 90, 121))],
    [fix(0), fix(10000, undefined, 1), fix(30000)]
  ]) assert.deepEqual(dwellSamples({ records, slipIndex }), []);
});

test("landing changes and gaps over 20 minutes split stops, including capture-end stops", () => {
  const records = [fix(0), fix(30000), fix(1230001), fix(1260001), fix(1290001, stops[1]), fix(1320001, stops[1])];
  const samples = dwellSamples({ records, slipIndex });
  assert.deepEqual(samples.map(({ landingStopId, since, until }) => ({ landingStopId, since, until })), [
    { landingStopId: "9001", since: 0, until: 30000 },
    { landingStopId: "9001", since: 1230001, until: 1260001 },
    { landingStopId: "9002", since: 1290001, until: 1320001 }
  ]);
  assert.equal(dwellSamples({ records: [fix(0), fix(1200000)], slipIndex }).length, 1);
});

test("evaluation counts final assignments, per-landing totals and dwells with flips across nulls", () => {
  const unstable = sample([first.points[0], ...Array(12).fill(second.points[0]), ...Array(12).fill(first.points[0])]);
  const midpoint = { latitude: (first.points[0].latitude + second.points[0].latitude) / 2, longitude: first.points[0].longitude };
  const samples = [sample([first.points[0], first.points[0]]), sample([midpoint, midpoint]), unstable, sample([partner, partner], "tst:1")];
  const before = structuredClone(samples);
  const result = evaluate({ samples, slipIndex, model });
  assert.equal(result.dwells, 4);
  assert.equal(result.named, 2);
  assert.equal(result.namedShare, 0.5);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.flips, 1); // Several transitions in one dwell still count only once.
  const expected = samples.map((item) => assignSlip(item.points, slipIndex, { landingStopId: item.landingStopId, model }));
  assert.equal(result.meanConfidence, expected.reduce((sum, item) => sum + item.confidence, 0) / 4);
  assert.deepEqual(result.byLanding["tst:1"], { ...zero, dwells: 1 });
  assert.equal(result.byLanding["9001"].flips, 1);
  assert.equal(result.byLanding["9001"].namedShare, 2 / 3);
  assert.deepEqual(samples, before);
  assert.deepEqual(evaluate({ samples: [], slipIndex, model }), { ...zero, byLanding: {} });
});

test("evaluation enables storage only at the 90-minute prefix", () => {
  const passenger = { ...first, points: [first.points[0]] };
  const yard = { ...second, kind: "yard", points: [offsetPoint(first.points[0], 90, 30)] };
  const index = buildSlipIndex([passenger, yard], { stops });
  const points = Array.from({ length: 20 }, (_, i) => ({
    ...yard.points[0], at: i < 19 ? i * 30000 : 5400000
  }));
  const short = { ...sample(points), points: points.slice(0, -1), until: points.at(-2).at };
  const long = { ...short, points, until: 5400000 };
  assert.equal(evaluate({ samples: [short], slipIndex: index, model }).flips, 0);
  assert.equal(evaluate({ samples: [long], slipIndex: index, model }).flips, 1);
});

test("sweep maximizes named share among zero-flip models and breaks ties toward larger sigma", () => {
  const models = [
    model, { ...model, sigmaMetres: 6 }, { ...model, sigmaMetres: 12, minP: 1 }
  ];
  const samples = [sample([first.points[0], first.points[0]])];
  const result = sweep({ samples, slipIndex, models });
  assert.deepEqual(result.rows, models.map((item) => ({ model: item, ...evaluate({ samples, slipIndex, model: item }) })));
  assert.deepEqual(result.recommended, models[1]);
  assert.deepEqual(sweep({ samples, slipIndex, models: [] }), { rows: [], recommended: null });
  const unstable = [sample([first.points[0], ...Array(12).fill(second.points[0])])];
  assert.equal(sweep({ samples: unstable, slipIndex, models: [model] }).recommended, null);
  assert.deepEqual(sweep({ samples: [], slipIndex, models }).recommended, models[2]);
});

test("gap percentiles interpolate per MMSI using the earlier speed and exclude unknown speeds", () => {
  const records = [
    fix(0, undefined, 2), fix(1000, undefined, 0, "367000002"),
    fix(10000, undefined, 3), fix(11000, undefined, 0, "367000002"),
    fix(30000, undefined, 2), fix(41000, undefined, 1.9, "367000002"),
    fix(60000, undefined, 2), fix(101000, undefined, null, "367000002"),
    fix(100000, undefined, null), fix(200000, undefined, 0),
    fix(200001, undefined, 0, "367000002"), { kind: "error", message: "ignored" }
  ].sort((a, b) => (a.fix?.at ?? Infinity) - (b.fix?.at ?? Infinity));
  assert.deepEqual(reportGaps(records), {
    moving: { count: 4, median: 25, p75: 32.5, p90: 37, p95: 38.5 },
    stopped: { count: 3, median: 30, p75: 45, p90: 54, p95: 57 }
  });
  assert.deepEqual(reportGaps([]), {
    moving: { count: 0, median: null, p75: null, p90: null, p95: null },
    stopped: { count: 0, median: null, p75: null, p90: null, p95: null }
  });
  assert.equal(reportGaps([fix(0), fix(30000)]).stopped.p95, 30);
});

const replayClock = Date.UTC(2026, 0, 1);
const captureStart = replayClock + 86400000;

function wireFix(at) {
  return {
    MessageType: "PositionReport", MetaData: { time_utc: new Date(at).toISOString() },
    Message: { PositionReport: {
      UserID: 367000001, Latitude: first.points[0].latitude, Longitude: first.points[0].longitude, Sog: 0
    } }
  };
}

async function calibrateWithFrozenClock(records) {
  const dir = await mkdtemp(join(tmpdir(), "harbor-calibrate-clock-"));
  try {
    const stop = parseCsv(readFileSync(new URL("../gtfs/stops.txt", import.meta.url), "utf8"))[0];
    const csvPath = join(dir, "slips.csv"), capturePath = join(dir, "capture.ndjson"), clockPath = join(dir, "clock.mjs");
    const point = first.points[0];
    await writeFile(csvPath, `landing,slip,latitude,longitude\n"${stop.stop_name}",Slip 1,${point.latitude},${point.longitude}\n`);
    await writeFile(capturePath, records.map((record) => JSON.stringify(record)).join("\n"));
    await writeFile(clockPath, `Date.now = () => ${replayClock};\n`);
    const script = new URL("../scripts/harbor-calibrate.mjs", import.meta.url).pathname;
    const result = await run(process.execPath, [
      "--import", clockPath, script, "--capture", capturePath, "--slips", csvPath, "--json"
    ], { cwd: dir });
    return JSON.parse(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CLI preserves a future capture's 30-second dwell and gap against an injected clock", async () => {
  const report = await calibrateWithFrozenClock([wireFix(captureStart), wireFix(captureStart + 30000)]);
  assert.equal(report.dwells.length, 1);
  assert.equal(report.dwells[0].since, captureStart);
  assert.equal(report.dwells[0].until, captureStart + 30000);
  assert.equal(report.capture.fixes, 2);
  assert.equal(report.capture.ignored, 0);
  assert.deepEqual(report.gaps.stopped, { count: 1, median: 30, p75: 30, p90: 30, p95: 30 });
});

test("CLI ignores fixes and static records with missing or invalid capture timestamps", async () => {
  const missingFix = wireFix(captureStart), invalidFix = wireFix(captureStart);
  delete missingFix.MetaData.time_utc;
  invalidFix.MetaData.time_utc = "not a timestamp";
  const missingStatic = {
    MessageType: "ShipStaticData", Message: { ShipStaticData: { UserID: 367000001, Name: "UNTIMED FERRY" } }
  };
  const invalidStatic = { ...missingStatic, MetaData: { time_utc: "not a timestamp" } };
  const report = await calibrateWithFrozenClock([missingFix, invalidFix, missingStatic, invalidStatic]);
  assert.equal(report.capture.ignored, 4);
  assert.equal(report.capture.fixes, 0);
  assert.equal(report.capture.invalidLines, 0);
  assert.deepEqual(report.dwells, []);
  assert.equal(report.gaps.stopped.count, 0);
});

test("CLI replays multiple raw captures, prints ids without coordinates, and handles invalid lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-calibrate-"));
  try {
    const stop = parseCsv(readFileSync(new URL("../gtfs/stops.txt", import.meta.url), "utf8"))[0];
    const csvPath = join(dir, "slips.csv"), one = join(dir, "one.ndjson"), two = join(dir, "two.ndjson");
    const point = first.points[0];
    await writeFile(csvPath, `landing,slip,latitude,longitude\n"${stop.stop_name}",Slip 1,${point.latitude},${point.longitude}\n`);
    const raw = (seconds, speed) => JSON.stringify({ MessageType: "PositionReport", MetaData: {
      time_utc: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), ShipName: "TEST FERRY"
    }, Message: { PositionReport: { UserID: 367000001, Latitude: point.latitude, Longitude: point.longitude, Sog: speed } } });
    await writeFile(one, `${raw(0, 0)}\ninvalid\n${JSON.stringify("bad frame")}\n`);
    await writeFile(two, `${raw(30, 0)}\n${raw(60, 2)}\n${raw(101, 2)}\n`);
    const script = new URL("../scripts/harbor-calibrate.mjs", import.meta.url).pathname;
    const args = [script, "--capture", two, "--capture", one, "--slips", csvPath];
    const json = await run(process.execPath, [...args, "--json"], { cwd: dir });
    const report = JSON.parse(json.stdout);
    assert.equal(report.dwells.length, 1);
    assert.equal(report.rows.length, 20);
    assert.equal(report.dwells[0].landingStopId, stop.stop_id);
    assert.equal(report.dwells[0].slipId, `NYCF_${stop.stop_id}_SLIP_1`);
    assert.equal(report.suggestedMovingStaleSeconds, 60);
    assert.equal(report.capture.invalidLines, 1);
    assert.equal(report.capture.ignored, 1);
    assert.equal(report.recommended.sigmaMetres, 12);
    const table = await run(process.execPath, args, { cwd: dir });
    assert.match(table.stdout, /1 dwell/);
    assert.match(table.stdout, /recommended/i);
    assert.match(table.stdout, /median.*p75.*p90.*p95/i);
    assert.ok(table.stdout.includes(`NYCF_${stop.stop_id}_SLIP_1`));
    for (const output of [json.stdout, json.stderr, table.stdout, table.stderr]) {
      assert.ok(!output.includes(String(point.latitude)));
      assert.ok(!output.includes(String(point.longitude)));
      assert.doesNotMatch(output, /latitude|longitude/);
    }
    await assert.rejects(run(process.execPath, [script, "--capture", one, "--nope"]), /Usage/);
    await assert.rejects(run(process.execPath, [script, "--capture", join(dir, "missing.ndjson")]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "Could not calibrate harbor captures; check input files\n");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
