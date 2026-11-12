// The harbor's long memory.
//
// The tracker itself is in-memory and restarts from a small JSON snapshot. What it learns over days
// does not fit that shape: which transponder is which hull, where each boat spends its nights, which
// boat worked which run last Tuesday. Those are questions with a "which" and a "when" in them, so
// they live in SQLite, where the next question is a SELECT.
//
// The reviewed fleet list stays in git (content/harbor-roster.json) and seeds this database at
// boot. Everything observed lives only here. node:sqlite is built in, as in lib/stats-store.js.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

// Times are epoch milliseconds (INTEGER). Service dates are "YYYYMMDD" TEXT in the feed's zone.
// Columns ending in _json hold JSON text. Booleans are 0 or 1.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS operators (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    feed_prefix TEXT NOT NULL DEFAULT '',
    website     TEXT,
    realtime    TEXT
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS vessels (
    id          TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators (id),
    name        TEXT NOT NULL,
    number      TEXT,
    class       TEXT,
    capacity    INTEGER,
    builder     TEXT,
    year        INTEGER,
    call_sign   TEXT,
    ais_names_json TEXT NOT NULL DEFAULT '[]',
    active      INTEGER NOT NULL DEFAULT 1
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS vessels_operator ON vessels (operator_id);

  -- One transponder belongs to at most one hull. source is how the link is known:
  -- roster | ais-name | proximity | dwell-pattern | research.
  CREATE TABLE IF NOT EXISTS vessel_ais (
    mmsi        TEXT PRIMARY KEY,
    vessel_id   TEXT NOT NULL REFERENCES vessels (id),
    source      TEXT NOT NULL,
    confidence  REAL NOT NULL DEFAULT 1,
    first_seen  INTEGER,
    last_seen   INTEGER,
    names_json      TEXT NOT NULL DEFAULT '[]',
    call_signs_json TEXT NOT NULL DEFAULT '[]'
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS vessel_ais_vessel ON vessel_ais (vessel_id);

  -- Where each researched fact came from. origin is 'roster' for rows that mirror the committed
  -- roster (replaced on every seed) and 'research' for rows written by the research pipeline.
  CREATE TABLE IF NOT EXISTS vessel_refs (
    id           INTEGER PRIMARY KEY,
    vessel_id    TEXT NOT NULL REFERENCES vessels (id),
    field        TEXT NOT NULL,
    value        TEXT,
    source_url   TEXT,
    retrieved_at TEXT,
    note         TEXT,
    origin       TEXT NOT NULL DEFAULT 'roster'
  );
  CREATE INDEX IF NOT EXISTS vessel_refs_vessel ON vessel_refs (vessel_id);

  -- Two claims that cannot both be true, kept for a person to settle.
  -- kind: name-collision (two transponders, one roster name) | mmsi-collision | operator-mismatch.
  CREATE TABLE IF NOT EXISTS identity_conflicts (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    mmsi        TEXT,
    vessel_id   TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (kind, mmsi, vessel_id)
  );

  CREATE TABLE IF NOT EXISTS terminals (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    town          TEXT,
    state         TEXT,
    latitude      REAL NOT NULL,
    longitude     REAL NOT NULL,
    radius_metres REAL NOT NULL DEFAULT 120,
    landing_id    TEXT,
    stop_ids_json TEXT NOT NULL DEFAULT '[]'
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS slips (
    id            TEXT PRIMARY KEY,
    terminal_id   TEXT NOT NULL REFERENCES terminals (id),
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    platform_code TEXT,
    points_json   TEXT NOT NULL DEFAULT '[]'
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS slips_terminal ON slips (terminal_id);

  -- Every transponder that could be a ferry, rostered or not.
  CREATE TABLE IF NOT EXISTS sightings (
    mmsi          TEXT PRIMARY KEY,
    name          TEXT,
    call_sign     TEXT,
    ship_type     INTEGER,
    dims_json     TEXT,
    ais_class     TEXT,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    fixes         INTEGER NOT NULL DEFAULT 0,
    max_sog_knots REAL,
    terminals_json TEXT NOT NULL DEFAULT '{}'
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS dwells (
    id              INTEGER PRIMARY KEY,
    track_key       TEXT NOT NULL,
    mmsi            TEXT,
    vessel_id       TEXT,
    terminal_id     TEXT NOT NULL,
    slip_id         TEXT,
    confidence      REAL,
    ambiguous       INTEGER NOT NULL DEFAULT 0,
    since           INTEGER NOT NULL,
    until           INTEGER NOT NULL,
    latitude        REAL,
    longitude       REAL,
    heading_degrees REAL,
    dims_json       TEXT,
    UNIQUE (track_key, since)
  );
  CREATE INDEX IF NOT EXISTS dwells_terminal ON dwells (terminal_id, since);
  CREATE INDEX IF NOT EXISTS dwells_mmsi ON dwells (mmsi, since);

  -- One row per boat per scheduled trip per service date.
  -- source: operator-rt | schedule | run | pattern | model.
  CREATE TABLE IF NOT EXISTS trip_observations (
    id                  INTEGER PRIMARY KEY,
    track_key           TEXT NOT NULL,
    mmsi                TEXT,
    vessel_id           TEXT,
    operator_id         TEXT NOT NULL,
    trip_id             TEXT NOT NULL,
    route_id            TEXT,
    run_id              TEXT,
    service_date        TEXT NOT NULL,
    terminal_id         TEXT,
    departed_at         INTEGER,
    arrived_terminal_id TEXT,
    arrived_at          INTEGER,
    confidence          REAL NOT NULL,
    source              TEXT NOT NULL,
    UNIQUE (track_key, trip_id, service_date)
  );
  CREATE INDEX IF NOT EXISTS trip_observations_day ON trip_observations (operator_id, service_date);
  CREATE INDEX IF NOT EXISTS trip_observations_vessel ON trip_observations (vessel_id, service_date);

  -- The chain of trips one boat can work on one service date. signature is the same for the
  -- same run on another date, so patterns can be learned across days.
  -- source: block (the feed's block_id) | synthesized (chained from the timetable).
  CREATE TABLE IF NOT EXISTS runs (
    operator_id  TEXT NOT NULL,
    service_date TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    signature    TEXT NOT NULL,
    source       TEXT NOT NULL,
    trips_json   TEXT NOT NULL,
    PRIMARY KEY (operator_id, service_date, run_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS runs_signature ON runs (operator_id, signature);

  -- How often a hull has worked a run on a kind of day. day_type: weekday | saturday | sunday.
  CREATE TABLE IF NOT EXISTS assignment_patterns (
    vessel_id     TEXT NOT NULL,
    operator_id   TEXT NOT NULL,
    run_signature TEXT NOT NULL,
    day_type      TEXT NOT NULL,
    count         INTEGER NOT NULL,
    last_seen     TEXT NOT NULL,
    PRIMARY KEY (vessel_id, operator_id, run_signature, day_type)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS assignment_estimates (
    id            INTEGER PRIMARY KEY,
    vessel_id     TEXT NOT NULL,
    operator_id   TEXT NOT NULL,
    service_date  TEXT NOT NULL,
    run_id        TEXT,
    run_signature TEXT,
    route_id      TEXT,
    confidence    REAL NOT NULL,
    source        TEXT NOT NULL,
    reasoning     TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    model         TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE (vessel_id, service_date, source)
  );
  CREATE INDEX IF NOT EXISTS assignment_estimates_day ON assignment_estimates (operator_id, service_date);

  CREATE TABLE IF NOT EXISTS llm_runs (
    id                INTEGER PRIMARY KEY,
    purpose           TEXT NOT NULL,
    model             TEXT NOT NULL,
    service_date      TEXT,
    batch_id          TEXT,
    status            TEXT NOT NULL,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_runs_created ON llm_runs (created_at);

  CREATE TABLE IF NOT EXISTS llm_batches (
    batch_id      TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    llm_run_id    INTEGER,
    created_at    INTEGER NOT NULL,
    collected_at  INTEGER
  ) WITHOUT ROWID;
`;

export const HARBOR_TABLES = Object.freeze([
  "meta", "operators", "vessels", "vessel_ais", "vessel_refs", "identity_conflicts", "terminals", "slips",
  "sightings", "dwells", "trip_observations", "runs", "assignment_patterns", "assignment_estimates", "llm_runs", "llm_batches"
]);

export function openHarborDb({ databasePath } = {}) {
  if (!databasePath) throw new Error("A harbor database path is required.");
  const database = new DatabaseSync(databasePath);
  // WAL so the API can read while the tracker writes; a lost last second of observations after a
  // crash is acceptable, a request that waits on fsync is not.
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);

  const stored = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  if (stored !== undefined && Number(stored) > SCHEMA_VERSION) {
    database.close();
    throw new Error(`The harbor database is from a newer schema (${stored}) than this build understands (${SCHEMA_VERSION}).`);
  }
  database.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));

  let closed = false;
  // node:sqlite has no transaction helper, so the statements are bracketed by hand.
  function transaction(work) {
    database.exec("BEGIN");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    database, schemaVersion: SCHEMA_VERSION, transaction,
    close() { if (!closed) { closed = true; database.close(); } }
  };
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const whole = (value) => (Number.isInteger(value) ? value : null);

// The committed roster is the authority on which hulls exist and on any MMSI it states. It never
// deletes: a vessel that leaves the roster is retired, because its history still refers to it.
export function seedRoster(store, roster) {
  const { database } = store;
  const operator = database.prepare(`
    INSERT INTO operators (id, name, feed_prefix, website, realtime) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, feed_prefix = excluded.feed_prefix,
      website = excluded.website, realtime = excluded.realtime`);
  const vessel = database.prepare(`
    INSERT INTO vessels (id, operator_id, name, number, class, capacity, builder, year, call_sign, ais_names_json, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET operator_id = excluded.operator_id, name = excluded.name, number = excluded.number,
      class = excluded.class, capacity = excluded.capacity, builder = excluded.builder, year = excluded.year,
      call_sign = excluded.call_sign, ais_names_json = excluded.ais_names_json, active = excluded.active`);
  const link = database.prepare(`
    INSERT INTO vessel_ais (mmsi, vessel_id, source, confidence) VALUES (?, ?, 'roster', 1)
    ON CONFLICT (mmsi) DO UPDATE SET vessel_id = excluded.vessel_id, source = 'roster', confidence = 1`);
  const clearRefs = database.prepare("DELETE FROM vessel_refs WHERE origin = 'roster'");
  const reference = database.prepare(`
    INSERT INTO vessel_refs (vessel_id, field, value, source_url, retrieved_at, note, origin) VALUES (?, ?, ?, ?, ?, ?, 'roster')`);
  const retire = database.prepare("UPDATE vessels SET active = 0 WHERE id = ?");
  const known = database.prepare("SELECT id FROM vessels");

  store.transaction(() => {
    for (const item of roster.operators ?? []) {
      operator.run(item.id, item.name, item.feedPrefix ?? "", text(item.website), text(item.realtime));
    }
    const listed = new Set();
    clearRefs.run();
    for (const item of roster.vessels ?? []) {
      listed.add(item.id);
      vessel.run(item.id, item.operatorId, item.name, text(item.number), text(item.class), whole(item.capacity),
        text(item.builder), whole(item.year), text(item.callSign), JSON.stringify(item.aisNames ?? []), item.active === false ? 0 : 1);
      if (text(item.mmsi)) link.run(item.mmsi.trim(), item.id);
      for (const ref of item.references ?? []) {
        reference.run(item.id, ref.field, ref.value === undefined || ref.value === null ? null : String(ref.value),
          text(ref.url), text(ref.retrievedAt), text(ref.note));
      }
    }
    for (const row of known.all()) if (!listed.has(row.id)) retire.run(row.id);
  });
}
