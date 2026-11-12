import { readFile } from "node:fs/promises";
import path from "node:path";

const nullable = (value) => value ?? null;
const json = (value) => value == null ? null : JSON.stringify(value);
const limitOf = (value) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(0, Math.min(1000, Math.trunc(value))) : 200;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const list = (value) => Array.isArray(value) ? value : [];

function validLegacyFields(item, strings, numbers, objects = []) {
  return strings.every((key) => item[key] == null || typeof item[key] === "string")
    && numbers.every((key) => item[key] == null || Number.isFinite(item[key]))
    && objects.every((key) => item[key] == null || isRecord(item[key]));
}

// Column names come only from statements in this module. JSON suffixes describe storage,
// not the objects callers work with, and SQLite's integer booleans stop at this boundary.
function decode(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([column, value]) => {
    const key = column.replace(/_json$/, "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (column.endsWith("_json")) return [key, value === null ? null : JSON.parse(value)];
    if (["active", "ambiguous", "resolved"].includes(column)) return [key, Boolean(value)];
    return [key, value];
  }));
}

async function readLegacy(stateDir, file, key) {
  try {
    const data = JSON.parse(await readFile(path.join(stateDir, file), "utf8"));
    return isRecord(data) ? list(data[key]) : [];
  } catch { return []; }
}

export function createHarborStore(store) {
  const { database } = store;
  const prepare = (sql) => database.prepare(sql);
  // These identifiers are fixed below, never supplied by a caller. All record values,
  // including filters and limits, are bound separately by node:sqlite.
  const insert = (table, columns, conflict = [], updates = columns.filter((column) => !conflict.includes(column))) => prepare(`
    INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
    ${conflict.length ? `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}` : ""}`);
  const rows = (statement, ...args) => statement.all(...args).map(decode);

  const sightingColumns = ["mmsi", "name", "call_sign", "ship_type", "dims_json", "ais_class", "first_seen", "last_seen", "fixes", "max_sog_knots", "terminals_json"];
  const sighting = insert("sightings", sightingColumns, ["mmsi"]);
  const getSighting = prepare("SELECT * FROM sightings WHERE mmsi = ?");
  const sightings = prepare(`SELECT * FROM sightings WHERE (? IS NULL OR last_seen >= ?)
    AND (? IS NULL OR last_seen < ? OR (last_seen = ? AND mmsi > ?))
    ORDER BY last_seen DESC, mmsi LIMIT ?`);
  const dwellColumns = ["track_key", "mmsi", "vessel_id", "terminal_id", "slip_id", "confidence", "ambiguous", "since", "until", "latitude", "longitude", "heading_degrees", "dims_json"];
  const dwell = insert("dwells", dwellColumns, ["track_key", "since"]);
  const dwells = prepare(`SELECT * FROM dwells WHERE (? IS NULL OR vessel_id = ?) AND (? IS NULL OR mmsi = ?)
    AND (? IS NULL OR terminal_id = ?) AND (? IS NULL OR since >= ?)
    AND (? IS NULL OR since < ? OR (since = ? AND id < ?)) ORDER BY since DESC, id DESC LIMIT ?`);

  const getLink = prepare("SELECT * FROM vessel_ais WHERE mmsi = ?");
  const rosterLink = prepare("SELECT mmsi FROM vessel_ais WHERE vessel_id = ? AND source = ? AND mmsi != ? LIMIT 1");
  const link = insert("vessel_ais", ["mmsi", "vessel_id", "source", "confidence", "first_seen", "last_seen", "names_json", "call_signs_json"], ["mmsi"]);
  const links = prepare("SELECT * FROM vessel_ais WHERE (? IS NULL OR vessel_id = ?) ORDER BY mmsi");

  // UNIQUE treats NULL as distinct. A null-safe identity lookup gives conflicts the
  // same upsert semantics whether or not both sides of the claim are known yet.
  const getConflict = prepare("SELECT * FROM identity_conflicts WHERE kind = ? AND mmsi IS ? AND vessel_id IS ?");
  const conflict = insert("identity_conflicts", ["kind", "mmsi", "vessel_id", "detail_json", "first_seen", "last_seen"]);
  const updateConflict = prepare("UPDATE identity_conflicts SET detail_json = ?, first_seen = ?, last_seen = ? WHERE id = ?");
  const conflicts = prepare("SELECT * FROM identity_conflicts WHERE resolved = ? ORDER BY last_seen DESC, id DESC");
  const vesselConflicts = prepare("SELECT * FROM identity_conflicts WHERE vessel_id = ? ORDER BY last_seen DESC, id DESC");

  const observationColumns = ["track_key", "mmsi", "vessel_id", "operator_id", "trip_id", "route_id", "run_id", "service_date", "terminal_id", "departed_at", "arrived_terminal_id", "arrived_at", "confidence", "source"];
  const observation = insert("trip_observations", observationColumns, ["track_key", "trip_id", "service_date"]);
  const observations = prepare(`SELECT * FROM trip_observations WHERE (? IS NULL OR operator_id = ?)
    AND (? IS NULL OR service_date = ?) AND (? IS NULL OR vessel_id = ?)
    ORDER BY COALESCE(arrived_at, departed_at, 0) DESC, id DESC LIMIT ?`);
  const clearRuns = prepare("DELETE FROM runs WHERE operator_id = ? AND service_date = ?");
  const run = insert("runs", ["operator_id", "service_date", "run_id", "signature", "source", "trips_json"]);
  const runs = prepare("SELECT * FROM runs WHERE operator_id = ? AND service_date = ? ORDER BY run_id");
  const clearPatterns = prepare("DELETE FROM assignment_patterns WHERE operator_id = ?");
  const pattern = insert("assignment_patterns", ["vessel_id", "operator_id", "run_signature", "day_type", "count", "last_seen"]);
  const patterns = prepare(`SELECT * FROM assignment_patterns WHERE (? IS NULL OR operator_id = ?)
    AND (? IS NULL OR vessel_id = ?) ORDER BY operator_id, vessel_id, run_signature, day_type`);
  const estimateColumns = ["vessel_id", "operator_id", "service_date", "run_id", "run_signature", "route_id", "confidence", "source", "reasoning", "evidence_json", "model", "created_at"];
  const estimate = insert("assignment_estimates", estimateColumns, ["vessel_id", "service_date", "source"]);
  const estimates = prepare(`SELECT * FROM assignment_estimates WHERE (? IS NULL OR service_date = ?)
    AND (? IS NULL OR operator_id = ?) AND (? IS NULL OR vessel_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?`);
  const llmRun = insert("llm_runs", ["purpose", "model", "service_date", "batch_id", "status", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd", "created_at"]);
  const llmFields = [["status", "status"], ["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"],
    ["cacheReadTokens", "cache_read_tokens"], ["costUsd", "cost_usd"], ["batchId", "batch_id"]];
  const updateLlmRun = prepare(`UPDATE llm_runs SET ${llmFields.map(([, column]) => `${column} = CASE WHEN ? THEN ? ELSE ${column} END`).join(", ")} WHERE id = ?`);
  const llmBatch = insert("llm_batches", ["batch_id", "purpose", "manifest_json", "llm_run_id", "created_at"], ["batch_id"]);
  const getLlmBatch = prepare("SELECT * FROM llm_batches WHERE batch_id = ?");
  const collectLlmBatch = prepare("UPDATE llm_batches SET collected_at = ? WHERE batch_id = ?");
  const spend = prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_runs WHERE created_at >= ?");

  const clearSlips = prepare("DELETE FROM slips");
  const clearTerminals = prepare("DELETE FROM terminals");
  const terminal = insert("terminals", ["id", "name", "town", "state", "latitude", "longitude", "radius_metres", "landing_id", "stop_ids_json"]);
  const slip = insert("slips", ["id", "terminal_id", "label", "kind", "platform_code", "points_json"]);
  const terminals = prepare("SELECT * FROM terminals ORDER BY id");
  const slips = prepare("SELECT id, terminal_id, label AS name, kind, platform_code, points_json FROM slips ORDER BY id");
  const operators = prepare("SELECT * FROM operators ORDER BY id");
  const vessels = prepare("SELECT * FROM vessels WHERE (? IS NULL OR operator_id = ?) ORDER BY id");
  const vessel = prepare("SELECT * FROM vessels WHERE id = ?");
  const references = prepare("SELECT * FROM vessel_refs WHERE vessel_id = ? ORDER BY id");
  const importKey = "legacy_imported";
  const imported = prepare("SELECT value FROM meta WHERE key = ?");
  const markImported = prepare("INSERT INTO meta (key, value) VALUES (?, ?)");

  function mergeSighting(item, fixes, firstSeen, lastSeen, visits) {
    const old = decode(getSighting.get(item.mmsi));
    // Terminal ids are arbitrary text, including Object.prototype property names.
    const terminals = Object.assign(Object.create(null), old?.terminals ?? {});
    for (const [id, count] of Object.entries(visits)) terminals[id] = (Object.hasOwn(terminals, id) ? terminals[id] : 0) + count;
    const speeds = [old?.maxSogKnots, item.sogKnots].filter((value) => value != null);
    sighting.run(item.mmsi, item.name ?? old?.name ?? null, item.callSign ?? old?.callSign ?? null,
      item.shipType ?? old?.shipType ?? null, json(item.dims ?? old?.dims), item.aisClass ?? old?.aisClass ?? null,
      old ? Math.min(old.firstSeen, firstSeen) : firstSeen, old ? Math.max(old.lastSeen, lastSeen) : lastSeen,
      (old?.fixes ?? 0) + fixes, speeds.length ? Math.max(...speeds) : null, json(terminals));
  }

  function recordSighting(item) {
    mergeSighting(item, 1, item.at, item.at, item.terminalId == null ? {} : { [item.terminalId]: 1 });
  }

  function recordDwell(item) {
    dwell.run(nullable(item.trackKey), nullable(item.mmsi), nullable(item.vesselId), nullable(item.terminalId),
      nullable(item.slipId), nullable(item.confidence), item.ambiguous ? 1 : 0, nullable(item.since), nullable(item.until),
      nullable(item.latitude), nullable(item.longitude), nullable(item.headingDegrees), json(item.dims));
  }

  function linkAis(item) {
    const old = decode(getLink.get(item.mmsi));
    if (old?.source === "roster" || rosterLink.get(item.vesselId, "roster", item.mmsi)) return false;
    const append = (values, value) => value == null || values.includes(value) ? values : [...values, value];
    const times = [old?.firstSeen, old?.lastSeen, item.at].filter((value) => value != null);
    link.run(item.mmsi, item.vesselId, item.source, item.confidence ?? old?.confidence ?? 1,
      times.length ? Math.min(...times) : null, times.length ? Math.max(...times) : null,
      json(append(old?.names ?? [], item.name)), json(append(old?.callSigns ?? [], item.callSign)));
    return true;
  }

  function recordConflict(item) {
    const old = getConflict.get(item.kind, nullable(item.mmsi), nullable(item.vesselId));
    if (old) updateConflict.run(json(item.detail ?? {}), Math.min(old.first_seen, item.at), Math.max(old.last_seen, item.at), old.id);
    else conflict.run(item.kind, nullable(item.mmsi), nullable(item.vesselId), json(item.detail ?? {}), item.at, item.at);
  }

  function recordTripObservation(item) {
    observation.run(...[item.trackKey, item.mmsi, item.vesselId, item.operatorId, item.tripId, item.routeId, item.runId,
      item.serviceDate, item.terminalId, item.departedAt, item.arrivedTerminalId, item.arrivedAt, item.confidence, item.source].map(nullable));
  }

  function saveEstimate(item) {
    estimate.run(...[item.vesselId, item.operatorId, item.serviceDate, item.runId, item.runSignature, item.routeId,
      item.confidence, item.source, item.reasoning, json(item.evidence ?? []), item.model, item.createdAt].map(nullable));
  }

  function listAisLinks({ vesselId = null } = {}) { return rows(links, vesselId, vesselId); }

  function vesselDetail(id) {
    const found = decode(vessel.get(id));
    return found ? { vessel: found, links: listAisLinks({ vesselId: id }), references: rows(references, id), conflicts: rows(vesselConflicts, id) } : null;
  }

  async function importLegacy({ stateDir }) {
    if (imported.get(importKey)) return;
    const [discovery, oldDwells, learned] = await Promise.all([
      readLegacy(stateDir, "harbor-discovery.json", "vessels"),
      readLegacy(stateDir, "harbor-dwells.json", "dwells"),
      readLegacy(stateDir, "harbor-identities.json", "learned")
    ]);
    store.transaction(() => {
      // Reading files yields to other imports. Recheck the durable marker while holding
      // the transaction so two calls cannot count the same legacy history twice.
      if (imported.get(importKey)) return;
      for (const item of discovery) {
        if (!isRecord(item) || !nonempty(item.mmsi) || !Number.isFinite(item.firstSeen) || !Number.isFinite(item.lastSeen)
          || !Number.isInteger(item.fixes) || item.fixes < 0
          || !validLegacyFields(item, ["name", "callSign", "aisClass"], ["shipType", "maxSogKnots"], ["dims"])) continue;
        const visits = Object.fromEntries(list(item.landings).filter(nonempty).map((id) => [id, 1]));
        mergeSighting({ ...item, sogKnots: item.maxSogKnots }, item.fixes, item.firstSeen, item.lastSeen, visits);
      }
      for (const item of oldDwells) {
        if (!isRecord(item) || !nonempty(item.key) || !nonempty(item.landingStopId)
          || !Number.isFinite(item.since) || !Number.isFinite(item.until)
          || !validLegacyFields(item, ["vesselId", "slipId"], ["confidence", "latitude", "longitude", "headingDegrees"], ["dims"])
          || (item.ambiguous != null && typeof item.ambiguous !== "boolean")) continue;
        recordDwell({ ...item, trackKey: item.key, terminalId: item.landingStopId,
          mmsi: /^\d{9}$/.test(item.key) ? item.key : null });
      }
      for (const item of learned) {
        if (!isRecord(item) || !nonempty(item.mmsi) || !nonempty(item.vesselId) || !nonempty(item.source)
          || !Number.isFinite(item.at) || !validLegacyFields(item, ["name", "callSign"], ["confidence"])
          || !vessel.get(item.vesselId)) continue;
        linkAis(item);
      }
      markImported.run(importKey, "1");
    });
  }

  return {
    recordSighting,
    // A cursor includes the last row's tie breaker as well as its timestamp:
    // { lastSeen, mmsi } for sightings and { since, id } for dwells. Timestamps
    // alone would skip history when several observations share a page boundary.
    listSightings({ since = null, before = null, limit } = {}) {
      const at = before?.lastSeen ?? null;
      return rows(sightings, since, since, at, at, at, before?.mmsi ?? null, limitOf(limit));
    },
    recordDwell,
    listDwells({ vesselId = null, mmsi = null, terminalId = null, since = null, before = null, limit } = {}) {
      const at = before?.since ?? null;
      return rows(dwells, vesselId, vesselId, mmsi, mmsi, terminalId, terminalId, since, since,
        at, at, at, before?.id ?? null, limitOf(limit));
    },
    linkAis,
    listAisLinks,
    recordConflict,
    listConflicts({ resolved = false } = {}) { return rows(conflicts, resolved ? 1 : 0); },
    recordTripObservation,
    listTripObservations({ operatorId = null, serviceDate = null, vesselId = null, limit } = {}) {
      return rows(observations, operatorId, operatorId, serviceDate, serviceDate, vesselId, vesselId, limitOf(limit));
    },
    saveRuns(operatorId, serviceDate, items) {
      return store.transaction(() => {
        clearRuns.run(operatorId, serviceDate);
        for (const item of items) run.run(operatorId, serviceDate, item.runId, item.signature, item.source, json(item.trips ?? []));
      });
    },
    listRuns(operatorId, serviceDate) { return rows(runs, operatorId, serviceDate); },
    replacePatterns(operatorId, items) {
      return store.transaction(() => {
        clearPatterns.run(operatorId);
        for (const item of items) pattern.run(item.vesselId, operatorId, item.runSignature, item.dayType, item.count, item.lastSeen);
      });
    },
    listPatterns({ operatorId = null, vesselId = null } = {}) { return rows(patterns, operatorId, operatorId, vesselId, vesselId); },
    saveEstimate,
    listEstimates({ serviceDate = null, operatorId = null, vesselId = null, limit } = {}) {
      return rows(estimates, serviceDate, serviceDate, operatorId, operatorId, vesselId, vesselId, limitOf(limit));
    },
    recordLlmRun(item) {
      return llmRun.run(item.purpose, item.model, nullable(item.serviceDate), nullable(item.batchId), item.status,
        item.inputTokens ?? 0, item.outputTokens ?? 0, item.cacheReadTokens ?? 0, item.costUsd ?? 0, item.createdAt).lastInsertRowid;
    },
    updateLlmRun(id, item) {
      // Zero is a real token or spend value; omission alone means to leave a field alone.
      const flags = llmFields.map(([key]) => Object.hasOwn(item, key) && item[key] !== undefined);
      if (!flags.some(Boolean)) return false;
      return updateLlmRun.run(...llmFields.flatMap(([key], index) => [flags[index] ? 1 : 0, flags[index] ? nullable(item[key]) : null]), id).changes > 0;
    },
    saveLlmBatch(item) {
      llmBatch.run(item.batchId, item.purpose, json(item.manifest), nullable(item.llmRunId), item.createdAt);
    },
    getLlmBatch(batchId) { return decode(getLlmBatch.get(batchId)); },
    markLlmBatchCollected(batchId, at) { collectLlmBatch.run(at, batchId); },
    llmSpendSince(at) { return spend.get(at).cost; },
    syncTerminals(items, slipItems) {
      return store.transaction(() => {
        clearSlips.run();
        clearTerminals.run();
        for (const item of items) terminal.run(item.id, item.name, nullable(item.town), nullable(item.state),
          item.latitude, item.longitude, item.radiusMetres ?? 120, nullable(item.landingId), json(item.stopIds ?? []));
        for (const item of slipItems) slip.run(item.id, item.terminalId, item.name, item.kind, nullable(item.platformCode), json(item.points ?? []));
      });
    },
    listTerminals() {
      const byTerminal = new Map();
      for (const item of rows(slips)) {
        if (!byTerminal.has(item.terminalId)) byTerminal.set(item.terminalId, []);
        byTerminal.get(item.terminalId).push(item);
      }
      return rows(terminals).map((item) => ({ ...item, slips: byTerminal.get(item.id) ?? [] }));
    },
    listOperators() { return rows(operators); },
    listVessels({ operatorId = null } = {}) { return rows(vessels, operatorId, operatorId); },
    vesselDetail,
    importLegacy
  };
}
