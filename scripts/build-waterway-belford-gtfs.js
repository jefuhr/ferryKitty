// November 2 advisory adds separately dated weekday trips below; September tables remain historical.
// Builds gtfs/waterway-belford/ from NY Waterway's printed Belford timetable: the weekday sheet
// effective 8 September 2026 and the weekend sheet effective 12 September 2026.
//
// Why this is not in gtfs/waterway/:
//
//   gtfs/waterway/ is a Trillium download and the board's contract for it is "drop in a fresh copy
//   when NY Waterway publishes one". The copy bundled today has no Belford stop, no Belford route
//   and a calendar that lapses 20261001, so a new download is due within weeks — and it would
//   silently erase anything hand-written into those files. A transcription that can be quietly
//   deleted by a routine feed refresh is worse than no transcription, so this route gets its own
//   directory and its own PARTNER_FEEDS entry, the way gtfs/ikea/ does for the other NY Waterway
//   boat the operator leaves out of its GTFS.
//
//   When NY Waterway does publish Belford in the download, this whole feed should be deleted and
//   its landings.json keys with it. The stop ids below are deliberately the operator's own real
//   ids so that day is a deletion and not a migration.
//
// Run with: node scripts/build-waterway-belford-gtfs.js
//
// !! This is a TRANSCRIPTION, not a download. Nothing can diff it against the operator for you.
// !! When NY Waterway publishes a new sheet, re-read it and update the tables below and the dates.
//
// Reading the source:
//
//   The weekday sheet prints a MORNING PEAK PERIOD table headed "Depart Belford" with the four
//   Manhattan/Jersey City columns headed "Arrive", and an EVENING PEAK PERIOD table headed the
//   other way. That is taken literally, as it is for Seastreak in scripts/build-seastreak-gtfs.js:
//   an "Arrive" call is drop-off only and never advertises a boarding. The evening table heads its
//   last column "Depart Belford", but Belford is the end of the run there, so it is an arrival like
//   the rest — a boarding on a trip's final call would be a boat you could get on and never off.
//
//   THE "PIER 79 VIA TRANSFER AT PIER 11" ROWS. Four rows carry that note, and on them the Pier 79
//   end of the journey is a different vessel. The morning gives it away by the clock: the 05:45
//   from Belford is printed as Pier 11 06:25, Brookfield 06:40, Paulus Hook 06:50 and Midtown
//   06:50, and no boat is at Paulus Hook and Midtown in the same minute. Pier 11 06:25 to Midtown
//   06:50 is twenty-five minutes, which is the existing Pier 11 - Midtown/W 39th run in the
//   downloaded feed. So the note qualifies the column it names and only that column: on those rows
//   the Pier 79 call is dropped here, because it is a connection the rider makes at Pier 11 on a
//   boat gtfs/waterway/ already carries. Transcribing it would advertise one sailing twice.
//
//   The intermediate calls on those rows are NOT dropped. The note names Pier 79, the clock places
//   every other call on the through boat, and dropping Brookfield would take real boardings off a
//   pier this board watches.
//
//   THE ROWS THAT DO NOT RUN ALL WEEK. Two rows carry a day note in the Service Notes column and
//   are transcribed exactly as printed: the 05:15 from Belford is "Tuesday - Thursday" and the
//   18:15 from Pier 79 is "Tuesday - Friday". Neither runs on a Monday. That is easy to miss on the
//   sheet — the notes column sits well right of the times it qualifies — and easy to talk yourself
//   out of, because NY Waterway's own GTFS carries a "(MTuWTh)" service on other routes and these
//   look like they should match it. They do not. The paper is the source; read the notes column.
//
//   THE WEEKEND SHEET is a different route rather than the weekday one thinned out: Belford, Pier
//   11, Brookfield and Midtown only, with no Paulus Hook call and no transfer rows. It prints
//   Brookfield as "WFC" on the evening table and "Brookfield" on the daytime one; both are the same
//   pier, landing 25. It starts on the Saturday after the weekday sheet, which is the date printed
//   on it.
//
// !! Seastreak ran Belford until 4 September 2026 and its transcription still carries those
// !! sailings under a service that ends on that date. See scripts/build-seastreak-gtfs.js.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "gtfs/waterway-belford");

export const SOURCE_URL = "https://www.nywaterway.com/BelfordRoute.aspx";
export const SOURCE_CHECKED_ON = "2026-11-02";
export const NOVEMBER_SOURCE_URL = "https://www.nywaterway.com/UserFiles/Images/2026/Belford/BelfordSch_261102a.jpg";

// Both dates are printed on the sheets themselves. The weekday one starts on a Tuesday because the
// Monday is Labor Day.
const SERVICE_START = "20260908";
const WEEKEND_SERVICE_START = "20260912";
// NY Waterway publishes no end date. Finite on purpose, so a transcription cannot quietly outlive
// the timetable it came from, and long enough that it will not lapse before somebody re-reads it.
const SERVICE_END = "20271231";

// NY Waterway's own agency id, from gtfs/waterway/agency.txt.
const AGENCY_ID = "815";
const AGENCY_NAME = "NY Waterway";
const ROUTE_ID = "belford";

const SERVICE_WEEKDAY = "wbf-weekday";
// The 05:15 from Belford, printed "Tuesday - Thursday".
const SERVICE_TUE_THU = "wbf-tue-thu";
// The 18:15 from Pier 79, printed "Tuesday - Friday".
const SERVICE_TUE_FRI = "wbf-tue-fri";
const SERVICE_WEEKEND = "wbf-weekend";

// Stop ids are NY Waterway's own, taken from gtfs/waterway/stops.txt, so that the day the operator
// puts Belford in its download this feed can simply be deleted. Belford is the one stop with no
// published id yet; the position is the Belford Ferry Terminal at 10 Harbor Way, which is the pier
// Seastreak used and which NY Waterway takes over.
const STOPS = {
  belford:    { id: "belford", name: "Belford, NJ",                        desc: "10 Harbor Way, Belford", lat: 40.433209, lon: -74.078817, side: "nj" },
  pier11:     { id: "2439146", name: "Pier 11 / Wall Street",              desc: "", lat: 40.702800820044, lon: -74.005721223577, side: "ny" },
  brookfield: { id: "2729332", name: "Brookfield Place/Battery Park City", desc: "", lat: 40.714932739104626, lon: -74.0173750458923, side: "ny" },
  // Jersey City, but the sheet groups it with the New York calls and it is an "Arrive" on the
  // morning table like the rest of them, so it is on the New York side of the boarding rule.
  paulus:     { id: "2439141", name: "Paulus Hook",                        desc: "", lat: 40.713718479988, lon: -74.032029165667, side: "ny" },
  midtown:    { id: "2439145", name: "Midtown / W 39th Street",            desc: "", lat: 40.76062395229,  lon: -74.003851516287, side: "ny" }
};

// MORNING PEAK PERIOD — Belford boards, everything else is an arrival.
const MORNING = [
  // "Tuesday - Thursday". No Midtown call on this one.
  { service: SERVICE_TUE_THU, calls: [["belford", "05:15"], ["pier11", "05:55"], ["brookfield", "06:10"], ["paulus", "06:20"]] },
  // Midtown 06:50 dropped: Pier 79 via transfer at Pier 11.
  { service: SERVICE_WEEKDAY, calls: [["belford", "05:45"], ["pier11", "06:25"], ["brookfield", "06:40"], ["paulus", "06:50"]] },
  // Midtown 07:35 dropped: Pier 79 via transfer at Pier 11.
  { service: SERVICE_WEEKDAY, calls: [["belford", "06:30"], ["pier11", "07:10"], ["brookfield", "07:25"], ["paulus", "07:35"]] },
  { service: SERVICE_WEEKDAY, calls: [["belford", "07:30"], ["pier11", "08:10"], ["brookfield", "08:25"], ["paulus", "08:35"], ["midtown", "08:45"]] },
  { service: SERVICE_WEEKDAY, calls: [["belford", "08:00"], ["pier11", "08:40"], ["brookfield", "08:55"], ["paulus", "09:05"], ["midtown", "09:15"]] },
  { service: SERVICE_WEEKDAY, calls: [["belford", "09:30"], ["pier11", "10:10"], ["brookfield", "10:25"], ["paulus", "10:35"], ["midtown", "10:45"]] }
];

// EVENING PEAK PERIOD — the New York side boards, Belford is the arrival.
const EVENING = [
  { service: SERVICE_WEEKDAY, calls: [["midtown", "15:15"], ["paulus", "15:25"], ["brookfield", "15:35"], ["pier11", "15:45"], ["belford", "16:30"]] },
  { service: SERVICE_WEEKDAY, calls: [["midtown", "15:55"], ["paulus", "16:05"], ["brookfield", "16:15"], ["pier11", "16:30"], ["belford", "17:15"]] },
  // Midtown 16:50 dropped: Pier 79 via transfer at Pier 11.
  { service: SERVICE_WEEKDAY, calls: [["paulus", "17:05"], ["brookfield", "17:15"], ["pier11", "17:30"], ["belford", "18:15"]] },
  // Midtown 17:30 dropped: Pier 79 via transfer at Pier 11.
  { service: SERVICE_WEEKDAY, calls: [["paulus", "17:45"], ["brookfield", "18:00"], ["pier11", "18:15"], ["belford", "19:00"]] },
  // "Tuesday - Friday".
  { service: SERVICE_TUE_FRI, calls: [["midtown", "18:15"], ["paulus", "18:30"], ["brookfield", "18:45"], ["pier11", "19:00"], ["belford", "19:45"]] }
];

// WEEKENDS DAYTIME — Belford boards. No Paulus Hook call at the weekend.
const WEEKEND_MORNING = [
  { service: SERVICE_WEEKEND, calls: [["belford", "09:00"], ["pier11", "09:45"], ["brookfield", "10:00"], ["midtown", "10:15"]] },
  { service: SERVICE_WEEKEND, calls: [["belford", "11:30"], ["pier11", "12:15"], ["brookfield", "12:30"], ["midtown", "12:45"]] },
  { service: SERVICE_WEEKEND, calls: [["belford", "14:00"], ["pier11", "14:45"], ["brookfield", "15:00"], ["midtown", "15:15"]] }
];

// WEEKENDS EVENING — the New York side boards. "WFC" on this table is Brookfield Place.
const WEEKEND_EVENING = [
  { service: SERVICE_WEEKEND, calls: [["midtown", "16:45"], ["brookfield", "17:00"], ["pier11", "17:15"], ["belford", "18:00"]] },
  { service: SERVICE_WEEKEND, calls: [["midtown", "19:15"], ["brookfield", "19:30"], ["pier11", "19:45"], ["belford", "20:30"]] }
];

function toCsv(headers, rows) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n") + "\n";
}

// One printed row is one trip. The boarding side is whichever side the table is headed "Depart";
// the other side's calls are arrivals, so they are drop-off only and never advertise a departure.
function tripRows(table, { boardingSide, directionId, idPrefix }) {
  const trips = [], stopTimes = [];
  table.forEach((row, index) => {
    const tripId = `${idPrefix}-${String(index + 1).padStart(2, "0")}`;
    const calls = row.calls.map(([key, time]) => ({ stop: STOPS[key], time: `${time}:00` }));
    trips.push({
      route_id: ROUTE_ID,
      service_id: row.service,
      trip_id: tripId,
      trip_headsign: calls.at(-1).stop.name,
      direction_id: directionId
    });
    calls.forEach((call, sequence) => {
      const boarding = call.stop.side === boardingSide;
      stopTimes.push({
        trip_id: tripId,
        arrival_time: call.time,
        departure_time: call.time,
        stop_id: call.stop.id,
        stop_sequence: sequence + 1,
        // A boarding call on the last row of a trip would be a boat you could get on and never off.
        pickup_type: boarding && sequence < calls.length - 1 ? 0 : 1,
        drop_off_type: boarding ? 1 : 0
      });
    });
  });
  return { trips, stopTimes };
}

// What the shape of this feed is actually asserted on. Times must run forwards inside a trip — the
// tables are read column-by-column off a photographed sheet, and a stop out of order means a
// misread column, which is exactly how the "via transfer at Pier 11" rows announce themselves — and
// no two trips may offer a boarding at the same pier at the same minute on the same days.
function assertFeedIsSane(trips, stopTimes) {
  const byTrip = new Map();
  for (const row of stopTimes) {
    if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
    byTrip.get(row.trip_id).push(row);
  }
  const service = new Map(trips.map((trip) => [trip.trip_id, trip.service_id]));
  const problems = [];
  const boardings = new Map();
  for (const [tripId, calls] of byTrip) {
    if (calls.length < 2) problems.push(`${tripId} has fewer than two calls`);
    for (let index = 1; index < calls.length; index += 1) {
      if (calls[index].departure_time <= calls[index - 1].departure_time) {
        problems.push(`${tripId} does not run forwards at ${calls[index].departure_time}`);
      }
    }
    for (const call of calls) {
      if (call.pickup_type !== 0) continue;
      const key = `${call.stop_id}@${call.departure_time}/${service.get(tripId)}`;
      if (boardings.has(key)) problems.push(`${key} is a boarding on both ${boardings.get(key)} and ${tripId}`);
      boardings.set(key, tripId);
    }
  }
  if (problems.length) throw new Error(`Belford feed is not sane:\n  ${problems.join("\n  ")}`);
}

async function main() {
  const morning = tripRows(MORNING, { boardingSide: "nj", directionId: 0, idPrefix: "wbf-am" });
  const evening = tripRows(EVENING, { boardingSide: "ny", directionId: 1, idPrefix: "wbf-pm" });
  const weekendMorning = tripRows(WEEKEND_MORNING, { boardingSide: "nj", directionId: 0, idPrefix: "wbf-we-am" });
  const weekendEvening = tripRows(WEEKEND_EVENING, { boardingSide: "ny", directionId: 1, idPrefix: "wbf-we-pm" });
  const trips = [...morning.trips, ...evening.trips, ...weekendMorning.trips, ...weekendEvening.trips];
  const stopTimes = [...morning.stopTimes, ...evening.stopTimes, ...weekendMorning.stopTimes, ...weekendEvening.stopTimes];
  // November 2 advisory: retain September/October history and add separately scoped weekdays.
  const novemberMorning = MORNING.map(row => ({ ...row, service: row.service === SERVICE_TUE_THU ? "wbf-nov-mon-thu" : "wbf-nov-weekday",
    calls: row.calls[0][1] === "06:30" ? [["belford", "06:20"], ["pier11", "07:00"], ["brookfield", "07:10"], ["paulus", "07:15"]] : row.calls }));
  const novemberEvening = EVENING.map(row => ({ ...row, service: "wbf-nov-weekday" }));
  for (const [table, options] of [[novemberMorning, { boardingSide: "nj", directionId: 0, idPrefix: "wbf-nov-am" }],
    [novemberEvening, { boardingSide: "ny", directionId: 1, idPrefix: "wbf-nov-pm" }]]) {
    const added = tripRows(table, options);
    trips.push(...added.trips); stopTimes.push(...added.stopTimes);
  }
  assertFeedIsSane(trips, stopTimes);

  const files = {
    "agency.txt": toCsv(["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone"],
      [{ agency_id: AGENCY_ID, agency_name: AGENCY_NAME, agency_url: "https://www.nywaterway.com",
         agency_timezone: "America/New_York", agency_lang: "en", agency_phone: "1-800-533-3779" }]),
    "routes.txt": toCsv(["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color"],
      [{ route_id: ROUTE_ID, agency_id: AGENCY_ID, route_short_name: "",
         route_long_name: "Belford - Pier 11 / Wall St", route_desc: "Between Belford, NJ and New York City",
         route_type: 4, route_url: SOURCE_URL, route_color: "00558C", route_text_color: "FFFFFF" }]),
    "stops.txt": toCsv(["stop_id", "stop_name", "stop_desc", "stop_lat", "stop_lon", "location_type", "wheelchair_boarding"],
      Object.values(STOPS).map((stop) => ({
        stop_id: stop.id, stop_name: stop.name, stop_desc: stop.desc,
        stop_lat: stop.lat, stop_lon: stop.lon, location_type: 0, wheelchair_boarding: 1
      }))),
    "calendar.txt": toCsv(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
      [{ service_id: SERVICE_WEEKDAY, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: SERVICE_START, end_date: "20261101" },
       { service_id: SERVICE_TUE_THU, monday: 0, tuesday: 1, wednesday: 1, thursday: 1, friday: 0, saturday: 0, sunday: 0, start_date: SERVICE_START, end_date: "20261101" },
       { service_id: SERVICE_TUE_FRI, monday: 0, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: SERVICE_START, end_date: "20261101" },
       { service_id: "wbf-nov-weekday", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: SERVICE_END },
       { service_id: "wbf-nov-mon-thu", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 0, saturday: 0, sunday: 0, start_date: "20261102", end_date: SERVICE_END },
       // The weekend sheet carries its own effective date, the Saturday after the weekday one.
       { service_id: SERVICE_WEEKEND, monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1, start_date: WEEKEND_SERVICE_START, end_date: SERVICE_END }]),
    // No exception dates: the sheets print no holiday variations. The file is still written because
    // the build expects every feed to have one, and an absent file reads as a feed that was
    // assembled wrong rather than one with nothing to say.
    "calendar_dates.txt": toCsv(["service_id", "date", "exception_type"], []),
    "trips.txt": toCsv(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"], trips),
    "stop_times.txt": toCsv(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type"], stopTimes),
    "feed_info.txt": toCsv(["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
      [{ feed_publisher_name: AGENCY_NAME, feed_publisher_url: "https://www.nywaterway.com", feed_lang: "en",
         feed_start_date: SERVICE_START, feed_end_date: SERVICE_END, feed_version: `transcribed-${SOURCE_CHECKED_ON}` }])
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(OUTPUT_DIR, name), contents, "utf8");
  // The build owns the whole directory: a file left behind from an earlier shape of this feed is
  // not merely dead weight, it is a file a reader would have to work out the currency of.
  for (const stale of await readdir(OUTPUT_DIR)) {
    if (!Object.hasOwn(files, stale)) await rm(path.join(OUTPUT_DIR, stale), { force: true });
  }

  const weekend = trips.filter((trip) => trip.service_id === SERVICE_WEEKEND).length;
  console.log(`Wrote gtfs/waterway-belford/ from ${SOURCE_URL} as checked on ${SOURCE_CHECKED_ON}.`);
  console.log(`  weekday: ${MORNING.length} morning, ${EVENING.length} evening`);
  console.log(`  weekend: ${WEEKEND_MORNING.length} daytime, ${WEEKEND_EVENING.length} evening`);
  console.log(`  ${trips.length} trips, ${stopTimes.length} calls, ${weekend} of the trips Saturday/Sunday`);
  console.log(`  weekdays from ${SERVICE_START}, weekends from ${WEEKEND_SERVICE_START}, both to ${SERVICE_END}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
