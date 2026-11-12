// Failure modes: a schema that drifts from the contract, a reopen that loses or duplicates rows,
// a roster reseed that forgets a retired vessel or overwrites what was learned from AIS, and a
// database written by a newer build being opened by an older one.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HARBOR_TABLES, SCHEMA_VERSION, openHarborDb, seedRoster } from "../lib/harbor-db.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/harbor/", import.meta.url));
const roster = JSON.parse(await readFile(path.join(FIXTURES, "roster.json"), "utf8"));

async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harbor-db-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "harbor.db");
}

test("opening creates every contract table and records the schema version", async (t) => {
  const store = openHarborDb({ databasePath: await temp(t) });
  t.after(() => store.close());
  const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const table of HARBOR_TABLES) assert.ok(tables.includes(table), `missing table ${table}`);
  assert.equal(store.schemaVersion, SCHEMA_VERSION);
  assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("the roster seeds operators, vessels, committed MMSIs and references, and reseeding is idempotent", async (t) => {
  const databasePath = await temp(t);
  const referenced = { ...roster, vessels: roster.vessels.map((vessel) => vessel.id === "test-ferry-one"
    ? { ...vessel, capacity: 150, references: [{ field: "mmsi", value: "367000001", url: "https://example.test/one", retrievedAt: "2026-11-12", note: "invented" }] }
    : vessel) };
  let store = openHarborDb({ databasePath });
  seedRoster(store, referenced);
  seedRoster(store, referenced);
  const count = (table) => store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.equal(count("operators"), 2);
  assert.equal(count("vessels"), 4);
  assert.equal(count("vessel_refs"), 1);
  assert.deepEqual(store.database.prepare("SELECT mmsi, vessel_id, source FROM vessel_ais ORDER BY mmsi").all().map((row) => ({ ...row })), [
    { mmsi: "367000001", vessel_id: "test-ferry-one", source: "roster" },
    { mmsi: "367000003", vessel_id: "tst:partner-queen", source: "roster" },
    { mmsi: "367000009", vessel_id: "test-ferry-retired", source: "roster" }
  ]);
  assert.equal(store.database.prepare("SELECT capacity FROM vessels WHERE id = 'test-ferry-one'").get().capacity, 150);
  assert.equal(store.database.prepare("SELECT active FROM vessels WHERE id = 'test-ferry-retired'").get().active, 0);
  store.close();

  // A learned link survives a reseed, and a vessel dropped from the roster is retired, not deleted.
  store = openHarborDb({ databasePath });
  t.after(() => store.close());
  store.database.prepare("INSERT INTO vessel_ais (mmsi, vessel_id, source, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run("367000002", "test-ferry-two", "ais-name", 0.8, 1, 2);
  seedRoster(store, { ...referenced, vessels: referenced.vessels.filter((vessel) => vessel.id !== "tst:partner-queen") });
  assert.equal(store.database.prepare("SELECT source FROM vessel_ais WHERE mmsi = '367000002'").get().source, "ais-name");
  assert.equal(store.database.prepare("SELECT active FROM vessels WHERE id = 'tst:partner-queen'").get().active, 0);
  assert.equal(count("vessels"), 4);
});

test("a committed MMSI replaces a learned link to another vessel", async (t) => {
  const store = openHarborDb({ databasePath: await temp(t) });
  t.after(() => store.close());
  seedRoster(store, roster);
  store.database.prepare("INSERT INTO vessel_ais (mmsi, vessel_id, source, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run("367000077", "test-ferry-two", "proximity", 0.7, 1, 2);
  seedRoster(store, { ...roster, vessels: roster.vessels.map((vessel) => vessel.id === "test-ferry-retired" ? { ...vessel, mmsi: "367000077" } : vessel) });
  assert.deepEqual({ ...store.database.prepare("SELECT vessel_id, source FROM vessel_ais WHERE mmsi = '367000077'").get() },
    { vessel_id: "test-ferry-retired", source: "roster" });
});

test("a database from a newer schema is refused rather than written over", async (t) => {
  const databasePath = await temp(t);
  const store = openHarborDb({ databasePath });
  store.database.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  store.close();
  assert.throws(() => openHarborDb({ databasePath }), /newer/);
});

test("a read-only open never creates a file and refuses to write", async (t) => {
  const databasePath = await temp(t);
  assert.throws(() => openHarborDb({ databasePath, readOnly: true }));
  await assert.rejects(readFile(databasePath));

  const writer = openHarborDb({ databasePath });
  seedRoster(writer, roster);
  writer.close();
  const reader = openHarborDb({ databasePath, readOnly: true });
  t.after(() => reader.close());
  assert.equal(reader.schemaVersion, SCHEMA_VERSION);
  assert.equal(reader.database.prepare("SELECT COUNT(*) AS n FROM vessels").get().n, 4);
  assert.throws(() => reader.database.prepare("DELETE FROM vessels").run());
  assert.throws(() => reader.transaction(() => {}), /read-only/);
});

// Regressions from the adversarial review of phase 2.

test("a committed MMSI that changes leaves no link behind for the old transponder", async (t) => {
  const store = openHarborDb({ databasePath: await temp(t) });
  t.after(() => store.close());
  seedRoster(store, roster);
  seedRoster(store, { ...roster, vessels: roster.vessels.map((vessel) => vessel.id === "test-ferry-one" ? { ...vessel, mmsi: "367000111" } : vessel) });
  assert.deepEqual(store.database.prepare("SELECT mmsi FROM vessel_ais WHERE vessel_id = 'test-ferry-one'").all().map((row) => row.mmsi), ["367000111"]);
  // A committed MMSI that is removed altogether frees the transponder too.
  seedRoster(store, { ...roster, vessels: roster.vessels.map((vessel) => vessel.id === "test-ferry-one" ? { ...vessel, mmsi: null } : vessel) });
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM vessel_ais WHERE vessel_id = 'test-ferry-one'").get().n, 0);
});

test("a database from a newer schema is refused before anything in it is changed", async (t) => {
  const databasePath = await temp(t);
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(databasePath);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; INSERT INTO meta VALUES ('schema_version', '99');");
  raw.close();
  assert.throws(() => openHarborDb({ databasePath }), /newer/);
  const after = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => after.close());
  assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name), ["meta"]);
});
