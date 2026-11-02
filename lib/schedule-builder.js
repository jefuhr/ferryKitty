import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CREW_UNCONFIRMED, HOLIDAY_SERVICE, holidayDepartures } from "../scripts/nyc-fall-2026.js";
import {
  CREW_ROUTE, CREW_ROUTE_ID, HOME_PORT_STOP_ID, boatDeparturesByDay, boatRuns, crewCalendars,
  crewShuttleRows, crewSwapIndex, homePortCrewShuttles, homePortDepartures, homePortRows,
  serviceBreaks, calendarTurnaroundLayovers, turnaroundLayovers
} from "./out-of-service.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Holiday source IDs share a namespace with a different curated fall feed. Keep their
// schedules separate and carry the actual feed ID explicitly for realtime lookups.
const holidayTripKey = id => `nyc:sukkot:trip:${id}`;
function holidayOperations(live, crew) {
  const schedules = live?.trips || {};
  const runs = new Map(), certainty = new Map(), cutoff = new Map(), tieUps = [];
  const boatDepartures = new Map();
  for (const [id, trip] of Object.entries(schedules)) {
    if (!Number.isInteger(trip.boatAssignment) || trip.stops.length < 2) continue;
    const first = trip.stops[0], last = trip.stops.at(-1);
    const key = `${trip.routeId}${trip.boatAssignment}`;
    const run = { tripId: holidayTripKey(id), liveTripId: id, routeId: trip.routeId,
      boat: trip.boatAssignment, serviceId: HOLIDAY_SERVICE,
      startSeconds: first.departureSeconds ?? first.arrivalSeconds,
      endSeconds: last.arrivalSeconds ?? last.departureSeconds,
      startStopId: first.stopId, endStopId: last.stopId };
    const list = runs.get(key) || [];
    list.push(run); runs.set(key, list);
    for (const call of trip.stops.slice(0, -1)) {
      if (call.pickupType === 1 || call.departureSeconds == null) continue;
      const stopKey = `${key}|holiday|${call.stopId}`;
      const departures = boatDepartures.get(stopKey) || [];
      departures.push(call.departureSeconds); boatDepartures.set(stopKey, departures);
    }
  }
  for (const list of runs.values()) list.sort((a,b) => a.startSeconds - b.startSeconds);
  for (const list of boatDepartures.values()) list.sort((a,b) => a - b);
  const turnBoundaries = new Map();
  for (const [boat, shifts] of Object.entries(crew?.shifts?.holiday || {})) {
    const list = runs.get(boat) || [];
    // An unshuttled crew change never proves continuity of the physical vessel.
    for (const shift of shifts.slice(1).filter(item => !item.shuttled)) {
      const at = timeToSeconds(`${shift.startTime}:00`);
      const previous = list.findLast(run => run.startSeconds < at);
      if (previous) turnBoundaries.set(previous.tripId, "certain");
    }
    for (const [i, shift] of shifts.entries()) {
      if (!shift.endTripId || shifts[i + 1]?.shuttled) continue;
      const trip = schedules[shift.endTripId];
      const call = trip?.stops.find(item => item.sequence === shift.endSequence && item.stopId === shift.endStopId);
      const seconds = shift.endTime ? timeToSeconds(`${shift.endTime}:00`) : null;
      if (!call || call.arrivalSeconds !== seconds || `${trip.routeId}${trip.boatAssignment}` !== boat) {
        throw new Error(`Invalid verified Sukkot drop-off at ${shift.source}`);
      }
      const key = holidayTripKey(shift.endTripId);
      certainty.set(key, "certain"); cutoff.set(key, seconds);
      turnBoundaries.set(key, "certain");
      tieUps.push({ tripId: key, liveTripId: shift.endTripId, routeId: trip.routeId,
        boat: trip.boatAssignment, serviceId: HOLIDAY_SERVICE,
        endStopId: call.stopId, endSeconds: seconds, endsDay: i === shifts.length - 1 });
    }
  }
  const turns = turnaroundLayovers({ runs, endsShift: turnBoundaries });
  for (const turn of turns.values()) turn.nextLiveTripId = turn.nextTripId.slice("nyc:sukkot:trip:".length);
  return { schedules, certainty, cutoff, tieUps, turns, boatDepartures };
}

export function parseCsv(input) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header.replace(/^\uFEFF/, ""), values[index] ?? ""])));
}

export function timeToSeconds(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) throw new Error(`Invalid GTFS time: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function isoDate(value) {
  return /^\d{8}$/.test(value || "") ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}

// Seastreak publishes HTML-escaped text in its GTFS ("Martha&#8217;s Vineyard &amp; Nantucket"),
// which would otherwise reach the screen verbatim. Also collapses stray whitespace.
export function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return (value || "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/\s+/g, " ").trim();
}

function color(value, fallback) {
  return /^[0-9a-f]{6}$/i.test(value || "") ? `#${value.toUpperCase()}` : fallback;
}

function destinationInfo(stopTime, trip, finalStop, routeId) {
  const raw = (stopTime.stop_headsign || trip.trip_headsign || finalStop?.stop_name || "Destination unavailable")
    .replace(/\s+/g, " ").trim();
  const variantMatch = raw.match(/\s*\(E R ([AB])\)$/i);
  return {
    destination: raw.replace(/\s*\(E R [AB]\)$/i, "").trim(),
    variant: routeId === "ER" ? (variantMatch?.[1]?.toUpperCase() || "LOCAL") : null
  };
}

// Partner operators that share a dock with an NYC Ferry landing. Each has its own independently
// published GTFS directory, so their small integer route/trip/stop ids overlap with NYC Ferry's
// and with each other (waterway stop "4" is unrelated to NYC Ferry stop "4"). Every id from a
// partner feed is namespaced with that operator's prefix to keep the merged output unambiguous.

// Four NY Waterway routes are tagged route_type=3 (bus) in the Trillium feed even though they are
// ferries: they cross the Hudson, the operator publishes a ferry timetable for each of them on
// nywaterway.com, and every departure time in the feed matches that timetable exactly. Left alone
// they are dropped entirely wherever display.json sets busesEnabled=false, which silently removes
// a third of NY Waterway's service at Pier 11 (Edgewater, Hoboken/14th St and Port Liberte) and
// the Edgewater sailings at Brookfield Place.
//
// The correction lives here rather than in gtfs/waterway/routes.txt so that dropping in a fresh
// feed cannot quietly reintroduce the bug. It reclassifies a route; it does not touch a single
// published time. Everything else typed as a bus in that feed really is one — the town shuttles,
// the numbered Midtown crosstown buses, and the Newburgh–Beacon winter bus that substitutes for
// the ferry — so they stay buses.
const WATERWAY_FERRIES_TYPED_AS_BUS = new Set([
  "19750", // Edgewater - Brookfield Place
  "19751", // Edgewater - Pier 11/Wall St
  "74376", // Port Liberte - Pier 11/Wall St
  "76080"  // Hoboken / 14th St - Pier 11 / Wall St
]);

// NYC Ferry trips that the feed publishes as revenue sailings but which never carry a passenger.
//
// The feed is the published timetable, and the published timetable is not always what dispatch
// runs. Where the two disagree every weekend, in the same way, the board should show what the boat
// actually does — an agent who reads a departure off this board and sends a passenger to the gate
// is relying on it.
//
// Rockaway Rocket run 9105 is the case this exists for. The weekend timetable prints it as
// Long Island City 16:00, Greenpoint 16:11, Rockaway 17:16. It is not run that way: dispatch
// cancels it by hand every weekend and the boat deadheads from Long Island City straight to
// Rockaway, skipping Greenpoint entirely. Both printed departures are sellable seats that do not
// exist.
//
// The correction lives here rather than in gtfs/stop_times.txt for the same reason the NY Waterway
// route-type fix does: gtfs/ is a download, and a fresh copy would quietly put the ghost sailings
// back. It is matched strictly — route, day type, run number and the printed boarding time all
// have to agree — because applying it to the wrong boat would tell an agent that a real departure
// cannot be boarded, which is a worse failure than not applying it at all. A correction that stops
// matching warns and is skipped rather than throwing: NYC Ferry fixing its own feed, or moving the
// run, should send somebody back to this list, not take the board down.
const NYC_FERRY_NON_REVENUE_RUNS = [
  {
    routeId: "RR",
    dayType: "weekend",
    run: "9105",
    // The call that must match for the correction to apply at all.
    boardsAt: { stopId: "90", time: "16:00:00" }, // Long Island City
    // Calls the boat does not actually make, dropped from the trip.
    skips: ["18"],                                // Greenpoint
    note: "deadheads Long Island City to Rockaway; cancelled by dispatch every weekend"
  }
];

// Applies the corrections above. Returns the trip ids that carry no passengers, so the departures
// they still generate can be marked as such: the boat does move, and a row that says so with no
// pickup on it is more use to an agent than a row that has vanished.
export function applyNonRevenueRuns({ trips, timesByTrip, dayTypeOf, warn = console.warn }) {
  const nonRevenue = new Set();
  for (const correction of NYC_FERRY_NON_REVENUE_RUNS) {
    // The seasonal route may be absent entirely (Rockaway Rocket in fall 2026).
    if (!trips.some((trip) => trip.route_id === correction.routeId)) continue;
    const candidates = trips.filter((trip) =>
      trip.route_id === correction.routeId &&
      String(trip.trip_short_name || "").trim() === correction.run &&
      dayTypeOf(trip.service_id) === correction.dayType);
    const matched = candidates.filter((trip) => (timesByTrip.get(trip.trip_id) || []).some((call) =>
      call.stop_id === correction.boardsAt.stopId &&
      (call.departure_time || call.arrival_time) === correction.boardsAt.time));
    const label = `${correction.routeId} run ${correction.run} (${correction.dayType})`;
    if (matched.length !== 1) {
      warn(`NOTE: no longer correcting ${label} — ${matched.length} trips match ${correction.boardsAt.time} at stop ${correction.boardsAt.stopId}. Re-read the timetable and update NYC_FERRY_NON_REVENUE_RUNS.`);
      continue;
    }
    const tripId = matched[0].trip_id;
    const calls = timesByTrip.get(tripId);
    const kept = calls.filter((call) => !correction.skips.includes(call.stop_id));
    if (kept.length < 2) {
      warn(`NOTE: not correcting ${label} — skipping its calls would leave it with fewer than two.`);
      continue;
    }
    timesByTrip.set(tripId, kept);
    nonRevenue.add(tripId);
  }
  return nonRevenue;
}

// The three Manhattan terminals NY Waterway calls at, and the codes the crews use for them.
//
// One route links them: 77347, South Amboy - Pier 11/Wall St, which threads Pier 11, Brookfield
// Place and Pier 79 together in four different orders depending on the run. Every other waterway
// route touches at most one of the three, so on those the destination already tells the whole
// story. On this one it does not: the 17:15 from Pier 11 and the 15:35 from Pier 11 both read
// "South Amboy", but the first calls at Brookfield Place on the way and the second is direct.
//
// That difference is the reason for the badge. An agent at Pier 11 asked "can I get to Brookfield
// Place?" has no way to answer it from a row that only names the far end.
export const WATERWAY_MANHATTAN_TERMINALS = new Map([
  ["2439146", { code: "PIER 11", name: "Pier 11 / Wall Street" }],
  ["2729332", { code: "BPC", name: "Brookfield Place / Battery Park City" }],
  ["2439145", { code: "P79", name: "Midtown West / Pier 79" }]
]);

export const PARTNER_FEEDS = {
  waterway: { prefix: "wtr:", directory: "gtfs/waterway", label: "NY Waterway", defaultColor: "#00558C", enabledKey: "waterwayEnabled", stopIdsKey: "waterwayStopIds", ferryRouteIds: WATERWAY_FERRIES_TYPED_AS_BUS,
    connectingTerminals: WATERWAY_MANHATTAN_TERMINALS,
    // Departures carry the namespaced id by this point, so the prefix comes off first.
    lineOfRoute: (routeId) => WATERWAY_LINE_OF_ROUTE.get(String(routeId).replace(/^wtr:/, "")) },
  // NY Waterway's Belford route, which it takes over from Seastreak on 8 September 2026 and which
  // is not in the GTFS it publishes. It rides in its own directory rather than on the waterway
  // entry above for the reason set out at the top of scripts/build-waterway-belford-gtfs.js: that
  // directory is a download, and a fresh one would erase anything written into it. Same badge, same
  // colour, same three Manhattan terminals — to a rider these are NY Waterway rows, and the split
  // is only about which files a feed refresh is allowed to overwrite.
  //
  // showDropOffArrivals, like Seastreak, because the morning boat is drop-off only at all three of
  // the piers this board watches. Without it the whole morning peak would be invisible at Pier 11,
  // Brookfield and Pier 79, which is not what those piers showed while Seastreak ran the route.
  waterwayBelford: { prefix: "wbf:", directory: "gtfs/waterway-belford", label: "NY Waterway", defaultColor: "#00558C", enabledKey: "waterwayBelfordEnabled", stopIdsKey: "waterwayBelfordStopIds",
    connectingTerminals: WATERWAY_MANHATTAN_TERMINALS, showDropOffArrivals: true },
  seastreak: { prefix: "sea:", directory: "gtfs/seastreak", label: "Seastreak", defaultColor: "#013067", enabledKey: "seastreakEnabled", stopIdsKey: "seastreakStopIds", destinationFromFinalStop: true, showDropOffArrivals: true },
  // NYU publishes no GTFS at all — gtfs/nyu/ is reconstructed from its Passio GO backend by
  // scripts/fetch-nyu-gtfs.js. Once written it is an ordinary static feed, so it needs no special
  // handling here beyond its own prefix and switches.
  nyu: { prefix: "nyu:", directory: "gtfs/nyu", label: "NYU Langone Ferry", defaultColor: "#57068C", enabledKey: "nyuEnabled", stopIdsKey: "nyuStopIds" },
  liberty: { prefix: "lib:", directory: "gtfs/liberty", label: "Liberty Landing Ferry", defaultColor: "#1B3F94", enabledKey: "libertyEnabled", stopIdsKey: "libertyStopIds" },
  // NY Waterway runs the IKEA Brooklyn weekend boat but leaves it out of the GTFS it publishes,
  // so it gets its own feed and its own switches rather than riding on the waterway entry. It is
  // seasonal and transcribed from an image by scripts/build-ikea-gtfs.js; see that file.
  ikea: { prefix: "ike:", directory: "gtfs/ikea", label: "IKEA Brooklyn Ferry", defaultColor: "#0058A3", enabledKey: "ikeaEnabled", stopIdsKey: "ikeaStopIds" },
  // The Trust runs its own Brooklyn boats to Governors Island, which are not the NYC Ferry South
  // Brooklyn route that also calls there — different operator, different piers, weekends only.
  // Transcribed from the operator's schedule page by scripts/build-gi-gtfs.js; see that file.
  gi: { prefix: "gi:", directory: "gtfs/gi", label: "Governors Island Ferry", defaultColor: "#00BBE3", enabledKey: "giEnabled", stopIdsKey: "giStopIds", showNoPickup: true },
  // The Staten Island Ferry, from the GTFS NYC DOT publishes at
  // https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip. Unlike the transcribed feeds
  // above this one is a real download, so replacing gtfs/siferry/ with a fresh copy is all a
  // schedule change needs.
  //
  // The feed leaves trip_headsign empty on all 416 trips, so every row's destination falls through
  // to the trip's final stop — "St. George Ferry Terminal" or "Whitehall Ferry Terminal", which is
  // what the boat's own signage says anyway. It carries no block_id and no vehicle data of any
  // kind, and NYC DOT publishes no GTFS-realtime for the ferry, so these rows are schedule-only:
  // no live estimates and no vessel names, which is why nothing here opts into realtime.
  siferry: { prefix: "sif:", directory: "gtfs/siferry", label: "Staten Island Ferry", defaultColor: "#FF8330", enabledKey: "siferryEnabled", stopIdsKey: "siferryStopIds", operatorName: "Staten Island Ferry" },
  // The Statue of Liberty and Ellis Island boats, from the GTFS the National Park Service publishes
  // at https://www.nps.gov/external-resources/gtfs/stli/statue-of-liberty-ferries.zip. A download
  // like the Staten Island feed, not a transcription, and seasonal — the bundled copy runs
  // 2026-05-23 to 2026-09-07, after which its rows stop appearing until a fresh one is dropped in.
  //
  // Its trips are loops: Battery Park to Liberty Island to Ellis Island and back to Battery Park,
  // and the mirror of that from Liberty State Park in New Jersey. A loop's last stop is also its
  // first, so the usual "destination is the trip's final stop" fallback would tell someone boarding
  // at Battery Park that the boat is going to Battery Park. The feed carries a stop_headsign on
  // every call that matters, naming the island that call is bound for, and that is what the board
  // shows — which is also what a visitor is actually asking.
  //
  // NPS publishes the feed under its own name; the boats, the tickets and the pier signs all say
  // Statue City Cruises, so that is the operator the board names.
  statue: { prefix: "sta:", directory: "gtfs/statue", label: "Statue of Liberty Ferry", defaultColor: "#1B6E3C", enabledKey: "statueEnabled", stopIdsKey: "statueStopIds", operatorName: "Statue City Cruises",
    headsignFixes: { "Libery State Park": "Liberty State Park" } }
};

// Which landing a stop belongs to, for every operator at once.
//
// The board has always answered the other direction — a landing knows its stops — and that was
// enough while every row on screen was one of this landing's own departures. The trip view asks the
// reverse: given a stop somewhere along a trip, whose pier is that, and can the board show it?
//
// The two halves of config/landings.json disagree about spelling, which is the only subtlety here.
// A landing's own `stopIds` are NYC Ferry ids written bare ("87"), and so are the partner keys
// ("13138" under nyuStopIds) — but the moment a partner departure exists it carries the feed's
// prefix ("nyu:13138"), because that is what buildPartnerFeed's prefixed() does to every id it
// emits. So the index has to namespace the partner keys on the way in or it will never match
// anything it is asked about. That pairing of prefix to stopIdsKey lives in PARTNER_FEEDS above,
// which is why this sits here rather than anywhere else.
//
// Not every stop belongs to a landing, and the map says so with null rather than by omission: the
// Rockaway shuttle's two dozen kerbside bus stops are real calls on real trips that no pier serves.
export function stopLandingIndex(landings) {
  const index = new Map();
  for (const [key, landing] of Object.entries(landings || {})) {
    if (!landing || landing.unused) continue;
    // A hub is a pier where several routes meet, so somebody getting off has a real choice to read
    // rather than one onward boat. Named in config/landings.json because which piers those are is a
    // fact about the harbour, not about the code.
    const entry = { landingId: Number(key), hub: landing.hub === true };
    for (const stopId of landing.stopIds || []) index.set(String(stopId), entry);
    for (const feed of Object.values(PARTNER_FEEDS)) {
      for (const stopId of landing[feed.stopIdsKey] || []) index.set(`${feed.prefix}${stopId}`, entry);
    }
  }
  return index;
}

// The name and pier for every stop a trip on this board calls at, keyed the way the departures and
// trip schedules key them. Built from the trips actually on the board rather than from stops.txt:
// gtfs/waterway/stops.txt alone has 313 rows and a landing touches a handful of them.
function stopDirectory({ tripSchedules, nameOf, landingIndex }) {
  const stops = {};
  for (const schedule of Object.values(tripSchedules || {})) {
    for (const call of schedule.stops || []) {
      if (stops[call.stopId]) continue;
      const name = nameOf(call.stopId);
      if (!name) continue;
      const landing = landingIndex.get(call.stopId);
      stops[call.stopId] = { name, landingId: landing?.landingId ?? null, ...(landing?.hub ? { hub: true } : {}) };
    }
  }
  return stops;
}

// NY Waterway publishes one trip per origin-destination pair, so a boat that calls at two terminals
// arrives in the feed as two trips leaving the same berth at the same minute. Left alone the board
// shows one sailing as two boats: the 6:15 from Pier 11 appears once for Paulus Hook and again for
// Liberty Harbor, when it is a single boat calling at both. Thirty-three of Pier 11's fifty-two
// weekday departure times are affected.
//
// The operator's own route map is the authority for which of these are one boat, and the feed
// agrees with it wherever it can be checked: on a genuine single sailing the trips' onward calls
// compose into one ordered chain (Paulus Hook 6:23, then Liberty Harbor 6:27), while two boats that
// happen to share a minute do not — the 6:35 reaches Hoboken/NJ Transit and Brookfield Place both
// at 6:50, which no boat can do. So a group is merged only when every onward call has a distinct
// place and a distinct minute, and is otherwise left exactly as the feed states it.
// The map's line colours, as route ids. A colour is one boat: the green line calls at Paulus Hook
// and Liberty Harbor on its way to and from Pier 11, and the purple one links Edgewater, Hoboken
// 14th St and Port Imperial to both downtown terminals. Everything not listed here is its own boat
// even when it shares a berth and a minute with another — Hoboken/NJ Transit and Port Liberte both
// run to Pier 11, on their own lines, and must never be folded into a neighbour.
const WATERWAY_COMBINED_LINES = [
  ["10218", "10226"],           // green: Pier 11 - Paulus Hook - Liberty Harbor
  ["19751", "76080", "10227"],  // purple: Pier 11 - Hoboken 14th St - Port Imperial - Edgewater
  ["19750", "10220", "10222"],  // purple: Brookfield Place - Hoboken 14th St - Port Imperial - Edgewater
  ["10230", "10231"]            // pink: Midtown - Hoboken 14th St - Lincoln Harbor
];
const WATERWAY_LINE_OF_ROUTE = new Map(
  WATERWAY_COMBINED_LINES.flatMap((group, index) => group.map((routeId) => [routeId, index]))
);

function mergeSplitSailings(departures, lineOf) {
  const groups = new Map();
  for (const departure of departures) {
    const line = lineOf?.(departure.routeId);
    if (line === undefined || line === null) continue;
    const key = `${departure.serviceId}|${departure.stopId}|${departure.departureTime}|${line}`;
    groups.set(key, [...(groups.get(key) || []), departure]);
  }
  const dropped = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (group.some((item) => !(item.onward || []).length)) continue;
    const calls = group.flatMap((item) => item.onward || []);
    const names = new Set(calls.map((call) => call.name));
    const minutes = new Set(calls.map((call) => call.seconds));
    if (names.size !== calls.length || minutes.size !== calls.length) continue;
    const ordered = [...calls].sort((left, right) => left.seconds - right.seconds);
    // The row keeps the trip that actually runs to the far end, so its route colour, badge and
    // trip id all still describe the sailing a rider boards.
    const finalName = ordered.at(-1).name;
    const keep = group.find((item) => (item.onward || []).some((call) => call.name === finalName)) || group[0];
    keep.destination = finalName;
    keep.via = ordered.slice(0, -1).map((call) => call.name);
    keep.nextStop = ordered[0].name;
    for (const item of group) if (item !== keep) dropped.add(item);
  }
  if (!dropped.size) return;
  for (let index = departures.length - 1; index >= 0; index -= 1) {
    if (dropped.has(departures[index])) departures.splice(index, 1);
  }
}

// Reads one partner feed and returns its departures already namespaced and shaped exactly like
// the NYC Ferry entries, so the caller only has to concatenate.
async function buildPartnerFeed({ root, feed, stopIds, landingNumber, busesEnabled, landingIndex = new Map() }) {
  const [routesRaw, stopsRaw, tripsRaw, timesRaw, calendarRaw, datesRaw, agencyRaw] = await Promise.all([
    readFile(path.join(root, feed.directory, "routes.txt"), "utf8"), readFile(path.join(root, feed.directory, "stops.txt"), "utf8"),
    readFile(path.join(root, feed.directory, "trips.txt"), "utf8"), readFile(path.join(root, feed.directory, "stop_times.txt"), "utf8"),
    readFile(path.join(root, feed.directory, "calendar.txt"), "utf8"), readFile(path.join(root, feed.directory, "calendar_dates.txt"), "utf8"),
    readFile(path.join(root, feed.directory, "agency.txt"), "utf8")
  ]);
  const routes = parseCsv(routesRaw), stops = parseCsv(stopsRaw), trips = parseCsv(tripsRaw), stopTimes = parseCsv(timesRaw);
  const routesById = new Map(routes.map((item) => [item.route_id, item]));
  const stopsById = new Map(stops.map((item) => [item.stop_id, item]));
  const tripsById = new Map(trips.map((item) => [item.trip_id, item]));
  const selectedStops = new Set(stopIds);
  for (const stopId of selectedStops) if (!stopsById.has(stopId)) throw new Error(`Landing ${landingNumber} references missing ${feed.label} stop ${stopId}.`);
  // The operator's name as the board should say it. Normally that is whatever the feed's agency.txt
  // says, which is how every partner here got its name. NYC DOT is the exception: it publishes the
  // Staten Island Ferry under the department's legal name, which is not what the boat, the terminal
  // signs, or anyone at the pier calls it, and which would fill the operator filter and every route
  // row with "New York City Department of Transportation". The correction lives in PARTNER_FEEDS
  // rather than in gtfs/siferry/agency.txt so that dropping in a fresh download cannot undo it.
  const agencyName = feed.operatorName || parseCsv(agencyRaw)[0]?.agency_name || feed.label;
  const prefixed = (value) => `${feed.prefix}${value}`;
  // route_type as the feed means it, not as it says it. See WATERWAY_FERRIES_TYPED_AS_BUS.
  const modeOf = (route) => (route.route_type === "3" && !feed.ferryRouteIds?.has(route.route_id) ? "bus" : "ferry");

  const timesByTrip = new Map();
  for (const item of stopTimes) {
    const list = timesByTrip.get(item.trip_id) || [];
    list.push(item); timesByTrip.set(item.trip_id, list);
  }
  for (const list of timesByTrip.values()) list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  const departures = [];
  for (const [tripId, times] of timesByTrip) {
    const trip = tripsById.get(tripId), route = routesById.get(trip?.route_id);
    if (!trip || !route) continue;
    if (!busesEnabled && modeOf(route) === "bus") continue;
    for (let index = 0; index < times.length - 1; index += 1) {
      const current = times[index];
      if (!selectedStops.has(current.stop_id)) continue;
      // A stop nobody may board is normally not a departure at all, and dropping it is what keeps
      // Seastreak's hundreds of drop-off-only calls off the board. One feed wants the opposite: the
      // Trust's last boats of the day leave the shore empty to go and collect the last visitors, and
      // a crew board that hid them would show the pier going quiet an hour before the boat does. So
      // that feed shows them, flagged out of service — which is what NO PICKUP already means here.
      const noPickup = current.pickup_type === "1";
      if (noPickup && !feed.showNoPickup) continue;
      // A leg that arrives where it departed is not a sailing anyone can take. NYC DOT's feed has
      // fifteen of them, all on its dormant "threeboat" service: St. George at :00 to St. George at
      // :25, which is the Whitehall crossing with the wrong stop id on the far end. That service has
      // an all-zero calendar and no exception dates, so nothing renders them today — but the feed is
      // a drop-in download, and the day DOT switches three-boat service on, St. George would start
      // advertising boats to itself. Declining to show the leg is not a correction to published
      // data: the times are left exactly as they are, and the far end is simply not guessed at.
      if (times[index + 1].stop_id === current.stop_id) continue;
      const departureTime = current.departure_time || current.arrival_time;
      if (!departureTime) continue;
      const finalStop = stopsById.get(times.at(-1).stop_id);
      // Seastreak's headsigns name a region ("Manhattan", "New Jersey"), which tells a rider
      // standing in Manhattan nothing, so that feed is configured to show the trip's last stop
      // instead. NY Waterway's headsigns already name the terminal, so it keeps the headsign.
      // A published headsign, with one class of correction allowed: a misspelling of a place the
      // same feed spells correctly everywhere else. NPS writes "Libery State Park" on exactly one
      // of its seventeen Liberty State Park calls, and a board that printed it would look like it
      // had the bug. Nothing but the spelling of a destination label is touched — no time, no
      // route, no stop, and a headsign that is merely terse or unhelpful is left exactly as it is.
      const publishedHeadsign = current.stop_headsign || trip.trip_headsign;
      const headsign = feed.headsignFixes?.[publishedHeadsign] || publishedHeadsign;
      const destination = decodeEntities(feed.destinationFromFinalStop
        ? (finalStop?.stop_name || headsign || "Destination unavailable")
        : (headsign || finalStop?.stop_name || "Destination unavailable"));
      departures.push({
        tripId: prefixed(tripId), routeId: prefixed(trip.route_id), serviceId: prefixed(trip.service_id),
        directionId: trip.direction_id, stopId: prefixed(current.stop_id), departureTime, seconds: timeToSeconds(departureTime),
        destination, variant: null,
        nextStop: decodeEntities(stopsById.get(times[index + 1].stop_id)?.stop_name || "") || null,
        servesGovernorsIsland: false,
        // Which of the other Manhattan terminals this boat calls at before it gets where it is
        // going. The final stop is excluded because it is already the destination on the row, and
        // the departure stop is excluded by construction — the slice starts after it.
        viaTerminals: feed.connectingTerminals
          ? times.slice(index + 1, -1).map((stopTime) => feed.connectingTerminals.get(stopTime.stop_id)).filter(Boolean)
          : [],
        // Partner crews aren't in the NYC Ferry schedule workbook.
        boatAssignment: null,
        mode: modeOf(route),
        operator: agencyName,
        // Partner operators publish no crew schedule, so none of this is knowable for them.
        endsShift: null, outOfService: noPickup, crewShuttle: false, crewBoats: null,
        departureTimeEnd: null, secondsEnd: null, endsDay: false,
        via: [],
        // Kept only to stitch split sailings back together below, then discarded.
        // Some shuttle-bus stop_times carry no time at all, so a call without one is left out and
        // the group it belongs to simply will not qualify for merging below.
        onward: times.slice(index + 1)
          .filter((stopTime) => stopTime.arrival_time || stopTime.departure_time)
          .map((stopTime) => ({
            name: decodeEntities(stopsById.get(stopTime.stop_id)?.stop_name || ""),
            seconds: timeToSeconds(stopTime.arrival_time || stopTime.departure_time)
          }))
      });
    }

    // Arrivals that terminate here, drop-off only.
    //
    // A departure board shows departures, so a trip's last stop is normally not a row at all. But
    // Seastreak's New Jersey commuter boats end their run in Manhattan, and "when does the
    // Highlands boat get in" is a question crew are asked at the pier all morning. The operator
    // flags those calls itself with pickup_type 1 on the final stop, so the board is reading a
    // published fact rather than guessing which arrivals matter.
    //
    // Only the final stop, and only when flagged: a mid-route drop-off is already covered as a
    // departure above, and an unflagged terminus is just the end of a trip nobody asked about.
    if (feed.showDropOffArrivals && times.length > 1) {
      const last = times.at(-1);
      const arrivalTime = last.arrival_time || last.departure_time;
      if (last.pickup_type === "1" && selectedStops.has(last.stop_id) && arrivalTime) {
        const origin = decodeEntities(stopsById.get(times[0].stop_id)?.stop_name || "");
        departures.push({
          tripId: prefixed(tripId), routeId: prefixed(trip.route_id), serviceId: prefixed(trip.service_id),
          directionId: trip.direction_id, stopId: prefixed(last.stop_id),
          departureTime: arrivalTime, seconds: timeToSeconds(arrivalTime),
          // The row's headline. An arrival has no destination — it is the destination — so the
          // line says where the boat is coming from instead, which is the only thing left to ask.
          destination: origin ? `Arrives from ${origin}` : "Arrives",
          variant: null, nextStop: null, servesGovernorsIsland: false, viaTerminals: [],
          boatAssignment: null, mode: modeOf(route), operator: agencyName,
          endsShift: null, outOfService: false, crewShuttle: false, crewBoats: null,
          departureTimeEnd: null, secondsEnd: null, endsDay: false, via: [],
          // What makes the row read as an arrival rather than a sailing anyone can join.
          arrival: true,
          onward: []
        });
      }
    }
  }

  mergeSplitSailings(departures, feed.lineOfRoute);
  for (const departure of departures) delete departure.onward;

  const usedTripIds = new Set(departures.map((item) => item.tripId));
  const tripSchedules = Object.fromEntries([...usedTripIds].map((prefixedTripId) => [prefixedTripId, {
    stops: (timesByTrip.get(prefixedTripId.slice(feed.prefix.length)) || []).map((stopTime) => ({
      stopId: prefixed(stopTime.stop_id),
      sequence: Number(stopTime.stop_sequence),
      arrivalSeconds: stopTime.arrival_time ? timeToSeconds(stopTime.arrival_time) : null,
      departureSeconds: stopTime.departure_time ? timeToSeconds(stopTime.departure_time) : null
    }))
  }]));

  const usedRouteIds = new Set(departures.map((item) => item.routeId));
  const routeData = Object.fromEntries(routes
    .filter((item) => usedRouteIds.has(prefixed(item.route_id)))
    .map((item) => [prefixed(item.route_id), {
      id: prefixed(item.route_id), shortName: decodeEntities(item.route_short_name) || item.route_id,
      name: decodeEntities(item.route_long_name || item.route_short_name) || item.route_id,
      color: color(item.route_color, feed.defaultColor), textColor: color(item.route_text_color, "#FFFFFF"),
      mode: modeOf(item), operator: agencyName
    }]));

  const calendars = parseCsv(calendarRaw).map((item) => ({
    serviceId: prefixed(item.service_id),
    weekdays: [item.sunday,item.monday,item.tuesday,item.wednesday,item.thursday,item.friday,item.saturday].map((v) => v === "1"),
    startDate: isoDate(item.start_date), endDate: isoDate(item.end_date)
  }));
  const exceptions = parseCsv(datesRaw).map((item) => ({
    serviceId: prefixed(item.service_id), date: isoDate(item.date), added: item.exception_type === "1"
  }));

  // public/app.js only counts a departure whose service is in effect today, so a feed whose whole
  // calendar has lapsed contributes nothing and does so silently — the operator's rows just never
  // appear. Partner feeds are third-party and go stale without warning, so say it out loud at
  // build time rather than leaving someone to debug an empty row. The build still succeeds: an
  // expired feed is a publishing problem upstream, not a reason to refuse to build the board.
  const today = new Date().toISOString().slice(0, 10);
  const latestEnd = calendars.reduce((latest, item) => (item.endDate && item.endDate > latest ? item.endDate : latest), "");
  if (calendars.length && latestEnd && latestEnd < today) {
    console.warn(`WARNING: the ${feed.label} feed in ${feed.directory} expired on ${latestEnd}; no departures will be shown until it is replaced.`);
  }

  const stops_ = stopDirectory({
    tripSchedules,
    // The schedules carry prefixed ids; this feed's own stops.txt does not.
    nameOf: (stopId) => decodeEntities(stopsById.get(stopId.slice(feed.prefix.length))?.stop_name || ""),
    landingIndex
  });

  return { agencyName, departures, tripSchedules, stops: stops_, routes: routeData, calendars, exceptions };
}

export async function buildDisplayData({
  root = ROOT,
  landingNumber: landingOverride,
  departuresShown: departuresShownOverride,
  waterwayEnabled: waterwayEnabledOverride,
  seastreakEnabled: seastreakEnabledOverride,
  nyuEnabled: nyuEnabledOverride,
  libertyEnabled: libertyEnabledOverride,
  busesEnabled: busesEnabledOverride
} = {}) {
  let [displayRaw, landingsRaw, routesRaw, stopsRaw, tripsRaw, timesRaw, calendarRaw, datesRaw, feedRaw, agencyRaw] = await Promise.all([
    readFile(path.join(root, "config/display.json"), "utf8"), readFile(path.join(root, "config/landings.json"), "utf8"),
    readFile(path.join(root, "gtfs/routes.txt"), "utf8"), readFile(path.join(root, "gtfs/stops.txt"), "utf8"),
    readFile(path.join(root, "gtfs/trips.txt"), "utf8"), readFile(path.join(root, "gtfs/stop_times.txt"), "utf8"),
    readFile(path.join(root, "gtfs/calendar.txt"), "utf8"), readFile(path.join(root, "gtfs/calendar_dates.txt"), "utf8"),
    readFile(path.join(root, "gtfs/feed_info.txt"), "utf8"), readFile(path.join(root, "gtfs/agency.txt"), "utf8")
  ]);
  const november = await readFile(path.join(root, "schedules/november-2026-live.json"), "utf8")
    .then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const novemberPrefix = "nyc:november:";
  const appendCsv = (raw, rows) => {
    const fields = raw.trim().split(/\r?\n/)[0].split(",");
    const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return raw.trimEnd() + "\n" + rows.map(row => fields.map(key => quote(row[key])).join(",")).join("\n") + "\n";
  };
  if (november) {
    calendarRaw = appendCsv(calendarRaw, november.tables.calendar.map(row => ({ ...row, service_id: novemberPrefix + row.service_id })));
    datesRaw = appendCsv(datesRaw, november.tables.calendar_dates.map(row => ({ ...row, service_id: novemberPrefix + row.service_id })));
  }
  // Crew-schedule boat assignments ("East River 5"), keyed by GTFS trip_short_name. Generated
  // from the seasonal workbook by scripts/import-boat-assignments.py. Optional: a feed with no
  // matching schedule on hand still builds, just without assignment labels.
  const boatAssignments = await readFile(path.join(root, "content/boat-assignments.json"), "utf8")
    .then((raw) => JSON.parse(raw).assignments || {})
    .catch(() => ({}));
  // Home port and crew shuttles. Optional in the same way and for the same reason: neither the
  // feed nor the workbook describes a boat's movements once it stops carrying passengers, so a
  // board without this file simply shows no out-of-service rows.
  const storedCrewConfig = await readFile(path.join(root, "config/crew-shuttles.json"), "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  const curatedFallFeed = ["20260913", "20260920"].includes(parseCsv(feedRaw)[0]?.feed_version) &&
    parseCsv(feedRaw)[0]?.feed_end_date === "20261101";
  const fallCrew = curatedFallFeed
    ? await readFile(path.join(root, "schedules/fall-2026-weekday-crew.json"), "utf8")
      .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  const fallWeekendCrew = fallCrew
    ? await readFile(path.join(root, "schedules/fall-2026-weekend-crew.json"), "utf8")
      .then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; }) : null;
  const confirmedCrewServices = new Set([...(fallCrew?.serviceIds || []), ...(fallWeekendCrew?.serviceIds || [])]);
  const crewUnconfirmed = !fallCrew && storedCrewConfig.confirmationStatus === "unconfirmed";
  const crewConfig = fallCrew ? { homePort: storedCrewConfig.homePort, shuttles: { ...fallCrew.shuttles, ...fallWeekendCrew?.shuttles } }
    : crewUnconfirmed ? { homePort: storedCrewConfig.homePort } : storedCrewConfig;
  // Published crew shift boundaries, imported from the workbook's cell notes by
  // scripts/import-boat-shifts.py. Optional: without it every shift end is inferred from gaps.
  const storedBoatShifts = await readFile(path.join(root, "content/boat-shifts.json"), "utf8")
    .then((raw) => JSON.parse(raw).shifts || {})
    .catch(() => ({}));
  const boatShifts = fallCrew ? { ...fallCrew.shifts, ...fallWeekendCrew?.shifts } : crewUnconfirmed ? {} : storedBoatShifts;
  const holidaySource = await readFile(path.join(root, "schedules/sukkot-2026.json"), "utf8")
    .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const holidayLive = holidaySource ? await readFile(path.join(root, "schedules/sukkot-2026-live.json"), "utf8")
    .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  const holidayCrew = holidaySource ? await readFile(path.join(root, "schedules/sukkot-2026-crew.json"), "utf8")
    .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  const postHolidayLive = holidaySource ? await readFile(path.join(root, "schedules/fall-2026-post-sukkot-live.json"), "utf8")
    .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  if (holidaySource && (!holidayLive || !postHolidayLive || !holidayCrew)) {
    throw new Error("Missing reviewed Sukkot crew or live trip mapping.");
  }
  if (holidayLive && JSON.stringify(holidayLive.dates) !== JSON.stringify(holidaySource.dates)) {
    throw new Error("Sukkot live trip mapping dates disagree with the published timetable.");
  }
  if (holidayLive && holidayLive.counts.matched < holidayLive.counts.printed * 0.8) {
    throw new Error("Sukkot live trip mapping needs review against the operator GTFS.");
  }
  if (holidayCrew && (JSON.stringify(holidayCrew.dates) !== JSON.stringify(holidaySource.dates)
    || holidayCrew.feedVersion !== holidayLive.feedVersion
    || holidayCrew.workbookSha256 !== holidayLive.boardWorkbookSha256
    || holidayCrew.rejected?.length)) {
    throw new Error("Sukkot crew pickups need review against the workbook and operator GTFS.");
  }
  if (holidaySource && !curatedFallFeed) {
    throw new Error("Sukkot 2026 supplement must be reviewed against the replacement NYC Ferry feed.");
  }
  // Historical holiday IDs retain their archived feed. Ordinary service follows the reviewed
  // current feed, including cruise trips whose operator IDs change between service dates.
  const postIdentity = (id, field = "liveTripId") => id.startsWith(novemberPrefix)
    ? { [field]: id.slice(novemberPrefix.length) } : !postHolidayLive ? {} : ({
    [field]: postHolidayLive.matches[id] || `nyc:unmapped:${id}`,
    ...(postHolidayLive.datedMatches?.[id] ? { [`${field}sByDate`]: postHolidayLive.datedMatches[id] } : {})
  });
  if (!holidaySource && curatedFallFeed) {
    throw new Error("Missing schedules/sukkot-2026.json: the fall feed excludes ordinary service on the holiday dates.");
  }
  const display = JSON.parse(displayRaw);
  const landings = JSON.parse(landingsRaw);
  const landingNumber = Number(landingOverride ?? display.landingNumber);
  const landingConfig = landings[String(landingNumber)];
  // The set of valid landings is whatever config/landings.json declares, so adding a landing
  // only requires editing that file (plus a matching overrides/NN.json for SFTP notices).
  const activeLandingNumbers = Object.entries(landings)
    .filter(([, item]) => !item.unused).map(([key]) => Number(key)).sort((left, right) => left - right);
  if (!Number.isInteger(landingNumber) || !landingConfig || landingConfig.unused) {
    throw new Error(`Landing number must be an active landing from ${activeLandingNumbers[0]} through ${activeLandingNumbers.at(-1)}; received ${landingOverride ?? display.landingNumber}.`);
  }
  const departureWindowMinutes = Number(display.departureWindowMinutes);
  if (!Number.isFinite(departureWindowMinutes) || departureWindowMinutes < 1 || departureWindowMinutes > 1440) {
    throw new Error(`config/display.json departureWindowMinutes must be between 1 and 1440; received ${display.departureWindowMinutes}.`);
  }
  const departuresShown = Number(departuresShownOverride ?? display.departuresShown);
  if (!Number.isInteger(departuresShown) || departuresShown < 1 || departuresShown > 5) {
    throw new Error(`config/display.json departuresShown must be a whole number from 1 through 5; received ${departuresShownOverride ?? display.departuresShown}.`);
  }
  // config/display.json "busesEnabled" keeps or drops connecting shuttle-bus routes (GTFS
  // route_type 3) from both feeds: the Rockaway shuttles at landing 18 and the NY Waterway
  // shuttles at Pier 79 and the other waterway landings. Omitting the key means true, so a
  // config that predates this switch keeps every mode it used to show.
  if (display.busesEnabled !== undefined && typeof display.busesEnabled !== "boolean") {
    throw new Error(`config/display.json busesEnabled must be true or false; received ${JSON.stringify(display.busesEnabled)}.`);
  }
  const busesEnabled = (busesEnabledOverride ?? display.busesEnabled ?? true) === true;

  const routes = parseCsv(routesRaw), stops = parseCsv(stopsRaw), trips = parseCsv(tripsRaw), stopTimes = parseCsv(timesRaw);
  if (november) {
    for (const row of november.tables.routes) if (!routes.some(old => old.route_id === row.route_id)) routes.push(row);
    for (const row of november.tables.stops) if (!stops.some(old => old.stop_id === row.stop_id)) stops.push(row);
    // Blank only the crew join key in memory; the archived published working numbers remain intact.
    trips.push(...november.tables.trips.map(row => ({ ...row, trip_id: novemberPrefix + row.trip_id,
      service_id: novemberPrefix + row.service_id, trip_short_name: "" })));
    stopTimes.push(...november.tables.stop_times.map(row => ({ ...row, trip_id: novemberPrefix + row.trip_id })));
  }
  const agency = parseCsv(agencyRaw)[0] || {};
  const routesById = new Map(routes.map((item) => [item.route_id, item]));
  const stopsById = new Map(stops.map((item) => [item.stop_id, item]));
  const tripsById = new Map(trips.map((item) => [item.trip_id, item]));
  // Pier C is where the boats sleep, not somewhere the schedule stops, so no operator publishes it
  // and no feed contains it. Its landing is virtual: everything on it is derived from the crew
  // schedule's shift starts rather than read out of stop_times.txt.
  const isVirtual = landingConfig.virtual === true;
  // A landing the home agency does not call at.
  //
  // Every landing used to be an NYC Ferry stop with partners alongside it, so stopIds could be
  // assumed present and its first entry could be trusted to carry the landing's position. Whitehall
  // breaks that: the Staten Island Ferry, Seastreak and the Trust's Manhattan boat all berth there
  // and NYC Ferry does not stop there at all. Soissons Landing is the same case on the island.
  //
  // Such a landing is not virtual — it is a real dock with real published departures — so it keeps
  // going through the ordinary path, contributing no NYC Ferry departures because it matches no
  // NYC Ferry stop, and takes its position from config instead of from a stops.txt row it has none
  // of. Everything downstream is unchanged: partner stop ids were never read from here.
  const stopIds = landingConfig.stopIds || [];
  const partnerOnly = !isVirtual && stopIds.length === 0;
  if (partnerOnly && !(Number.isFinite(Number(landingConfig.latitude)) && Number.isFinite(Number(landingConfig.longitude)))) {
    throw new Error(`Landing ${landingNumber} has no NYC Ferry stopIds, so config/landings.json must give it a latitude and longitude.`);
  }
  const selectedStops = new Set(stopIds);
  const governorsIslandStops = new Set(landings["11"]?.stopIds || []);
  if (!isVirtual) {
    for (const stopId of selectedStops) if (!stopsById.has(stopId)) throw new Error(`Landing ${landingNumber} references missing GTFS stop ${stopId}.`);
  }

  const timesByTrip = new Map();
  for (const item of stopTimes) {
    const list = timesByTrip.get(item.trip_id) || [];
    list.push(item); timesByTrip.set(item.trip_id, list);
  }
  for (const list of timesByTrip.values()) list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  // Where each boat stops working. Only answerable because the workbook says which boat runs which
  // trip: grouped by boat, a shift ending mid-day is a hole in that boat's own run of trips. Routes
  // with no boat number (Governors Island, the Rockaway shuttle buses) contribute nothing.
  const calendarByService = new Map(parseCsv(calendarRaw).map((item) => [item.service_id, item]));
  const runs = boatRuns({ trips, timesByTrip, boatAssignments });
  const dayTypeOf = (serviceId) => {
    if (fallWeekendCrew && ["7", "8"].includes(serviceId)) return "weekend";
    const row = calendarByService.get(serviceId);
    if (!row) return null;
    const runsWeekday = ["monday", "tuesday", "wednesday", "thursday", "friday"].some((day) => row[day] === "1");
    const runsWeekend = row.saturday === "1" || row.sunday === "1";
    return runsWeekday && !runsWeekend ? "weekday" : (runsWeekend && !runsWeekday ? "weekend" : null);
  };
  // Sailings the timetable prints but dispatch does not run. Applied before the departures are
  // built so the calls the boat skips never become rows at all.
  const nonRevenueTrips = applyNonRevenueRuns({ trips, timesByTrip, dayTypeOf });

  // Which boats have a crew brought out to them rather than going home to swap. Read twice: once to
  // stop a shuttled boat being called out of service, and once to stop its next shift being counted
  // as a fresh departure from Pier C.
  const crewSwaps = crewSwapIndex({ shuttles: crewConfig.shuttles, landings });
  // The fall feed splits one working across unchanged and new service IDs. Crew boundaries
  // apply to each complete working and day type, never to the end of one fragment.
  const crewRuns = fallCrew ? new Map() : runs;
  if (fallCrew) {
    for (const list of runs.values()) {
      if (!list.length || !confirmedCrewServices.has(list[0].serviceId)) continue;
      // Cruise services 7 and 8 have identical trips on disjoint dates; never combine them.
      const kind = dayTypeOf(list[0].serviceId);
      const cruise = ["7", "8"].includes(list[0].serviceId) ? list[0].serviceId : "";
      const key = `${kind}|${cruise}|${list[0].routeId}|${list[0].boat}`;
      crewRuns.set(key, [...(crewRuns.get(key) || []), ...list]);
    }
    for (const list of crewRuns.values()) list.sort((a,b) => a.startSeconds - b.startSeconds);
  }
  const breaks = crewUnconfirmed ? { certainty: new Map(), tieUps: [] } : serviceBreaks({
    runs: crewRuns, dayTypeOf, shifts: boatShifts, timesByTrip: fallWeekendCrew ? timesByTrip : new Map(),
    stopName: (stopId) => stopsById.get(stopId)?.stop_name || null,
    gapMinutes: Number(crewConfig.outOfService?.gapMinutes) || 60,
    certainAfterMinutes: Number(crewConfig.outOfService?.certainAfterMinutes) || 180,
    crewSwaps
  });
  // An intermediate crew change does not prevent the new crew turning at the
  // passenger trip's final terminal.
  const terminalShiftEnds = new Map(breaks.certainty);
  for (const [tripId, cutoff] of breaks.endAt || []) {
    const final = timesByTrip.get(tripId)?.at(-1);
    if (final && cutoff < timeToSeconds(final.arrival_time)) terminalShiftEnds.delete(tripId);
  }
  const turnarounds = calendarTurnaroundLayovers({ runs, endsShift: terminalShiftEnds,
    calendars: [...calendarByService.values()], exceptions: parseCsv(datesRaw) });

  let departures = [];
  for (const [tripId, times] of timesByTrip) {
    const trip = tripsById.get(tripId), route = routesById.get(trip?.route_id);
    if (!trip || !route) continue;
    if (!busesEnabled && route.route_type === "3") continue;
    for (let index = 0; index < times.length - 1; index += 1) {
      const current = times[index];
      if (!selectedStops.has(current.stop_id) || current.pickup_type === "1") continue;
      const departureTime = current.departure_time || current.arrival_time;
      if (!departureTime) continue;
      const finalStop = stopsById.get(times.at(-1).stop_id);
      const destination = destinationInfo(current, trip, finalStop, trip.route_id);
      const servesGovernorsIsland = trip.route_id === "SB" &&
        times.slice(index).some((stopTime) => governorsIslandStops.has(stopTime.stop_id));
      const assignedBoat = boatAssignments[String(trip.trip_short_name || "").trim()];
      departures.push({
        tripId, liveTripId: null, ...postIdentity(tripId),
        routeId: trip.route_id, serviceId: trip.service_id, directionId: trip.direction_id,
        stopId: current.stop_id, departureTime, seconds: timeToSeconds(departureTime),
        destination: destination.destination, variant: destination.variant,
        nextStop: stopsById.get(times[index + 1].stop_id)?.stop_name || null,
        servesGovernorsIsland,
        boatAssignment: Number.isInteger(assignedBoat) ? assignedBoat : null,
        mode: route.route_type === "3" ? "bus" : "ferry",
        operator: agency.agency_name || "NYC Ferry",
        // Flagged on every leg of the trip, not just the last one: an agent at Pier 11 watching the
        // boat leave needs to know it is not coming back, not to be told once it has already gone.
        endsShift: timeToSeconds(departureTime) < (breaks.endAt?.get(tripId) ?? Infinity) ? breaks.certainty.get(tripId) || null : null,
        // A deadhead is out of service in the only sense the board means it: the boat is moving and
        // nobody boards. It reads the same as a boat running home, which is what it is.
        outOfService: nonRevenueTrips.has(tripId), crewShuttle: false, crewBoats: null,
        departureTimeEnd: null, secondsEnd: null, endsDay: false
      });
    }
  }
  departures.sort((a, b) => a.seconds - b.seconds || a.routeId.localeCompare(b.routeId));
  const holidayRows = holidayDepartures({ source: holidaySource, liveMatches: holidayLive?.matches,
    selectedStops, stopsById,
    agency: agency.agency_name || "NYC Ferry", busesEnabled });
  const holidayOps = holidayOperations(holidayLive, holidayCrew);
  for (const row of holidayRows) {
    const key = holidayTripKey(row.liveTripId);
    const trip = holidayOps.schedules[row.liveTripId];
    const call = trip?.stops.find(stop => stop.stopId === row.stopId && stop.departureSeconds === row.seconds && stop.pickupType !== 1);
    if (!call) continue;
    row.timetableOnly = false;
    row.endsShift = row.seconds < (holidayOps.cutoff.get(key) ?? Infinity) ? holidayOps.certainty.get(key) || null : null;
  }
  departures.push(...holidayRows);
  const usedTripIds = new Set(departures.map((item) => item.tripId));
  // Home-port rows open the arriving trip, even at a terminal with no pickup on that trip.
  for (const run of breaks.tieUps) {
    if (selectedStops.has(run.endStopId)) usedTripIds.add(run.tripId);
  }
  const tripSchedules = Object.fromEntries([...usedTripIds].map((tripId) => {
    const turnaround = turnarounds.get(tripId);
    return [tripId, {
      ...(tripsById.has(tripId) ? postIdentity(tripId) : {}),
      stops: (timesByTrip.get(tripId) || []).map((stopTime) => ({
        stopId: stopTime.stop_id,
        sequence: Number(stopTime.stop_sequence),
        arrivalSeconds: stopTime.arrival_time ? timeToSeconds(stopTime.arrival_time) : null,
        departureSeconds: stopTime.departure_time ? timeToSeconds(stopTime.departure_time) : null
      })),
      ...(turnaround ? { turnaround: { ...turnaround, ...postIdentity(turnaround.nextTripId, "nextLiveTripId") } } : {})
    }];
  }));
  const holidaySchedule = (id) => {
    const trip = holidayOps.schedules[id];
    if (!trip) return null;
    const turnaround = holidayOps.turns.get(holidayTripKey(id));
    return { liveTripId: id, serviceId: HOLIDAY_SERVICE, routeId: trip.routeId,
      boatAssignment: trip.boatAssignment, stops: trip.stops,
      ...(turnaround ? { turnaround } : {}) };
  };
  for (const [id, trip] of Object.entries(holidayOps.schedules)) {
    if (trip.stops.some(stop => selectedStops.has(stop.stopId)) ||
        (isVirtual && Object.values(holidayCrew?.shifts?.holiday || {}).flat().some(shift => shift.predictTripId === id))) {
      tripSchedules[holidayTripKey(id)] = holidaySchedule(id);
    }
  }
  for (const row of holidayRows) {
    tripSchedules[row.tripId] = row.timetableOnly === false ? holidaySchedule(row.liveTripId)
      : { timetableOnly: true, stops: [{ stopId: row.stopId, sequence: 1,
          arrivalSeconds: row.scheduledArrivalSeconds ?? null, departureSeconds: row.seconds }] };
  }
  const landingIndex = stopLandingIndex(landings);
  const stopsDirectory = stopDirectory({
    tripSchedules,
    nameOf: (stopId) => decodeEntities(stopsById.get(stopId)?.stop_name || ""),
    landingIndex
  });
  const usedRouteIds = new Set(departures.map((item) => item.routeId));
  const routeData = Object.fromEntries(routes.filter((item) => usedRouteIds.has(item.route_id)).map((item) => [item.route_id, {
    id: item.route_id, shortName: item.route_short_name || item.route_id, name: item.route_long_name,
    color: color(item.route_color, "#004E72"), textColor: color(item.route_text_color, "#FFFFFF"), mode: item.route_type === "3" ? "bus" : "ferry",
    operator: agency.agency_name || "NYC Ferry"
  }]));
  const stopDetails = isVirtual || partnerOnly
    ? [{ stop_lat: landingConfig.latitude, stop_lon: landingConfig.longitude }]
    : stopIds.map((id) => stopsById.get(id));
  const feed = november?.tables.feed_info[0] || parseCsv(feedRaw)[0] || {};
  let calendars = parseCsv(calendarRaw).map((item) => ({ serviceId: item.service_id, weekdays: [item.sunday,item.monday,item.tuesday,item.wednesday,item.thursday,item.friday,item.saturday].map((v) => v === "1"), startDate: isoDate(item.start_date), endDate: isoDate(item.end_date) }));
  let exceptions = parseCsv(datesRaw).map((item) => ({ serviceId: item.service_id, date: isoDate(item.date), added: item.exception_type === "1" }));
  if (holidaySource) {
    calendars.push({ serviceId: HOLIDAY_SERVICE, weekdays: Array(7).fill(false),
      startDate: holidaySource.dates[0], endDate: holidaySource.dates.at(-1) });
    exceptions.push(...holidaySource.dates.map((date) => ({ serviceId: HOLIDAY_SERVICE, date, added: true })));
  }

  // The moves a boat makes with no passengers aboard: the run to the home port after its last
  // revenue trip, and the crew shuttles that swap a crew mid-day without ending the boat's service.
  // Both are NYC Ferry only, and both are additions to the board rather than edits to it — no
  // published departure time is changed by any of this.
  const operatorName = agency.agency_name || "NYC Ferry";
  const homePort = crewConfig.homePort || "Pier C";
  if (isVirtual && !crewUnconfirmed) {
    const serviceOfDay = (kind) => {
      if (fallCrew) return kind === "weekday" ? "crew-weekday" : fallWeekendCrew && kind === "weekend" ? "crew-weekend" : null;
      for (const [serviceId, row] of calendarByService) if (dayTypeOf(serviceId) === kind) return serviceId;
      return null;
    };
    departures = homePortDepartures({
      shifts: boatShifts, dayTypeOf, servicesOfDay: serviceOfDay, homePort, operator: operatorName, runs: crewRuns,
      crewSwaps
    });
    if (holidayCrew) departures.push(...homePortDepartures({
      shifts: holidayCrew.shifts, dayTypeOf: () => "holiday",
      servicesOfDay: kind => kind === "holiday" ? HOLIDAY_SERVICE : null,
      homePort, operator: operatorName
    }));
    for (const row of departures) {
      if (row.serviceId === HOLIDAY_SERVICE && holidaySchedule(row.predictTripId)) {
        tripSchedules[row.tripId] = holidaySchedule(row.predictTripId);
      }
      if (row.serviceId !== HOLIDAY_SERVICE) {
        if (row.liveTripId) Object.assign(row, postIdentity(row.liveTripId));
        if (row.predictTripId) Object.assign(row, postIdentity(row.predictTripId, "predictTripId"));
      }
    }
  }
  const holidayReturns = homePortRows({ tieUps: holidayOps.tieUps, selectedStops, homePort,
    dwellMinutes: Number(crewConfig.homePortDwellMinutes) || 0, operator: operatorName });
  for (const row of holidayReturns) {
    row.liveTripId = holidayOps.tieUps.find(run => row.tripId === `oos:${run.tripId}`).liveTripId;
    tripSchedules[row.tripId] = holidaySchedule(row.liveTripId);
  }
  const outOfServiceDepartures = [
    ...holidayReturns,
    ...(holidayCrew ? crewShuttleRows({
      shuttles: { holiday: holidayCrew.shuttles.holiday.map(entry => ({ ...entry, serviceId: HOLIDAY_SERVICE })) },
      landingNumber, landings, selectedStops, homePort, operator: operatorName,
      boatDepartures: holidayOps.boatDepartures
    }) : []),
    ...homePortRows({
      tieUps: breaks.tieUps, selectedStops, homePort,
      dwellMinutes: Number(crewConfig.homePortDwellMinutes) || 0, operator: operatorName
    }),
    ...crewShuttleRows({
      shuttles: crewConfig.shuttles, landingNumber, landings, selectedStops, homePort, operator: operatorName,
      boatDepartures: boatDeparturesByDay({ trips: fallCrew ? trips.filter(t => confirmedCrewServices.has(t.service_id)) : trips, timesByTrip, boatAssignments, dayTypeOf })
    }),
    // Every shuttle sails from the home port, so the home port's board lists all of them — the
    // outbound leg only, since the range's far end at the collecting landing is the run back here.
    ...(isVirtual ? homePortCrewShuttles({ shuttles: crewConfig.shuttles, landings, homePort, operator: operatorName }) : []),
    ...(isVirtual && holidayCrew ? homePortCrewShuttles({
      shuttles: { holiday: holidayCrew.shuttles.holiday.map(entry => ({ ...entry, serviceId: HOLIDAY_SERVICE })) },
      landings, homePort, operator: operatorName
    }) : [])
  ];
  for (const row of outOfServiceDepartures) {
    if (postHolidayLive && row.serviceId !== HOLIDAY_SERVICE && row.liveTripId) {
      if (tripSchedules[row.liveTripId]) tripSchedules[row.tripId] = tripSchedules[row.liveTripId];
      Object.assign(row, postIdentity(row.liveTripId));
    }
  }
  if (fallWeekendCrew) {
    // Existing service 4 also runs before this board takes effect. Intersect its
    // operational rows with the imported season without changing passenger calendars.
    const scopedId = id => `crew:fall-weekend:${id}`;
    for (const id of fallWeekendCrew.serviceIds) {
      const calendar = calendars.find(c => c.serviceId === id);
      if (!calendar) continue;
      calendars.push({ ...calendar, serviceId: scopedId(id),
        startDate: calendar.startDate < fallWeekendCrew.startDate ? fallWeekendCrew.startDate : calendar.startDate,
        endDate: calendar.endDate > fallWeekendCrew.endDate ? fallWeekendCrew.endDate : calendar.endDate });
      exceptions.push(...exceptions.filter(e => e.serviceId === id && e.date >= fallWeekendCrew.startDate && e.date <= fallWeekendCrew.endDate)
        .map(e => ({ ...e, serviceId: scopedId(id) })));
    }
    for (const row of outOfServiceDepartures) {
      if (fallWeekendCrew.serviceIds.includes(row.serviceId)) row.serviceId = scopedId(row.serviceId);
    }
  }
  if (outOfServiceDepartures.length) {
    departures.push(...outOfServiceDepartures);
    departures.sort((a, b) => a.seconds - b.seconds || a.routeId.localeCompare(b.routeId));
    // A crew shuttle cannot reuse the feed's weekday service: on a holiday the feed still runs
    // weekdays while the crews change on the weekend pattern, so the shuttles get their own pair of
    // calendars bounded to the same dates the feed covers.
    const bounds = calendars.filter((item) => item.startDate && item.endDate);
    const crew = crewCalendars({
      startDate: fallCrew?.startDate || bounds.map((item) => item.startDate).sort()[0] || null,
      endDate: fallCrew?.endDate || bounds.map((item) => item.endDate).sort().at(-1) || null,
      holidays: crewConfig.holidays?.dates || []
    });
    if (fallWeekendCrew) {
      const weekend = crew.calendars.find(c => c.serviceId === "crew-weekend");
      weekend.startDate = fallWeekendCrew.startDate;
      weekend.endDate = fallWeekendCrew.endDate;
    }
    calendars = calendars.concat(crew.calendars);
    exceptions = exceptions.concat(crew.exceptions);
    if (fallCrew && holidaySource) exceptions.push(...holidaySource.dates.flatMap(date =>
      ["crew-weekday", "crew-weekend"].map(serviceId => ({serviceId, date, added:false}))));
    if (outOfServiceDepartures.some((item) => item.crewShuttle)) {
      routeData[CREW_ROUTE_ID] = { ...CREW_ROUTE, operator: operatorName };
    }
  }

  // Partner-operator departures (NY Waterway, Seastreak, NYU). Each is controlled by two independent,
  // additive switches: the operator's "...Enabled" key in config/display.json (global on/off for
  // the kiosk) and its "...StopIds" array in config/landings.json (per-landing; only landings with
  // that operator's dock nearby should set it). When either is off for an operator, none of its
  // data is read and the output keeps the same shape NYC-Ferry-only builds always produced.
  const partnerOverrides = { waterway: waterwayEnabledOverride, seastreak: seastreakEnabledOverride, nyu: nyuEnabledOverride, liberty: libertyEnabledOverride };
  const partners = {};
  for (const [name, feed] of Object.entries(PARTNER_FEEDS)) {
    const stopIds = landingConfig[feed.stopIdsKey] || [];
    // A missing switch means on, not off.
    //
    // config/display.json is the one file a deployment never overwrites — it holds the box's own
    // landingNumber and settings — so a release that adds an operator arrives with its switch
    // absent from the live config, and a switch read as false made the new operator invisible on
    // the very deploy that shipped it. That failure is silent: the landings appear, the boats do
    // not, and nothing in the logs says why.
    //
    // Defaulting to on is safe because the switch is not what decides where an operator shows. The
    // per-landing stop ids below do, and they live in config/landings.json, which every deploy does
    // ship. An operator with no stopIds anywhere stays off no matter what this reads. Turning one
    // off deliberately still works — the key is present in the repo's own display.json for every
    // operator — it now has to say so rather than be omitted.
    const enabled = (partnerOverrides[name] ?? display[feed.enabledKey] ?? true) === true && stopIds.length > 0;
    partners[name] = { enabled, agencyName: null, stopIds };
    if (!enabled) continue;
    const merged = await buildPartnerFeed({ root, feed, stopIds, landingNumber, busesEnabled, landingIndex });
    partners[name].agencyName = merged.agencyName;
    Object.assign(tripSchedules, merged.tripSchedules);
    Object.assign(stopsDirectory, merged.stops);
    Object.assign(routeData, merged.routes);
    calendars = calendars.concat(merged.calendars);
    exceptions = exceptions.concat(merged.exceptions);
    departures.push(...merged.departures);
  }
  // A feed can carry the same sailing twice. NY Waterway's does: the South Amboy route keeps a
  // stale pair of trips alongside the current ones, so 3:35 PM and 4:35 PM to South Amboy each
  // appear on the board twice, one row per trip id. Two rows that agree on service, route, stop,
  // minute and destination are one boat as far as a rider is concerned, and showing them twice
  // makes the board look broken and pushes a real later sailing off the screen.
  //
  // This drops the duplicate row, never a time: a sailing only disappears if an identical one
  // remains. The first occurrence wins, which is stable for a given feed because stop_times.txt
  // is read in file order.
  const seenDepartures = new Set();
  const deduped = departures.filter((item) => {
    const key = [item.serviceId, item.routeId, item.variant || "", item.stopId, item.departureTime, item.destination].join("\0");
    if (seenDepartures.has(key)) return false;
    seenDepartures.add(key);
    return true;
  });
  if (deduped.length !== departures.length) {
    console.warn(`NOTE: dropped ${departures.length - deduped.length} duplicate departure(s) at landing ${landingNumber} — the feed lists the same sailing under more than one trip id.`);
  }
  departures = deduped;
  departures.sort((a, b) => a.seconds - b.seconds || a.routeId.localeCompare(b.routeId));

  // Virtual Pier C has no passenger calls, but its confirmed working movements
  // still need the operator's route names and colors.
  for (const routeId of new Set(departures.map(item => item.routeId))) {
    const route = routesById.get(routeId);
    if (routeData[routeId] || !route) continue;
    routeData[routeId] = { id: routeId, shortName: route.route_short_name || routeId,
      name: route.route_long_name, color: color(route.route_color, "#004E72"),
      textColor: color(route.route_text_color, "#FFFFFF"),
      mode: route.route_type === "3" ? "bus" : "ferry", operator: operatorName };
  }

  // Dispatch-withheld returns and unverified last drops both leave a boat's return off the board.
  const holidayCrewMessage = [
    holidayCrew?.withheldDrops?.length ? `${holidayCrew.withheldDrops.length} Pier C returns await dispatch confirmation.` : null,
    holidayCrew?.unresolvedEnds?.length ? `${holidayCrew.unresolvedEnds.length} Sukkot last-drop notes remain unverified; their home-port returns are omitted.` : null
  ].filter(Boolean).join(" ");
  return {
    meta: {
      schemaVersion: 11, generatedAt: new Date().toISOString(), landingNumber, departureWindowMinutes,
      departuresShown, busesEnabled,
      showDwellTimes: display.showDwellTimes === true,
      showLayoverTimes: display.showLayoverTimes !== false,
      crewScheduleStatus: fallCrew ? { status: "unconfirmed", message: CREW_UNCONFIRMED,
        confirmedWeekdays: { startDate: fallCrew.startDate, endDate: fallCrew.endDate,
          excludedDates: holidaySource?.dates || [] },
        confirmedWeekends: fallWeekendCrew ? { startDate: fallWeekendCrew.startDate, endDate: fallWeekendCrew.endDate,
          excludedDates: [] } : null,
        confirmedHolidays: holidayCrew ? { dates: holidayCrew.dates,
          ...(holidayCrewMessage ? { message: holidayCrewMessage } : {}) } : null }
        : crewUnconfirmed ? { status: "unconfirmed", message: CREW_UNCONFIRMED } : null,
      holidaySchedule: holidaySource ? { dates: holidaySource.dates,
        message: "Sukkot: published departures; verified trips include arrivals, dwell and live status. Unmatched rows show departure times only." } : null,
      landing: { name: landingConfig.name, displayName: landingConfig.displayName || landingConfig.name, stopIds,
        latitude: Number(stopDetails[0].stop_lat), longitude: Number(stopDetails[0].stop_lon) },
      timezone: agency.agency_timezone || "America/New_York", agencyName: agency.agency_name || "NYC Ferry", feedVersion: feed.feed_version,
      feedStartDate: isoDate(feed.feed_start_date), feedEndDate: isoDate(feed.feed_end_date),
      sourceHash: createHash("sha256").update(routesRaw + tripsRaw + timesRaw + calendarRaw + datesRaw +
        JSON.stringify(holidaySource) + JSON.stringify(holidayLive) + JSON.stringify(holidayCrew) + JSON.stringify(postHolidayLive) +
        JSON.stringify(november) + JSON.stringify(boatAssignments) + JSON.stringify(storedCrewConfig) + JSON.stringify(fallCrew) + JSON.stringify(fallWeekendCrew)).digest("hex").slice(0, 16),
      waterway: partners.waterway, waterwayBelford: partners.waterwayBelford, seastreak: partners.seastreak, nyu: partners.nyu, liberty: partners.liberty, ikea: partners.ikea, gi: partners.gi, siferry: partners.siferry, statue: partners.statue
    },
    calendars, exceptions,
    // Every stop the board's own trips call at, named and tied to a landing where one serves it.
    // Small — the trips on one board touch a few dozen stops between them — and in the payload
    // rather than behind a request because the trip view has to be able to name its stops with no
    // network at all, and because whether a stop is tappable is a build-time fact that must not
    // arrive late and change under someone's thumb.
    routes: routeData, departures, tripSchedules, stops: stopsDirectory
  };
}
