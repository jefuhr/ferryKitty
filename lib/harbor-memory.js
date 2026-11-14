import { compareTripClaims, normalizeHarborServiceDate } from "./harbor-schedule.js";
import { buildPatterns, buildRuns, dayType, estimateFromPatterns, runOfTrip, tripsAfter } from "./harbor-runs.js";
import { normalizeIdentity } from "./realtime.js";
import { addDays, zonedParts } from "../public/assets/schedule.js";

// What the tracker writes down, and what it reads back to say which run a boat is on.
//
// lib/harbor-service.js holds the live picture and forgets it after a few hours. This is the part
// that keeps the long record in the database (who was seen, where they sat, which trips they were
// matched to) and turns that record, with the timetable's runs, into an assignment for each boat.
// It never decides where a boat is; it only remembers and estimates.

const NEXT_TRIPS = 5;
const RUN_CONFIDENCE = 0.7;
const LEARN_OBSERVATIONS = 1000;
// How far from a trip's own running time a report may be and still be taken as that trip.
const SERVICE_DAY_SLACK_MS = 6 * 60 * 60_000;
// Estimates from elsewhere, in the order they are believed when the boat itself says nothing.
const STORED_SOURCES = ["pattern", "model"];

const compact = (serviceDate) => normalizeHarborServiceDate(serviceDate).replaceAll("-", "");

export function createHarborMemory({ store, schedule = null, sameLanding = (left, right) => left === right, now = () => Date.now(), warn = () => {} }) {
  const runCache = new Map();
  const collisions = new Set();

  // A database that cannot be written is a lost note, never a lost boat.
  const quietly = (work, fallback = undefined) => {
    try { return work(); } catch (error) { warn(`Harbor memory: ${error.message}`); return fallback; }
  };
  quietly(() => store.reconcileTripObservations?.({ schedule }));

  function today(clock = now()) {
    return schedule ? zonedParts(new Date(clock), schedule.timezone).dateKey.replaceAll("-", "") : null;
  }

  function runsFor(operatorId, serviceDate) {
    if (!schedule || !operatorId || !serviceDate) return [];
    const date = compact(serviceDate), key = `${operatorId}|${date}`;
    if (runCache.has(key)) return runCache.get(key);
    const runs = quietly(() => buildRuns({ schedule, operatorId, serviceDate: date, sameLanding }), []);
    runCache.set(key, runs);
    // A handful of days is all that is ever asked for at once: yesterday, today and tomorrow.
    if (runCache.size > 64) runCache.delete(runCache.keys().next().value);
    quietly(() => store.saveRuns(operatorId, date, runs));
    return runs;
  }

  function sighting(track, terminalId = null) {
    if (!track.mmsi || !track.fix) return;
    quietly(() => store.recordSighting({ mmsi: track.mmsi, name: track.static?.name ?? null, callSign: track.static?.callSign ?? null,
      shipType: track.static?.shipType ?? null, dims: track.static?.dims ?? null,
      aisClass: track.static?.aisClass ?? track.fix.aisClass ?? null, at: track.fix.at, sogKnots: track.fix.sogKnots ?? null, terminalId }));
  }

  function dwell(record) {
    quietly(() => store.recordDwell(record));
  }

  function link(binding, track) {
    return quietly(() => store.linkAis({ mmsi: binding.mmsi, vesselId: binding.vesselId, source: binding.source,
      confidence: binding.source === "ais-name" ? 0.8 : 0.7, at: binding.at,
      name: track?.static?.name ?? null, callSign: track?.static?.callSign ?? null }), false) === true;
  }

  // A transponder using a name the roster already gave to another transponder. First heard still
  // wins in the live tracker; this makes sure a person gets to see that there were two.
  function nameCollision(track, roster) {
    const name = normalizeIdentity(track.static?.name);
    if (!name || !track.mmsi || collisions.has(track.mmsi) || roster.ignored?.has(track.mmsi)) return;
    for (const vessel of roster.byId.values()) {
      if (!vessel.mmsi || vessel.mmsi === track.mmsi) continue;
      if (![vessel.name, ...(vessel.aisNames || [])].some((candidate) => normalizeIdentity(candidate) === name)) continue;
      collisions.add(track.mmsi);
      quietly(() => store.recordConflict({ kind: "name-collision", mmsi: track.mmsi, vesselId: vessel.id,
        detail: { nameHeard: track.static.name, heldBy: vessel.mmsi }, at: now() }));
      return;
    }
  }

  // The run a trip belongs to, kept on the track so the assignment outlives the trip.
  function runFor(operatorId, trip) {
    if (!trip?.tripId || !trip.serviceDate) return null;
    const run = runOfTrip(runsFor(operatorId, trip.serviceDate), trip.tripId);
    return run ? { operatorId, runId: run.runId, signature: run.signature, serviceDate: compact(trip.serviceDate), lastTripId: trip.tripId } : null;
  }

  function observe(track, operatorId, trip, { terminalId = null, departedAt = null, arrivedTerminalId = null, arrivedAt = null } = {}) {
    if (!trip?.tripId || !trip.serviceDate || !operatorId) return true;
    const run = runFor(operatorId, trip);
    return quietly(() => store.recordTripObservation({ trackKey: track.key, mmsi: track.mmsi ?? null, vesselId: track.vesselId ?? null,
      operatorId, tripId: String(trip.tripId), routeId: trip.routeId ?? null, runId: run?.runId ?? null,
      serviceDate: compact(trip.serviceDate), terminalId, departedAt, arrivedTerminalId, arrivedAt,
      confidence: trip.confidence ?? 0.5, source: trip.source ?? "schedule", observedAt: trip.observedAt }, { schedule }), false);
  }

  function owns(track, operatorId, trip) {
    const owner = quietly(() => store.getTripObservation({ operatorId, tripId: trip.tripId, serviceDate: trip.serviceDate }), null);
    return !owner || owner.trackKey === track.key || (track.vesselId && owner.vesselId === track.vesselId);
  }

  function withdraw(track, operatorId, trip) {
    if (trip?.tripId && trip.serviceDate && operatorId) quietly(() => store.withdrawTripObservation({
      trackKey: track.key, operatorId, tripId: trip.tripId, serviceDate: compact(trip.serviceDate)
    }));
  }

  const upcoming = (run, tripId, clock) => tripsAfter(run, tripId).filter((trip) => trip.departsAt >= clock - 60_000).slice(0, NEXT_TRIPS)
    .map((trip) => ({ tripId: trip.tripId, routeId: trip.routeId, departsAt: trip.departsAt, fromStopId: trip.firstStopId }));

  const toNext = (trip) => ({ tripId: trip.tripId, routeId: trip.routeId, departsAt: trip.departsAt, fromStopId: trip.firstStopId });
  const claimKey = (operatorId, signature, date) => `${operatorId}|${compact(date)}|${signature}`;

  // The operator's feed names a trip without saying which service day it belongs to, and a trip
  // timed past midnight belongs to yesterday's. The day is the one whose copy of the trip is
  // running closest to the moment it was reported.
  function serviceDateOf(operatorId, tripId, at = now()) {
    if (!schedule || !operatorId) return null;
    const base = zonedParts(new Date(at), schedule.timezone).dateKey;
    let best = null;
    for (const offset of [-1, 0, 1]) {
      const date = addDays(base, offset).replaceAll("-", "");
      const trip = runOfTrip(runsFor(operatorId, date), tripId)?.trips.find((item) => item.tripId === tripId);
      if (!trip) continue;
      const distance = at < trip.departsAt ? trip.departsAt - at : at > trip.arrivesAt ? at - trip.arrivesAt : 0;
      if (distance <= SERVICE_DAY_SLACK_MS && (!best || distance < best.distance)) best = { date, distance };
    }
    return best?.date ?? null;
  }

  // What the boat itself establishes: the trip it is on, or the run of the last trip it was
  // confirmed on while that run still has trips to work.
  function direct(track, operatorId, clock) {
    const trip = track?.trip;
    if (trip?.tripId) {
      const tripId = String(trip.tripId);
      const date = trip.serviceDate ?? serviceDateOf(operatorId, tripId, trip.observedAt ?? clock);
      const run = date ? runOfTrip(runsFor(operatorId, date), tripId) : null;
      return { signature: run?.signature ?? null, serviceDate: date, assignment: {
        routeId: trip.routeId ?? run?.trips.find((item) => item.tripId === tripId)?.routeId ?? null,
        runId: run?.runId ?? null, tripId, nextTrips: upcoming(run, tripId, clock), confidence: trip.confidence ?? null, source: trip.source } };
    }
    const held = track?.run;
    if (held && held.operatorId === operatorId) {
      const run = runsFor(operatorId, held.serviceDate).find((item) => item.runId === held.runId);
      const next = upcoming(run, held.lastTripId, clock);
      if (run && next.length) return { signature: run.signature, serviceDate: held.serviceDate, assignment: { routeId: next[0].routeId, runId: run.runId, tripId: null,
        nextTrips: next, confidence: RUN_CONFIDENCE, source: "run" } };
    }
    return null;
  }

  /**
   * Which run each boat is on, decided for the fleet together so that no run goes to two boats.
   * Takes [{ vesselId, operatorId, track }] and returns a Map of vesselId to an assignment.
   * Best source first: what the boat itself establishes, then learned patterns, then stored
   * estimates. A run two boats have an equal learned claim to is left unassigned.
   */
  function allocate(items, clock = now()) {
    const result = new Map(), claimed = new Set(), idle = [];
    const ordered = [...items].sort((left, right) => compareTripClaims(
      { ...(right.track?.trip ?? { source: "run" }), trackKey: right.track?.key ?? right.vesselId },
      { ...(left.track?.trip ?? { source: "run" }), trackKey: left.track?.key ?? left.vesselId }, { schedule }));
    for (const item of ordered) {
      if (!item.operatorId) continue;
      const own = direct(item.track, item.operatorId, clock);
      if (!own) { idle.push(item); continue; }
      const key = own.signature && own.serviceDate ? claimKey(item.operatorId, own.signature, own.serviceDate) : null;
      if (key && claimed.has(key)) { idle.push(item); continue; }
      result.set(item.vesselId, own.assignment);
      if (key) claimed.add(key);
    }
    if (!idle.length) return result;
    const date = today(clock), type = dayType(date);
    // Read once per operator, not once per boat.
    const perOperator = new Map();
    const context = (operatorId) => {
      if (!perOperator.has(operatorId)) perOperator.set(operatorId, {
        runs: runsFor(operatorId, date),
        patterns: quietly(() => store.listPatterns({ operatorId }), []),
        stored: quietly(() => store.listEstimates({ serviceDate: date, operatorId, limit: 1000 }), [])
      });
      return perOperator.get(operatorId);
    };
    const describe = (operatorId, pick) => {
      const { runs } = context(operatorId);
      const run = runs.find((item) => item.runId === pick.runId) ?? runs.find((item) => item.signature === pick.runSignature) ?? null;
      return { signature: run?.signature ?? pick.runSignature ?? null, assignment: {
        routeId: pick.routeId ?? run?.trips[0]?.routeId ?? null, runId: run?.runId ?? pick.runId ?? null, tripId: null,
        nextTrips: run ? run.trips.filter((trip) => trip.departsAt >= clock - 60_000).slice(0, NEXT_TRIPS).map(toNext) : [],
        confidence: pick.confidence, source: pick.source } };
    };
    const claimedFor = (operatorId) => {
      const prefix = `${operatorId}|${date}|`;
      return new Set([...claimed].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
    };

    let pending = idle;
    // Each round either settles one boat or retires one contested run, so it ends.
    for (let round = 0; pending.length && round < 10_000; round += 1) {
      const offers = pending.map((item) => {
        const { runs, patterns } = context(item.operatorId);
        const estimate = quietly(() => estimateFromPatterns({ vesselId: item.vesselId, operatorId: item.operatorId, dayType: type, patterns, runs,
          claimed: claimedFor(item.operatorId) }), null);
        return estimate ? { item, estimate } : null;
      }).filter(Boolean);
      if (!offers.length) break;
      offers.sort((left, right) => right.estimate.confidence - left.estimate.confidence || right.estimate.evidence.count - left.estimate.evidence.count ||
        String(left.item.vesselId).localeCompare(String(right.item.vesselId)));
      const top = offers[0];
      const contested = offers.some((other) => other !== top && other.item.operatorId === top.item.operatorId &&
        other.estimate.runSignature === top.estimate.runSignature && other.estimate.confidence === top.estimate.confidence &&
        other.estimate.evidence.count === top.estimate.evidence.count);
      claimed.add(claimKey(top.item.operatorId, top.estimate.runSignature, date));
      if (contested) continue;
      result.set(top.item.vesselId, describe(top.item.operatorId, top.estimate).assignment);
      pending = pending.filter((item) => item !== top.item);
    }
    for (const source of STORED_SOURCES) {
      for (const item of idle) {
        if (result.has(item.vesselId)) continue;
        const pick = context(item.operatorId).stored.find((estimate) => estimate.vesselId === item.vesselId && estimate.source === source);
        if (!pick) continue;
        const described = describe(item.operatorId, pick);
        if (described.signature && claimed.has(claimKey(item.operatorId, described.signature, date))) continue;
        if (described.signature) claimed.add(claimKey(item.operatorId, described.signature, date));
        result.set(item.vesselId, described.assignment);
      }
    }
    return result;
  }

  /** Rebuild what has been learned about which hull works which run. Cheap; run a few times a day. */
  function learn() {
    if (!schedule) return { operators: 0, patterns: 0 };
    let patterns = 0, operators = 0;
    for (const operatorId of schedule.operators.keys()) {
      const observations = quietly(() => store.listTripObservations({ operatorId, limit: LEARN_OBSERVATIONS }), []);
      if (!observations.length) continue;
      const dates = [...new Set(observations.map((item) => item.serviceDate))];
      const rows = buildPatterns(observations, dates.flatMap((date) => runsFor(operatorId, date)));
      quietly(() => store.replacePatterns(operatorId, rows));
      patterns += rows.length;
      operators += 1;
    }
    return { operators, patterns };
  }

  return { sighting, dwell, link, nameCollision, runFor, observe, withdraw, owns, serviceDateOf, allocate, learn, runsFor, today };
}
