import { normalizeHarborServiceDate } from "./harbor-schedule.js";
import { zonedParts } from "../public/assets/schedule.js";

const compactDate = value => normalizeHarborServiceDate(value).replaceAll("-", "");
const compareText = (left, right) => String(left).localeCompare(String(right));
const compareTrips = (left, right) => left.departsAt - right.departsAt || compareText(left.tripId, right.tripId) ||
  compareText(left.routeId, right.routeId) || compareText(left.firstStopId, right.firstStopId);
const runDate = run => /:(\d{8}):\d+$/.exec(run.runId)?.[1] ?? null;
const runOperator = run => run.runId.replace(/:\d{8}:\d+$/, "");
const tripFields = trip => ({ tripId: trip.tripId, routeId: trip.routeId, firstStopId: trip.firstStopId,
  lastStopId: trip.lastStopId, departsAt: trip.departsAt, arrivesAt: trip.arrivesAt });

/** Blocks are authoritative. Only trips without a block participate in greedy turn matching. */
export function buildRuns({ schedule, operatorId, serviceDate, minTurnMs = 120_000, maxTurnMs = 2_700_000,
  sameLanding = (left, right) => left === right }) {
  const date = compactDate(serviceDate);
  const trips = [...schedule.tripsOn(operatorId, serviceDate)].sort(compareTrips);
  const blocks = new Map(), unblocked = [];
  for (const trip of trips) {
    if (trip.blockId == null || trip.blockId === "") unblocked.push(trip);
    else {
      const block = blocks.get(trip.blockId) || [];
      block.push(trip);
      blocks.set(trip.blockId, block);
    }
  }
  const chains = [...blocks.values()].map(trips => ({ source: "block", trips }));
  const taken = new Set();
  for (const first of unblocked) {
    if (taken.has(first)) continue;
    const chain = [first];
    taken.add(first);
    let previous = first;
    while (true) {
      const next = unblocked.find(candidate => !taken.has(candidate) &&
        candidate.departsAt - previous.arrivesAt >= minTurnMs &&
        candidate.departsAt - previous.arrivesAt <= maxTurnMs &&
        sameLanding(previous.lastStopId, candidate.firstStopId));
      if (!next) break;
      chain.push(next);
      taken.add(next);
      previous = next;
    }
    chains.push({ source: "synthesized", trips: chain });
  }
  chains.sort((left, right) => compareTrips(left.trips[0], right.trips[0]));
  return chains.map((chain, index) => {
    const first = chain.trips[0];
    const { seconds } = zonedParts(new Date(first.departsAt), schedule.timezone);
    const time = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
    return { runId: `${operatorId}:${date}:${index + 1}`, signature: `${first.firstStopId}>${time}>${first.routeId}`,
      source: chain.source, trips: chain.trips.map(tripFields) };
  });
}

export function runOfTrip(runs, tripId) {
  return runs.find(run => run.trips.some(trip => trip.tripId === tripId)) || null;
}

export function tripsAfter(run, tripId) {
  const index = run?.trips.findIndex(trip => trip.tripId === tripId) ?? -1;
  return index < 0 ? [] : run.trips.slice(index + 1);
}

export function dayType(serviceDate) {
  const weekday = new Date(`${normalizeHarborServiceDate(serviceDate)}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? "sunday" : weekday === 6 ? "saturday" : "weekday";
}

/** Resolve observations against their own operator-day so reused trip ids cannot teach a wrong run. */
export function buildPatterns(observations, runs) {
  const byId = new Map(runs.map(run => [run.runId, run]));
  const byTrip = new Map();
  for (const run of runs) {
    for (const trip of run.trips) {
      byTrip.set(JSON.stringify([runOperator(run), runDate(run), trip.tripId]), run);
    }
  }
  const counted = new Set(), rows = new Map();
  for (const observation of observations) {
    if (!observation.vesselId || !observation.serviceDate ||
      !(observation.confidence >= 0.9 || observation.source === "operator-rt")) continue;
    const date = compactDate(observation.serviceDate);
    const storedRun = byId.get(observation.runId);
    const run = storedRun && runDate(storedRun) === date && runOperator(storedRun) === observation.operatorId
      ? storedRun : byTrip.get(JSON.stringify([observation.operatorId, date, observation.tripId]));
    if (!run) continue;
    const key = JSON.stringify([observation.vesselId, run.signature, date]);
    if (counted.has(key)) continue;
    counted.add(key);
    const type = dayType(date), rowKey = JSON.stringify([observation.vesselId, run.signature, type]);
    const row = rows.get(rowKey) || { vesselId: observation.vesselId, runSignature: run.signature,
      dayType: type, count: 0, lastSeen: date };
    row.count += 1;
    if (date > row.lastSeen) row.lastSeen = date;
    rows.set(rowKey, row);
  }
  return [...rows.values()].sort((left, right) => compareText(left.vesselId, right.vesselId) ||
    compareText(left.runSignature, right.runSignature) || compareText(left.dayType, right.dayType));
}

export function estimateFromPatterns({ vesselId, operatorId, dayType, patterns, runs, claimed = new Set() }) {
  const totals = new Map(), own = new Map();
  for (const pattern of patterns) {
    if (pattern.dayType !== dayType || !Number.isFinite(pattern.count) || pattern.count <= 0) continue;
    totals.set(pattern.runSignature, (totals.get(pattern.runSignature) || 0) + pattern.count);
    if (pattern.vesselId !== vesselId) continue;
    const row = own.get(pattern.runSignature) || { count: 0, lastSeen: pattern.lastSeen };
    row.count += pattern.count;
    if (pattern.lastSeen > row.lastSeen) row.lastSeen = pattern.lastSeen;
    own.set(pattern.runSignature, row);
  }
  const candidates = [];
  for (const run of runs) {
    const row = own.get(run.signature);
    if (runOperator(run) !== operatorId || claimed.has(run.signature) || !row || row.count < 3) continue;
    const total = totals.get(run.signature);
    candidates.push({ run, count: row.count, estimate: {
      runId: run.runId, runSignature: run.signature, routeId: run.trips[0].routeId,
      confidence: Math.min(0.8, row.count / total), source: "pattern",
      evidence: { count: row.count, total, dayType, lastSeen: row.lastSeen }
    } });
  }
  candidates.sort((left, right) => right.estimate.confidence - left.estimate.confidence || right.count - left.count ||
    compareTrips(left.run.trips[0], right.run.trips[0]) || compareText(left.run.runId, right.run.runId));
  return candidates[0]?.estimate || null;
}
