import assert from "node:assert/strict";
import test from "node:test";

import { angleDifference, bearingDegrees, distanceMetres, median, offsetPoint } from "../lib/harbor-geo.js";

// Synthetic points only: a made-up origin in open water, nowhere near a real berth.
const ORIGIN = { latitude: 40.5, longitude: -74 };

test("distance is zero for the same point and symmetric between two", () => {
  const other = { latitude: 40.51, longitude: -73.99 };
  assert.equal(distanceMetres(ORIGIN, ORIGIN), 0);
  assert.equal(distanceMetres(ORIGIN, other), distanceMetres(other, ORIGIN));
});

test("one minute of latitude is one nautical mile", () => {
  const north = { latitude: 40.5 + 1 / 60, longitude: -74 };
  assert.ok(Math.abs(distanceMetres(ORIGIN, north) - 1852) < 3);
});

test("slip-scale distances resolve to well under a metre", () => {
  const twelveMetresEast = offsetPoint(ORIGIN, 90, 12);
  assert.ok(Math.abs(distanceMetres(ORIGIN, twelveMetresEast) - 12) < 0.05);
});

test("bearing runs clockwise from north and stays inside 0 to 360", () => {
  assert.ok(Math.abs(bearingDegrees(ORIGIN, { latitude: 40.6, longitude: -74 }) - 0) < 0.01);
  assert.ok(Math.abs(bearingDegrees(ORIGIN, { latitude: 40.5, longitude: -73.9 }) - 90) < 0.1);
  assert.ok(Math.abs(bearingDegrees(ORIGIN, { latitude: 40.4, longitude: -74 }) - 180) < 0.01);
  assert.ok(Math.abs(bearingDegrees(ORIGIN, { latitude: 40.5, longitude: -74.1 }) - 270) < 0.1);
});

test("a point offset by a bearing and distance comes back at that bearing and distance", () => {
  const moved = offsetPoint(ORIGIN, 225, 400);
  assert.ok(Math.abs(distanceMetres(ORIGIN, moved) - 400) < 0.5);
  assert.ok(Math.abs(bearingDegrees(ORIGIN, moved) - 225) < 0.1);
});

test("angle difference is the short way round and never negative", () => {
  assert.equal(angleDifference(350, 10), 20);
  assert.equal(angleDifference(10, 350), 20);
  assert.equal(angleDifference(0, 180), 180);
  assert.equal(angleDifference(90, 90), 0);
  assert.equal(angleDifference(-10, 370), 20);
});

test("a missing coordinate or angle gives null rather than a number that looks real", () => {
  assert.equal(distanceMetres(ORIGIN, { latitude: null, longitude: -74 }), null);
  assert.equal(distanceMetres(null, ORIGIN), null);
  assert.equal(bearingDegrees(ORIGIN, ORIGIN), null);
  assert.equal(angleDifference(null, 90), null);
  assert.equal(angleDifference(90, undefined), null);
});

test("median ignores non-numbers and is null for nothing", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, null, NaN, 7]), 6);
  assert.equal(median([]), null);
});
