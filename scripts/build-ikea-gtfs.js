// Regenerates gtfs/ikea/ from NY Waterway's published IKEA Brooklyn weekend timetable.
//
// NY Waterway runs this service but does not include it in the GTFS it publishes through Trillium:
// gtfs/waterway/ has no IKEA route, no Red Hook stop, and no weekend service on any Pier 11 route.
// The only place the operator publishes it is SOURCE_URL, and there only as a JPEG of a table —
// there is no machine-readable source anywhere, so the timetable below is transcribed by hand.
//
// Run with: node scripts/build-ikea-gtfs.js
//
// !! This is a TRANSCRIPTION of an image, not a download. Nothing can diff it against the operator
// !! for you. Re-read SOURCE_URL when SOURCE_CHECKED_ON gets old — NY Waterway reissues that image
// !! under a new filename every month or two (the one transcribed here was read on 2026-11-12 from
// !! a screenshot of the page, headed "2026 Weekend Schedule ... Now Running", since the site refuses
// !! automated requests)
// !! and pauses the service over the winter. SEASON_DAYS deliberately bounds the generated calendar
// !! so the feed expires loudly (build-data.js warns on a lapsed partner feed, and the IKEA rows
// !! simply stop appearing) rather than advertising winter sailings that do not run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { gtfsDate, toCsv, writeGtfsFiles } from "./gtfs-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "gtfs/ikea");

export const SOURCE_URL = "https://www.nywaterway.com/ikea.aspx";
export const SOURCE_CHECKED_ON = "2026-11-12";
// Short on purpose. The service is seasonal and the operator gives no end date on the page, so the
// feed is written to lapse well before the winter pause and force a re-read rather than guessing at
// a season end that is not published.
const SEASON_DAYS = 90;

const AGENCY_ID = "815";
const AGENCY_NAME = "NY Waterway";
const ROUTE_ID = "IKEA";
const SERVICE_ID = "ikea-weekend";

// Ids are local to this feed — build-data.js namespaces every one of them with the "ike:" prefix,
// so they cannot collide with the NY Waterway feed's own numeric ids for the same two piers.
// Pier 11 and Midtown carry NY Waterway's published coordinates unchanged. The IKEA dock is the
// Erie Basin pier behind the store at 1 Beard Street; its position is approximate, and nothing on
// the board reads it — partner stop coordinates are not used for display.
const STOPS = [
  { stop_id: "midtown", stop_name: "Midtown / W 39th Street", stop_lat: "40.76062395229", stop_lon: "-74.003851516287" },
  { stop_id: "pier11", stop_name: "Pier 11 / Wall Street", stop_lat: "40.702800820044", stop_lon: "-74.005721223577" },
  { stop_id: "ikea", stop_name: "IKEA Brooklyn", stop_lat: "40.6734", stop_lon: "-74.0156" }
];

// Every "Depart" cell of the published table, transcribed. Southbound rows list Midtown then
// Pier 11; the last sailing of the day is printed with the Pier 11 cell blacked out, so it runs
// non-stop and is modelled with no Pier 11 stop at all.
//
// The northbound rows are the operator's three columns as published. Until the November 2026
// reissue the "Arrive Midtown" column was unusable (it printed five minutes after Pier 11, once
// before it) and was derived instead; the current table prints plausible arrivals, 20 to 25
// minutes after Pier 11, so they are transcribed like every other cell. It is a terminal arrival,
// so it never reaches the board: a trip's final stop is never shown as a departure.
const SOUTHBOUND = [
  { midtown: "10:30", pier11: "11:00", ikea: "11:10" },
  { midtown: "12:00", pier11: "12:30", ikea: "12:40" },
  { midtown: "13:30", pier11: "14:00", ikea: "14:10" },
  { midtown: "15:00", pier11: "15:30", ikea: "15:40" },
  { midtown: "16:30", pier11: "17:00", ikea: "17:10" },
  { midtown: "17:55", pier11: null, ikea: "18:15" }
];
const NORTHBOUND = [
  { ikea: "11:20", pier11: "11:30", midtown: "11:55" },
  { ikea: "12:50", pier11: "13:00", midtown: "13:25" },
  { ikea: "14:20", pier11: "14:30", midtown: "14:55" },
  { ikea: "15:50", pier11: "16:00", midtown: "16:25" },
  { ikea: "17:20", pier11: "17:30", midtown: "17:50" },
  { ikea: "18:25", pier11: "18:35", midtown: "18:55" }
];

function hhmmss(value) {
  return `${value}:00`;
}

export function buildTimetable() {
  const tripRows = [], stopTimeRows = [];
  const push = (tripId, headsign, directionId, stops) => {
    tripRows.push({ route_id: ROUTE_ID, service_id: SERVICE_ID, trip_id: tripId, trip_headsign: headsign, direction_id: directionId });
    stops.forEach(([stopId, time], index) => {
      stopTimeRows.push({ trip_id: tripId, arrival_time: hhmmss(time), departure_time: hhmmss(time), stop_id: stopId, stop_sequence: String(index + 1) });
    });
  };

  SOUTHBOUND.forEach((row, index) => {
    const stops = [["midtown", row.midtown]];
    if (row.pier11) stops.push(["pier11", row.pier11]);
    stops.push(["ikea", row.ikea]);
    push(`ikea-to-${String(index + 1).padStart(2, "0")}`, "IKEA Brooklyn", "0", stops);
  });
  NORTHBOUND.forEach((row, index) => {
    push(`ikea-from-${String(index + 1).padStart(2, "0")}`, "Midtown / W 39th Street", "1", [
      ["ikea", row.ikea], ["pier11", row.pier11], ["midtown", row.midtown]
    ]);
  });

  const today = new Date();
  const startDate = gtfsDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const endDate = gtfsDate(new Date(today.getTime() + SEASON_DAYS * 86400000));
  return { tripRows, stopTimeRows, startDate, endDate };
}

async function main() {
  const { tripRows, stopTimeRows, startDate, endDate } = buildTimetable();
  const files = {
    "agency.txt": toCsv(["agency_id", "agency_name", "agency_url", "agency_lang", "agency_timezone"],
      [{ agency_id: AGENCY_ID, agency_name: AGENCY_NAME, agency_url: SOURCE_URL, agency_lang: "en", agency_timezone: "America/New_York" }]),
    // IKEA blue on IKEA yellow: the badge reads "IKEA", which tells a rider more than the operator
    // mark would here — NY Waterway's other routes are all commuter runs across the Hudson.
    "routes.txt": toCsv(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
      [{ route_id: ROUTE_ID, agency_id: AGENCY_ID, route_short_name: "IKEA", route_long_name: "IKEA Brooklyn Ferry", route_type: "4", route_color: "0058A3", route_text_color: "FFDB00" }]),
    "stops.txt": toCsv(["stop_id", "stop_name", "stop_lat", "stop_lon"], STOPS),
    // Saturdays and Sundays only, for as long as SEASON_DAYS allows.
    "calendar.txt": toCsv(["service_id", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "start_date", "end_date"],
      [{ service_id: SERVICE_ID, sunday: "1", monday: "0", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "1", start_date: startDate, end_date: endDate }]),
    // The operator publishes no holiday exceptions for this service, so none are invented here.
    "calendar_dates.txt": toCsv(["service_id", "date", "exception_type"], []),
    "trips.txt": toCsv(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"], tripRows),
    "stop_times.txt": toCsv(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], stopTimeRows),
    "feed_info.txt": toCsv(["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
      [{ feed_publisher_name: AGENCY_NAME, feed_publisher_url: SOURCE_URL, feed_lang: "en", feed_start_date: startDate, feed_end_date: endDate, feed_version: `transcribed-${SOURCE_CHECKED_ON}` }])
  };

  await writeGtfsFiles(OUTPUT_DIR, files);
  console.log(`Wrote gtfs/ikea/ from ${SOURCE_URL} as checked on ${SOURCE_CHECKED_ON}.`);
  console.log(`  trips: ${tripRows.length} per weekend day  valid ${startDate}-${endDate}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
