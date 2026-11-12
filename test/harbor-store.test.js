// Failure modes: replayed writes duplicate history, late fixes erase known static data or
// timestamps, learned identities displace roster links, JSON/booleans leak SQL encoding,
// replacement writes partially commit, caller strings become SQL, unbounded lists grow,
// legacy files corrupt startup or import twice, and persisted history disappears on reopen.
// LLM batches must retain manifests and collection state, while partial run updates must
// preserve omitted fields and replace spend instead of double counting it.
// History cursors must not skip or repeat rows sharing a page-boundary timestamp.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openHarborDb, seedRoster } from "../lib/harbor-db.js";
import { createHarborStore } from "../lib/harbor-store.js";

const hostile = "boat'; DROP TABLE vessels; --";
const dims = { a: 10, b: 20, c: 3, d: 4 };
const roster = {
  operators: [{ id: "op", name: "Test Operator" }, { id: "other", name: "Other" }],
  vessels: [
    { id: "locked", operatorId: "op", name: "Locked", mmsi: "111111111", references: [{ field: "builder", value: "Test", url: "https://example.invalid/reference" }] },
    { id: "free", operatorId: "op", name: "Free", aisNames: [hostile], active: false },
    { id: hostile, operatorId: "other", name: hostile }
  ]
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harbor-store-"));
  const databasePath = path.join(dir, "harbor.sqlite");
  const db = openHarborDb({ databasePath });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  seedRoster(db, roster);
  return { dir, databasePath, db, store: createHarborStore(db) };
}

const dwell = (extra = {}) => ({ trackKey: "222222222", terminalId: "terminal", since: 100, until: 200, ...extra });
const observation = (extra = {}) => ({ trackKey: "222222222", vesselId: "free", operatorId: "op", tripId: "trip", serviceDate: "20261112", confidence: 0.9, source: "schedule", departedAt: 200, ...extra });
const estimate = (extra = {}) => ({ vesselId: "free", operatorId: "op", serviceDate: "20261112", confidence: 0.7, source: "pattern", createdAt: 300, ...extra });
const run = (runId = "run") => ({ runId, signature: "terminal>07:10>route", source: "block", trips: [{ tripId: "trip", departsAt: 100, arrivesAt: 200 }] });
const terminal = (id = "terminal") => ({ id, name: "Terminal", latitude: 1, longitude: 2, stopIds: ["stop"] });
const slip = (id = "slip", terminalId = "terminal") => ({ id, terminalId, name: "Slip 1", kind: "passenger", points: [{ latitude: 1, longitude: 2 }] });

test("sightings merge late fixes, static fields, speed maxima and terminal counts", async (t) => {
  const { store } = await fixture(t);
  store.recordSighting({ mmsi: "222222222", name: hostile, callSign: "WTEST", shipType: 60, dims, aisClass: "A", at: 200, sogKnots: 12, terminalId: "terminal" });
  store.recordSighting({ mmsi: "222222222", name: null, callSign: null, shipType: null, dims: null, at: 100, sogKnots: 2, terminalId: "terminal" });
  store.recordSighting({ mmsi: "222222222", at: 300, sogKnots: null, terminalId: "__proto__" });
  store.recordSighting({ mmsi: "222222222", at: 250 });
  assert.deepEqual(store.listSightings(), [{ mmsi: "222222222", name: hostile, callSign: "WTEST", shipType: 60, dims, aisClass: "A", firstSeen: 100, lastSeen: 300, fixes: 4, maxSogKnots: 12, terminals: { terminal: 2, ["__proto__"]: 1 } }]);
  assert.deepEqual(store.listSightings({ since: 301 }), []);
  store.recordSighting({ mmsi: "333333333", at: 400 });
  const [empty] = store.listSightings();
  assert.equal(empty.dims, null);
  assert.equal(empty.name, null);
  assert.equal(empty.maxSogKnots, null);
  store.recordSighting({ mmsi: "222222222", at: 500, name: "Renamed", callSign: "WNEW", shipType: 61, dims: { a: 2 }, sogKnots: 20, aisClass: "B" });
  const updated = store.listSightings()[0];
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.callSign, "WNEW");
  assert.equal(updated.shipType, 61);
  assert.equal(updated.aisClass, "B");
  assert.equal(updated.maxSogKnots, 20);
  assert.deepEqual(updated.dims, { a: 2 });
});

test("dwell replay updates one row and filters bind hostile ids literally", async (t) => {
  const { store } = await fixture(t);
  store.recordDwell(dwell({ vesselId: hostile, mmsi: "222222222", dims, ambiguous: true }));
  store.recordDwell(dwell({ vesselId: hostile, mmsi: "222222222", dims, ambiguous: false, until: 250 }));
  const [row] = store.listDwells({ vesselId: hostile, mmsi: "222222222", terminalId: "terminal", since: 100 });
  assert.equal(store.listDwells().length, 1);
  assert.equal(row.until, 250);
  assert.equal(row.ambiguous, false);
  assert.deepEqual(row.dims, dims);
  assert.equal(row.slipId, null);
  assert.equal(row.headingDegrees, null);
  assert.deepEqual(store.listDwells({ vesselId: "' OR 1=1 --" }), []);
  assert.deepEqual(store.listDwells({ since: 101 }), []);
});

test("roster links cannot be touched or displaced through either MMSI or hull", async (t) => {
  const { store } = await fixture(t);
  const before = store.listAisLinks();
  assert.equal(store.linkAis({ mmsi: "111111111", vesselId: "free", source: "research", at: 100, name: hostile }), false);
  assert.equal(store.linkAis({ mmsi: "222222222", vesselId: "locked", source: "ais-name", at: 100 }), false);
  assert.equal(store.linkAis({ mmsi: "111111111", vesselId: "locked", source: "roster", at: 100 }), false);
  assert.deepEqual(store.listAisLinks(), before);
});

test("learned AIS links upsert with unique names and earliest/latest times", async (t) => {
  const { store } = await fixture(t);
  assert.equal(store.linkAis({ mmsi: "222222222", vesselId: "free", source: "ais-name", confidence: 0.8, at: 200, name: hostile, callSign: "WTEST" }), true);
  store.linkAis({ mmsi: "222222222", vesselId: "free", source: "research", confidence: 1, at: 100, name: hostile, callSign: "WTEST" });
  store.linkAis({ mmsi: "222222222", vesselId: "free", source: "research", at: 300, name: "New", callSign: "WNEW" });
  store.linkAis({ mmsi: "222222222", vesselId: "free", source: "research", at: 250 });
  const [row] = store.listAisLinks({ vesselId: "free" });
  assert.deepEqual(row.names, [hostile, "New"]);
  assert.deepEqual(row.callSigns, ["WTEST", "WNEW"]);
  assert.equal(row.firstSeen, 100);
  assert.equal(row.lastSeen, 300);
  assert.equal(row.source, "research");
  assert.deepEqual(store.listAisLinks({ vesselId: hostile }), []);
  assert.equal(store.linkAis({ mmsi: "222222222", vesselId: hostile, source: "research", at: 400 }), true);
  assert.deepEqual(store.listAisLinks({ vesselId: "free" }), []);
  assert.deepEqual(store.listAisLinks({ vesselId: hostile })[0].names, [hostile, "New"]);
});

test("conflicts upsert null-safe identities and round-trip details and resolved booleans", async (t) => {
  const { store, db } = await fixture(t);
  for (const pair of [{ mmsi: null, vesselId: "free" }, { mmsi: "222222222", vesselId: null }, { mmsi: null, vesselId: null }, { mmsi: "333333333", vesselId: "free" }]) {
    store.recordConflict({ kind: "name-collision", ...pair, detail: { names: [hostile] }, at: 200 });
    store.recordConflict({ kind: "name-collision", ...pair, detail: { names: ["new"] }, at: 100 });
  }
  const rows = store.listConflicts();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual(row.detail, { names: ["new"] });
    assert.equal(row.firstSeen, 100);
    assert.equal(row.lastSeen, 200);
    assert.equal(row.resolved, false);
  }
  db.database.prepare("UPDATE identity_conflicts SET resolved = 1 WHERE id = ?").run(rows[0].id);
  assert.equal(store.listConflicts({ resolved: true })[0].resolved, true);
  assert.equal(store.listConflicts().length, 3);
});

test("trip observations replay once, filter all dimensions and sort by latest arrival/departure", async (t) => {
  const { store } = await fixture(t);
  store.recordTripObservation(observation());
  store.recordTripObservation(observation({ arrivedAt: 500, arrivedTerminalId: "end" }));
  store.recordTripObservation(observation({ tripId: "later", departedAt: 600 }));
  store.recordTripObservation(observation({ tripId: "tie", departedAt: 600 }));
  assert.deepEqual(store.listTripObservations({ operatorId: "op", serviceDate: "20261112", vesselId: "free" }).map((row) => row.tripId), ["tie", "later", "trip"]);
  assert.equal(store.listTripObservations().at(-1).arrivedTerminalId, "end");
  assert.equal(store.listTripObservations()[0].runId, null);
  assert.deepEqual(store.listTripObservations({ operatorId: hostile }), []);
  assert.deepEqual(store.listTripObservations({ serviceDate: "20261113" }), []);
  assert.deepEqual(store.listTripObservations({ vesselId: hostile }), []);
});

test("run and pattern replacement is scoped and atomic", async (t) => {
  const { store } = await fixture(t);
  store.saveRuns("op", "20261112", [run()]);
  store.saveRuns("other", "20261112", [run("other")]);
  store.saveRuns("op", "20261113", [run("tomorrow")]);
  const before = store.listRuns("op", "20261112");
  assert.deepEqual(before[0].trips, run().trips);
  assert.throws(() => store.saveRuns("op", "20261112", [run("new"), run("new")]));
  assert.deepEqual(store.listRuns("op", "20261112"), before);
  store.saveRuns("op", "20261112", []);
  assert.deepEqual(store.listRuns("op", "20261112"), []);
  assert.equal(store.listRuns("other", "20261112").length, 1);
  assert.equal(store.listRuns("op", "20261113").length, 1);
  const pattern = { vesselId: "free", runSignature: hostile, dayType: "weekday", count: 4, lastSeen: "20261112" };
  store.replacePatterns("op", [pattern]);
  store.replacePatterns("other", [{ ...pattern, vesselId: hostile }]);
  const patterns = store.listPatterns({ operatorId: "op", vesselId: "free" });
  assert.equal(patterns[0].runSignature, hostile);
  assert.throws(() => store.replacePatterns("op", [pattern, pattern]));
  assert.deepEqual(store.listPatterns({ operatorId: "op" }), patterns);
  store.replacePatterns("op", []);
  assert.deepEqual(store.listPatterns({ operatorId: "op" }), []);
  assert.equal(store.listPatterns({ vesselId: hostile }).length, 1);
});

test("estimates upsert by vessel/date/source and decode evidence", async (t) => {
  const { store } = await fixture(t);
  store.saveEstimate(estimate({ evidence: [{ observationId: 1, name: hostile }], reasoning: hostile }));
  store.saveEstimate(estimate({ confidence: 0.8, createdAt: 400, evidence: { nested: [1, 2] } }));
  store.saveEstimate(estimate({ source: "model", createdAt: 500 }));
  const rows = store.listEstimates({ operatorId: "op", serviceDate: "20261112", vesselId: "free" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "model");
  assert.deepEqual(rows[1].evidence, { nested: [1, 2] });
  assert.equal(rows[1].confidence, 0.8);
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].runId, null);
  assert.deepEqual(store.listEstimates({ operatorId: hostile }), []);
  assert.deepEqual(store.listEstimates({ serviceDate: "20261113" }), []);
  assert.deepEqual(store.listEstimates({ vesselId: hostile }), []);
});

test("LLM accounting totals inclusive timestamps with empty totals zero", async (t) => {
  const { store } = await fixture(t);
  assert.equal(store.llmSpendSince(0), 0);
  store.recordLlmRun({ purpose: "day", model: "test", status: "ended", costUsd: 0.25, createdAt: 100 });
  store.recordLlmRun({ purpose: "day", model: "test", status: "ended", inputTokens: 50, outputTokens: 10, cacheReadTokens: 4, costUsd: 0.5, createdAt: 200 });
  assert.equal(store.llmSpendSince(100), 0.75);
  assert.equal(store.llmSpendSince(200), 0.5);
  assert.equal(store.llmSpendSince(201), 0);
});

test("LLM run ids allow partial updates without duplicate spend or erased fields", async (t) => {
  const { store, db } = await fixture(t);
  const id = store.recordLlmRun({ purpose: "day", model: "test", serviceDate: "20261112", status: "submitted", inputTokens: 50, outputTokens: 10, cacheReadTokens: 4, costUsd: 0.25, createdAt: 100 });
  assert.ok(Number.isInteger(id));
  const second = store.recordLlmRun({ purpose: "review", model: "other", status: "ended", costUsd: 0.5, createdAt: 200 });
  assert.notEqual(id, second);
  assert.equal(store.updateLlmRun(id, { status: "ended", batchId: hostile, costUsd: 0.75 }), true);
  assert.equal(store.llmSpendSince(0), 1.25);
  assert.equal(store.updateLlmRun(id, { costUsd: 0.75 }), true);
  assert.equal(store.llmSpendSince(0), 1.25);
  const read = () => ({ ...db.database.prepare("SELECT * FROM llm_runs WHERE id = ?").get(id) });
  assert.deepEqual(read(), { id, purpose: "day", model: "test", service_date: "20261112", batch_id: hostile, status: "ended", input_tokens: 50, output_tokens: 10, cache_read_tokens: 4, cost_usd: 0.75, created_at: 100 });
  assert.equal(store.updateLlmRun(id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, batchId: null, status: undefined }), true);
  const updated = read();
  assert.equal(updated.status, "ended");
  assert.equal(updated.batch_id, null);
  assert.equal(updated.input_tokens, 0);
  assert.equal(updated.output_tokens, 0);
  assert.equal(updated.cache_read_tokens, 0);
  assert.equal(store.llmSpendSince(0), 0.5);
  assert.equal(store.updateLlmRun(id, {}), false);
  assert.equal(store.updateLlmRun(id, { purpose: "unapproved", status: undefined }), false);
  assert.equal(store.updateLlmRun(second + 1, { status: "ended" }), false);
  assert.equal(store.updateLlmRun(hostile, { status: "ended" }), false);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM llm_runs").get().n, 2);
});

test("LLM batch manifests upsert and retain collection markers across reopening", async (t) => {
  const { store, db, databasePath } = await fixture(t);
  assert.equal(store.getLlmBatch("missing"), null);
  assert.doesNotThrow(() => store.markLlmBatchCollected("missing", 50));
  const manifest = { requests: [{ id: hostile, evidence: [1, { confidence: 0.8 }] }], model: "test" };
  store.saveLlmBatch({ batchId: hostile, purpose: "day", manifest, createdAt: 100 });
  assert.deepEqual(store.getLlmBatch(hostile), { batchId: hostile, purpose: "day", manifest, llmRunId: null, createdAt: 100, collectedAt: null });
  assert.equal(store.getLlmBatch("' OR 1=1 --"), null);
  const id = store.recordLlmRun({ purpose: "day", model: "test", status: "submitted", createdAt: 100 });
  store.saveLlmBatch({ batchId: hostile, purpose: "review", manifest: [manifest, null], llmRunId: id, createdAt: 200 });
  store.markLlmBatchCollected(hostile, 300);
  store.saveLlmBatch({ batchId: "other", purpose: "day", manifest: {}, createdAt: 400 });
  store.saveLlmBatch({ batchId: hostile, purpose: "review", manifest, llmRunId: id, createdAt: 200 });
  const expected = { batchId: hostile, purpose: "review", manifest, llmRunId: id, createdAt: 200, collectedAt: 300 };
  assert.deepEqual(store.getLlmBatch(hostile), expected);
  assert.equal(store.getLlmBatch("other").collectedAt, null);
  db.close();
  const reopened = openHarborDb({ databasePath });
  try { assert.deepEqual(createHarborStore(reopened).getLlmBatch(hostile), expected); }
  finally { reopened.close(); }
});

test("all written history survives closing and reopening the database", async (t) => {
  const { store, db, databasePath } = await fixture(t);
  store.recordDwell(dwell({ dims, ambiguous: true }));
  store.recordTripObservation(observation());
  store.saveRuns("op", "20261112", [run()]);
  store.replacePatterns("op", [{ vesselId: "free", runSignature: "run", dayType: "weekday", count: 3, lastSeen: "20261112" }]);
  store.saveEstimate(estimate({ reasoning: hostile, evidence: [{ name: hostile }] }));
  store.recordConflict({ kind: "name-collision", vesselId: "free", detail: { name: hostile }, at: 100 });
  store.linkAis({ mmsi: "222222222", vesselId: "free", name: hostile, source: "ais-name", at: 100 });
  store.recordLlmRun({ purpose: "day", model: "test", status: "ended", costUsd: 0.5, createdAt: 100 });
  store.syncTerminals([terminal()], [slip()]);
  const snapshot = (s) => ({
    dwells: s.listDwells(), trips: s.listTripObservations(), runs: s.listRuns("op", "20261112"),
    patterns: s.listPatterns(), estimates: s.listEstimates(), detail: s.vesselDetail("free"),
    terminals: s.listTerminals(), spend: s.llmSpendSince(0)
  });
  const before = snapshot(store);
  db.close();
  const reopened = openHarborDb({ databasePath });
  try { assert.deepEqual(snapshot(createHarborStore(reopened)), before); }
  finally { reopened.close(); }
});

test("terminal replacement is atomic and returns canonical nested slips", async (t) => {
  const { store } = await fixture(t);
  store.syncTerminals([terminal("z"), terminal()], [slip("z"), slip("a")]);
  const before = store.listTerminals();
  assert.deepEqual(before.map((row) => row.id), ["terminal", "z"]);
  assert.deepEqual(before[0], { ...terminal(), town: null, state: null, radiusMetres: 120, landingId: null, slips: [
    { ...slip("a"), platformCode: null }, { ...slip("z"), platformCode: null }
  ] });
  assert.throws(() => store.syncTerminals([terminal("replacement")], [slip("bad", "missing")]));
  assert.deepEqual(store.listTerminals(), before);
  store.syncTerminals([], []);
  assert.deepEqual(store.listTerminals(), []);
});

test("roster detail decodes vessels and includes only related links, references and conflicts", async (t) => {
  const { store } = await fixture(t);
  assert.equal(store.vesselDetail("missing"), null);
  assert.equal(store.listOperators()[0].feedPrefix, "");
  assert.equal(store.listOperators()[0].website, null);
  assert.equal(store.listVessels({ operatorId: "op" }).length, 2);
  assert.equal(store.listVessels({ operatorId: "other" })[0].name, hostile);
  const free = store.listVessels().find((row) => row.id === "free");
  assert.equal(free.active, false);
  assert.deepEqual(free.aisNames, [hostile]);
  assert.equal(free.capacity, null);
  store.recordConflict({ kind: "operator-mismatch", vesselId: "locked", at: 100 });
  store.recordConflict({ kind: "operator-mismatch", vesselId: "free", at: 100 });
  const detail = store.vesselDetail("locked");
  assert.deepEqual(Object.keys(detail).sort(), ["conflicts", "links", "references", "vessel"]);
  assert.equal(detail.vessel.id, "locked");
  assert.equal(detail.vessel.active, true);
  assert.equal(detail.links.length, 1);
  assert.equal(detail.references[0].field, "builder");
  assert.equal(detail.conflicts.length, 1);
  assert.equal(store.vesselDetail(hostile).vessel.name, hostile);
});

test("history lists sort descending, default to 200 and cap limits at 1000", async (t) => {
  const { store, db } = await fixture(t);
  db.transaction(() => {
    for (let i = 0; i < 1005; i += 1) {
      store.recordSighting({ mmsi: String(i), at: i });
      store.recordDwell(dwell({ trackKey: String(i), since: i, until: i + 1 }));
      store.recordTripObservation(observation({ tripId: String(i), departedAt: i }));
      store.saveEstimate(estimate({ vesselId: String(i), createdAt: i }));
    }
  });
  for (const name of ["listSightings", "listDwells", "listTripObservations", "listEstimates"]) {
    assert.equal(store[name]().length, 200, name);
    assert.equal(store[name]({ limit: 5000 }).length, 1000, name);
    assert.equal(store[name]({ limit: 2 }).length, 2, name);
    assert.equal(store[name]({ limit: 0 }).length, 0, name);
    assert.equal(store[name]({ limit: hostile }).length, 200, name);
  }
  assert.equal(store.listSightings()[0].lastSeen, 1004);
  assert.equal(store.listDwells()[0].since, 1004);
  assert.equal(store.listTripObservations()[0].departedAt, 1004);
  assert.equal(store.listEstimates()[0].createdAt, 1004);
});

test("sighting cursors page past tied timestamps without skipping or repeating MMSIs", async (t) => {
  const { store, db } = await fixture(t);
  db.transaction(() => {
    for (let i = 0; i < 1007; i++) {
      store.recordSighting({ mmsi: String(367000000 + i), at: i === 0 ? 200 : i === 1006 ? 50 : 100 });
    }
  });
  const first = store.listSightings({ limit: 5000 });
  assert.equal(first.length, 1000);
  const last = first.at(-1);
  const before = { lastSeen: last.lastSeen, mmsi: last.mmsi };
  const second = store.listSightings({ limit: 1000, before });
  assert.equal(second.length, 7);
  assert.deepEqual([...first, ...second].map((row) => row.mmsi), Array.from({ length: 1007 }, (_, i) => String(367000000 + i)));
  assert.equal(store.listSightings({ limit: 1000, before, since: 100 }).length, 6);
  assert.deepEqual(store.listSightings({ before: { lastSeen: 50, mmsi: "367001006" } }), []);
});

test("dwell cursors preserve descending id ties and combine with the existing filters", async (t) => {
  const { store, db } = await fixture(t);
  db.transaction(() => {
    for (let i = 0; i < 1007; i++) {
      store.recordDwell(dwell({ trackKey: `track:${i}`, mmsi: "222222222", vesselId: "free", since: i === 0 ? 50 : i === 1006 ? 200 : 100 }));
    }
    store.recordDwell(dwell({ trackKey: "unrelated", mmsi: "333333333", vesselId: "locked", terminalId: "other", since: 100 }));
  });
  const filters = { mmsi: "222222222", vesselId: "free", terminalId: "terminal" };
  const first = store.listDwells({ ...filters, limit: 5000 });
  assert.equal(first.length, 1000);
  const last = first.at(-1);
  const before = { since: last.since, id: last.id };
  const second = store.listDwells({ ...filters, limit: 1000, before });
  assert.equal(second.length, 7);
  assert.deepEqual([...first, ...second].map((row) => row.trackKey), Array.from({ length: 1007 }, (_, i) => `track:${1006 - i}`));
  assert.equal(store.listDwells({ ...filters, limit: 1000, before, since: 100 }).length, 6);
  assert.deepEqual(store.listDwells({ ...filters, before: { since: 50, id: second.at(-1).id } }), []);
});

test("legacy import preserves aggregates, maps dwell keys/terminals and runs once across reopen", async (t) => {
  const { store, db, dir, databasePath } = await fixture(t);
  const write = (file, value) => writeFile(path.join(dir, file), JSON.stringify(value));
  await write("harbor-discovery.json", { vessels: [null, {}, { mmsi: "222222222", name: hostile, callSign: "WTEST", shipType: 60, dims, aisClass: "A", firstSeen: 100, lastSeen: 300, fixes: 17, maxSogKnots: 12, landings: ["terminal", "other"] }] });
  await write("harbor-dwells.json", { dwells: [null, {}, { key: "222222222", vesselId: null, landingStopId: "terminal", since: 100, until: 200, dims, ambiguous: true }, { key: "vessel:free", vesselId: "free", landingStopId: "other", since: 200, until: 300 }] });
  await write("harbor-identities.json", { learned: [{ mmsi: "222222222", vesselId: "free", source: "ais-name", at: 100 }, { mmsi: "111111111", vesselId: "free", source: "proximity", at: 200 }, { mmsi: "333333333", vesselId: "missing", source: "ais-name", at: 100 }, null] });
  await store.importLegacy({ stateDir: dir });
  await store.importLegacy({ stateDir: dir });
  const [seen] = store.listSightings();
  assert.equal(seen.fixes, 17);
  assert.equal(seen.firstSeen, 100);
  assert.equal(seen.lastSeen, 300);
  assert.deepEqual(seen.terminals, { terminal: 1, other: 1 });
  assert.deepEqual(seen.dims, dims);
  assert.equal(store.listDwells().length, 2);
  assert.equal(store.listDwells({ terminalId: "terminal" })[0].mmsi, "222222222");
  assert.equal(store.listDwells({ terminalId: "other" })[0].mmsi, null);
  assert.equal(store.listAisLinks({ vesselId: "free" }).length, 1);
  assert.equal(store.listAisLinks({ vesselId: "locked" })[0].source, "roster");
  assert.ok(db.database.prepare("SELECT key FROM meta WHERE key != ?").all("schema_version").length);
  db.close();
  const reopened = openHarborDb({ databasePath });
  try {
    const next = createHarborStore(reopened);
    await next.importLegacy({ stateDir: dir });
    assert.deepEqual(next.listSightings(), [seen]);
    assert.equal(next.listDwells().length, 2);
    assert.equal(next.vesselDetail(hostile).vessel.name, hostile);
  } finally { reopened.close(); }
});

test("missing, malformed JSON and wrong-shaped legacy files never throw", async (t) => {
  for (const content of [null, "{broken", "[]", '{"vessels":{},"dwells":42,"learned":false}', JSON.stringify({
    vessels: [{ mmsi: "222222222", firstSeen: 100, lastSeen: 200, fixes: 1, name: {} }],
    dwells: [{ key: "222222222", landingStopId: "terminal", since: 100, until: 200, vesselId: [] }],
    learned: [{ mmsi: "222222222", vesselId: "free", source: "ais-name", at: 100, name: [] }]
  })]) {
    const { store, dir } = await fixture(t);
    if (content !== null) {
      for (const file of ["harbor-discovery.json", "harbor-dwells.json", "harbor-identities.json"]) await writeFile(path.join(dir, file), content);
    }
    await assert.doesNotReject(() => store.importLegacy({ stateDir: dir }));
    assert.deepEqual(store.listSightings(), []);
    assert.deepEqual(store.listDwells(), []);
  }
});

test("concurrent legacy imports share the durable once-only guard", async (t) => {
  const { store, db, dir } = await fixture(t);
  await writeFile(path.join(dir, "harbor-discovery.json"), JSON.stringify({ vessels: [{ mmsi: "222222222", firstSeen: 100, lastSeen: 200, fixes: 7, landings: ["terminal"] }] }));
  const second = createHarborStore(db);
  await Promise.all([store.importLegacy({ stateDir: dir }), second.importLegacy({ stateDir: dir })]);
  assert.equal(store.listSightings()[0].fixes, 7);
});

test("a failed legacy transaction leaves no partial rows or import marker", async (t) => {
  const { db, dir } = await fixture(t);
  await writeFile(path.join(dir, "harbor-discovery.json"), JSON.stringify({ vessels: [{ mmsi: "222222222", firstSeen: 100, lastSeen: 200, fixes: 7 }] }));
  const failing = createHarborStore({ database: db.database, transaction(work) {
    return db.transaction(() => { work(); throw new Error("Interrupted import"); });
  } });
  await assert.rejects(() => failing.importLegacy({ stateDir: dir }), /Interrupted import/);
  assert.deepEqual(failing.listSightings(), []);
  const store = createHarborStore(db);
  await store.importLegacy({ stateDir: dir });
  assert.equal(store.listSightings()[0].fixes, 7);
});

test("multi-row methods use the injected transaction and prepare nothing after construction", async (t) => {
  const { db, dir } = await fixture(t);
  let calls = 0;
  const store = createHarborStore({ database: db.database, transaction(work) { calls += 1; return db.transaction(work); } });
  const original = db.database.prepare;
  db.database.prepare = () => { throw new Error("Statement prepared after construction"); };
  try {
    store.saveRuns("op", "20261112", [run()]);
    store.replacePatterns("op", []);
    store.syncTerminals([terminal()], [slip()]);
    await store.importLegacy({ stateDir: dir });
    store.listTerminals();
    store.vesselDetail("locked");
    const id = store.recordLlmRun({ purpose: "day", model: "test", status: "submitted", createdAt: 100 });
    store.updateLlmRun(id, { status: "ended" });
    store.saveLlmBatch({ batchId: "batch", purpose: "day", manifest: { id }, llmRunId: id, createdAt: 100 });
    store.markLlmBatchCollected("batch", 200);
    assert.equal(store.getLlmBatch("batch").collectedAt, 200);
    assert.equal(calls, 4);
  } finally { db.database.prepare = original; }
});
