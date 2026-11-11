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

function stopIds(landingStopId) {
  return [...new Set((Array.isArray(landingStopId) ? landingStopId : [landingStopId])
    .filter(id => id != null).map(String))];
}

/**
 * All bundled operators, retaining the same id prefixes as the departure board.
 *
 * Tests and callers that already parsed GTFS can pass `tables` instead of a root directory:
 * [{ operatorId, prefix, trips, stopTimes, calendar, calendarDates }]. The four tables contain
 * ordinary GTFS rows with their original column names. No files are read in that mode.
 * Operator ids are "nycf" for the root feed and the keys of PARTNER_FEEDS for partner feeds.
 */
export async function buildHarborSchedule({ root = ROOT, tables = null } = {}) {
  if (tables == null) {
    const feeds = [{ operatorId: "nycf", prefix: "", directory: "gtfs" },
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
      const [trips, stopTimes, calendar, calendarDates] = await Promise.all([
        readTable("trips.txt"), readTable("stop_times.txt"),
        readTable("calendar.txt", true), readTable("calendar_dates.txt", true)
      ]);
      return { operatorId: feed.operatorId, prefix: feed.prefix, trips, stopTimes, calendar, calendarDates };
    }))).filter(Boolean);
  }

  const operators = new Map(), trips = new Map(), departures = new Map();
  const calendars = [], exceptions = [];
  for (const feed of tables) {
    const { operatorId, prefix = PARTNER_FEEDS[operatorId]?.prefix || "" } = feed;
    const prefixed = value => `${prefix}${value}`;
    const callsByTrip = new Map();
    for (const row of feed.stopTimes || []) {
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
    for (const row of feed.trips || []) {
      const tripId = prefixed(row.trip_id), routeId = prefixed(row.route_id), serviceId = prefixed(row.service_id);
      const stops = callsByTrip.get(tripId) || [];
      trips.set(tripId, { tripId, routeId, serviceId, operatorId, stops });
      for (let index = 0; index < stops.length - 1; index += 1) {
        const call = stops[index], next = stops[index + 1];
        if (call.departureSeconds == null) continue;
        const byStop = departures.get(operatorId) || new Map();
        const list = byStop.get(call.stopId) || [];
        list.push({ tripId, routeId, serviceId, sequence: call.sequence,
          departureSeconds: call.departureSeconds, nextStopId: next.stopId, nextSequence: next.sequence });
        byStop.set(call.stopId, list);
        departures.set(operatorId, byStop);
      }
    }
    operators.set(operatorId, { prefix, tripCount: (feed.trips || []).length });
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
      left.departureSeconds - right.departureSeconds || left.tripId.localeCompare(right.tripId) || left.sequence - right.sequence);
  }
  return {
    timezone: TIMEZONE, operators,
    departuresFrom: (landingStopId, operatorId) => stopIds(landingStopId)
      .flatMap(id => departures.get(operatorId)?.get(id) || []),
    trip: tripId => trips.get(String(tripId)) || null,
    activeOn: day => activeServices({ calendars, exceptions }, day)
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
  const departures = schedule.departuresFrom(landingStopId, operatorId);
  for (const offset of [-1, 0]) {
    const serviceDate = addDays(current.dateKey, offset);
    const active = schedule.activeOn(serviceDate);
    for (const departure of departures) {
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
  const stops = schedule.trip(trip.tripId)?.stops || [];
  const nextIndex = stops.findIndex(call => call.sequence === trip.nextSequence);
  if (nextIndex < 0) return null;
  const landing = new Set(stopIds(landingStopId));
  const index = stops.findIndex((call, index) => index >= nextIndex && landing.has(call.stopId));
  if (index < 0) return null;
  if (index !== nextIndex) return trip;
  return { ...trip, confidence: 0.9, nextSequence: stops[index + 1]?.sequence ?? null };
}
