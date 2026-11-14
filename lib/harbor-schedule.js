import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARTNER_FEEDS, parseCsv, timeToSeconds } from "./schedule-builder.js";
import { activeServices, addDays, zonedParts } from "../public/assets/schedule.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TIMEZONE = "America/New_York";
const DAY_SECONDS = 86400;

function dateKey(value) {
  return /^\d{8}$/.test(value || "") ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}

/** Phase 2 stores compact service dates; the board's calendar helpers use dashed dates. */
export function normalizeHarborServiceDate(value) {
  const text = String(value ?? "");
  const day = dateKey(text) || (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null);
  if (!day || addDays(day, 0) !== day) throw new RangeError("Invalid harbor service date");
  return day;
}

export function tripClaimPriority(claim) {
  if (claim.source === "operator-rt") return 6;
  if (claim.source === "schedule" && claim.confidence >= 0.9) return 5;
  if (claim.source === "run") return 4;
  if (claim.source === "schedule") return 3;
  return claim.source === "pattern" ? 2 : claim.source === "model" ? 1 : 0;
}

function departureDistance(claim, schedule) {
  if (!schedule || !claim.serviceDate || !Number.isFinite(claim.departedAt) || claim.terminalId == null) return Infinity;
  const stops = schedule.trip(claim.tripId, normalizeHarborServiceDate(claim.serviceDate), claim.routeId)?.stops || [];
  const landing = new Set(stopIds(claim.terminalId));
  const distances = stops.filter(call => landing.has(call.stopId)).map(call => {
    const at = serviceTimeAt(normalizeHarborServiceDate(claim.serviceDate), call.departureSeconds, schedule.timezone);
    return at == null ? Infinity : Math.abs(at - claim.departedAt);
  });
  return Math.min(Infinity, ...distances);
}

/** Positive means left wins. Exact evidence ties use a stable track key, never ingestion order. */
export function compareTripClaims(left, right, { schedule = null } = {}) {
  const priority = tripClaimPriority(left) - tripClaimPriority(right);
  if (priority) return priority;
  if (left.source === "operator-rt") {
    const time = (left.observedAt ?? 0) - (right.observedAt ?? 0);
    if (time) return time;
  }
  if (left.source === "schedule") {
    const arrival = Number(Number.isFinite(left.arrivedAt)) - Number(Number.isFinite(right.arrivedAt));
    if (arrival) return arrival;
    const leftDistance = departureDistance(left, schedule), rightDistance = departureDistance(right, schedule);
    if (leftDistance !== rightDistance) return leftDistance < rightDistance ? 1 : -1;
  }
  return String(right.trackKey ?? right.key ?? "").localeCompare(String(left.trackKey ?? left.key ?? ""));
}

function serviceTimeAt(day, seconds, timezone) {
  if (!Number.isFinite(seconds)) return null;
  const calendarDate = addDays(day, Math.floor(seconds / DAY_SECONDS));
  const clockSeconds = ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  let instant = Date.parse(`${calendarDate}T12:00:00Z`);
  // Resolve the target calendar day's wall clock with the same zone helper as departure matching.
  // Adding elapsed hours to service midnight would drift across a DST change on an overnight run.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedParts(new Date(instant), timezone);
    const dayDelta = Date.parse(`${calendarDate}T00:00:00Z`) - Date.parse(`${local.dateKey}T00:00:00Z`);
    const correction = dayDelta + (clockSeconds - local.seconds) * 1000;
    if (correction === 0) return instant;
    instant += correction;
  }
  // A clock time in a spring-forward gap has no matching instant.
  return null;
}

function stopIds(landingStopId) {
  return [...new Set((Array.isArray(landingStopId) ? landingStopId : [landingStopId])
    .filter(id => id != null).map(String))];
}

/**
 * All bundled operators, retaining the same id prefixes as the departure board.
 *
 * Tests and callers that already parsed GTFS can pass `tables` instead of a root directory:
 * [{ operatorId, prefix, trips, stopTimes, calendar, calendarDates, routes?, ferryRouteIds? }].
 * The tables contain ordinary GTFS rows with their original column names. No files are read in
 * that mode.
 *
 * This index is for boats, so trips on bus routes (route_type 3 in `routes`) are left out: a hull
 * must never be matched to a shuttle bus. `ferryRouteIds` names the routes a feed types as buses
 * that are really ferries; it defaults to the operator's entry in PARTNER_FEEDS. A feed with no
 * routes table keeps every trip.
 * Operator ids are "nycf" for the root feed and the keys of PARTNER_FEEDS for partner feeds.
 *
 * When `serviceTrips` is supplied, NYC Ferry comes from the board's layered service-trip index
 * instead of the historical root tables. Live ids can have several dated candidates: pass a
 * service date to departuresFrom(stopId, operatorId, serviceDate) and trip(tripId, serviceDate).
 * trip() returns null when several candidates remain; an optional third routeId narrows arrival
 * lookups to the route already matched. Without serviceTrips, the GTFS-only behavior is unchanged.
 */
export async function buildHarborSchedule({ root = ROOT, tables = null, serviceTrips = null } = {}) {
  if (tables == null) {
    const feeds = [...(serviceTrips ? [] : [{ operatorId: "nycf", prefix: "", directory: "gtfs" }]),
      ...Object.entries(PARTNER_FEEDS).map(([operatorId, feed]) => ({ operatorId, ...feed }))];
    tables = (await Promise.all(feeds.map(async feed => {
      if (feed.operatorId !== "nycf") {
        const exists = await stat(path.join(root, feed.directory)).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!exists) return null;
      }
      const readTable = async (filename, optional = false) => {
        const text = await readFile(path.join(root, feed.directory, filename), "utf8").catch(error => {
          // GTFS allows an exceptions-only feed, or a calendar with no exceptions file.
          if (optional && error.code === "ENOENT") return "";
          throw error;
        });
        return parseCsv(text);
      };
      const [trips, stopTimes, calendar, calendarDates, routes] = await Promise.all([
        readTable("trips.txt"), readTable("stop_times.txt"),
        readTable("calendar.txt", true), readTable("calendar_dates.txt", true), readTable("routes.txt", true)
      ]);
      return { operatorId: feed.operatorId, prefix: feed.prefix, trips, stopTimes, calendar, calendarDates, routes };
    }))).filter(Boolean);
  }

  const operators = new Map(), trips = new Map(), departures = new Map();
  const calendars = [], exceptions = [];
  const holidayDates = new Set(serviceTrips?.holidayDates || []);
  const addCandidate = (trip, { dates = null, holiday = false, layered = false, blockId = null } = {}) => {
    const timetableKey = layered ? JSON.stringify([trip.operatorId, trip.tripId, trip.routeId,
      trip.stops.map(call => [call.stopId, call.sequence, call.arrivalSeconds, call.departureSeconds])]) : null;
    const candidate = { trip, dates, holiday, layered, blockId, timetableKey };
    const candidates = trips.get(trip.tripId) || [];
    candidates.push(candidate);
    trips.set(trip.tripId, candidates);
    for (let index = 0; index < trip.stops.length - 1; index += 1) {
      const call = trip.stops[index], next = trip.stops[index + 1];
      if (call.departureSeconds == null) continue;
      const byStop = departures.get(trip.operatorId) || new Map();
      const list = byStop.get(call.stopId) || [];
      list.push({ candidate, departure: {
        tripId: trip.tripId, routeId: trip.routeId, serviceId: trip.serviceId, sequence: call.sequence,
        departureSeconds: call.departureSeconds, nextStopId: next.stopId, nextSequence: next.sequence
      } });
      byStop.set(call.stopId, list);
      departures.set(trip.operatorId, byStop);
    }
  };
  if (serviceTrips) {
    const liveIds = new Set();
    for (const [liveId, candidates] of serviceTrips.trips) {
      for (const candidate of candidates) {
        // The layered index also describes partner trips for the map. Their own bundled feeds
        // remain the source here, and a prefixed route must never become an NYC Ferry candidate.
        if (String(candidate.routeId).includes(":")) continue;
        const tripId = String(liveId);
        const stops = (candidate.stops || []).map(call => ({
          stopId: String(call.stopId), sequence: call.sequence,
          arrivalSeconds: call.arrivalSeconds, departureSeconds: call.departureSeconds
        })).sort((left, right) => left.sequence - right.sequence);
        addCandidate({ tripId, routeId: candidate.routeId, serviceId: candidate.serviceId, operatorId: "nycf", stops }, {
          dates: candidate.dates ? [...candidate.dates] : null, holiday: candidate.holiday === true, layered: true
        });
        liveIds.add(tripId);
      }
    }
    operators.set("nycf", { prefix: "", tripCount: liveIds.size });
    calendars.push(...serviceTrips.calendars.map(calendar => ({ ...calendar, weekdays: [...calendar.weekdays] })));
    exceptions.push(...serviceTrips.exceptions.map(exception => ({ ...exception })));
  }
  for (const feed of tables) {
    const { operatorId, prefix = PARTNER_FEEDS[operatorId]?.prefix || "" } = feed;
    if (serviceTrips && operatorId === "nycf") continue;
    const prefixed = value => `${prefix}${value}`;
    const ferryRouteIds = feed.ferryRouteIds || PARTNER_FEEDS[operatorId]?.ferryRouteIds;
    const busRouteIds = new Set((feed.routes || []).filter(route => String(route.route_type).trim() === "3" &&
      !ferryRouteIds?.has(route.route_id)).map(route => route.route_id));
    const boatTrips = (feed.trips || []).filter(row => !busRouteIds.has(row.route_id));
    const boatTripIds = new Set(boatTrips.map(row => row.trip_id));
    const callsByTrip = new Map();
    for (const row of feed.stopTimes || []) {
      if (!boatTripIds.has(row.trip_id)) continue;
      const id = prefixed(row.trip_id);
      const calls = callsByTrip.get(id) || [];
      calls.push({
        stopId: prefixed(row.stop_id), sequence: Number(row.stop_sequence),
        arrivalSeconds: row.arrival_time || row.departure_time ? timeToSeconds(row.arrival_time || row.departure_time) : null,
        departureSeconds: row.departure_time || row.arrival_time ? timeToSeconds(row.departure_time || row.arrival_time) : null
      });
      callsByTrip.set(id, calls);
    }
    for (const calls of callsByTrip.values()) calls.sort((left, right) => left.sequence - right.sequence);
    for (const row of boatTrips) {
      const tripId = prefixed(row.trip_id), routeId = prefixed(row.route_id), serviceId = prefixed(row.service_id);
      const stops = callsByTrip.get(tripId) || [];
      addCandidate({ tripId, routeId, serviceId, operatorId, stops }, { blockId: String(row.block_id || "").trim() || null });
    }
    operators.set(operatorId, { prefix, tripCount: boatTrips.length });
    calendars.push(...(feed.calendar || []).map(row => ({
      serviceId: prefixed(row.service_id),
      weekdays: [row.sunday, row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday].map(value => value === "1"),
      startDate: dateKey(row.start_date), endDate: dateKey(row.end_date)
    })));
    exceptions.push(...(feed.calendarDates || []).map(row => ({
      serviceId: prefixed(row.service_id), date: dateKey(row.date), added: row.exception_type === "1"
    })));
  }
  for (const byStop of departures.values()) {
    for (const list of byStop.values()) list.sort((left, right) =>
      left.departure.departureSeconds - right.departure.departureSeconds ||
      left.departure.tripId.localeCompare(right.departure.tripId) || left.departure.sequence - right.departure.sequence);
  }
  const activeOn = day => activeServices({ calendars, exceptions }, day);
  const eligible = (candidate, day, active) => !candidate.layered || day == null ||
    (active.has(candidate.trip.serviceId) && (!candidate.dates || candidate.dates.includes(day)) &&
      candidate.holiday === holidayDates.has(day));
  // Operational calendars can alias a passenger sailing's full timetable. Resolve eligibility
  // first: calendars and dated restrictions still matter, but two active aliases are one trip.
  // Conflicting routes or calls remain separate, and undated lookups retain their ambiguity.
  const distinctCandidates = (candidates, day) => {
    if (day == null) return candidates;
    const distinct = new Map();
    for (const candidate of candidates) {
      const key = candidate.layered ? candidate.timetableKey : candidate;
      const previous = distinct.get(key);
      if (!previous || candidate.trip.serviceId.localeCompare(previous.trip.serviceId) < 0) distinct.set(key, candidate);
    }
    return [...distinct.values()];
  };
  const timezone = serviceTrips?.timezone || TIMEZONE;
  const candidatesOn = (operatorId, serviceDate) => {
    const day = normalizeHarborServiceDate(serviceDate), active = activeOn(day);
    return { day, groups: [...trips.values()].map(candidates => distinctCandidates(candidates.filter(candidate =>
      candidate.trip.operatorId === operatorId && active.has(candidate.trip.serviceId) && eligible(candidate, day, active)), day)) };
  };
  return {
    timezone, operators,
    /** Unambiguous active trips for runs, without changing the existing trip/departure shapes. */
    tripsOn(operatorId, serviceDate) {
      const { day, groups } = candidatesOn(operatorId, serviceDate);
      return groups.filter(candidates => candidates.length === 1).flatMap(([candidate]) => {
        const { trip, blockId } = candidate;
        const first = trip.stops[0], last = trip.stops.at(-1);
        if (!first || !last) return [];
        const departsAt = serviceTimeAt(day, first.departureSeconds, timezone);
        const arrivesAt = serviceTimeAt(day, last.arrivalSeconds, timezone);
        if (departsAt == null || arrivesAt == null || arrivesAt < departsAt) return [];
        return [{ tripId: trip.tripId, routeId: trip.routeId, blockId,
          firstStopId: first.stopId, lastStopId: last.stopId, departsAt, arrivesAt }];
      }).sort((left, right) => left.departsAt - right.departsAt || left.tripId.localeCompare(right.tripId));
    },
    ambiguousTripsOn(operatorId, serviceDate) {
      return candidatesOn(operatorId, serviceDate).groups.filter(candidates => candidates.length > 1).length;
    },
    departuresFrom(landingStopId, operatorId, serviceDate = null) {
      const active = serviceDate == null ? null : activeOn(serviceDate);
      const entries = stopIds(landingStopId).flatMap(id => departures.get(operatorId)?.get(id) || [])
        .filter(entry => eligible(entry.candidate, serviceDate, active));
      const candidates = new Set(distinctCandidates(entries.map(entry => entry.candidate), serviceDate));
      return entries.filter(entry => candidates.has(entry.candidate)).map(entry => entry.departure);
    },
    trip(tripId, serviceDate = null, routeId = null) {
      const active = serviceDate == null ? null : activeOn(serviceDate);
      const candidates = distinctCandidates((trips.get(String(tripId)) || []).filter(candidate =>
        (routeId == null || candidate.trip.routeId === routeId) && eligible(candidate, serviceDate, active)), serviceDate);
      return candidates.length === 1 ? candidates[0].trip : null;
    },
    activeOn
  };
}

/**
 * `landingStopId` accepts one namespaced stop id, or a list of stop ids sharing a landing.
 * Callers supply that list when different operators use different ids for the same pier.
 */
export function matchDeparture({ schedule, operatorId, landingStopId, departedAt, taken = new Set() }) {
  if (!Number.isFinite(departedAt)) return null;
  const current = zonedParts(new Date(departedAt), schedule.timezone);
  const seconds = current.seconds + ((departedAt % 1000) + 1000) % 1000 / 1000;
  let best = null;
  // Yesterday for calls timed past 24:00, and tomorrow for a boat that leaves a few minutes before
  // midnight on a trip timed just after it.
  for (const offset of [-1, 0, 1]) {
    const serviceDate = addDays(current.dateKey, offset);
    const active = schedule.activeOn(serviceDate);
    for (const departure of schedule.departuresFrom(landingStopId, operatorId, serviceDate)) {
      if (!active.has(departure.serviceId) || taken.has(`${serviceDate}|${departure.tripId}`)) continue;
      // Compare the same local service clock as the board. Adding milliseconds to midnight would
      // shift a 24-plus-hour call by an hour when a daylight-saving change lies between the two.
      const delta = seconds - (offset * DAY_SECONDS + departure.departureSeconds);
      if (delta < -4 * 60 || delta > 20 * 60) continue;
      const distance = Math.abs(delta);
      if (best && distance >= best.distance) continue;
      best = { distance, trip: { tripId: departure.tripId, routeId: departure.routeId, serviceDate,
        nextSequence: departure.nextSequence, confidence: 0.5, source: "schedule" } };
    }
  }
  return best?.trip || null;
}

/** Arrival matching accepts the same single stop id or shared-landing stop-id list as departures. */
export function confirmArrival({ schedule, trip, landingStopId }) {
  if (!trip || trip.nextSequence == null) return null;
  const stops = schedule.trip(trip.tripId, trip.serviceDate, trip.routeId)?.stops || [];
  const nextIndex = stops.findIndex(call => call.sequence === trip.nextSequence);
  if (nextIndex < 0) return null;
  const landing = new Set(stopIds(landingStopId));
  const index = stops.findIndex((call, index) => index >= nextIndex && landing.has(call.stopId));
  if (index < 0) return null;
  if (index !== nextIndex) return trip;
  return { ...trip, confidence: 0.9, nextSequence: stops[index + 1]?.sequence ?? null };
}
