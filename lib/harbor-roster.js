import { readFile } from "node:fs/promises";
import { normalizeIdentity } from "./realtime.js";

export function rosterFromFleet(fleet) {
  return fleet.map(({ id, name, number }) => ({
    id, operatorId: "nycf", name, number, mmsi: null, callSign: null, aisNames: [], active: true
  }));
}

export function buildRoster({ operators, vessels }, learned = []) {
  const byId = new Map(vessels.map((vessel) => [vessel.id, { ...vessel, learned: false }]));
  const byMmsi = new Map();
  // Committed bindings all enter first so that learned data can never claim their vessels or MMSIs.
  for (const vessel of byId.values()) {
    if (vessel.mmsi) byMmsi.set(vessel.mmsi, { vesselId: vessel.id, source: "roster", at: null });
  }
  for (const binding of learned) {
    const vessel = byId.get(binding.vesselId);
    if (!vessel || vessel.mmsi || !binding.mmsi || byMmsi.has(binding.mmsi)) continue;
    byId.set(vessel.id, { ...vessel, mmsi: binding.mmsi, learned: true });
    byMmsi.set(binding.mmsi, { vesselId: vessel.id, source: binding.source, at: binding.at });
  }
  return { operators, vessels, byMmsi, byId };
}

export async function loadRoster({ rosterPath, learned = [] }) {
  return buildRoster(JSON.parse(await readFile(rosterPath, "utf8")), learned);
}

export function resolveIdentity({ mmsi, staticData }, roster) {
  const binding = roster.byMmsi.get(mmsi);
  if (binding) return { vesselId: binding.vesselId, source: binding.source };
  const name = normalizeIdentity(staticData?.name);
  if (!name) return null;
  const matches = roster.vessels.filter((vessel) => (
    [vessel.name, ...(vessel.aisNames ?? [])].some((identity) => normalizeIdentity(identity) === name)
  ));
  return matches.length === 1 ? { vesselId: matches[0].id, source: "ais-name" } : null;
}
