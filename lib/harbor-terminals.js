import { readFile } from "node:fs/promises";

/** Read the committed catalog before any of its positions enter the docking index. */
export async function loadHarborTerminals(path) {
  const text = await readFile(path, "utf8");
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid harbor terminals file ${path}: invalid JSON`, { cause: error });
  }
  if (!Array.isArray(catalog?.terminals)) throw new Error(`Invalid harbor terminals file ${path}: terminals must be an array`);
  const seen = new Set();
  for (const [index, terminal] of catalog.terminals.entries()) {
    const label = typeof terminal?.id === "string" && terminal.id.trim() ? terminal.id : `entry ${index}`;
    const invalid = reason => { throw new Error(`Invalid harbor terminal ${label}: ${reason}`); };
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) invalid("entry must be an object");
    for (const field of ["id", "name", "town", "state"]) {
      if (typeof terminal[field] !== "string" || !terminal[field].trim()) invalid(`${field} must be a non-empty string`);
    }
    if (seen.has(terminal.id)) invalid("duplicate id");
    seen.add(terminal.id);
    if (!Number.isFinite(terminal.latitude) || Math.abs(terminal.latitude) > 90) invalid("latitude must be finite and between -90 and 90");
    if (!Number.isFinite(terminal.longitude) || Math.abs(terminal.longitude) > 180) invalid("longitude must be finite and between -180 and 180");
    if (!Array.isArray(terminal.stopIds) || !terminal.stopIds.length || terminal.stopIds.some(id => typeof id !== "string" || !id.trim())) {
      invalid("stopIds must be a non-empty array of non-empty strings");
    }
    // Optional: where this terminal's boats actually lie, when that is too far from the published
    // stop for the default circle to reach (a 100 m ferry reports from well off the stop).
    if (terminal.berth !== undefined) {
      const berth = terminal.berth;
      if (!berth || typeof berth !== "object" || Array.isArray(berth)
        || !Number.isFinite(berth.latitude) || Math.abs(berth.latitude) > 90
        || !Number.isFinite(berth.longitude) || Math.abs(berth.longitude) > 180
        || !Number.isFinite(berth.radiusMetres) || berth.radiusMetres <= 0 || berth.radiusMetres > 1000) {
        invalid("berth must have a latitude, a longitude and a radiusMetres between 0 and 1000");
      }
    }
  }
  return catalog.terminals;
}

/** A board pier keeps its identity even when another operator calls it by another stop id. */
export function harborLandings({ boardLandings, terminals }) {
  const landings = [];
  const stopIdsOfLanding = new Map();
  const landingOfStop = new Map();
  const remember = (landing, stopIds) => {
    const aliases = stopIdsOfLanding.get(landing.landingStopId) || [];
    for (const stopId of stopIds) {
      if (!aliases.includes(stopId)) aliases.push(stopId);
      landingOfStop.set(stopId, landing);
    }
    stopIdsOfLanding.set(landing.landingStopId, aliases);
  };
  for (const { landingStopId, landingId, name, latitude, longitude, stopIds } of boardLandings) {
    const landing = { landingStopId, landingId, name, latitude, longitude };
    landings.push(landing);
    remember(landing, [landingStopId, ...(stopIds || [])]);
  }
  for (const terminal of terminals) {
    if (terminal.berth) {
      // Its own dock: boats here are placed by the berth, not by the board pier that shares the
      // name. The board pier's identity is kept for display and its claim to these stops removed.
      const board = terminal.stopIds.map(id => landingOfStop.get(id)).find(Boolean);
      for (const [landingStopId, aliases] of stopIdsOfLanding) {
        stopIdsOfLanding.set(landingStopId, aliases.filter(id => id === landingStopId || !terminal.stopIds.includes(id)));
      }
      const landing = { landingStopId: terminal.stopIds[0], landingId: board?.landingId ?? null, name: terminal.name,
        latitude: terminal.berth.latitude, longitude: terminal.berth.longitude, radiusMetres: terminal.berth.radiusMetres };
      landings.push(landing);
      stopIdsOfLanding.set(landing.landingStopId, []);
      remember(landing, terminal.stopIds);
      continue;
    }
    const existing = terminal.stopIds.map(id => landingOfStop.get(id)).find(Boolean);
    const landing = existing || {
      landingStopId: terminal.stopIds[0], landingId: null, name: terminal.name,
      latitude: terminal.latitude, longitude: terminal.longitude
    };
    if (!existing) landings.push(landing);
    remember(landing, terminal.stopIds);
  }
  return { landings, stopIdsOfLanding };
}
