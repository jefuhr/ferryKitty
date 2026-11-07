// Everything NYC Ferry that this repository knows and no published feed told it.
//
// The board is built from GTFS, but a lot of what makes it useful is in no GTFS at all: which boat
// works which trip, when a crew changes over and where, where the boats sleep overnight, and the
// thresholds used to infer a boat going out of service. That knowledge is spread across config/,
// content/ and a few module constants — the right place for it to live, and a poor place to read
// it from if you are not this program.
//
// This gathers it into one JSON file with its provenance attached, so it can be handed to someone,
// diffed across a schedule change, or checked against the operator without anyone reading
// JavaScript. It is a snapshot for export, never an input: nothing in the build reads it back, and
// editing it changes nothing. Edit the sources named in each section's `source` field.
//
// NYC Ferry only. The partner operators that share these docks — NY Waterway, Seastreak, NYU
// Langone, Liberty Landing, the IKEA boat, the Trust's Governors Island boats, the Staten Island
// Ferry and the Statue of Liberty boats — each have their own feed, corrections and transcribed timetables in this
// repository, and none of it is here. Their stop ids and their on/off switches are stripped out
// of the two config files that carry them, so what remains is NYC Ferry's own.
//
// Regenerate with:  node scripts/export-hardcoded-data.js

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Imported only to learn which keys belong to a partner, so that adding one cannot quietly leave
// its data in an export that promises not to carry any.
import { PARTNER_FEEDS } from "../lib/schedule-builder.js";
import {
  CREW_ROUTE, CREW_ROUTE_ID, CREW_WEEKDAY_SERVICE, CREW_WEEKEND_SERVICE, HOME_PORT_STOP_ID,
  SHUTTLE_READY_BEFORE, SWAP_WINDOW_AFTER, SWAP_WINDOW_BEFORE
} from "../lib/out-of-service.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "export/nyc-ferry-hardcoded-data.json");

export const PARTNER_STOP_KEYS = Object.values(PARTNER_FEEDS).map((feed) => feed.stopIdsKey);
export const PARTNER_ENABLED_KEYS = Object.values(PARTNER_FEEDS).map((feed) => feed.enabledKey);

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

function without(source, drop) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !drop.includes(key)));
}

// Reads back as a value plus its unit, so nobody has to guess whether 3600 is seconds, minutes or
// a clock time.
function duration(seconds) {
  return { seconds, minutes: seconds / 60 };
}

export async function buildExport({ generatedAt = new Date().toISOString() } = {}) {
  const [landings, display, crew, boatAssignments, boatShifts, fleet] = await Promise.all([
    readJson("config/landings.json"),
    readJson("config/display.json"),
    readJson("config/crew-shuttles.json"),
    readJson("content/boat-assignments.json"),
    readJson("content/boat-shifts.json"),
    readJson("content/vessels.json")
  ]);

  const shifts = boatShifts.shifts || {};
  const shiftCount = Object.values(shifts).reduce(
    (total, byBoat) => total + Object.values(byBoat).reduce((sum, list) => sum + list.length, 0), 0
  );
  // Four landings are docks NYC Ferry does not call at — Whitehall, Soissons Landing, Liberty
  // Island and Ellis Island, all served entirely by partner operators — so once the partner keys
  // are stripped their stopIds are empty. An empty array would read as data that went missing on the way out, which is exactly
  // what this export's own tests watch for, so the absence is stated instead of implied.
  const ferryLandings = Object.fromEntries(
    Object.entries(landings).map(([number, landing]) => {
      const stripped = without(landing, PARTNER_STOP_KEYS);
      if (stripped.stopIds?.length) return [number, stripped];
      return [number, { ...without(stripped, ["stopIds"]), nycFerryCalls: false }];
    })
  );

  return {
    meta: {
      title: "NYC Ferry departure board — hardcoded NYC Ferry data",
      generatedAt,
      generator: "scripts/export-hardcoded-data.js",
      description:
        "Every piece of NYC Ferry data this repository carries that did not come from a published " +
        "GTFS feed. Each section names the file it was read from; edit that file, not this one.",
      scope:
        "NYC Ferry only. The partner operators sharing these docks have their own hand-maintained " +
        "data in this repository — NY Waterway route corrections, transcribed timetables for the " +
        "Governors Island, IKEA and Liberty Landing boats, and downloads for the Staten Island Ferry " +
        "and the Statue of Liberty boats — " +
        "and none of it is included here. Partner stop ids and partner on/off switches are stripped " +
        "from the config below.",
      readOnly:
        "A snapshot for export. Nothing in the build reads this file back, so editing it changes nothing.",
      sources: [
        "config/landings.json", "config/display.json", "config/crew-shuttles.json",
        "content/boat-assignments.json", "content/boat-shifts.json", "content/vessels.json",
        "scripts/out-of-service.js", "schedules/fall-2026-weekday-crew.json", "schedules/fall-2026-weekend-crew.json", "schedules/november-2026-crew.json", "schedules/winter-2026-weekend-crew.json"
      ]
    },

    winterWeekendCrew: {
      source: "schedules/winter-2026-weekend-crew.json",
      description: "Reviewed winter weekend Board; cruise service requires explicit dates and operator coverage. ER3 is disabled until separately reviewed.",
      data: await readJson("schedules/winter-2026-weekend-crew.json")
    },
    novemberWeekdayCrew: {
      source: "schedules/november-2026-crew.json",
      description: "User-selected Board notes matched to November weekday GTFS. Six boundaries remain unresolved; user-confirmed crew-shuttle times are preserved as listed without endpoint claims. Weekends are not inferred.",
      data: await readJson("schedules/november-2026-crew.json")
    },
    fallWeekdayCrew: {
      source: "schedules/fall-2026-weekday-crew.json",
      description: "Verified ordinary fall weekday crew operations; overrides historical crew data below. Sukkot remains unconfirmed.",
      data: await readJson("schedules/fall-2026-weekday-crew.json")
    },
    fallWeekendCrew: {
      source: "schedules/fall-2026-weekend-crew.json",
      description: "Fall weekend crew boundaries and five crew shuttles; Red Hook cruise working restricted to its ten published dates.",
      data: await readJson("schedules/fall-2026-weekend-crew.json")
    },
    landings: {
      source: "config/landings.json",
      description:
        "Every landing the board can show, keyed by the landing number an agent dials. stopIds are " +
        "NYC Ferry GTFS stops. Landing 27 (Pier C) is virtual — no feed contains the home port — so " +
        "it carries its own coordinates and a stop id that exists only in this repository. A landing " +
        "marked nycFerryCalls: false is a real dock that NYC Ferry does not serve: its departures all " +
        "belong to partner operators, so it has no NYC Ferry stop id and carries its own coordinates.",
      partnerStopIdsRemoved: PARTNER_STOP_KEYS,
      count: Object.values(ferryLandings).filter((item) => !item.unused).length,
      landings: ferryLandings
    },

    display: {
      source: "config/display.json",
      description:
        "Which landing a kiosk shows and how much of it. A deployed staff or mobile server answers " +
        "for every landing and uses landingNumber only as its default. busesEnabled keeps or drops " +
        "connecting shuttle-bus routes, which for NYC Ferry means the Rockaway shuttles at landing 18.",
      partnerSwitchesRemoved: PARTNER_ENABLED_KEYS,
      settings: without(display, PARTNER_ENABLED_KEYS)
    },

    crewShuttles: {
      source: "config/crew-shuttles.json",
      description:
        "Crew shuttles, the home port, the holiday list and the thresholds used to spot a boat going " +
        "out of service. None of this is published anywhere: the GTFS feed and the schedule workbook " +
        "are both silent about moves made with no passengers aboard, so this file is maintained by " +
        "hand and must be revisited whenever the schedule changes.",
      // Only the arrays: the shuttles object also carries an explanatory `note` string, and counting
      // its characters as shuttles is exactly the kind of thing a summary line is for.
      shuttleCount: Object.values(crew.shuttles || {}).filter(Array.isArray).reduce((total, list) => total + list.length, 0),
      holidayCount: crew.holidays?.dates?.length || 0,
      config: crew
    },

    crewModelConstants: {
      source: "scripts/out-of-service.js",
      description:
        "The constants the out-of-service model runs on. These are inference parameters, not published " +
        "facts, and each was chosen against the shape of the bundled schedule — re-check them when the " +
        "schedule changes.",
      homePortStopId: {
        value: HOME_PORT_STOP_ID,
        note: "Pier C is in no feed, so the virtual landing's one stop id exists only in this repository."
      },
      crewServiceIds: {
        weekday: CREW_WEEKDAY_SERVICE,
        weekend: CREW_WEEKEND_SERVICE,
        note:
          "Synthetic calendars. The feed's own weekday service cannot be reused, because on a holiday " +
          "the feed still runs weekdays while the crews change on the weekend pattern."
      },
      crewRoute: {
        id: CREW_ROUTE_ID,
        route: CREW_ROUTE,
        note: "A crew shuttle belongs to no passenger route; borrowing one's colour would imply the boat is running that service."
      },
      crewSwapWindowBefore: {
        ...duration(SWAP_WINDOW_BEFORE),
        note: "How long before a boat's run ends a listed shuttle may be and still be read as the cause of the gap."
      },
      crewSwapWindowAfter: {
        ...duration(SWAP_WINDOW_AFTER),
        note: "And how long after. A crew rides the shuttle shortly after stepping off, not six hours into a gap."
      },
      shuttleReadyBefore: {
        ...duration(SHUTTLE_READY_BEFORE),
        note:
          "A shuttle is listed at the minute it is ready and then waits for the boat to sail, so it can " +
          "appear well before the crew it collects has finished. Bounded empirically: the widest real " +
          "case in the bundled config is 31 minutes."
      }
    },

    boatAssignments: {
      source: "content/boat-assignments.json",
      description:
        "GTFS trip_short_name to the numbered boat that works it, imported from the seasonal workbook " +
        "by scripts/import-boat-assignments.py. This is what lets the board label a sailing 'ER5', " +
        "infer where a boat stops working, and predict the vessel on a sailing the feed has not reached.",
      workbook: boatAssignments.source,
      count: Object.keys(boatAssignments.assignments || {}).length,
      assignments: boatAssignments.assignments || {}
    },

    boatShifts: {
      source: "content/boat-shifts.json",
      description:
        "Published crew shift boundaries, imported from the workbook's cell notes by " +
        "scripts/import-boat-shifts.py and verified against the bundled GTFS at import time — anything " +
        "the feed disagreed with was dropped rather than guessed at.",
      workbook: boatShifts.source,
      count: shiftCount,
      shifts
    },

    fleet: {
      source: "content/vessels.json",
      description:
        "The vessel roster. Used to turn a realtime vehicle label into a name a person recognises; each " +
        "record carries only the id, name and hull number the match runs on.",
      count: (fleet.vessels || []).length,
      vessels: fleet.vessels || []
    }
  };
}

export async function writeExport(options) {
  const data = await buildExport(options);
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { data, output: OUTPUT };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { data, output } = await writeExport();
  console.log(`Wrote ${path.relative(ROOT, output)} — NYC Ferry only, no partner operators.`);
  console.log(`  landings            ${data.landings.count}`);
  console.log(`  crew shuttles       ${data.crewShuttles.shuttleCount} (plus ${data.crewShuttles.holidayCount} holidays)`);
  console.log(`  boat assignments    ${data.boatAssignments.count} trips`);
  console.log(`  crew shifts         ${data.boatShifts.count}`);
  console.log(`  vessels             ${data.fleet.count}`);
  console.log(`  stripped            ${PARTNER_STOP_KEYS.length} partner stop-id keys, ${PARTNER_ENABLED_KEYS.length} partner switches`);
}
