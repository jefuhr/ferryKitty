import { normalizeHarborServiceDate } from "./harbor-schedule.js";
import { buildPatterns, buildRuns, dayType, estimateFromPatterns, runOfTrip, tripsAfter } from "./harbor-runs.js";
import { normalizeIdentity } from "./realtime.js";
import { zonedParts } from "../public/assets/schedule.js";

// What the tracker writes down, and what it reads back to say which run a boat is on.
//
// lib/harbor-service.js holds the live picture and forgets it after a few hours. This is the part
// that keeps the long record in the database (who was seen, where they sat, which trips they were
// matched to) and turns that record, with the timetable's runs, into an assignment for each boat.
// It never decides where a boat is; it only remembers and estimates.

const NEXT_TRIPS = 5;
const RUN_CONFIDENCE = 0.7;
const LEARN_OBSERVATIONS = 1000;
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
      name: track?.static?.name ?? null, callSign: track?.static?.callSign ?? null }), false);
  }

  // A transponder using a name the roster already gave to another transponder. First heard still
  // wins in the live tracker; this makes sure a person gets to see that there were two.
  function nameCollision(track, roster) {
    const name = normalizeIdentity(track.static?.name);
    if (!name || !track.mmsi || collisions.has(track.mmsi)) return;
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
    if (!trip?.tripId || !trip.serviceDate || !operatorId) return;
    const run = runFor(operatorId, trip);
    quietly(() => store.recordTripObservation({ trackKey: track.key, mmsi: track.mmsi ?? null, vesselId: track.vesselId ?? null,
      operatorId, tripId: String(trip.tripId), routeId: trip.routeId ?? null, runId: run?.runId ?? null,
      serviceDate: compact(trip.serviceDate), terminalId, departedAt, arrivedTerminalId, arrivedAt,
      confidence: trip.confidence ?? 0.5, source: trip.source ?? "schedule" }));
  }

  const upcoming = (run, tripId, clock) => tripsAfter(run, tripId).filter((trip) => trip.departsAt >= clock - 60_000).slice(0, NEXT_TRIPS)
    .map((trip) => ({ tripId: trip.tripId, routeId: trip.routeId, departsAt: trip.departsAt, fromStopId: trip.firstStopId }));

  /** Which run a boat is on, best source first. Null when nothing at all is known. */
  function assignment({ track, vesselId, operatorId, clock = now() }) {
    if (!operatorId) return null;
    const trip = track?.trip;
    if (trip?.tripId) {
      const date = trip.serviceDate ?? today(clock);
      const run = runOfTrip(runsFor(operatorId, date), String(trip.tripId));
      return { routeId: trip.routeId ?? run?.trips.find((item) => item.tripId === String(trip.tripId))?.routeId ?? null,
        runId: run?.runId ?? null, tripId: String(trip.tripId), nextTrips: upcoming(run, String(trip.tripId), clock),
        confidence: trip.confidence ?? null, source: trip.source };
    }
    // Between trips: the boat keeps the run of the last trip it was confirmed on, for as long as
    // that run still has trips to work.
    const held = track?.run;
    if (held && held.operatorId === operatorId) {
      const run = runsFor(operatorId, held.serviceDate).find((item) => item.runId === held.runId);
      const next = upcoming(run, held.lastTripId, clock);
      if (run && next.length) return { routeId: next[0].routeId, runId: run.runId, tripId: null, nextTrips: next, confidence: RUN_CONFIDENCE, source: "run" };
    }
    if (!vesselId) return null;
    const date = today(clock);
    const runs = runsFor(operatorId, date);
    const learned = quietly(() => estimateFromPatterns({ vesselId, operatorId, dayType: dayType(date),
      patterns: store.listPatterns({ operatorId }), runs }), null);
    const stored = quietly(() => store.listEstimates({ serviceDate: date, vesselId }), []);
    const pick = learned ?? STORED_SOURCES.map((source) => stored.find((item) => item.source === source)).find(Boolean) ?? null;
    if (!pick) return null;
    const run = runs.find((item) => item.runId === pick.runId) ?? runs.find((item) => item.signature === pick.runSignature) ?? null;
    return { routeId: pick.routeId ?? run?.trips[0]?.routeId ?? null, runId: run?.runId ?? pick.runId ?? null, tripId: null,
      nextTrips: run ? run.trips.filter((trip) => trip.departsAt >= clock - 60_000).slice(0, NEXT_TRIPS)
        .map((trip) => ({ tripId: trip.tripId, routeId: trip.routeId, departsAt: trip.departsAt, fromStopId: trip.firstStopId })) : [],
      confidence: pick.confidence, source: pick.source };
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

  return { sighting, dwell, link, nameCollision, runFor, observe, assignment, learn, runsFor, today };
}
