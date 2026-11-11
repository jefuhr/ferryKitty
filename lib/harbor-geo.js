// The small amount of geometry the harbor tracker needs, in one place so that the slip index, the
// state machine and the fusion step all measure the same way. Everything here is metres and degrees
// clockwise from true north, on a sphere: over the few hundred metres that separate a boat from a
// berth the difference from an ellipsoid is centimetres, which is far below what AIS can resolve.

const EARTH_RADIUS_METRES = 6371008.8;
const RADIANS = Math.PI / 180;

function isPoint(point) {
  return Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude);
}

/** Great-circle distance in metres, or null when either point has no position. */
export function distanceMetres(from, to) {
  if (!isPoint(from) || !isPoint(to)) return null;
  const latitude1 = from.latitude * RADIANS, latitude2 = to.latitude * RADIANS;
  const deltaLatitude = latitude2 - latitude1, deltaLongitude = (to.longitude - from.longitude) * RADIANS;
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from one point to another, 0 to 360, or null when there is no direction to give. */
export function bearingDegrees(from, to) {
  if (!isPoint(from) || !isPoint(to)) return null;
  if (from.latitude === to.latitude && from.longitude === to.longitude) return null;
  const latitude1 = from.latitude * RADIANS, latitude2 = to.latitude * RADIANS;
  const deltaLongitude = (to.longitude - from.longitude) * RADIANS;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  return (Math.atan2(y, x) / RADIANS + 360) % 360;
}

/** The smaller angle between two headings, 0 to 180, or null when either is unknown. */
export function angleDifference(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/** The point a given distance away on a given bearing. Used to move a fix from antenna to bow. */
export function offsetPoint(from, bearing, metres) {
  if (!isPoint(from) || !Number.isFinite(bearing) || !Number.isFinite(metres)) return null;
  const angular = metres / EARTH_RADIUS_METRES, theta = bearing * RADIANS;
  const latitude1 = from.latitude * RADIANS, longitude1 = from.longitude * RADIANS;
  const latitude2 = Math.asin(Math.sin(latitude1) * Math.cos(angular) + Math.cos(latitude1) * Math.sin(angular) * Math.cos(theta));
  const longitude2 = longitude1 + Math.atan2(Math.sin(theta) * Math.sin(angular) * Math.cos(latitude1), Math.cos(angular) - Math.sin(latitude1) * Math.sin(latitude2));
  return { latitude: latitude2 / RADIANS, longitude: longitude2 / RADIANS };
}

/** Median of the finite numbers in a list, or null when there are none. */
export function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
