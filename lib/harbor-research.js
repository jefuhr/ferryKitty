import { normalizeIdentity } from "./realtime.js";

const FCC_SHIPS_URL = "https://data.fcc.gov/download/pub/uls/complete/l_ship.zip";
const textValue = (value) => typeof value === "string" ? value.trim().replace(/@+$/g, "").trim() || null : null;
const validMmsi = (value) => typeof value === "string" && /^\d{9}$/.test(value);

export function candidates({ sightings, dwells, terminals, roster }) {
  const linked = new Set(roster.byMmsi?.keys() ?? []);
  for (const vessel of roster.vessels) if (vessel.mmsi) linked.add(vessel.mmsi);
  const users = new Map(terminals.map((terminal) => [terminal.id, roster.operators.filter((operator) =>
    // The root feed has an empty prefix; it must not claim every partner stop.
    terminal.stopIds.some((id) => operator.feedPrefix
      ? [operator.feedPrefix, ...(operator.extraFeedPrefixes ?? [])].some((prefix) => id.startsWith(prefix)) : !id.includes(":"))
  ).map((operator) => operator.id)]));
  const visits = new Map();
  for (const dwell of dwells) {
    if (!visits.has(dwell.mmsi)) visits.set(dwell.mmsi, []);
    visits.get(dwell.mmsi).push(dwell.terminalId);
  }
  const found = [];
  for (const sighting of sightings) {
    if (!validMmsi(sighting.mmsi) || linked.has(sighting.mmsi)) continue;
    const calls = visits.get(sighting.mmsi) ?? [];
    const counts = new Map();
    const operatorCounts = new Map(roster.operators.map((operator) => [operator.id, 0]));
    for (const terminalId of calls) {
      counts.set(terminalId, (counts.get(terminalId) ?? 0) + 1);
      for (const id of users.get(terminalId) ?? []) operatorCounts.set(id, operatorCounts.get(id) + 1);
    }
    const best = [...operatorCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const share = calls.length ? (best?.[1] ?? 0) / calls.length : 0;
    const tiedOperators = share >= 0.6 ? [...operatorCounts].filter(([, count]) => count === best[1]).map(([id]) => id).sort() : [];
    found.push({ mmsi: sighting.mmsi, name: textValue(sighting.name), callSign: textValue(sighting.callSign),
      shipType: sighting.shipType ?? null, operatorGuess: calls.length >= 3 && share >= 0.6 && tiedOperators.length === 1 ? best[0] : null,
      ...(tiedOperators.length > 1 ? { tiedOperators } : {}),
      share, dwellCount: calls.length, terminals: [...counts].map(([terminalId, count]) => ({ terminalId, count }))
        .sort((a, b) => b.count - a.count || String(a.terminalId).localeCompare(String(b.terminalId))) });
  }
  return found.sort((a, b) => b.dwellCount * b.share - a.dwellCount * a.share || a.mmsi.localeCompare(b.mmsi));
}

export function parseFccShips(text) {
  const licensees = new Map();
  const ships = [];
  // Observed in the FCC l_ship.zip snapshot dated 2026-11-08: pipe-delimited,
  // headerless CRLF records. SH.dat has 27 fields, EN.dat 30. A caller can
  // concatenate SH.dat and EN.dat in either order to retain licensee evidence.
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split("|");
    if (!/^\d+$/.test(fields[1] ?? "")) continue;
    if (fields[0] === "EN" && fields.length >= 30 && fields[5] === "L") {
      licensees.set(fields[1], textValue(fields[7]));
    } else if (fields[0] === "SH" && fields.length >= 27) {
      const mmsi = textValue(fields[21]);
      if (mmsi !== null && !validMmsi(mmsi)) continue;
      const callSign = textValue(fields[4]);
      const name = textValue(fields[9]);
      if (callSign && name) ships.push({ systemId: fields[1], callSign, name, mmsi });
    }
  }
  return ships.map(({ systemId, ...ship }) => ({ ...ship, licensee: licensees.get(systemId) ?? null }));
}

function slug(name) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fccFor(candidate, fcc) {
  let matches = fcc.filter((record) => record.mmsi === candidate.mmsi);
  if (!matches.length && candidate.callSign) matches = fcc.filter((record) =>
    !record.mmsi && record.callSign?.toUpperCase() === candidate.callSign.toUpperCase());
  const distinct = new Map(matches.map((record) => [JSON.stringify([record.name, record.callSign, record.mmsi]), record]));
  // The bulk archive includes expired licences. Ambiguous records are not a
  // licence to choose one by name: keep the AIS evidence for human review.
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

export function propose({ candidates, fcc = [], confirmations = {}, roster }) {
  const proposed = [];
  const skipped = [];
  const dropped = [];
  for (const candidate of candidates) {
    const confirmation = confirmations instanceof Map ? confirmations.get(candidate.mmsi) : confirmations[candidate.mmsi];
    const sourced = {};
    for (const field of ["operatorId", "name", "class", "capacity", "builder", "year"]) {
      if (confirmation?.[field] === undefined || confirmation[field] === null) continue;
      const sources = (confirmation.references ?? []).filter((reference) => reference.field === field &&
        String(confirmation[field]) === String(reference.value).trim());
      if (sources.length) sourced[field] = { value: confirmation[field], sources };
      else dropped.push({ mmsi: candidate.mmsi, field, reason: "Dropped for lack of a source" });
    }
    const record = fccFor(candidate, fcc);
    const operatorId = sourced.operatorId?.value ?? candidate.operatorGuess;
    const name = textValue(sourced.name?.value) ?? textValue(record?.name) ?? textValue(candidate.name);
    if (!roster.operators.some((operator) => operator.id === operatorId)) {
      skipped.push({ mmsi: candidate.mmsi, reason: "No supported operator" });
      continue;
    }
    if (!name || !slug(name)) {
      skipped.push({ mmsi: candidate.mmsi, reason: "No usable vessel name" });
      continue;
    }
    const references = [];
    const add = (field, value, url, note, retrievedAt = null) => references.push({ field, value, url, retrievedAt, note });
    const observation = `AIS observation: MMSI ${candidate.mmsi}, name heard ${candidate.name ?? "unknown"}, ${candidate.dwellCount} dwells`;
    add("mmsi", candidate.mmsi, null, observation);
    if (candidate.name) add("name", candidate.name, null, observation);
    if (candidate.callSign) add("callSign", candidate.callSign, null, observation);
    const aisNames = candidate.name ? [candidate.name] : [];
    add("aisNames", aisNames, null, observation);
    if (candidate.operatorGuess) add("operatorId", candidate.operatorGuess, null,
      `${observation}; terminal share ${candidate.share}; visits ${JSON.stringify(candidate.terminals)}`);
    if (record) {
      const note = `FCC ULS ship licence: call sign ${record.callSign}, licensee ${record.licensee ?? "not supplied"}; verify licence currency before approval`;
      for (const field of ["name", "callSign", "mmsi"]) if (record[field]) add(field, record[field], FCC_SHIPS_URL, note);
    }
    const vessel = { id: `${operatorId}:${slug(name)}`, operatorId, name, number: null,
      mmsi: candidate.mmsi, callSign: record?.callSign ?? candidate.callSign ?? null, aisNames, active: true, references };
    for (const [field, { value, sources }] of Object.entries(sourced)) {
      if (!["operatorId", "name"].includes(field)) vessel[field] = value;
      for (const source of sources) add(field, source.value, source.url ?? null, source.note ?? null, source.retrievedAt ?? null);
    }
    proposed.push(vessel);
  }
  const counts = new Map();
  for (const vessel of proposed) counts.set(vessel.id, (counts.get(vessel.id) ?? 0) + 1);
  const vessels = [];
  const conflicts = [];
  for (const vessel of proposed) {
    const existing = roster.vessels.find((entry) => {
      const bound = entry.mmsi ?? [...(roster.byMmsi ?? [])].find(([, link]) => link.vesselId === entry.id)?.[0];
      return bound && bound !== vessel.mmsi && normalizeIdentity(entry.name) === normalizeIdentity(vessel.name);
    });
    if (counts.get(vessel.id) > 1) conflicts.push({ kind: "duplicate-id", mmsi: vessel.mmsi, vesselId: vessel.id, vessel });
    else if (existing) conflicts.push({ kind: "roster-name-mmsi", mmsi: vessel.mmsi, vesselId: existing.id, vessel });
    else vessels.push(vessel);
  }
  return { vessels, conflicts, skipped, dropped };
}
