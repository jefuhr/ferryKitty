import { distanceMetres } from "./harbor-geo.js";
import { normalizeIdentity } from "./realtime.js";

const KNOTS_PER_METRE_SECOND = 3600 / 1852;
const TRIP_AUTHORITY_SECONDS = 180;
// Spherical offsets can land a few billionths of a metre outside an inclusive boundary.
const DISTANCE_EPSILON = 1e-6;

function usablePoint(point) {
  return Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point?.longitude) && Math.abs(point.longitude) <= 180;
}

function usableTime(value) {
  return Number.isFinite(value) && value >= 0;
}

/** A GTFS bearing is a course over ground; it does not establish the vessel's true heading. */
export function operatorFix(position, { fallbackAt = null } = {}) {
  if (!usablePoint(position)) return null;
  const at = usableTime(position.updatedAtEpochSeconds) ? position.updatedAtEpochSeconds * 1000 : fallbackAt;
  if (!usableTime(at)) return null;
  return {
    mmsi: null, latitude: position.latitude, longitude: position.longitude,
    sogKnots: Number.isFinite(position.speed) && position.speed >= 0 ? position.speed * KNOTS_PER_METRE_SECOND : null,
    cogDegrees: Number.isFinite(position.bearing) && position.bearing >= 0 && position.bearing < 360 ? position.bearing : null,
    headingDegrees: null, navStatus: null, at, source: "operator", aisClass: null
  };
}

function positionVessel(position, vessels) {
  const names = new Set([position.boatName, position.vesselNumber].map(normalizeIdentity).filter(Boolean));
  const matches = vessels.filter(vessel => vessel.operatorId === "nycf" && vessel.active !== false &&
    [vessel.name, vessel.number, vessel.id].some(value => value && names.has(normalizeIdentity(value))));
  // A normalized position already carries the fleet's canonical name and number. Exact identity
  // avoids binding "Test Ferry One Extra" to "Test Ferry One", or picking between conflicting ids.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Old positions remain joinable, but their top-level trip fields are cleared. `position` retains
 * the original report, while `authoritative` is true only with a timestamp younger than 180 s.
 * Tracks may be an array or a Map of the contract's Track objects.
 */
export function joinOperatorPositions({ tracks, positions, roster, now }) {
  const trackList = tracks instanceof Map ? [...tracks.values()] : tracks || [];
  const vessels = roster.vessels || [...(roster.byId?.values() || [])];
  const joined = [];
  for (const position of positions || []) {
    const vessel = positionVessel(position, vessels);
    if (!vessel) continue;
    const matching = trackList.filter(track => {
      if (track.vesselId) return track.vesselId === vessel.id;
      const byMmsi = roster.byMmsi?.get(track.mmsi);
      return (byMmsi?.id || byMmsi?.vesselId) === vessel.id || (track.mmsi != null && track.mmsi === vessel.mmsi);
    });
    // During a source handover both keys can exist. The AIS key is the lasting identity.
    const track = matching.find(track => track.mmsi) || matching[0];
    const ageSeconds = usableTime(position.updatedAtEpochSeconds) && usableTime(now)
      ? Math.max(0, (now - position.updatedAtEpochSeconds * 1000) / 1000) : null;
    const authoritative = ageSeconds != null && ageSeconds < TRIP_AUTHORITY_SECONDS;
    joined.push({
      key: track?.key || `vessel:${vessel.id}`, vesselId: vessel.id,
      tripId: authoritative ? position.tripId ?? null : null,
      stopSequence: authoritative ? position.stopSequence ?? null : null,
      position, ageSeconds, authoritative
    });
  }
  return joined;
}

function bindingEvidence(records, boundMmsis) {
  const ordered = [...records].sort((left, right) => left.sample.operator?.at - right.sample.operator?.at);
  const distinct = new Map();
  for (const { sample, candidate } of ordered) {
    if (!usableTime(sample.operator?.at) || !usablePoint(sample.operator) || !usablePoint(candidate) ||
      !Number.isFinite(candidate.sogKnots) || candidate.sogKnots < 5 || candidate.docked !== false) return false;
    if (distanceMetres(sample.operator, candidate) > 75 + DISTANCE_EPSILON) return false;
    const competing = (sample.candidates || []).some(other => other.mmsi !== candidate.mmsi &&
      !boundMmsis.has(other.mmsi) && usablePoint(other) &&
      distanceMetres(sample.operator, other) <= 150 + DISTANCE_EPSILON);
    if (competing) return false;
    // Re-reading one cached operator position is not another independent observation. Validate
    // every supplied record above, then count and measure motion on distinct measured times.
    if (!distinct.has(sample.operator.at)) distinct.set(sample.operator.at, candidate);
  }
  const times = [...distinct.keys()];
  if (times.length < 5 || times.at(-1) - times[0] < 180_000) return false;
  const points = [...distinct.values()];
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) travelled += distanceMetres(points[index - 1], points[index]);
  return travelled + DISTANCE_EPSILON >= 500;
}

/**
 * Every observation for a proposed pair must satisfy the gates; a bad sample cannot be silently
 * dropped to manufacture a successful five-sample subset. Distances travelled follow the ordered
 * AIS positions, already interpolated by the caller to each operator position's measured time.
 */
export function proximityBindings({ samples, now, boundMmsis = new Set(), boundVesselIds = new Set() }) {
  if (!usableTime(now)) return [];
  const pairs = new Map();
  for (const sample of samples || []) {
    if (!sample.vesselId || boundVesselIds.has(sample.vesselId)) continue;
    for (const candidate of sample.candidates || []) {
      if (!/^\d{9}$/.test(candidate.mmsi || "") || boundMmsis.has(candidate.mmsi)) continue;
      const key = JSON.stringify([sample.vesselId, candidate.mmsi]);
      const pair = pairs.get(key) || { vesselId: sample.vesselId, mmsi: candidate.mmsi, records: [] };
      pair.records.push({ sample, candidate });
      pairs.set(key, pair);
    }
  }
  const eligible = [...pairs.values()].filter(pair => bindingEvidence(pair.records, boundMmsis));
  const mmsiCounts = new Map(), vesselCounts = new Map();
  for (const pair of eligible) {
    mmsiCounts.set(pair.mmsi, (mmsiCounts.get(pair.mmsi) || 0) + 1);
    vesselCounts.set(pair.vesselId, (vesselCounts.get(pair.vesselId) || 0) + 1);
  }
  // Even without a second AIS candidate, two operator vessels can both fit the same MMSI. Neither
  // has an exclusive identity in that case, so do not let input order choose a winner.
  return eligible.filter(pair => mmsiCounts.get(pair.mmsi) === 1 && vesselCounts.get(pair.vesselId) === 1)
    .sort((left, right) => left.vesselId.localeCompare(right.vesselId) || left.mmsi.localeCompare(right.mmsi))
    .map(({ mmsi, vesselId }) => ({ mmsi, vesselId, source: "proximity", at: now }));
}
