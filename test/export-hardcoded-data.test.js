import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PARTNER_ENABLED_KEYS, PARTNER_STOP_KEYS, buildExport } from "../scripts/export-hardcoded-data.js";
import { PARTNER_FEEDS } from "../scripts/build-data.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_PATH = path.join(ROOT, "export/nyc-ferry-hardcoded-data.json");

const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
const committed = async () => readJson("export/nyc-ferry-hardcoded-data.json");

// The whole point of the file is to be a faithful snapshot. If a source changes and nobody
// regenerates, the export becomes a confident lie about data someone is about to act on — so the
// drift is a test failure rather than something to notice later.
test("the committed export matches a fresh build of it", async () => {
  const [saved, fresh] = await Promise.all([committed(), buildExport()]);
  // Only the timestamp may differ; everything else must be reproducible.
  assert.deepEqual(
    { ...saved, meta: { ...saved.meta, generatedAt: null } },
    { ...fresh, meta: { ...fresh.meta, generatedAt: null } },
    "export/nyc-ferry-hardcoded-data.json is stale — run: node scripts/export-hardcoded-data.js"
  );
});

test("every file the export claims to draw from exists", async () => {
  const { meta } = await committed();
  assert.ok(meta.sources.length > 0);
  for (const source of meta.sources) {
    await readFile(path.join(ROOT, source), "utf8");
  }
});

// The export is NYC Ferry's data. Partner operators keep their own corrections and transcribed
// timetables in this repository and none of it belongs here — including the partner stop ids and
// switches threaded through the two config files this does read.
test("no partner operator data reaches the export", async () => {
  const data = await committed();

  for (const landing of Object.values(data.landings.landings)) {
    for (const key of PARTNER_STOP_KEYS) {
      assert.ok(!(key in landing), `landing kept ${key}`);
    }
  }
  for (const key of PARTNER_ENABLED_KEYS) {
    assert.ok(!(key in data.display.settings), `display kept ${key}`);
  }

  // Derived from the feed registry rather than listed by hand, so adding a partner cannot quietly
  // leave its data in an export that promises to carry none.
  assert.equal(PARTNER_STOP_KEYS.length, Object.keys(PARTNER_FEEDS).length);
  assert.equal(PARTNER_ENABLED_KEYS.length, Object.keys(PARTNER_FEEDS).length);
  assert.deepEqual(data.landings.partnerStopIdsRemoved, PARTNER_STOP_KEYS);
  assert.deepEqual(data.display.partnerSwitchesRemoved, PARTNER_ENABLED_KEYS);

  // And nothing partner-shaped anywhere else in the payload. `meta` is exempt: it explains the
  // exclusion, so it necessarily names the operators.
  const body = JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "meta")))
    .replace(/"partner(?:StopIdsRemoved|SwitchesRemoved)":\[[^\]]*\]/g, "");
  for (const prefix of Object.values(PARTNER_FEEDS).map((feed) => feed.prefix)) {
    assert.ok(!body.includes(prefix), `export carries the ${prefix} namespace`);
  }
  for (const term of ["waterway", "seastreak", "Seastreak", "NYU", "IKEA", "govisland", "Trust for Governors"]) {
    assert.ok(!body.includes(term), `export mentions ${term}`);
  }
});

// Counts are the part a reader trusts without checking, so they are the part most worth checking.
test("the export's counts agree with the files it drew them from", async () => {
  const data = await committed();
  const [landings, crew, assignments, shifts, vessels] = await Promise.all([
    readJson("config/landings.json"), readJson("config/crew-shuttles.json"),
    readJson("content/boat-assignments.json"), readJson("content/boat-shifts.json"),
    readJson("content/vessels.json")
  ]);

  assert.equal(data.landings.count, Object.values(landings).filter((item) => !item.unused).length);
  // Stripping partner keys must not drop a landing.
  assert.deepEqual(Object.keys(data.landings.landings), Object.keys(landings));
  assert.equal(data.boatAssignments.count, Object.keys(assignments.assignments).length);
  assert.equal(data.fleet.count, vessels.vessels.length);
  assert.equal(
    data.boatShifts.count,
    Object.values(shifts.shifts).reduce((total, byBoat) => total + Object.values(byBoat).reduce((sum, list) => sum + list.length, 0), 0)
  );
  // The shuttles object carries an explanatory `note` alongside its two arrays; counting that
  // string's characters as shuttles is the obvious way to get this wrong.
  assert.equal(data.crewShuttles.shuttleCount, crew.shuttles.weekday.length + crew.shuttles.weekend.length);
  assert.equal(data.crewShuttles.shuttleCount, 12);
  assert.equal(data.crewShuttles.holidayCount, crew.holidays.dates.length);
});

// Sets, Maps and functions all survive JSON.stringify in their own way — as {}, as {}, and by
// vanishing. Each would leave a section that looks present and is empty.
test("nothing was lost or emptied on the way through JSON", async () => {
  const raw = await readFile(EXPORT_PATH, "utf8");
  assert.doesNotMatch(raw, /\[Function/);
  assert.doesNotMatch(raw, /"__proto__"/);

  const walk = (value, trail = "$") => {
    if (Array.isArray(value)) {
      // All crew boundaries can be resolved, leaving no rejected fields.
      const intentionallyDisabled = ["$.winterWeekendCrew.data.optionalWorkings.er3Mid.dates",
        "$.winterWeekendCrew.data.optionalWorkings.er3Mid.verifiedDates", "$.winterWeekendCrew.data.optionalWorkings.er3Mid.tripIds"];
      if (trail !== "$.fallWeekdayCrew.data.rejected" && !intentionallyDisabled.includes(trail)) {
        assert.notEqual(value.length, 0, `${trail} is an empty array`);
      }
      return value.forEach((item, index) => walk(item, `${trail}[${index}]`));
    }
    if (value && typeof value === "object") {
      assert.notEqual(Object.keys(value).length, 0, `${trail} is an empty object — a Set or Map probably did not survive`);
      return Object.entries(value).forEach(([key, item]) => walk(item, `${trail}.${key}`));
    }
  };
  walk(JSON.parse(raw));
});

test("the crew model constants reach the export as real values, not transcriptions", async () => {
  const data = await committed();
  const outOfService = await readFile(path.join(ROOT, "lib/out-of-service.js"), "utf8");
  // Imported from the module that uses them, so they cannot drift from the running code.
  assert.match(outOfService, /export const SHUTTLE_READY_BEFORE/);
  assert.match(outOfService, /export const SWAP_WINDOW_BEFORE/);
  assert.match(outOfService, /export const SWAP_WINDOW_AFTER/);

  const constants = data.crewModelConstants;
  // Both the raw value and its unit, so nobody has to guess whether 3600 is seconds or minutes.
  assert.equal(constants.shuttleReadyBefore.seconds, 3600);
  assert.equal(constants.shuttleReadyBefore.minutes, 60);
  assert.equal(constants.crewSwapWindowBefore.minutes, 30);
  assert.equal(constants.crewSwapWindowAfter.minutes, 90);
  assert.equal(constants.homePortStopId.value, "home-port");
  assert.equal(constants.crewServiceIds.weekday, "crew-weekday");
  assert.equal(constants.crewRoute.id, "CREW");
});

// Pier C is the one landing with no feed behind it, so the export is the only place its position
// and its invented stop id are written down together.
test("the virtual home-port landing survives the export intact", async () => {
  const { landings } = await committed();
  const pierC = Object.values(landings.landings).find((landing) => landing.virtual);
  assert.ok(pierC, "Pier C must be in the export");
  assert.equal(pierC.stopIds[0], "home-port");
  assert.equal(typeof pierC.latitude, "number");
  assert.equal(typeof pierC.longitude, "number");
});

// A snapshot, not an input. If anything ever read it back, editing the export would quietly change
// the board while the real sources said otherwise.
test("nothing in the build reads the export back", async () => {
  for (const directory of ["scripts", "lib", "public"]) {
    for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      if (entry.name === "export-hardcoded-data.js") continue;
      const source = await readFile(path.join(ROOT, directory, entry.name), "utf8");
      assert.doesNotMatch(source, /nyc-ferry-hardcoded-data/, `${directory}/${entry.name} must not read the export`);
    }
  }
  const server = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.doesNotMatch(server, /nyc-ferry-hardcoded-data/);
});
