// The harbor the boats are drawn on, and what each boat out there is doing.
//
// Nothing here fetches a tile. The page draws OpenStreetMap and OpenSeaMap underneath what this
// module produces, but that is the browser's business and a backdrop it can do without: everything
// below is derived from the bundled feed, so a board with no signal still gets its harbor. The
// interesting geography for a ferry is the ferry network anyway, and shapes.txt already traces
// every route across the water — on a system whose lines are two rivers and a bay, drawing those
// lines draws the harbor. The landings sit on top of that, and the boats on top of those.
//
// Everything static here is built once at startup, for the same reason lib/landing-data.js builds
// there: the inputs are the bundled feed and the config files, which only change on redeploy.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./schedule-builder.js";
import { activeServices, addDays, zonedParts } from "../public/assets/schedule.js";

// Roughly a metre. Five decimal places on a coordinate is finer than any boat is drawn and finer
// than the feed's own fix, and dropping the rest takes a third off the geometry a phone downloads.
const PRECISION = 1e5;

// GTFS-realtime reports speed in metres per second; the boats are talked about in knots.
const KNOTS_PER_METRE_SECOND = 1.94384;

// A vehicle whose last fix is much older than the rest of the feed is not out on the water, it is a
// row nobody cleaned up — a boat tied up for the night still sitting in the feed where it moored.
// Measured against the snapshot rather than against now, so a stale cache still draws the harbor as
// it was when it was last read instead of emptying out one boat at a time.
const MAX_REPORT_AGE_SECONDS = 20 * 60;

function round(value) {
  return Math.round(value * PRECISION) / PRECISION;
}

function hexColor(value, fallback) {
  return /^[0-9a-f]{6}$/i.test(value || "") ? `#${value.toUpperCase()}` : fallback;
}

/**
 * Every route in the feed, keyed by id.
 *
 * route_type 3 is a bus, and the Rockaway shuttles really are buses that this operator runs and
 * this vendor tracks. They are kept rather than dropped so that a vehicle turning up on one can be
 * labelled as what it is; a page that calls everything a boat would quietly promote a coach on
 * Beach Channel Drive to a ferry.
 */
export function routeIndex(routesCsv) {
  return new Map(parseCsv(routesCsv).map((route) => [route.route_id, {
    id: route.route_id,
    shortName: route.route_short_name || route.route_id,
    name: route.route_long_name || route.route_short_name || route.route_id,
    color: hexColor(route.route_color, "#0B3D91"),
    textColor: hexColor(route.route_text_color, "#FFFFFF"),
    mode: route.route_type === "3" ? "bus" : "ferry"
  }]));
}

/**
 * shapes.txt as drawable polylines, ordered by shape_pt_sequence.
 *
 * The sequence numbers are not dense and not always sorted in the file, so the order is taken from
 * the column rather than from the row order.
 */
export function shapePaths(shapesCsv) {
  const points = new Map();
  for (const row of parseCsv(shapesCsv)) {
    const latitude = Number(row.shape_pt_lat);
    const longitude = Number(row.shape_pt_lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const list = points.get(row.shape_id) || [];
    list.push({ sequence: Number(row.shape_pt_sequence), latitude, longitude });
    points.set(row.shape_id, list);
  }
  const paths = new Map();
  for (const [shapeId, list] of points) {
    list.sort((left, right) => left.sequence - right.sequence);
    paths.set(shapeId, list.map((point) => [round(point.latitude), round(point.longitude)]));
  }
  return paths;
}

// A line drawn twice is a line drawn twice. Most routes have one shape per direction over the same
// water in opposite order, and on a static picture the second one only costs bytes: it lands
// exactly under the first. Compared in whichever order sorts first so a path and its reverse
// collapse together.
function pathKey(points) {
  const forward = JSON.stringify(points);
  const backward = JSON.stringify([...points].reverse());
  return forward < backward ? forward : backward;
}

/**
 * The static picture: one entry per route, each carrying the distinct paths its trips are drawn
 * along, plus the docks and the bounds that hold all of it.
 *
 * Landings come from the caller rather than from stops.txt on purpose. stops.txt holds 50 rows, and
 * half of them are bus stops along Rockaway Beach Boulevard; the landings the board knows are the
 * 30 docks a person recognizes, they carry display names, and they include the three docks NYC
 * Ferry does not call at (Whitehall, Soissons Landing) or publish at all (Pier C).
 */
export function buildHarborMap({ routes: routesCsv, trips: tripsCsv, shapes: shapesCsv, landings = [], chart = null }) {
  const routesById = routeIndex(routesCsv);
  const paths = shapePaths(shapesCsv);
  const drawn = new Map();
  for (const trip of parseCsv(tripsCsv)) {
    const route = routesById.get(trip.route_id);
    // Only the boats' own lines are drawn. A bus route's shape is a road, and a road through the
    // middle of a map of the harbor reads as a route no ferry has ever taken.
    if (!route || route.mode !== "ferry") continue;
    const points = paths.get(trip.shape_id);
    if (!points || points.length < 2) continue;
    const forRoute = drawn.get(route.id) || new Map();
    forRoute.set(pathKey(points), points);
    drawn.set(route.id, forRoute);
  }

  const drawnRoutes = [...drawn]
    .map(([routeId, byKey]) => ({ ...routesById.get(routeId), paths: [...byKey.values()] }))
    .sort((left, right) => left.shortName.localeCompare(right.shortName));

  const docks = landings
    .filter((landing) => Number.isFinite(landing.latitude) && Number.isFinite(landing.longitude))
    .map((landing) => ({
      id: landing.id,
      name: landing.name,
      displayName: landing.displayName || landing.name,
      latitude: round(landing.latitude),
      longitude: round(landing.longitude)
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  const latitudes = [...drawnRoutes.flatMap((route) => route.paths.flat().map((point) => point[0])), ...docks.map((dock) => dock.latitude)];
  const longitudes = [...drawnRoutes.flatMap((route) => route.paths.flat().map((point) => point[1])), ...docks.map((dock) => dock.longitude)];
  const bounds = latitudes.length
    ? {
      minLatitude: Math.min(...latitudes), maxLatitude: Math.max(...latitudes),
      minLongitude: Math.min(...longitudes), maxLongitude: Math.max(...longitudes)
    }
    // An empty feed still has to produce a map the client can set a viewBox from. The harbor is a
    // reasonable thing to be looking at when there is nothing to draw on it.
    : { minLatitude: 40.56, maxLatitude: 40.81, minLongitude: -74.08, maxLongitude: -73.76 };

  const result = { bounds, routes: drawnRoutes, landings: docks };
  if (chart) result.chart = chart;
  return result;
}

/**
 * Which route a trip belongs to, where it is headed, and the stops it calls at in order.
 *
 * The vehicle feed says a boat is in transit to stop sequence 4 of trip 863 and stops there; the
 * name of that stop only exists in the static feed. Keyed by trip id, which is the id the realtime
 * feed uses.
 */
export function buildTripIndex({ trips: tripsCsv, stopTimes: stopTimesCsv, stops: stopsCsv }) {
  const stopsById = new Map(parseCsv(stopsCsv).map((stop) => [stop.stop_id, stop]));
  const stopsByTrip = new Map();
  for (const stopTime of parseCsv(stopTimesCsv)) {
    const stop = stopsById.get(stopTime.stop_id);
    const list = stopsByTrip.get(stopTime.trip_id) || [];
    list.push({
      sequence: Number(stopTime.stop_sequence),
      stopId: stopTime.stop_id,
      name: stop?.stop_name || stopTime.stop_id,
      // Carried so that a next stop can be matched to the dock drawn on the map by where it is
      // rather than by what it is called. The feed's stop names and the board's landing names are
      // different spellings of the same piers — "Atlantic Ave/BBP Pier 6" against "Atlantic
      // Avenue" — and comparing those strings is a game with no end.
      latitude: Number(stop?.stop_lat),
      longitude: Number(stop?.stop_lon)
    });
    stopsByTrip.set(stopTime.trip_id, list);
  }
  for (const list of stopsByTrip.values()) list.sort((left, right) => left.sequence - right.sequence);

  const index = new Map();
  for (const trip of parseCsv(tripsCsv)) {
    const stops = stopsByTrip.get(trip.trip_id) || [];
    index.set(trip.trip_id, {
      routeId: trip.route_id,
      serviceId: trip.service_id,
      directionId: trip.direction_id || null,
      destination: (trip.trip_headsign || stops.at(-1)?.name || "").trim() || null,
      stops
    });
  }
  return index;
}

/**
 * Verified trip identities used by today's vehicle feed. A numeric live ID can name a holiday
 * sailing and a different fall sailing, so keep candidates with their service calendars instead
 * of letting the last imported schedule overwrite the first one.
 */
export function buildServiceTripIndex({ byLanding, baseTrips = new Map(), stops: stopsCsv = "" }) {
  const rawStops = new Map(parseCsv(stopsCsv).map(stop => [stop.stop_id, stop]));
  const names = new Map();
  const departures = new Map();
  const calendars = new Map(), exceptions = new Map();
  const holidayDates = new Set();
  let timezone = "America/New_York";
  for (const data of byLanding?.values?.() || []) {
    // New landings may come from the current supplement rather than the historical root GTFS.
    const landing = data.meta?.landing;
    if (landing?.stopIds?.length === 1 && Number.isFinite(landing.latitude) && Number.isFinite(landing.longitude)) {
      for (const id of landing.stopIds || []) if (!rawStops.has(id)) {
        rawStops.set(id, { stop_lat: landing.latitude, stop_lon: landing.longitude });
      }
    }
    timezone = data.meta?.timezone || timezone;
    for (const date of data.meta?.holidaySchedule?.dates || []) holidayDates.add(date);
    for (const [id, stop] of Object.entries(data.stops || {})) names.set(id, stop.name);
    for (const row of data.departures || []) {
      // Passenger identities take precedence over an operational row reusing the arriving trip.
      const previous = departures.get(String(row.tripId));
      if (!previous || previous.outOfService && !row.outOfService) departures.set(String(row.tripId), row);
    }
    for (const calendar of data.calendars || []) calendars.set(JSON.stringify(calendar), calendar);
    for (const exception of data.exceptions || []) exceptions.set(JSON.stringify(exception), exception);
  }
  const trips = new Map(), seen = new Set();
  for (const data of byLanding?.values?.() || []) {
    for (const [publishedID, schedule] of Object.entries(data.tripSchedules || {})) {
      if (schedule.timetableOnly || !schedule.stops?.length) continue;
      const departure = departures.get(publishedID);
      const base = baseTrips.get(publishedID);
      const liveID = String(schedule.liveTripId || departure?.liveTripId || publishedID);
      const serviceId = schedule.serviceId || departure?.serviceId || base?.serviceId;
      const routeId = schedule.routeId || departure?.routeId || base?.routeId;
      if (!serviceId || !routeId || departure?.scheduleOnly && !departure.liveTripId && !schedule.liveTripId) continue;
      const stops = [...schedule.stops].sort((left, right) => left.sequence - right.sequence).map(call => {
        const source = rawStops.get(String(call.stopId));
        return {
          sequence: call.sequence, stopId: String(call.stopId),
          name: names.get(String(call.stopId)) || source?.stop_name || String(call.stopId),
          latitude: source?.stop_lat ? Number(source.stop_lat) : null,
          longitude: source?.stop_lon ? Number(source.stop_lon) : null,
          arrivalSeconds: call.arrivalSeconds, departureSeconds: call.departureSeconds
        };
      });
      const dated = schedule.liveTripIdsByDate || departure?.liveTripIdsByDate;
      const identities = new Map();
      if (dated) for (const [date, id] of Object.entries(dated)) {
        identities.set(id, [...(identities.get(id) || []), date]);
      }
      else identities.set(liveID, null);
      for (const [id, dates] of identities) {
        const key = JSON.stringify([id, dates, serviceId, routeId, stops.map(stop => [stop.stopId, stop.sequence, stop.arrivalSeconds, stop.departureSeconds])]);
        if (seen.has(key)) continue;
        seen.add(key);
        const candidates = trips.get(id) || [];
        candidates.push({
          serviceId, routeId, dates, directionId: departure?.directionId ?? base?.directionId ?? null,
          destination: stops.at(-1)?.name || null, stops,
          holiday: String(serviceId).startsWith("nyc:sukkot:") || publishedID.startsWith("nyc:sukkot:")
        });
        trips.set(id, candidates);
      }
    }
  }
  return { trips, timezone, holidayDates, calendars: [...calendars.values()], exceptions: [...exceptions.values()] };
}

export function serviceFrame(index, asOf) {
  const current = zonedParts(new Date(asOf), index.timezone);
  return { ...current, days: [-1, 0].map(offset => {
    const date = addDays(current.dateKey, offset);
    return { offset, date, holiday: index.holidayDates.has(date), active: activeServices(index, date) };
  }) };
}

export function describedServiceTrip(index, tripID, stopSequence, frame) {
  const candidates = [];
  for (const trip of index.trips.get(String(tripID)) || []) {
    for (const day of frame.days) {
      if (!day.active.has(trip.serviceId)) continue;
      if (trip.dates && !trip.dates.includes(day.date)) continue;
      // NYC's published holiday replaces its ordinary service even if a baseline calendar still
      // spans that date. Partner route IDs have their own calendars and are unaffected.
      if (!String(trip.routeId).includes(":") && trip.holiday !== day.holiday) continue;
      const moments = trip.stops.flatMap(stop => [stop.arrivalSeconds, stop.departureSeconds]).filter(Number.isFinite);
      if (day.offset === -1 && !moments.some(seconds => seconds >= 86400)) continue;
      const target = trip.stops.find(stop => stop.sequence === stopSequence);
      const seconds = target?.arrivalSeconds ?? target?.departureSeconds;
      const distance = Number.isFinite(seconds)
        ? Math.abs(day.offset * 86400 + seconds - frame.seconds)
        : moments.length ? Math.min(...moments.map(time => Math.abs(day.offset * 86400 + time - frame.seconds))) : Infinity;
      candidates.push({ trip, distance });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  const first = candidates[0], second = candidates[1];
  // Conflicting active identities with identical timing cannot be resolved by a position fix.
  if (first && second && first.distance === second.distance && first.trip.routeId !== second.trip.routeId) return null;
  return first?.trip || null;
}

/**
 * The live half: one entry per boat the feed can place, said in the terms the page needs.
 *
 * A position with no trip is kept. The feed names a trip for a boat that is working one, and a boat
 * repositioning, laying over or running light is still a boat on the water and still the answer to
 * "what is out there right now" — it just has no route, no destination and no next stop to give.
 */
export function describeBoats(positions = [], { trips = new Map(), serviceTrips = null, routes = new Map(), asOf = Date.now() } = {}) {
  const asOfSeconds = Math.floor(asOf / 1000);
  const frame = serviceTrips ? serviceFrame(serviceTrips, asOf) : null;
  const boats = [];
  for (const position of positions) {
    const reportedAt = position.updatedAtEpochSeconds ?? null;
    const ageSeconds = reportedAt == null ? null : Math.max(0, asOfSeconds - reportedAt);
    if (ageSeconds != null && ageSeconds > MAX_REPORT_AGE_SECONDS) continue;
    const trip = position.tripId
      ? serviceTrips ? describedServiceTrip(serviceTrips, position.tripId, position.stopSequence, frame)
        : trips.get(position.tripId) || null
      : null;
    const route = trip ? routes.get(trip.routeId) || null : null;
    // stop_sequence counts the calls on the trip, so it indexes the stop the boat is working
    // towards — or, when it is stopped, the one it is lying alongside.
    const stop = trip && position.stopSequence != null
      ? trip.stops.find((candidate) => candidate.sequence === position.stopSequence) || null
      : null;
    boats.push({
      id: position.id,
      name: position.boatName,
      number: position.vesselNumber,
      latitude: round(position.latitude),
      longitude: round(position.longitude),
      bearing: position.bearing == null ? null : Math.round(position.bearing),
      speedKnots: position.speed == null ? null : Math.round(position.speed * KNOTS_PER_METRE_SECOND * 10) / 10,
      tripId: position.tripId,
      routeId: route?.id ?? null,
      route: route?.shortName ?? null,
      routeName: route?.name ?? null,
      color: route?.color ?? null,
      mode: route?.mode ?? "ferry",
      destination: trip?.destination ?? null,
      status: position.status,
      stop: stop ? {
        id: stop.stopId,
        name: stop.name,
        latitude: Number.isFinite(stop.latitude) ? round(stop.latitude) : null,
        longitude: Number.isFinite(stop.longitude) ? round(stop.longitude) : null
      } : null,
      reportedAt: reportedAt == null ? null : new Date(reportedAt * 1000).toISOString(),
      ageSeconds
    });
  }
  // Grouped by line and then by the name on the hull, so a boat keeps its place in the list between
  // refreshes instead of jumping around as the feed reorders itself.
  return boats.sort((left, right) =>
    (left.route || "￿").localeCompare(right.route || "￿") ||
    (left.name || left.id).localeCompare(right.name || right.id));
}

/**
 * Reads the static feed once and returns both halves of what the map page needs: the picture to
 * draw, and the index that turns a live vehicle into a sentence.
 */
export async function loadHarborMap({ root, landings = [], byLanding = null }) {
  const [routes, trips, stops, shapes, stopTimes, chartRaw] = await Promise.all([
    readFile(path.join(root, "gtfs/routes.txt"), "utf8"),
    readFile(path.join(root, "gtfs/trips.txt"), "utf8"),
    readFile(path.join(root, "gtfs/stops.txt"), "utf8"),
    readFile(path.join(root, "gtfs/shapes.txt"), "utf8"),
    readFile(path.join(root, "gtfs/stop_times.txt"), "utf8"),
    readFile(path.join(root, "content/harbor-chart.json"), "utf8").catch(() => null)
  ]);
  const chart = chartRaw ? JSON.parse(chartRaw) : null;
  const indexedTrips = buildTripIndex({ trips, stopTimes, stops });
  return {
    map: buildHarborMap({ routes, trips, shapes, landings, chart }),
    trips: indexedTrips,
    serviceTrips: byLanding ? buildServiceTripIndex({ byLanding, baseTrips: indexedTrips, stops }) : null,
    routes: routeIndex(routes)
  };
}
