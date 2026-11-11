import { distanceMetres } from "./harbor-geo.js";

// Entry and exit limits differ deliberately: ordinary AIS jitter must not end a dwell.
export const THRESHOLDS = Object.freeze({
  dockMaxSpeedKnots: 0.5,
  dockRadiusMetres: 35,
  dockMinFixes: 2,
  dockMinSpanMs: 30_000,
  mooredNavStatus: 5,
  departureMinSpeedKnots: 2,
  departureMinFixes: 2,
  departureRadiusMetres: 60,
  landingExitMarginMetres: 25,
  approachRadiusMetres: 400,
  arrivalMaxSpeedKnots: 12,
  rangeSamples: 3,
  rangeMinChangeMetres: 5,
  departingMaxMs: 180_000,
  nonPassengerLayupMs: 300_000,
  passengerLayupMs: 5_400_000,
  landingRadiusMetres: 120,
  movingMinSpeedKnots: 2,
  movingStaleMs: 90_000,
  stationaryStaleMs: 360_000,
  lostMs: 1_200_000,
  dockMaxPoints: 10,
  recentMaxFixes: 20,
  slipChangeMinP: 0.6
});

export function emptyTrack(key) {
  return {
    key,
    mmsi: key.startsWith("vessel:") ? null : key,
    vesselId: null,
    identitySource: null,
    static: null,
    fix: null,
    recent: [],
    state: "unknown",
    stateSince: 0,
    moving: false,
    stale: false,
    dock: null,
    lastDock: null,
    pending: null,
    trip: null
  };
}

function event(track, type, at, fields = {}) {
  return { type, key: track.key, at, ...fields };
}

function inState(track, state, at) {
  return track.state === state ? track : { ...track, state, stateSince: at };
}

function atBerth(track) {
  return track.dock !== null && (track.state === "docked" || track.state === "laid-up");
}

function speedAtLeast(fix, minimum) {
  return Number.isFinite(fix?.sogKnots) && fix.sogKnots >= minimum;
}

function landingById(index, landingStopId) {
  return index.landings.find((landing) => landing.landingStopId === landingStopId) ?? null;
}

function landingRadius(landing) {
  return landing.radiusMetres ?? THRESHOLDS.landingRadiusMetres;
}

function rangeTrend(recent, landing) {
  const samples = recent.slice(-THRESHOLDS.rangeSamples);
  if (!landing || samples.length < THRESHOLDS.rangeSamples) return { closing: false, opening: false };
  const ranges = samples.map((fix) => distanceMetres(fix, landing));
  if (!ranges.every(Number.isFinite)) return { closing: false, opening: false };
  const change = ranges.at(-1) - ranges[0];
  return {
    closing: -change >= THRESHOLDS.rangeMinChangeMetres && ranges.every((range, index) => index === 0 || range < ranges[index - 1]),
    opening: change >= THRESHOLDS.rangeMinChangeMetres && ranges.every((range, index) => index === 0 || range > ranges[index - 1])
  };
}

function stoppingLanding(fix, index) {
  // Unknown speed is not evidence of stopping, even if AIS also says "moored".
  if (!Number.isFinite(fix.sogKnots) || fix.sogKnots > THRESHOLDS.dockMaxSpeedKnots) return null;
  const candidates = index.slipsNear(fix, THRESHOLDS.dockRadiusMetres).map(({ slip, distanceMetres: distance }) => ({
    landing: landingById(index, slip.landingStopId), distance
  })).filter(({ landing }) => landing !== null);
  for (const landing of index.landings) {
    if (landing.slipIds.length) continue;
    const distance = distanceMetres(fix, landing);
    if (distance !== null && distance <= landingRadius(landing)) candidates.push({ landing, distance });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0]?.landing ?? null;
}

function leftBerth(track, index, recent) {
  const fast = recent.slice(-THRESHOLDS.departureMinFixes);
  if (fast.length >= THRESHOLDS.departureMinFixes && fast.every((fix) => speedAtLeast(fix, THRESHOLDS.departureMinSpeedKnots))) return true;
  const landing = landingById(index, track.dock.landingStopId);
  if (!landing) return false;
  const fix = recent.at(-1);
  if (!landing.slipIds.length) {
    return distanceMetres(fix, landing) > landingRadius(landing) + THRESHOLDS.landingExitMarginMetres;
  }
  const distances = landing.slipIds.flatMap((id) => (index.byId.get(id)?.points ?? []).map((point) => distanceMetres(fix, point)))
    .filter(Number.isFinite);
  return distances.length > 0 && distances.every((distance) => distance > THRESHOLDS.departureRadiusMetres);
}

function dockAssignment(previous, landing, points, fix, { slipIndex, assignSlip, slipHeadings }) {
  const assigned = assignSlip(points, slipIndex, {
    landingStopId: landing.landingStopId,
    headingDegrees: fix.headingDegrees ?? null,
    slipHeadings
  });
  let slipId = assigned.slipId;
  if (previous && slipId !== previous.slipId) {
    const candidate = assigned.candidates.find((item) => item.slipId === slipId);
    // The winning probability matters, even when ambiguity caps the reported confidence.
    if (!slipId || !candidate || candidate.p < THRESHOLDS.slipChangeMinP) slipId = previous.slipId;
  }
  const retained = assigned.candidates.find((candidate) => candidate.slipId === slipId);
  const confidence = slipId === assigned.slipId ? assigned.confidence : Math.min(assigned.confidence, retained?.p ?? 0);
  return {
    landingStopId: landing.landingStopId,
    landingId: landing.landingId ?? null,
    slipId,
    // Refreshes need the dwell rule without receiving the slip index again.
    kind: slipIndex.byId.get(slipId)?.kind ?? (landing.yard ? "yard" : "passenger"),
    confidence,
    ambiguous: assigned.ambiguous,
    candidates: assigned.candidates.map((candidate) => ({ ...candidate })),
    since: previous?.since ?? fix.at,
    points
  };
}

function underwayState(previous, track, index) {
  const fix = track.fix;
  const departedLanding = track.lastDock && landingById(index, track.lastDock.landingStopId);
  const sinceDeparture = track.lastDock ? fix.at - track.lastDock.until : null;
  if (departedLanding && sinceDeparture >= 0 && sinceDeparture < THRESHOLDS.departingMaxMs &&
      distanceMetres(fix, departedLanding) <= THRESHOLDS.approachRadiusMetres &&
      (previous.state === "departing" || rangeTrend(track.recent, departedLanding).opening)) {
    return inState(track, "departing", fix.at);
  }

  // Keep an approach through a slow or stationary report; only a sustained opening ends it.
  const approaching = previous.state === "arriving" ? index.nearestLanding(previous.fix)?.landing : null;
  if (approaching && !rangeTrend(track.recent, approaching).opening) return inState(track, "arriving", fix.at);
  const nearest = index.nearestLanding(fix);
  if (nearest && nearest.distanceMetres <= THRESHOLDS.approachRadiusMetres &&
      Number.isFinite(fix.sogKnots) && fix.sogKnots < THRESHOLDS.arrivalMaxSpeedKnots &&
      rangeTrend(track.recent, nearest.landing).closing) {
    return inState(track, "arriving", fix.at);
  }
  return inState(track, "underway", fix.at);
}

// Time-only transitions share one path so refreshes and incoming fixes cannot disagree.
function ageTrack(track, now) {
  if (!track.fix) return { track, events: [] };
  const age = Math.max(0, now - track.fix.at);
  const freshness = speedAtLeast(track.fix, THRESHOLDS.movingMinSpeedKnots) ? THRESHOLDS.movingStaleMs : THRESHOLDS.stationaryStaleMs;
  let next = { ...track, stale: age > freshness };
  if (age > THRESHOLDS.lostMs) {
    next = { ...inState(next, "unknown", now), dock: null, pending: null };
    return { track: next, events: track.state === "unknown" ? [] : [event(next, "lost", now)] };
  }
  if (next.state === "departing" && next.lastDock && now - next.lastDock.until >= THRESHOLDS.departingMaxMs) {
    next = inState(next, "underway", now);
  }
  if (next.state === "docked" && next.dock) {
    const layupMs = next.dock.kind === "passenger" ? THRESHOLDS.passengerLayupMs : THRESHOLDS.nonPassengerLayupMs;
    if (now - next.dock.since >= layupMs) {
      next = inState(next, "laid-up", now);
      return { track: next, events: [event(next, "laid-up", now, { landingStopId: next.dock.landingStopId, slipId: next.dock.slipId })] };
    }
  }
  return { track: next, events: [] };
}

export function refreshTrack(track, { now = track.fix?.at ?? 0 } = {}) {
  return ageTrack(track, now);
}

export function advanceTrack(track, fix, { slipIndex, assignSlip, now = fix?.at, slipHeadings = new Map() }) {
  if (!Number.isFinite(fix?.at) || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) ||
      (track.fix && fix.at <= track.fix.at)) return { track, events: [] };
  const accepted = { ...fix };
  const recent = [...track.recent, accepted].slice(-THRESHOLDS.recentMaxFixes);
  let next = { ...track, fix: accepted, recent, moving: speedAtLeast(fix, THRESHOLDS.movingMinSpeedKnots) };
  const events = [];

  if (atBerth(track)) {
    if (leftBerth(track, slipIndex, recent)) {
      events.push(event(next, "departed", fix.at, {
        landingStopId: track.dock.landingStopId, slipId: track.dock.slipId,
        dockedAt: track.dock.since, departedAt: fix.at
      }));
      next = { ...next, dock: null, pending: null, lastDock: { ...track.dock, until: fix.at } };
      next = underwayState(track, next, slipIndex);
    } else {
      const landing = landingById(slipIndex, track.dock.landingStopId);
      const points = [...track.dock.points, accepted].slice(-THRESHOLDS.dockMaxPoints);
      const dock = landing ? dockAssignment(track.dock, landing, points, fix, { slipIndex, assignSlip, slipHeadings }) : { ...track.dock, points };
      next = { ...next, dock, pending: null };
      if (dock.slipId !== track.dock.slipId) {
        events.push(event(next, "slip-changed", fix.at, { landingStopId: dock.landingStopId, slipId: dock.slipId, confidence: dock.confidence }));
      }
    }
  } else {
    const landing = stoppingLanding(fix, slipIndex);
    let pending = null;
    if (landing) {
      const previous = track.pending?.landingStopId === landing.landingStopId ? track.pending : null;
      // Preserve the start even when high-rate reports roll out of recent.
      pending = {
        landingStopId: landing.landingStopId,
        since: previous?.since ?? fix.at,
        fixes: (previous?.fixes ?? 0) + 1,
        points: [...(previous?.points ?? []), accepted].slice(-THRESHOLDS.dockMaxPoints)
      };
    }
    const mooredArrival = track.state === "arriving" && fix.navStatus === THRESHOLDS.mooredNavStatus;
    if (pending && (mooredArrival || (pending.fixes >= THRESHOLDS.dockMinFixes && fix.at - pending.since >= THRESHOLDS.dockMinSpanMs))) {
      const dock = { ...dockAssignment(null, landing, pending.points, fix, { slipIndex, assignSlip, slipHeadings }), since: pending.since };
      next = { ...inState(next, "docked", fix.at), dock, pending: null };
      events.push(event(next, "docked", fix.at, { landingStopId: dock.landingStopId, slipId: dock.slipId, confidence: dock.confidence }));
    } else {
      next = underwayState(track, { ...next, pending, dock: null }, slipIndex);
    }
  }

  const aged = ageTrack(next, now);
  return { track: aged.track, events: [...events, ...aged.events] };
}
