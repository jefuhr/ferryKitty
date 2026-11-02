import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildDisplayData as buildCurrentDisplayData, decodeEntities, parseCsv } from "../scripts/build-data.js";

import { summerRoot } from "./fixtures/summer-root.js";
const buildDisplayData = (options = {}) => buildCurrentDisplayData({ root: summerRoot, ...options });

test("every configured landing builds departures", async () => {
  for (let landingNumber = 2; landingNumber <= 26; landingNumber += 1) {
    const data = await buildDisplayData({ landingNumber });
    assert.equal(data.meta.landingNumber, landingNumber);
    assert.ok(data.departures.length > 0, `Landing ${landingNumber} has no departures`);
  }
});

test("Rockaway includes ferry and bus service", async () => {
  const data = await buildDisplayData({ landingNumber: 18, busesEnabled: true });
  assert.equal(data.meta.busesEnabled, true);
  assert.ok(data.departures.some((item) => item.mode === "ferry"));
  assert.ok(data.departures.some((item) => item.mode === "bus"));
});

test("busesEnabled false drops the Rockaway shuttles and keeps the ferries", async () => {
  const data = await buildDisplayData({ landingNumber: 18, busesEnabled: false });
  assert.equal(data.meta.busesEnabled, false);
  assert.equal(data.departures.some((item) => item.mode === "bus"), false);
  assert.ok(data.departures.some((item) => item.mode === "ferry"));
  for (const route of Object.values(data.routes)) assert.equal(route.mode, "ferry");
});

test("busesEnabled false drops the NY Waterway shuttles at Pier 79", async () => {
  const withBuses = await buildDisplayData({ landingNumber: 26, waterwayEnabled: true, busesEnabled: true });
  assert.ok(withBuses.departures.some((item) => item.operator === "NY Waterway" && item.mode === "bus"));

  const data = await buildDisplayData({ landingNumber: 26, waterwayEnabled: true, busesEnabled: false });
  assert.equal(data.departures.some((item) => item.mode === "bus"), false);
  // The waterway merge itself stays on; only its bus routes are removed.
  assert.equal(data.meta.waterway.enabled, true);
  assert.ok(data.departures.some((item) => item.operator === "NY Waterway" && item.mode === "ferry"));
  for (const route of Object.values(data.routes)) assert.equal(route.mode, "ferry");
});

test("config/display.json declares busesEnabled as a boolean", async () => {
  const display = JSON.parse(await readFile(path.join(summerRoot, "config/display.json"), "utf8"));
  assert.equal(typeof display.busesEnabled, "boolean");
});

test("routes retain their official abbreviations and colors", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  assert.equal(data.routes.SB.shortName, "SB");
  assert.equal(data.routes.SB.name, "South Brooklyn");
  assert.equal(data.routes.SB.color, "#FFD100");
  for (const route of Object.values(data.routes)) {
    assert.match(route.shortName, /\S/);
    assert.match(route.color, /^#[0-9A-F]{6}$/);
  }
});

test("display data includes the configured slideshow interval and all directions", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const display = JSON.parse(await readFile(path.join(summerRoot, "config/display.json"), "utf8"));
  assert.equal(data.meta.slideSeconds, display.slideSeconds);
  assert.equal(data.meta.departureWindowMinutes, display.departureWindowMinutes);
  assert.equal(data.meta.departuresShown, display.departuresShown);
  assert.equal(data.meta.routesShown, display.routesShown);
  assert.equal(data.meta.schemaVersion, 9);
  assert.ok(data.tripSchedules[data.departures[0].tripId]?.stops.length > 1);
  const directions = new Set(data.departures.map((item) => `${item.routeId}|${item.directionId}|${item.destination}`));
  assert.ok(directions.size > 4, "Pier 11 should require more than one four-route slide");
});

test("display counts support every whole number from one through five", async () => {
  for (let departuresShown = 1; departuresShown <= 5; departuresShown += 1) {
    for (let routesShown = 1; routesShown <= 5; routesShown += 1) {
      const data = await buildDisplayData({ landingNumber: 16, departuresShown, routesShown });
      assert.equal(data.meta.departuresShown, departuresShown);
      assert.equal(data.meta.routesShown, routesShown);
    }
  }
});

test("display counts reject values outside one through five", async () => {
  await assert.rejects(
    () => buildDisplayData({ landingNumber: 16, departuresShown: 0 }),
    /departuresShown must be a whole number from 1 through 5/
  );
  await assert.rejects(
    () => buildDisplayData({ landingNumber: 16, routesShown: 6 }),
    /routesShown must be a whole number from 1 through 5/
  );
  await assert.rejects(
    () => buildDisplayData({ landingNumber: 16, departuresShown: 2.5 }),
    /departuresShown must be a whole number from 1 through 5/
  );
});

test("South Brooklyn trips identify Governors Island service", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const islandTrips = data.departures.filter((item) => item.routeId === "SB" && item.servesGovernorsIsland);
  assert.ok(islandTrips.length > 0);
  assert.equal(islandTrips.at(-1).tripId, "1168");
  assert.equal(islandTrips.at(-1).destination, "Governors Island");
  assert.ok(data.departures.some((item) => item.routeId === "SB" && item.seconds > islandTrips.at(-1).seconds && !item.servesGovernorsIsland));
});

test("East River departures are split into A, B, and Local variants", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  // Revenue departures only: a home-port run belongs to no A/B/Local pattern and carries no variant.
  const variants = new Set(
    data.departures.filter((item) => item.routeId === "ER" && !item.outOfService).map((item) => item.variant)
  );
  assert.deepEqual([...variants].sort(), ["A", "B", "LOCAL"]);
  for (const variant of variants) {
    assert.ok(data.departures.some((item) => item.routeId === "ER" && item.variant === variant));
  }
});

test("landing 1 remains unused", async () => {
  await assert.rejects(() => buildDisplayData({ landingNumber: 1 }), /active landing/);
});

test("NY Waterway departures are merged in at Pier 11 when enabled", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true });
  assert.equal(data.meta.waterway.enabled, true);
  assert.equal(data.meta.waterway.agencyName, "NY Waterway");
  // Scoped by feed prefix, not by operator: NY Waterway also runs the IKEA boat, which is a
  // separate feed with its own prefix, so the operator name alone no longer identifies this feed.
  const waterwayDepartures = data.departures.filter((item) => item.routeId.startsWith("wtr:"));
  assert.ok(waterwayDepartures.length > 0, "Pier 11 should include NY Waterway departures");
  for (const departure of waterwayDepartures) {
    assert.match(departure.tripId, /^wtr:/);
    assert.match(departure.routeId, /^wtr:/);
    assert.match(departure.stopId, /^wtr:/);
    assert.ok(data.tripSchedules[departure.tripId]?.stops.length > 1);
    assert.ok(data.routes[departure.routeId]);
    assert.equal(data.routes[departure.routeId].operator, "NY Waterway");
  }
  // Namespacing must not disturb NYC Ferry's own departures or route ids.
  assert.ok(data.departures.some((item) => item.operator === "NYC Ferry"));
  assert.ok(data.routes.SB);
  assert.equal(data.routes.SB.operator, "NYC Ferry");
});

test("NY Waterway departures are omitted when waterwayEnabled is false", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: false });
  assert.equal(data.meta.waterway.enabled, false);
  assert.equal(data.meta.waterway.agencyName, null);
  assert.equal(data.departures.some((item) => item.routeId.startsWith("wtr:")), false);
  assert.equal(data.meta.schemaVersion, 9);
});

test("NY Waterway departures are omitted for landings without a waterwayStopIds mapping", async () => {
  const data = await buildDisplayData({ landingNumber: 7, waterwayEnabled: true });
  assert.equal(data.meta.waterway.enabled, false);
  assert.equal(data.departures.some((item) => item.routeId.startsWith("wtr:")), false);
});

test("Seastreak departures are merged in at East 34th Street when enabled", async () => {
  const data = await buildDisplayData({ landingNumber: 8, seastreakEnabled: true });
  assert.equal(data.meta.seastreak.enabled, true);
  assert.equal(data.meta.seastreak.agencyName, "Seastreak");
  const seastreakDepartures = data.departures.filter((item) => item.operator === "Seastreak");
  assert.ok(seastreakDepartures.length > 0, "East 34th Street should include Seastreak departures");
  for (const departure of seastreakDepartures) {
    assert.match(departure.tripId, /^sea:/);
    assert.match(departure.routeId, /^sea:/);
    assert.match(departure.stopId, /^sea:/);
    assert.match(departure.serviceId, /^sea:/);
    assert.ok(data.tripSchedules[departure.tripId]?.stops.length > 1);
    assert.equal(data.routes[departure.routeId].operator, "Seastreak");
    // Seastreak's own headsigns only name a region, so the board shows the trip's last stop.
    assert.doesNotMatch(departure.destination, /^(Manhattan|New Jersey)$/);
  }
  // NYC Ferry's own departures and route ids are untouched by the merge.
  assert.ok(data.departures.some((item) => item.operator === "NYC Ferry"));
  assert.ok(data.routes.ER);
  assert.equal(data.routes.ER.operator, "NYC Ferry");
});

test("Seastreak departures are omitted when seastreakEnabled is false", async () => {
  const data = await buildDisplayData({ landingNumber: 8, seastreakEnabled: false });
  assert.equal(data.meta.seastreak.enabled, false);
  assert.equal(data.meta.seastreak.agencyName, null);
  assert.equal(data.departures.some((item) => item.operator === "Seastreak"), false);
  assert.ok(data.departures.length > 0);
});

test("Seastreak departures are omitted for landings without a seastreakStopIds mapping", async () => {
  const data = await buildDisplayData({ landingNumber: 16, seastreakEnabled: true });
  assert.equal(data.meta.seastreak.enabled, false);
  assert.equal(data.departures.some((item) => item.operator === "Seastreak"), false);
});

test("NYU ferry departures are merged in at both terminals it serves", async () => {
  // East 34th Street and Sunset Park are opposite ends of the same NYU crossing, so each should
  // show the other as the destination.
  for (const [landingNumber, destination] of [[8, "Brooklyn Army Terminal"], [24, "East 34th Street"]]) {
    const data = await buildDisplayData({ landingNumber, nyuEnabled: true });
    assert.equal(data.meta.nyu.enabled, true);
    assert.equal(data.meta.nyu.agencyName, "New York University");
    const nyuDepartures = data.departures.filter((item) => item.operator === "New York University");
    assert.ok(nyuDepartures.length > 0, `landing ${landingNumber} should include NYU departures`);
    for (const departure of nyuDepartures) {
      assert.match(departure.tripId, /^nyu:/);
      assert.match(departure.routeId, /^nyu:/);
      assert.match(departure.stopId, /^nyu:/);
      assert.match(departure.serviceId, /^nyu:/);
      assert.ok(data.tripSchedules[departure.tripId]?.stops.length > 1);
      assert.equal(data.routes[departure.routeId].operator, "New York University");
      assert.equal(departure.destination, destination);
      assert.equal(departure.mode, "ferry");
    }
    assert.ok(data.departures.some((item) => item.operator === "NYC Ferry"));
  }
});

test("NYU ferry departures are omitted when nyuEnabled is false", async () => {
  const data = await buildDisplayData({ landingNumber: 8, nyuEnabled: false });
  assert.equal(data.meta.nyu.enabled, false);
  assert.equal(data.meta.nyu.agencyName, null);
  assert.equal(data.departures.some((item) => item.operator === "New York University"), false);
  assert.ok(data.departures.length > 0);
});

test("NYU ferry departures are omitted for landings without a nyuStopIds mapping", async () => {
  const data = await buildDisplayData({ landingNumber: 16, nyuEnabled: true });
  assert.equal(data.meta.nyu.enabled, false);
  assert.equal(data.departures.some((item) => item.operator === "New York University"), false);
});

test("the generated NYU feed only runs on the weekdays Passio publishes service for", async () => {
  const data = await buildDisplayData({ landingNumber: 8, nyuEnabled: true });
  const nyuCalendars = data.calendars.filter((item) => item.serviceId.startsWith("nyu:"));
  assert.ok(nyuCalendars.length > 0);
  for (const calendar of nyuCalendars) {
    // weekdays is [Sun..Sat]; NYU runs Monday through Friday only.
    assert.deepEqual(calendar.weekdays, [false, true, true, true, true, true, false]);
    assert.match(calendar.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(calendar.endDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("Liberty Landing departures are merged in at Battery Park City when enabled", async () => {
  const data = await buildDisplayData({ landingNumber: 25, libertyEnabled: true });
  assert.equal(data.meta.liberty.enabled, true);
  assert.equal(data.meta.liberty.agencyName, "Liberty Landing Ferry");
  const libertyDepartures = data.departures.filter((item) => item.operator === "Liberty Landing Ferry");
  assert.ok(libertyDepartures.length > 0, "Battery Park City should parse Liberty Landing departures");
  for (const departure of libertyDepartures) {
    assert.match(departure.tripId, /^lib:/);
    assert.match(departure.routeId, /^lib:/);
    assert.match(departure.stopId, /^lib:/);
    assert.match(departure.serviceId, /^lib:/);
    assert.ok(data.tripSchedules[departure.tripId]?.stops.length > 1);
    assert.equal(data.routes[departure.routeId].operator, "Liberty Landing Ferry");
    assert.equal(departure.mode, "ferry");
  }
  // The NY Waterway dock at this landing keeps its own namespace and its own operator.
  assert.ok(data.departures.some((item) => item.operator === "NY Waterway"));
  assert.ok(data.departures.some((item) => item.operator === "NYC Ferry"));
});

test("Liberty Landing departures are omitted when libertyEnabled is false", async () => {
  const data = await buildDisplayData({ landingNumber: 25, libertyEnabled: false });
  assert.equal(data.meta.liberty.enabled, false);
  assert.equal(data.meta.liberty.agencyName, null);
  assert.equal(data.departures.some((item) => item.operator === "Liberty Landing Ferry"), false);
  assert.ok(data.departures.length > 0);
});

test("Liberty Landing departures are omitted for landings without a libertyStopIds mapping", async () => {
  const data = await buildDisplayData({ landingNumber: 16, libertyEnabled: true });
  assert.equal(data.meta.liberty.enabled, false);
  assert.equal(data.departures.some((item) => item.operator === "Liberty Landing Ferry"), false);
});

test("every bundled feed is still in service, so no operator is silently empty", async () => {
  // public/app.js only counts a departure whose service is in effect today, so a lapsed feed shows
  // nothing at all rather than failing loudly. Liberty Landing shipped that way once — a 2019 feed
  // that had expired in 2020 — so this asserts the invariant for every operator at every landing
  // that pulls one in. A failure here means that feed needs regenerating or replacing.
  const today = new Date().toISOString().slice(0, 10);
  for (const landingNumber of [8, 16, 25]) {
    const data = await buildCurrentDisplayData({ landingNumber });
    const latestEnd = new Map();
    const covered = new Set();
    for (const calendar of data.calendars) {
      const operator = calendar.serviceId.includes(":") ? calendar.serviceId.split(":")[0] : "nycf";
      if (!latestEnd.has(operator) || calendar.endDate > latestEnd.get(operator)) latestEnd.set(operator, calendar.endDate);
      if (today >= calendar.startDate && today <= calendar.endDate) covered.add(operator);
    }
    for (const [operator, endDate] of latestEnd) {
      assert.ok(
        covered.has(operator),
        `landing ${landingNumber}: the "${operator}" feed has no service covering ${today} (latest end ${endDate}); it needs replacing`
      );
    }
  }
});

test("the Liberty Landing feed matches the timetable its operator publishes", async () => {
  // gtfs/liberty/ is transcribed from libertylandingcityferry.com by scripts/build-liberty-gtfs.js,
  // not downloaded, so this pins the shape of that transcription. The operator prints hourly
  // sailings leaving Brookfield Place at :45 — weekdays 06:45 to 19:45, weekends from 09:45.
  const data = await buildDisplayData({ landingNumber: 25, libertyEnabled: true });
  const fromBrookfield = data.departures.filter((item) => item.stopId === "lib:2557122");
  const byService = new Map();
  for (const departure of fromBrookfield) {
    const list = byService.get(departure.serviceId) || [];
    list.push(departure.departureTime);
    byService.set(departure.serviceId, list);
  }
  const weekday = (byService.get("lib:liberty-weekday") || []).sort();
  const weekend = (byService.get("lib:liberty-weekend") || []).sort();
  assert.deepEqual(weekday, Array.from({ length: 14 }, (_, index) => `${String(index + 6).padStart(2, "0")}:45:00`));
  assert.deepEqual(weekend, Array.from({ length: 11 }, (_, index) => `${String(index + 9).padStart(2, "0")}:45:00`));
  // Every sailing from Manhattan runs to Liberty Landing by way of Warren Street.
  for (const departure of fromBrookfield) {
    assert.equal(departure.destination, "Liberty Landing");
    assert.equal(departure.nextStop, "Warren Street");
  }
});

test("partner feeds keep separate id namespaces at a landing that has both", async () => {
  const data = await buildDisplayData({ landingNumber: 8, seastreakEnabled: true, waterwayEnabled: true, nyuEnabled: true });
  const prefixes = new Set(Object.keys(data.routes).map((id) => id.split(":")[1] ? `${id.split(":")[0]}:` : "nycf"));
  assert.ok(prefixes.has("sea:"));
  assert.ok(prefixes.has("nyu:"));
  for (const departure of data.departures) {
    const operator = data.routes[departure.routeId].operator;
    if (departure.routeId.startsWith("sea:")) assert.equal(operator, "Seastreak");
    else if (departure.routeId.startsWith("wtr:")) assert.equal(operator, "NY Waterway");
    else if (departure.routeId.startsWith("nyu:")) assert.equal(operator, "New York University");
    else assert.equal(operator, "NYC Ferry");
  }
  // Departures stay in one time-sorted list regardless of which feed they came from.
  const seconds = data.departures.map((item) => item.seconds);
  assert.deepEqual(seconds, [...seconds].sort((left, right) => left - right));
});

test("HTML-escaped feed text is decoded before it reaches the screen", async () => {
  assert.equal(decodeEntities("Martha&#8217;s Vineyard &amp; Nantucket"), "Martha’s Vineyard & Nantucket");
  assert.equal(decodeEntities("New Bedford &#038; Nantucket"), "New Bedford & Nantucket");
  assert.equal(decodeEntities("Pier 11  /  Wall St"), "Pier 11 / Wall St");
  assert.equal(decodeEntities(""), "");
  const data = await buildDisplayData({ landingNumber: 8, seastreakEnabled: true });
  for (const route of Object.values(data.routes)) assert.doesNotMatch(route.name, /&#?\w+;/);
  for (const departure of data.departures) assert.doesNotMatch(departure.destination, /&#?\w+;/);
});

test("crew boat assignments are attached to NYC Ferry departures", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  // The Governors Island shuttle is crewed off-schedule and has no Boat column in the
  // workbook, so it is the one ferry route that never carries an assignment.
  const scheduled = data.departures.filter((item) =>
    item.operator === "NYC Ferry" && item.mode === "ferry" && item.routeId !== "GI");
  assert.ok(scheduled.length > 0);
  const labeled = scheduled.filter((item) => Number.isInteger(item.boatAssignment) && item.boatAssignment >= 1);
  assert.ok(labeled.length / scheduled.length > 0.95,
    `${scheduled.length - labeled.length} of ${scheduled.length} scheduled ferry departures lack a boat assignment`);
  assert.ok(data.departures.filter((item) => item.routeId === "GI").every((item) => item.boatAssignment === null));
  // NY Waterway publishes no crew schedule, so those rows stay unlabeled.
  assert.ok(data.departures.filter((item) => item.operator === "NY Waterway").every((item) => item.boatAssignment === null));
});

test("boat assignments join GTFS trip_short_name to the schedule workbook", async () => {
  const [assignmentsRaw, tripsRaw] = await Promise.all([
    readFile(path.join(summerRoot, "content/boat-assignments.json"), "utf8"),
    readFile(path.join(summerRoot, "gtfs/trips.txt"), "utf8")
  ]);
  const { assignments } = JSON.parse(assignmentsRaw);
  assert.ok(Object.keys(assignments).length > 300);
  assert.ok(Object.values(assignments).every((boat) => Number.isInteger(boat) && boat >= 1));
  // Shuttle-bus routes (RES/RWS) and the Governors Island shuttle carry no boat number, so
  // coverage is asserted over the ferry routes the workbook actually schedules.
  const trips = parseCsv(tripsRaw).filter((trip) => ["AS", "ER", "RS", "SB", "SG", "RR"].includes(trip.route_id));
  const missing = trips.filter((trip) => assignments[String(trip.trip_short_name).trim()] === undefined);
  assert.ok(missing.length / trips.length < 0.05, `${missing.length} of ${trips.length} ferry trips lack a boat assignment`);
});

// The Trillium feed types four Hudson-crossing ferries as buses. With busesEnabled=false — the
// setting every deployed board uses — that silently deleted a third of NY Waterway's service at
// Pier 11. These are the routes and the counts the operator publishes on nywaterway.com.
test("NY Waterway ferries mistyped as buses in the feed still sail", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true, busesEnabled: false });
  // Counted by the terminals a sailing reaches, not by the row's headline destination: one boat
  // calls at several, so "Edgewater" is sometimes the far end and sometimes a stop on the way.
  const counts = {};
  for (const item of data.departures.filter((entry) => entry.routeId.startsWith("wtr:"))) {
    for (const place of [item.destination, ...(item.via || [])]) counts[place] = (counts[place] || 0) + 1;
  }
  // Edgewater, Hoboken/14th St and Port Liberte are the three mistyped routes calling at Pier 11.
  assert.equal(counts.Edgewater, 6);
  assert.equal(counts["Hoboken (14th Street)"], 15);
  assert.equal(counts["Port Liberte"], 11);
  // Every one of them is a ferry on the board, not a bus, so busesEnabled cannot reach them.
  for (const item of data.departures.filter((entry) => entry.routeId.startsWith("wtr:"))) {
    assert.equal(item.mode, "ferry");
  }
  // Genuine buses are still dropped: the feed's crosstown shuttles never appear.
  assert.equal(data.departures.some((item) => item.mode === "bus"), false);
});

// The same sailing listed under two trip ids used to render as two identical rows.
test("a sailing listed twice in a feed is shown once", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true });
  const seen = new Set();
  for (const item of data.departures) {
    const key = [item.serviceId, item.routeId, item.variant || "", item.stopId, item.departureTime, item.destination].join(" ");
    assert.equal(seen.has(key), false, `duplicate departure on the board: ${key}`);
    seen.add(key);
  }
  // The known case: NY Waterway carries stale South Amboy trips alongside the current ones, so
  // Pier 11 must show the six departures the operator publishes rather than eight.
  const southAmboy = data.departures.filter((item) => item.routeId.startsWith("wtr:") && item.destination === "South Amboy");
  assert.deepEqual(southAmboy.map((item) => item.departureTime).sort(),
    ["06:35:00", "07:40:00", "15:35:00", "16:35:00", "17:15:00", "18:15:00"]);
});

// NY Waterway runs the IKEA Brooklyn weekend boat but leaves it out of its GTFS, so gtfs/ikea/ is
// transcribed from the operator's published image. These are the departure times on that image.
test("the IKEA weekend ferry sails from Pier 11 and Midtown", async () => {
  const pier11 = await buildDisplayData({ landingNumber: 16, ikeaEnabled: true });
  assert.equal(pier11.meta.ikea.enabled, true);
  const fromPier11 = pier11.departures.filter((item) => item.routeId.startsWith("ike:"));
  assert.deepEqual(fromPier11.filter((item) => item.destination === "IKEA Brooklyn").map((item) => item.departureTime),
    ["11:00:00", "12:30:00", "14:00:00", "15:30:00", "17:00:00"]);
  assert.deepEqual(fromPier11.filter((item) => item.destination === "Midtown / W 39th Street").map((item) => item.departureTime),
    ["11:30:00", "13:00:00", "14:30:00", "16:00:00", "17:30:00", "18:35:00"]);

  const midtown = await buildDisplayData({ landingNumber: 26, ikeaEnabled: true });
  const fromMidtown = midtown.departures.filter((item) => item.routeId.startsWith("ike:"));
  assert.deepEqual(fromMidtown.map((item) => item.departureTime),
    ["10:30:00", "12:00:00", "13:30:00", "15:00:00", "16:30:00", "17:55:00"]);
  // The last sailing of the day is printed with the Pier 11 cell blacked out: it runs non-stop,
  // which is why Pier 11 sees five southbound boats and Midtown sees six.
  assert.equal(fromMidtown.at(-1).nextStop, "IKEA Brooklyn");
  // It is NY Waterway's boat, badged IKEA, and it is a ferry rather than a shuttle bus.
  assert.equal(midtown.routes["ike:IKEA"].operator, "NY Waterway");
  assert.equal(midtown.routes["ike:IKEA"].shortName, "IKEA");
  assert.equal(midtown.routes["ike:IKEA"].mode, "ferry");
});

test("the IKEA ferry only runs at weekends, and only where it docks", async () => {
  const calendar = await readFile(path.join(summerRoot, "gtfs/ikea/calendar.txt"), "utf8");
  const [, row] = calendar.trim().split("\n");
  const [, sunday, monday, tuesday, wednesday, thursday, friday, saturday] = row.split(",");
  assert.deepEqual([monday, tuesday, wednesday, thursday, friday], ["0", "0", "0", "0", "0"]);
  assert.deepEqual([saturday, sunday], ["1", "1"]);
  // The switch is off wherever no ikeaStopIds mapping exists, so no other landing grows an IKEA row.
  const redHook = await buildDisplayData({ landingNumber: 17, ikeaEnabled: true });
  assert.equal(redHook.meta.ikea.enabled, false);
  assert.equal(redHook.departures.some((item) => item.routeId.startsWith("ike:")), false);
});

// The Trust for Governors Island runs its own Brooklyn boats, which no GTFS anywhere describes, so
// gtfs/gi/ is transcribed from the operator's schedule page. These are the times on that page.
test("the Trust's Governors Island ferry sails from Red Hook and Pier 6", async () => {
  const redHook = await buildDisplayData({ landingNumber: 17 });
  assert.equal(redHook.meta.gi.enabled, true);
  const fromRedHook = redHook.departures.filter((item) => item.routeId.startsWith("gi:"));
  assert.deepEqual(fromRedHook.map((item) => item.departureTime),
    ["09:45:00", "10:45:00", "11:45:00", "12:45:00", "13:45:00", "14:45:00", "15:45:00", "16:45:00", "17:45:00"]);
  assert.ok(fromRedHook.every((item) => item.destination === "Governors Island / Yankee Pier"));
  // The last two leave empty to go and fetch the last visitors, so they are shown but marked.
  assert.deepEqual(fromRedHook.filter((item) => item.outOfService).map((item) => item.departureTime),
    ["16:45:00", "17:45:00"]);

  const pier6 = await buildDisplayData({ landingNumber: 3 });
  const fromPier6 = pier6.departures.filter((item) => item.routeId.startsWith("gi:"));
  assert.deepEqual(fromPier6.map((item) => item.departureTime),
    ["10:15:00", "11:15:00", "12:15:00", "13:15:00", "14:15:00", "15:15:00", "16:15:00", "17:15:00", "18:15:00"]);
  assert.ok(fromPier6.every((item) => item.destination === "Governors Island / Yankee Pier"));
  assert.deepEqual(fromPier6.filter((item) => item.outOfService).map((item) => item.departureTime),
    ["17:15:00", "18:15:00"]);

  // The Trust's boat, not the NYC Ferry South Brooklyn route that also calls at the island.
  assert.equal(redHook.routes["gi:GI-RH"].operator, "The Trust for Governors Island");
  assert.equal(redHook.routes["gi:GI-RH"].mode, "ferry");
  assert.equal(pier6.routes["gi:GI-BBP"].operator, "The Trust for Governors Island");

  // The return sailings are the last stop of their trip, so they are arrivals and must never be
  // shown as departures from the Brooklyn side — otherwise each landing doubles.
  assert.equal(fromRedHook.length + fromPier6.length, 18);
});

// pickup_type 1 means "nobody boards here". Seastreak's feed is full of them — its long routes
// drop off on the way back and those calls are not departures — and showing them would put
// hundreds of unboardable rows on the board. The Trust's four end-of-day runs are the opposite
// case and the only feed opted in, so the two behaviours have to stay apart.
// A departure board does not normally show a trip's last stop, because arriving is not departing.
// Seastreak's New Jersey commuter boats end their run in Manhattan and the operator flags those
// calls itself, so they are shown as arrivals — named for where the boat is coming from, and
// barred from claiming LAST, which belongs to the last sailing someone can actually take.
test("Seastreak's terminating boats show as arrivals at both Manhattan piers", async () => {
  const [east34, pier79] = await Promise.all([
    buildDisplayData({ landingNumber: 8 }),
    buildDisplayData({ landingNumber: 26 })
  ]);
  const arrivals = (data) => data.departures.filter((item) => item.arrival);

  for (const data of [east34, pier79]) {
    assert.ok(arrivals(data).length > 0, "the commuter boats terminate here and must be shown");
    for (const item of arrivals(data)) {
      assert.match(item.destination, /^Arrives from .+/, "an arrival names its origin, not a destination");
      assert.ok(String(item.routeId).startsWith("sea:"), "only the opted-in feed contributes arrivals");
      assert.equal(item.outOfService, false, "an arriving boat is in service and full of passengers");
      assert.equal(item.crewShuttle, false);
    }
  }

  // West 39th St is Pier 79 on this board, and its boats are Belford's.
  assert.equal(pier79.meta.seastreak.enabled, true);
  assert.ok(arrivals(pier79).some((item) => item.destination === "Arrives from Belford, NJ"));
  // The ordinary sailings come with them: the pier gets the whole service, not only the arrivals.
  assert.ok(pier79.departures.some((item) => String(item.routeId).startsWith("sea:") && !item.arrival),
    "Pier 79 must also show the boats leaving for New Jersey");

  assert.ok(arrivals(east34).some((item) => /Highlands/.test(item.destination)));
});

test("only the opted-in feed shows its no-pickup sailings; everyone else's stay hidden", async () => {
  const redHook = await buildDisplayData({ landingNumber: 17 });
  const shown = redHook.departures.filter((item) => item.outOfService && String(item.routeId).startsWith("gi:"));
  assert.equal(shown.length, 2, "the Trust's two Red Hook run-overs are shown, flagged");

  // Every landing at once: no partner other than the Trust may contribute a no-pickup row.
  const landings = JSON.parse(await readFile(path.join(summerRoot, "config/landings.json"), "utf8"));
  let seastreakRows = 0;
  for (const [id, landing] of Object.entries(landings)) {
    if (landing.unused) continue;
    const data = await buildDisplayData({ landingNumber: Number(id) });
    for (const item of data.departures) {
      const routeId = String(item.routeId);
      if (routeId.startsWith("sea:")) seastreakRows += 1;
      if (!item.outOfService || routeId.startsWith("gi:")) continue;
      assert.ok(!/^(wtr|sea|nyu|lib|ike):/.test(routeId),
        `${routeId} at landing ${id} leaked a no-pickup call onto the board`);
    }
  }
  assert.ok(seastreakRows > 0, "Seastreak still runs; only its unboardable calls are hidden");
});

test("the Governors Island ferry runs weekends and holidays, in season, where it docks", async () => {
  const [calendar, dates] = await Promise.all([
    readFile(path.join(summerRoot, "gtfs/gi/calendar.txt"), "utf8"),
    readFile(path.join(summerRoot, "gtfs/gi/calendar_dates.txt"), "utf8")
  ]);
  const [, row] = calendar.trim().split("\n");
  const [, sunday, monday, tuesday, wednesday, thursday, friday, saturday, startDate, endDate] = row.split(",");
  assert.deepEqual([monday, tuesday, wednesday, thursday, friday], ["0", "0", "0", "0", "0"]);
  assert.deepEqual([saturday, sunday], ["1", "1"]);
  // "Saturdays, Sundays, and holidays from May 23-November 1, 2026", quoted from the operator.
  assert.equal(startDate, "20260523");
  assert.equal(endDate, "20261101");
  // Weekday holidays are added, and every one has to fall inside the season or it does nothing.
  const added = dates.trim().split("\n").slice(1).map((line) => line.split(","));
  assert.ok(added.length > 0, "the page says holidays run, so some must be listed");
  for (const [, date, exceptionType] of added) {
    assert.equal(exceptionType, "1");
    assert.ok(date >= startDate && date <= endDate, `holiday ${date} is outside the season`);
  }

  // The switch is off wherever no giStopIds mapping exists, so a landing the Trust does not serve
  // cannot grow a Trust row. Pier 11 is the case: the Trust's boats run between Brooklyn and the
  // island and never call there.
  const pier11 = await buildDisplayData({ landingNumber: 16 });
  assert.equal(pier11.meta.gi.enabled, false);
  assert.equal(pier11.departures.some((item) => item.routeId.startsWith("gi:")), false);

  // Governors Island is not that case and used to be treated as one. The Trust's whole point is
  // getting people to and from the island, so the island is where its boats matter most — see
  // "every stop in the Trust's feed is attached to a landing".
  const island = await buildDisplayData({ landingNumber: 11 });
  assert.equal(island.meta.gi.enabled, true);
  assert.ok(island.departures.some((item) => item.routeId.startsWith("gi:")));
});

// Out-of-service moves. Nothing here is in the GTFS feed or the schedule workbook — the workbook
// only says which boat runs which trip, which is what makes "this boat's last trip" answerable.
test("a boat going out of service is spotted from the gap in its own day", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const homePort = data.departures.filter((item) => item.outOfService);
  assert.ok(homePort.length > 0, "Pier 11 should be where several boats tie up");
  for (const item of homePort) {
    assert.equal(item.destination, "Pier C");
    assert.equal(item.operator, "NYC Ferry");
    assert.equal(item.crewShuttle, false);
    // A home-port run belongs to the boat that makes it, so the badge still identifies the boat.
    assert.ok(Number.isInteger(item.boatAssignment));
  }
  // The weekday split shifts: these three boats work the morning peak, tie up at Pier 11 mid-morning
  // for more than five hours, and come back for the evening. Nothing in the feed says so — it is a
  // hole in the boat's own run of trips.
  const midday = homePort.filter((item) => !item.endsDay)
    .map((item) => `${item.routeId}${item.boatAssignment}@${item.departureTime.slice(0, 5)}`).sort();
  // The long ones are the weekday split shifts: these boats work the morning peak, tie up for more
  // than five hours and come back for the evening. The short ones are crew changeovers, where the
  // boat is swapped rather than the crew stepping aboard — it goes in and its relief comes out of
  // Pier C minutes later. Neither is in the feed; both come off the crew sheet.
  assert.deepEqual(midday, [
    "AS1@10:42", "AS2@13:14", "AS3@14:11", "ER1@10:28", "ER2@14:31", "ER5@10:04", "ER6@13:54",
    "SG1@13:18", "SG2@14:08"
  ]);
  // Those are distinct from finishing for the day, which an agent needs to tell apart.
  assert.ok(homePort.some((item) => item.endsDay));

  // The trip before the gap is flagged on every leg, so an agent upstream sees it too.
  const flagged = data.departures.filter((item) => item.endsShift);
  assert.ok(flagged.length > 0);
  assert.ok(flagged.every((item) => !item.outOfService && !item.crewShuttle));
  assert.ok(flagged.every((item) => ["certain", "unsure"].includes(item.endsShift)));

  // Governors Island is crewed off-schedule and carries no boat number, so nothing is derivable and
  // it must not acquire a home-port run by accident.
  assert.equal(data.departures.some((item) => item.routeId === "GI" && item.outOfService), false);
  const waterway = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true });
  assert.equal(waterway.departures.some((item) => item.routeId.startsWith("wtr:") && item.outOfService), false);
});

test("published crew shifts replace the gap guesswork", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  // With the crew schedule's own shift boundaries imported, nothing at Pier 11 is inferred any
  // more: every drop-off flag comes from a published shift end or from the boat's last run.
  assert.equal(data.departures.some((item) => item.endsShift === "unsure"), false);
  assert.ok(data.departures.some((item) => item.endsShift === "certain"));

  // The weekday split shifts, exactly as the crew schedule states them: ER5 finishes at Pier 11 at
  // 10:04, ER1 at 10:28 and AS1 at 10:42, each returning for the evening peak hours later.
  const midday = data.departures.filter((item) => item.outOfService && !item.endsDay)
    .map((item) => `${item.routeId}${item.boatAssignment}@${item.departureTime.slice(0, 5)}`).sort();
  // The long ones are the weekday split shifts: these boats work the morning peak, tie up for more
  // than five hours and come back for the evening. The short ones are crew changeovers, where the
  // boat is swapped rather than the crew stepping aboard — it goes in and its relief comes out of
  // Pier C minutes later. Neither is in the feed; both come off the crew sheet.
  assert.deepEqual(midday, [
    "AS1@10:42", "AS2@13:14", "AS3@14:11", "ER1@10:28", "ER2@14:31", "ER5@10:04", "ER6@13:54",
    "SG1@13:18", "SG2@14:08"
  ]);

  // Every boat still gets a home-port run at the end of its day, taken from the feed rather than
  // the notes so that an unusable shift note cannot make a day look shorter than it is. ER1's
  // weekday PM note names the wrong terminal and is dropped at import, yet its 10:28 tie-up and its
  // end of day both still appear.
  const er1 = data.departures.filter((item) => item.outOfService && item.routeId === "ER" && item.boatAssignment === 1);
  assert.ok(er1.some((item) => !item.endsDay), "ER1 should still tie up mid-morning");
  assert.ok(er1.some((item) => item.endsDay), "ER1 should still finish for the day");
});

test("a crew handover ties the boat up unless a shuttle brings the relief out to it", async () => {
  const shifts = JSON.parse(await readFile(path.join(summerRoot, "content/boat-shifts.json"), "utf8")).shifts;
  const minutes = (value) => Number(value.split(":")[0]) * 60 + Number(value.split(":")[1]);
  const handovers = [], breaks = [];
  for (const boats of Object.values(shifts)) {
    for (const list of Object.values(boats)) {
      for (const [index, entry] of list.entries()) {
        const next = list[index + 1];
        if (!next) continue;
        (minutes(next.startTime) - minutes(entry.endTime) <= 60 ? handovers : breaks)
          .push(minutes(next.startTime) - minutes(entry.endTime));
      }
    }
  }
  // The published data separates the two completely: handovers run 0-34 minutes, and every real
  // break is over four hours. Nothing sits between, which is what makes the distinction safe.
  assert.ok(handovers.length > 20 && breaks.length > 0);
  assert.ok(Math.max(...handovers) <= 60, `longest handover was ${Math.max(...handovers)} min`);
  assert.ok(Math.min(...breaks) > 120, `shortest break was ${Math.min(...breaks)} min`);

  // What happens at a handover depends on how the relief gets aboard, and only on that. A crew
  // carried out by shuttle steps onto the boat already alongside and it sails on. Everywhere else a
  // handover is a boat swap: the vessel that finishes runs to Pier C and another comes out of it to
  // pick the working up, which is why both halves are on the board.
  const crew = JSON.parse(await readFile(path.join(summerRoot, "config/crew-shuttles.json"), "utf8"));
  const shuttled = new Set(crew.shuttles.weekday.flatMap((entry) => entry.boats));
  const data = await buildDisplayData({ landingNumber: 16 });
  const tieUps = data.departures.filter((item) => item.outOfService && item.serviceId === "1")
    .map((item) => `${item.routeId}${item.boatAssignment}@${item.departureTime.slice(0, 5)}`);
  for (const [boat, list] of Object.entries(shifts.weekday || {})) {
    for (const [index, entry] of list.entries()) {
      const next = list[index + 1];
      if (!next || minutes(next.startTime) - minutes(entry.endTime) > 60) continue;
      // Only the ones that tie up at this landing are visible here.
      if (entry.endPlace !== "Wall St/Pier 11") continue;
      assert.equal(tieUps.includes(`${boat}@${entry.endTime}`), !shuttled.has(boat),
        shuttled.has(boat)
          ? `${boat} is relieved by shuttle at ${entry.endTime} and must stay in service`
          : `${boat} is swapped at ${entry.endTime} and must run to Pier C`);
    }
  }
});

test("a crew shuttle is one departure for all the boats it relieves, and never marks them out of service", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const shuttles = data.departures.filter((item) => item.crewShuttle);
  assert.ok(shuttles.length > 0);
  const weekend = shuttles.filter((item) => item.serviceId === "crew-weekend");
  // "ERF 3 PM/RWSV 5PM/RWSV 2PM/AST 2 PM: P11 14:35" is one 2:35pm departure, not four.
  const swap = weekend.find((item) => item.departureTime === "14:35:00");
  assert.ok(swap, "expected the 14:35 Pier 11 crew shuttle");
  assert.deepEqual(swap.crewBoats, ["ER3", "RS5", "RS2", "AS2"]);
  assert.equal(swap.destination, "Pier C");
  assert.equal(swap.outOfService, false);
  assert.equal(swap.routeId, "CREW");
  assert.ok(data.routes.CREW, "the shuttle needs a route of its own, not a borrowed one");
  // None of the boats it relieves is finishing: each keeps running afterwards.
  for (const boat of swap.crewBoats) {
    const route = boat.replace(/\d+$/, ""), number = Number(boat.replace(/^\D+/, ""));
    const later = data.departures.filter((item) =>
      item.routeId === route && item.boatAssignment === number && !item.outOfService &&
      item.seconds > swap.seconds);
    assert.ok(later.length > 0, `${boat} should still have revenue departures after the crew swap`);
  }
});

test("crew shuttles follow the weekend pattern on holidays, which the feed knows nothing about", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const services = new Map(data.calendars.map((item) => [item.serviceId, item]));
  // weekdays[] is Sunday-first.
  assert.deepEqual(services.get("crew-weekend").weekdays, [true, false, false, false, false, false, true]);
  assert.deepEqual(services.get("crew-weekday").weekdays, [false, true, true, true, true, true, false]);
  assert.ok(services.get("crew-weekend").startDate && services.get("crew-weekend").endDate);
  // A holiday swaps one for the other. The bundled feed has an empty calendar_dates.txt, so these
  // exceptions are the only thing that makes a holiday different from any other weekday.
  const holiday = "2026-09-07";
  assert.ok(data.exceptions.some((item) => item.serviceId === "crew-weekend" && item.date === holiday && item.added));
  assert.ok(data.exceptions.some((item) => item.serviceId === "crew-weekday" && item.date === holiday && !item.added));
});

test("landings with no crew shuttle configured get none", async () => {
  // Red Hook appears in no shuttle line, so it should carry home-port runs at most.
  const data = await buildDisplayData({ landingNumber: 17 });
  assert.equal(data.departures.some((item) => item.crewShuttle), false);
  assert.equal(data.routes.CREW, undefined);
});

test("a crew shuttle waits for its boats, so it shows a window rather than a minute", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const shuttles = data.departures.filter((item) => item.crewShuttle);
  const swap = shuttles.find((item) => item.serviceId === "crew-weekend" && item.departureTime === "14:35:00");
  assert.ok(swap, "expected the 14:35 Pier 11 crew shuttle");
  // ER3, RS5, RS2 and AS2 next sail from Pier 11 at 15:05, 14:55, 15:00 and 15:05. The shuttle
  // cannot go until the last crew is aboard, so the window closes at 15:05.
  assert.equal(swap.departureTimeEnd, "15:05:00");
  assert.ok(swap.secondsEnd > swap.seconds);
  for (const item of shuttles) {
    assert.ok(item.departureTimeEnd, `every shuttle should close its window: ${item.tripId}`);
    assert.ok(item.secondsEnd > item.seconds);
  }
  // A home-port run is a single time, not a window — nothing is waiting on it.
  for (const item of data.departures.filter((entry) => entry.outOfService)) {
    assert.equal(item.departureTimeEnd, null);
  }
});

test("a crew swap does not read as a boat going out of service", async () => {
  const data = await buildDisplayData({ landingNumber: 16 });
  const shuttles = data.departures.filter((item) => item.crewShuttle);
  const named = new Set(shuttles.flatMap((item) => item.crewBoats || []));
  assert.ok(named.size > 0);
  // In this schedule a swap leaves no hole at all: the relief crew steps aboard and the boat sails.
  // So no boat is both named in a shuttle and shown tying up at that landing around that time.
  for (const shuttle of shuttles) {
    for (const boat of shuttle.crewBoats || []) {
      const tieUp = data.departures.find((item) => item.outOfService &&
        `${item.routeId}${item.boatAssignment}` === boat &&
        item.serviceId !== "crew-weekday" && item.serviceId !== "crew-weekend" &&
        Math.abs(item.seconds - shuttle.seconds) < 3600);
      assert.equal(tieUp, undefined, `${boat} is swapping crew at ${shuttle.departureTime}, not finishing`);
    }
  }
});

// NY Waterway publishes one trip per origin-destination pair, so a boat calling at two terminals
// arrives as two trips leaving the same berth at the same minute and used to render as two boats.
test("a NY Waterway boat calling at several terminals is one row, not several", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true });
  const waterway = data.departures.filter((item) => item.routeId.startsWith("wtr:"));
  // The operator's map: green is one line calling at Paulus Hook and Liberty Harbor.
  const green = waterway.find((item) => item.departureTime === "06:15:00");
  assert.equal(green.destination, "Liberty Harbor");
  assert.deepEqual(green.via, ["Paulus Hook"]);
  assert.equal(waterway.filter((item) => item.departureTime === "06:15:00").length, 1);
  // Purple links Hoboken 14th St, Port Imperial and Edgewater to Pier 11.
  const purple = waterway.find((item) => item.departureTime === "07:51:00");
  assert.equal(purple.destination, "Edgewater");
  assert.deepEqual(purple.via, ["Hoboken (14th Street)", "Port Imperial"]);

  // Two boats that merely share a minute must stay two rows. At 6:35 one sails to Hoboken/NJ
  // Transit and another to South Amboy — both reach a terminal at 6:50, which no single boat can.
  const sixThirtyFive = waterway.filter((item) => item.departureTime === "06:35:00");
  assert.equal(sixThirtyFive.length, 2);
  assert.deepEqual(sixThirtyFive.map((item) => item.destination).sort(),
    ["Hoboken / NJ Transit Terminal", "South Amboy"]);
  // Port Liberte runs its own line to Pier 11 and is never folded into a neighbour.
  for (const item of waterway.filter((entry) => entry.destination === "Port Liberte")) {
    assert.deepEqual(item.via, []);
  }
});

// Pier C is where the boats sleep. No operator publishes it and no feed contains it, so its landing
// is virtual and everything on it comes from the crew schedule's shift starts.
test("Pier C shows every boat leaving the home port to start a shift", async () => {
  const data = await buildDisplayData({ landingNumber: 27 });
  assert.equal(data.meta.landing.displayName, "Pier C (Staff)");
  assert.ok(data.departures.length > 40);
  // The crew shuttles sail from here too, but they are a boat going to collect a crew rather than a
  // boat starting a shift, so they carry no vessel of their own and are checked separately below.
  const shiftStarts = data.departures.filter((item) => !item.crewShuttle);
  for (const item of shiftStarts) {
    // The operator says the home-port departure is not constant, so every row is approximate and
    // carries the time the boat is due at its first landing instead.
    assert.equal(item.approximate, true);
    assert.equal(item.fromHomePort, true);
    assert.ok(item.destination, "a home-port run needs somewhere to be going");
    assert.ok(Number.isInteger(item.boatAssignment));
    // Named so the board can show whichever vessel is currently on that working.
    assert.ok(item.predictTripId);
  }
  // The first boats out on a weekday are the Rockaway pair, due at Ferry Point Park and Rockaway
  // just after five.
  const first = shiftStarts.slice(0, 2)
    .map((item) => `${item.routeId}${item.boatAssignment} ${item.departureTime.slice(0, 5)} ${item.destination}`);
  assert.deepEqual(first, ["RS1 05:03 Ferry Point Park", "RS4 05:05 Rockaway"]);

  // A boat relieved mid-day never went home, so its afternoon shift is not a Pier C departure.
  // SB1 works both a weekday and a weekend, but leaves the home port once on each.
  for (const serviceId of new Set(data.departures.map((item) => item.serviceId))) {
    const swapped = data.departures.filter((item) =>
      item.serviceId === serviceId && item.routeId === "SB" && item.boatAssignment === 1);
    assert.ok(swapped.length <= 1, "SB1 swaps crew mid-day and stays on the water");
  }
});

// Every crew shuttle has to leave the home port before it can collect anyone, so Pier C is the one
// landing that sees all of them — outbound only, because the return is not a departure from here.
// Every shift boundary on the crew sheet is a real movement out of the home port, with one
// exception: a crew shuttle carries the relief out to the boat, so that boat never goes home. The
// shuttle config is the only record of which changeovers those are, so it is what decides — not the
// shape of the gap, which says nothing about whether a shuttle ran.
test("only a crew shuttle keeps a shift start off the Pier C board", async () => {
  const [pierC, crew] = await Promise.all([
    buildDisplayData({ landingNumber: 27 }),
    readFile(path.join(summerRoot, "config/crew-shuttles.json"), "utf8").then(JSON.parse)
  ]);
  const starts = pierC.departures.filter((item) => !item.crewShuttle);
  const departuresOf = (boat, serviceId) => starts.filter((item) =>
    `${item.routeId}${item.boatAssignment}` === boat && item.serviceId === serviceId);

  // Weekday: SB1 rides a shuttle at 13:30 and stays on the water, so it leaves Pier C once. AS3
  // changes crew at Pier 11 with six minutes between shifts and no shuttle against it, so both of
  // its shifts are departures — the short gap on its own is not evidence the boat stayed put.
  assert.equal(departuresOf("SB1", "1").length, 1, "SB1 is shuttled on a weekday");
  assert.equal(departuresOf("AS3", "1").length, 2, "AS3 has no weekday shuttle");
  const as3 = departuresOf("AS3", "1").map((item) => item.departureTime.slice(0, 5)).sort();
  assert.deepEqual(as3, ["06:22", "14:17"]);

  // Every boat named in a weekday shuttle leaves Pier C exactly once; every boat that changes crew
  // without one leaves twice.
  const shuttled = new Set(crew.shuttles.weekday.flatMap((entry) => entry.boats));
  for (const boat of shuttled) {
    assert.equal(departuresOf(boat, "1").length, 1, `${boat} rides the weekday shuttle`);
  }
  for (const boat of ["AS2", "ER2", "ER3", "ER6", "SG1", "SG2", "SG4"]) {
    assert.ok(!shuttled.has(boat), `${boat} has no weekday shuttle configured`);
    assert.equal(departuresOf(boat, "2").length + departuresOf(boat, "1").length >= 2, true,
      `${boat} changes crew with no shuttle, so both shifts leave Pier C`);
  }

  // The weekend shuttle list covers every changeover there is, so no weekend boat gains a second
  // departure — the rule and the board agree completely on a weekend.
  const weekendShuttled = new Set(crew.shuttles.weekend.flatMap((entry) => entry.boats));
  for (const boat of weekendShuttled) {
    assert.equal(departuresOf(boat, "2").length, 1, `${boat} rides the weekend shuttle`);
  }
});

// The Rocket has no readable column in the workbook: it is headed "RWY RKT" with no boat number and
// the note inside it is copied from RWSV 9, giving Pier 11 times for a boat that runs between Long
// Island City and Rockaway and never calls at Pier 11. Its note is supplied by hand instead, and it
// was the one boat working a weekend that never left the home port on the board.
test("the Rockaway Rocket leaves Pier C like every other weekend boat", async () => {
  const [pierC, shiftFile] = await Promise.all([
    buildDisplayData({ landingNumber: 27 }),
    readFile(path.join(summerRoot, "content/boat-shifts.json"), "utf8").then(JSON.parse)
  ]);

  const rocket = shiftFile.shifts.weekend.RR1;
  assert.equal(rocket?.length, 1, "the Rocket works one weekend shift");
  assert.equal(rocket[0].startTime, "09:30");
  assert.equal(rocket[0].startPlace, "Long Island City");
  // "Last drop off 17:30 at Long Island City" names the leg by when the boat let go of Rockaway and
  // where it was heading. The crew finishes when that leg does, which the feed puts at 18:46, and
  // the noted time is kept beside it.
  assert.equal(rocket[0].endTime, "18:46");
  assert.equal(rocket[0].endPlace, "Long Island City");
  assert.equal(rocket[0].endNoteTime, "17:30");
  assert.match(rocket[0].source, /supplied by hand/);

  const departure = pierC.departures.find((item) =>
    item.serviceId === "2" && !item.crewShuttle && `${item.routeId}${item.boatAssignment}` === "RR1");
  assert.ok(departure, "the Rocket leaves Pier C on a weekend");
  assert.equal(departure.departureTime.slice(0, 5), "09:30");
  assert.equal(departure.destination, "Long Island City");
});

// The weekday needed eight rows restored; the weekend needed none, because every changeover there
// already has a shuttle against it. That is worth holding still: it is the evidence that the gap
// was in the weekday shuttle config rather than in the rule, and if a weekend shuttle is ever
// removed or a weekend boat gains a second shift, the board should change and this should say so.
test("every weekend shift start reaches Pier C unless a shuttle covers it", async () => {
  const [pierC, shiftFile, crew] = await Promise.all([
    buildDisplayData({ landingNumber: 27 }),
    readFile(path.join(summerRoot, "content/boat-shifts.json"), "utf8").then(JSON.parse),
    readFile(path.join(summerRoot, "config/crew-shuttles.json"), "utf8").then(JSON.parse)
  ]);
  const shifts = shiftFile.shifts.weekend;
  const shuttled = new Set(crew.shuttles.weekend.flatMap((entry) => entry.boats));
  const board = new Map();
  for (const item of pierC.departures.filter((row) => !row.crewShuttle && row.serviceId === "2")) {
    const boat = `${item.routeId}${item.boatAssignment}`;
    board.set(boat, [...(board.get(boat) || []), item.departureTime.slice(0, 5)].sort());
  }

  let expectedTotal = 0;
  for (const [boat, list] of Object.entries(shifts)) {
    const starts = list.map((item) => item.startTime);
    // The first shift of the day is always a departure - the boat spent the night at the home port.
    // A later one is a departure only where no shuttle brought the relief out to it.
    const expected = shuttled.has(boat) ? [starts[0]] : starts;
    expectedTotal += expected.length;
    assert.deepEqual(board.get(boat), [...expected].sort(), `${boat} on the weekend board`);
  }
  assert.equal(pierC.departures.filter((item) => !item.crewShuttle && item.serviceId === "2").length, expectedTotal);
  assert.equal([...board.keys()].every((boat) => boat in shifts), true, "no boat on the board is absent from the sheet");

  // Every weekend boat that works two shifts has a shuttle, which is why the weekend gained nothing
  // when the rule changed. A boat here with two shifts and no shuttle means the config has fallen
  // behind the sheet the way the weekday one had.
  const twoShifts = Object.entries(shifts).filter(([, list]) => list.length > 1).map(([boat]) => boat);
  assert.ok(twoShifts.length >= 16);
  assert.deepEqual(twoShifts.filter((boat) => !shuttled.has(boat)), [],
    "a weekend changeover with no shuttle against it - add it to config/crew-shuttles.json");
});

// Two shift notes name the far end of the boat's last leg as the place it finished — "last drop
// 20:02 at E 34th" for a trip that leaves East 34th at 19:26 and reaches Pier 11 at 20:02. Matching
// place and time together discarded both shifts whole, and with them a start time the feed agreed
// with to the second, so their afternoon Pier C departures went missing from the board.
test("a shift note that names the wrong end still yields its Pier C departure", async () => {
  const shifts = await readFile(path.join(summerRoot, "content/boat-shifts.json"), "utf8").then(JSON.parse);

  const er1 = shifts.shifts.weekday.ER1.find((item) => item.startTime === "15:46");
  assert.ok(er1, "ER1 works a weekday afternoon shift out of Pier 11");
  assert.equal(er1.endTime, "20:02");
  // The feed's place is stored and the crew's own wording is kept beside it, because the note is
  // the record of what was written and this is the field it got wrong.
  assert.equal(er1.endPlace, "Wall St/Pier 11");
  assert.equal(er1.endNotePlace, "East 34th Street");

  const er5 = shifts.shifts.weekend.ER5.find((item) => item.startTime === "10:32");
  assert.ok(er5, "ER5 works a weekend shift out of Pier 11");
  assert.equal(er5.endPlace, "East 34th Street");
  assert.equal(er5.endNotePlace, "Wall St/Pier 11");

  // Both reach the board as home-port departures, which is the whole point of recovering them.
  const pierC = await buildDisplayData({ landingNumber: 27 });
  const at = (serviceId, time) => pierC.departures.find((item) =>
    item.serviceId === serviceId && item.departureTime.startsWith(time) && !item.crewShuttle);
  assert.ok(at("1", "15:46"), "ER1's afternoon shift start shows at Pier C on a weekday");
  assert.ok(at("2", "10:32"), "ER5's shift start shows at Pier C on a weekend");

  // SG4's weekend PM note is a stale copy of its weekday one (21:12 at Pier 79 is a weekday time),
  // and no weekend event matches it at any place, so it stays dropped rather than being rescued.
  assert.equal(shifts.shifts.weekend.SG4.length, 1);
});

test("Pier C shows every crew shuttle sailing out to collect a crew", async () => {
  const [pierC, config] = await Promise.all([
    buildDisplayData({ landingNumber: 27 }),
    readFile(path.join(summerRoot, "config/crew-shuttles.json"), "utf8").then(JSON.parse)
  ]);
  const shuttles = pierC.departures.filter((item) => item.crewShuttle);
  const configured = [...config.shuttles.weekday, ...config.shuttles.weekend];
  assert.equal(shuttles.length, configured.length, "one row per configured shuttle, no more and no fewer");
  assert.ok(pierC.routes.CREW, "the shuttles need their own route so no passenger route is implied");

  for (const item of shuttles) {
    assert.equal(item.stopId, "home-port", "the shuttle sails from the home port");
    assert.equal(item.routeId, "CREW");
    // The collecting landing shows a range because the shuttle waits there for boats to sail. The
    // far end of that range is the run back here, which is an arrival, so this side drops it.
    assert.equal(item.departureTimeEnd, null, `${item.tripId} should carry one time, not a range`);
    assert.equal(item.secondsEnd, null);
    // Same footing as a shift start: the configured time is when the shuttle is due at the other
    // end, and the operator does not publish when it lets go of Pier C.
    assert.equal(item.approximate, true);
    assert.equal(item.fromHomePort, true);
    assert.ok(item.crewBoats?.length, "a shuttle exists to collect the crews off named boats");
    assert.equal(item.boatAssignment, null, "the shuttle is not one of the boats it collects from");
  }

  // Destination is the landing it is going to — the mirror of the row at that landing, which reads
  // "Pier C". The weekend 14:35 collects four crews off Pier 11.
  const busiest = shuttles.find((item) => item.departureTime === "14:35:00");
  assert.equal(busiest.destination, "Pier 11");
  assert.deepEqual(busiest.crewBoats, ["ER3", "RS5", "RS2", "AS2"]);
  assert.equal(busiest.serviceId, "crew-weekend");

  // Weekday and weekend shuttles run on their own pair of calendars, because a holiday keeps the
  // feed on weekday service while the crews change on the weekend pattern.
  assert.deepEqual(
    new Set(shuttles.map((item) => item.serviceId)),
    new Set(["crew-weekday", "crew-weekend"])
  );

  // The other end of each shuttle still reads the same way at the landing it collects from.
  const pier11 = await buildDisplayData({ landingNumber: 16 });
  for (const item of pier11.departures.filter((row) => row.crewShuttle)) {
    assert.equal(item.destination, "Pier C");
    assert.ok(item.departureTimeEnd, "the collecting landing keeps its range");
  }
});

// Which of the other Manhattan terminals a NY Waterway boat calls at on the way.
//
// Route 77347 (South Amboy - Pier 11/Wall St) is the only waterway route that touches more than
// one of Pier 11, Brookfield Place and Pier 79, and it threads them in four different orders. Two
// departures from Pier 11 can both read "South Amboy" while only one calls at Brookfield Place, so
// the destination alone cannot answer whether a rider can get from here to there on this boat.
test("waterway departures name the Manhattan terminals they call at on the way", async () => {
  const [pier11, brookfield, pier79] = await Promise.all([
    buildDisplayData({ landingNumber: 16, waterwayEnabled: true }),
    buildDisplayData({ landingNumber: 25, waterwayEnabled: true }),
    buildDisplayData({ landingNumber: 26, waterwayEnabled: true })
  ]);
  const codes = (data) => data.departures
    .filter((item) => (item.viaTerminals || []).length)
    .map((item) => `${item.departureTime.slice(0, 5)} ${item.viaTerminals.map((terminal) => terminal.code).join("+")}`)
    .sort();

  // Every Pier 11 connector sailing runs by way of Brookfield Place; the two direct ones are
  // deliberately absent rather than badged.
  assert.deepEqual(codes(pier11), [
    "06:35 BPC", "07:40 BPC", "08:35 BPC", "09:35 BPC", "17:15 BPC", "18:15 BPC"
  ]);
  // The reverse, read from the other two terminals.
  assert.deepEqual(codes(brookfield), ["15:25 PIER 11", "16:25 PIER 11"]);
  assert.deepEqual(codes(pier79), ["15:10 BPC+PIER 11", "16:10 BPC+PIER 11"]);

  // Order follows the boat, not the alphabet: from Pier 79 it reaches Brookfield Place first.
  const [first] = pier79.departures.filter((item) => (item.viaTerminals || []).length);
  assert.deepEqual(first.viaTerminals.map((terminal) => terminal.code), ["BPC", "PIER 11"]);
  // The full name travels with the code, for the row's aria-label.
  assert.equal(first.viaTerminals[0].name, "Brookfield Place / Battery Park City");

  // A terminal is never listed as a "via" of itself, and never when it is the destination: the
  // 08:35 from Pier 11 finishes at Pier 79 and is badged for Brookfield Place only.
  const toPier79 = pier11.departures.find((item) => item.departureTime.startsWith("08:35") && item.destination.includes("39th"));
  assert.deepEqual(toPier79.viaTerminals.map((terminal) => terminal.code), ["BPC"]);

  // Nothing outside this route acquires the field's contents.
  for (const data of [pier11, brookfield, pier79]) {
    for (const item of data.departures.filter((row) => (row.viaTerminals || []).length)) {
      assert.equal(item.routeId, "wtr:77347");
    }
  }
});

// NYC Ferry's own rows never carry the field at all — the client tolerates its absence rather than
// the build stamping an empty array onto every departure in the system. Partner feeds all carry it
// because they share one code path, but only the waterway feed is configured with terminals to
// find, so for the others it is always empty.
test("only the waterway feed can produce a via-terminal list", async () => {
  const data = await buildDisplayData({ landingNumber: 16, waterwayEnabled: true, seastreakEnabled: true });
  const own = data.departures.filter((item) => !/^[a-z]+:/.test(String(item.routeId)));
  assert.ok(own.length > 0, "landing 16 has NYC Ferry departures");
  assert.ok(own.every((item) => item.viaTerminals === undefined), "NYC Ferry rows omit the field entirely");

  const otherPartners = data.departures.filter((item) => /^[a-z]+:/.test(String(item.routeId)) && !String(item.routeId).startsWith("wtr:"));
  assert.ok(otherPartners.every((item) => Array.isArray(item.viaTerminals) && item.viaTerminals.length === 0));
});

// A crew changeover with no shuttle is a real drop off, however short the gap looks.
//
// AS3's sheet has the AM crew finishing at 14:11 at Pier 11 and the PM crew starting there at
// 14:17. The feed shows no hole — trip 1018 gets in at 14:11 and trip 999 leaves at 14:17 — so the
// gap heuristic could never see it, and a rule that dismissed any same-place changeover under an
// hour dismissed this one too. But the sheet is the record of when a crew stops working, and the
// 13:20 out of East 90th St is the last trip that crew works: it takes nobody back.
test("a crew changeover with no shuttle is badged as a drop off", async () => {
  const east90th = await buildDisplayData({ landingNumber: 9 });
  const finalTrip = east90th.departures.find((item) => String(item.tripId) === "1018");
  assert.ok(finalTrip, "AS3's 13:20 from East 90th St must be on the board");
  assert.equal(finalTrip.boatAssignment, 3);
  assert.equal(finalTrip.routeId, "AS");
  assert.equal(finalTrip.endsShift, "certain", "the trip the AM crew finishes on is a drop off");

  // Every leg of it, so an agent watching the boat leave anywhere on that trip is told.
  const astoria = await buildDisplayData({ landingNumber: 2 });
  assert.equal(astoria.departures.find((item) => String(item.tripId) === "1018")?.endsShift, "certain");

  // And the boat leaves. A changeover is a swap, not a crew stepping aboard the boat already
  // alongside, so the vessel that finishes at 14:11 runs to Pier C — the six minutes to the 14:17
  // are two different boats, not one waiting.
  const pier11 = await buildDisplayData({ landingNumber: 16 });
  const homePortRuns = pier11.departures.filter((item) =>
    item.outOfService && item.routeId === "AS" && item.boatAssignment === 3 &&
    item.serviceId === "1" && item.seconds >= 13 * 3600 && item.seconds <= 15 * 3600);
  assert.equal(homePortRuns.length, 1, "AS3's 14:11 must be shown running to Pier C");
  assert.equal(homePortRuns[0].departureTime.slice(0, 5), "14:11");
  assert.equal(homePortRuns[0].destination, "Pier C");
  assert.equal(homePortRuns[0].endsDay, false, "the working carries on with another boat, so this is not the end of its day");

  // And the other half of the same rule still holds: the relieving crew's first departure.
  const pierC = await buildDisplayData({ landingNumber: 27 });
  assert.ok(pierC.departures.some((item) => item.tripId === "pierc:weekday:AS3:14:17"),
    "AS3's 14:17 shift start must still be a Pier C row");
});

// The exception, and the only one: a crew carried out to the boat. The relief steps aboard from the
// shuttle and the boat sails on with nobody put ashore, so there is no drop off to badge.
test("a crew changeover covered by a shuttle is not a drop off", async () => {
  const pier11 = await buildDisplayData({ landingNumber: 16 });
  const shuttled = pier11.departures.filter((item) =>
    item.routeId === "RS" && [1, 3, 4, 6].includes(item.boatAssignment) &&
    item.serviceId === "1" && item.endsShift && item.seconds >= 12 * 3600 && item.seconds <= 15 * 3600);
  assert.deepEqual(shuttled, [], "RS1/RS3/RS4/RS6 change crew by shuttle at midday and must not be badged");
});

// The two halves of the rule are computed in different places — the drop off from the boat's runs,
// the first departure from the shift sheet — so they are pinned together here. Every weekday
// changeover the sheet records produces both or neither, and which it is turns only on whether a
// shuttle is configured for that boat.
test("drop offs and Pier C first departures agree about every weekday changeover", async () => {
  const [shiftFile, crewFile, pierC] = await Promise.all([
    readFile(path.join(summerRoot, "content/boat-shifts.json"), "utf8").then(JSON.parse),
    readFile(path.join(summerRoot, "config/crew-shuttles.json"), "utf8").then(JSON.parse),
    buildDisplayData({ landingNumber: 27 })
  ]);
  const shuttled = new Set(crewFile.shuttles.weekday.flatMap((entry) => entry.boats));

  // Every trip badged as a drop off on a weekday, anywhere in the system, with the boat that works
  // it and the minute that trip ends.
  const badged = new Map();
  for (let landingNumber = 2; landingNumber <= 26; landingNumber += 1) {
    const data = await buildDisplayData({ landingNumber });
    for (const item of data.departures) {
      if (!item.endsShift || !Number.isInteger(item.boatAssignment) || item.serviceId !== "1") continue;
      badged.set(String(item.tripId), `${item.routeId}${item.boatAssignment}`);
    }
  }

  const standalone = [], covered = [];
  for (const [boat, list] of Object.entries(shiftFile.shifts.weekday)) {
    for (const [index, entry] of list.slice(0, -1).entries()) {
      const next = list[index + 1];
      if (entry.endPlace !== next.startPlace) continue;
      // Only the quick turns. A same-place changeover hours later is an ordinary break — the boat
      // really does go to Pier C and come back — and the gap heuristic always caught those. The
      // short ones are the population this rule is about and the ones that used to be dismissed.
      const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      if (minutes(next.startTime) - minutes(entry.endTime) > 60) continue;
      (shuttled.has(boat) ? covered : standalone).push({ boat, entry, next });
    }
  }
  // The bundled sheet: eight changeovers stand on their own, six are covered by a shuttle.
  assert.equal(standalone.length, 8);
  assert.equal(covered.length, 6);

  for (const { boat, next } of standalone) {
    assert.ok(
      pierC.departures.some((item) => item.tripId === `pierc:weekday:${boat}:${next.startTime}`),
      `${boat} has no shuttle; its ${next.startTime} shift start belongs on Pier C`
    );
  }
  for (const { boat, next } of covered) {
    assert.ok(
      !pierC.departures.some((item) => item.tripId === `pierc:weekday:${boat}:${next.startTime}`),
      `${boat} changes crew by shuttle; it must not start a shift from Pier C`
    );
  }

  // And the drop offs those eight changeovers produce, named by trip so that a boat's unrelated
  // end-of-day badge cannot stand in for the mid-day one this rule is about.
  const changeoverTrips = { AS2: "1017", AS3: "1018", ER2: "404", ER3: "330", ER6: "403", SG1: "758", SG2: "759", SG4: "929" };
  assert.deepEqual(standalone.map((item) => item.boat).sort(), Object.keys(changeoverTrips).sort());
  for (const [boat, tripId] of Object.entries(changeoverTrips)) {
    assert.equal(badged.get(tripId), boat, `${boat}'s changeover trip ${tripId} must be badged as a drop off`);
  }
  // The shuttled six contribute no mid-day drop off of their own.
  for (const { boat } of covered) {
    const midday = [...badged].filter(([, name]) => name === boat).length;
    assert.ok(midday <= 1, `${boat} should carry only its end-of-day badge, found ${midday}`);
  }

  // Each of the eight also runs to the home port, at the minute its shift sheet ends. Both halves
  // of a swap are on the board: this boat going in, and its relief coming out of Pier C.
  const homePortRuns = new Map();
  for (let landingNumber = 2; landingNumber <= 26; landingNumber += 1) {
    const data = await buildDisplayData({ landingNumber });
    for (const item of data.departures) {
      if (!item.outOfService || item.serviceId !== "1" || !Number.isInteger(item.boatAssignment)) continue;
      homePortRuns.set(`${item.routeId}${item.boatAssignment}|${item.departureTime.slice(0, 5)}`, item);
    }
  }
  for (const { boat, entry } of standalone) {
    const run = homePortRuns.get(`${boat}|${entry.endTime}`);
    assert.ok(run, `${boat} must run to the home port when its shift ends at ${entry.endTime}`);
    assert.equal(run.destination, "Pier C");
    assert.equal(run.endsDay, false, `${boat}'s working continues with another boat, so ${entry.endTime} is not the end of its day`);
  }
});

// The Trust for Governors Island runs its own Brooklyn boats to the island, on its own piers, and
// its whole network sits inside NYC Ferry's: all three of its stops are places NYC Ferry also
// serves. So every one of them must be attached to a landing.
//
// Landing 11 was the one that was not. Both shore ends were wired up and the island itself was not,
// which meant the sixteen sailings a day *off* the island — the ones you need when you are standing
// on it and want to leave — appeared nowhere on the board.
test("every stop in the Trust's feed is attached to a landing", async () => {
  const [landings, stopsRaw] = await Promise.all([
    readFile(path.join(summerRoot, "config/landings.json"), "utf8").then(JSON.parse),
    readFile(path.join(summerRoot, "gtfs/gi/stops.txt"), "utf8")
  ]);
  const feedStops = parseCsv(stopsRaw).map((stop) => stop.stop_id);
  assert.deepEqual(feedStops.slice().sort(), ["bmb", "govisland", "pier6", "redhook", "soissons"]);

  const claimed = new Map();
  for (const [number, landing] of Object.entries(landings)) {
    for (const stopId of landing.giStopIds || []) {
      assert.ok(!claimed.has(stopId), `${stopId} is claimed by both landing ${claimed.get(stopId)} and ${number}`);
      claimed.set(stopId, number);
    }
  }
  for (const stopId of feedStops) {
    assert.ok(claimed.has(stopId), `no landing claims the Trust's "${stopId}" stop, so its boats are invisible there`);
  }
  // The island itself, which is the one that was missed.
  assert.equal(claimed.get("govisland"), "11");
  // The island has two piers and they are a walk apart, so each is its own landing: the Brooklyn
  // boats and NYC Ferry berth at Yankee Pier, the Manhattan boat at Soissons Landing. A single
  // island landing claiming both would put a boat on a board it does not call at.
  assert.equal(claimed.get("soissons"), "29");
  assert.equal(claimed.get("bmb"), "28");
});

// Both directions of the Trust's service, counted against the transcribed timetable: seven sailings
// from each shore pier plus two end-of-day runs that carry nobody outbound, and eight back from the
// island on each line.
test("the Trust's boats show at the island as well as at both shore piers", async () => {
  const [island, pier6, redHook] = await Promise.all([
    buildDisplayData({ landingNumber: 11 }),
    buildDisplayData({ landingNumber: 3 }),
    buildDisplayData({ landingNumber: 17 })
  ]);
  const trust = (data) => data.departures.filter((item) => String(item.routeId).startsWith("gi:"));

  assert.equal(island.meta.gi.enabled, true, "the Governors Island landing must read the Trust's feed");
  assert.deepEqual(island.meta.gi.stopIds, ["govisland"]);
  assert.equal(trust(island).length, 16, "eight off the island on each of the two lines");
  // Leaving the island means going to one of the two Brooklyn piers, never to the island itself.
  const destinations = [...new Set(trust(island).map((item) => item.destination))].sort();
  assert.deepEqual(destinations, ["Brooklyn Bridge Park / Pier 6", "Red Hook / Atlantic Basin"]);
  for (const item of trust(island)) {
    assert.equal(item.operator, "The Trust for Governors Island");
    assert.equal(item.mode, "ferry");
  }

  // The shore ends are unchanged, and from there the boats run to the island.
  assert.equal(trust(pier6).length, 9);
  assert.equal(trust(redHook).length, 9);
  // The pier is named, not just the island: the Trust's Manhattan boat ties up at Soissons Landing
  // on the other side of it, so a row reading only "Governors Island" would not say which.
  for (const item of [...trust(pier6), ...trust(redHook)]) {
    assert.equal(item.destination, "Governors Island / Yankee Pier");
  }

  // NYC Ferry's own South Brooklyn boats also call at the island and are a different operator's
  // service on different piers; adding the Trust must not have disturbed them.
  assert.ok(island.departures.some((item) => item.routeId === "SB"));
  assert.equal(island.departures.some((item) => item.routeId === "GI" && String(item.routeId).startsWith("gi:")), false);
});

// Whitehall and Soissons Landing: two real docks the home agency does not call at.
//
// Every landing before these was an NYC Ferry stop with partners alongside it, so the build could
// assume a stop id existed and read the landing's position off its stops.txt row. These have no
// NYC Ferry stop at all — the Staten Island Ferry, Seastreak and the Trust's Manhattan boat berth
// at Whitehall, and only the Trust's boat calls at Soissons — so they carry their own coordinates
// and are built entirely from partner feeds.
test("a landing NYC Ferry does not call at still builds from its partners", async () => {
  const [whitehall, soissons] = await Promise.all([
    buildDisplayData({ landingNumber: 28 }),
    buildDisplayData({ landingNumber: 29 })
  ]);

  // Position comes from config, because there is no feed row to take it from. Without it the
  // nearest-landing button would skip the landing entirely rather than send anyone to it.
  assert.equal(whitehall.meta.landing.latitude, 40.70136);
  assert.equal(whitehall.meta.landing.longitude, -74.012666);
  assert.deepEqual(whitehall.meta.landing.stopIds, []);
  assert.equal(soissons.meta.landing.latitude, 40.6893);

  // Nothing here belongs to the home agency: every row is a partner's, and no NYC Ferry route id
  // can appear on a board built from stops NYC Ferry does not have.
  for (const data of [whitehall, soissons]) {
    assert.ok(data.departures.length > 0);
    for (const item of data.departures) {
      assert.notEqual(item.operator, "NYC Ferry");
      assert.match(String(item.routeId), /^(sif|sea|gi|sta):/);
    }
  }

  const operators = [...new Set(whitehall.departures.map((item) => item.operator))].sort();
  assert.deepEqual(operators, ["Seastreak", "Staten Island Ferry", "Statue City Cruises", "The Trust for Governors Island"]);

  // The island end of the same crossing, and only that: NYC Ferry and the Brooklyn boats tie up at
  // Yankee Pier, which is landing 11, and must not appear here.
  assert.deepEqual([...new Set(soissons.departures.map((item) => item.operator))], ["The Trust for Governors Island"]);
  assert.deepEqual([...new Set(soissons.departures.map((item) => item.destination))], ["Battery Maritime Building"]);
});

test("a landing with no NYC Ferry stop and no coordinates is rejected rather than guessed at", async () => {
  // A real root, with only config/landings.json swapped: everything else is symlinked to this
  // repository's own files, so the build runs exactly as it does in production and the only thing
  // under test is the missing position.
  const root = await mkdtemp(path.join(tmpdir(), "did-landing-"));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const name of ["gtfs", "content", "public"]) await symlink(path.join(repo, name), path.join(root, name));
  await mkdir(path.join(root, "config"));
  for (const name of ["display.json", "crew-shuttles.json"]) {
    await symlink(path.join(repo, "config", name), path.join(root, "config", name));
  }
  const landings = JSON.parse(await readFile(path.join(repo, "config/landings.json"), "utf8"));
  delete landings["28"].latitude;
  delete landings["28"].longitude;
  await writeFile(path.join(root, "config/landings.json"), JSON.stringify(landings), "utf8");

  await assert.rejects(
    () => buildDisplayData({ root, landingNumber: 28 }),
    /must give it a latitude and longitude/
  );
  // The same root builds the landing fine once the position is there, so the rejection is about
  // the missing coordinates and not about the fixture.
  await writeFile(path.join(root, "config/landings.json"), await readFile(path.join(repo, "config/landings.json"), "utf8"), "utf8");
  const data = await buildDisplayData({ root, landingNumber: 28 });
  assert.equal(data.meta.landing.latitude, 40.70136);
});

// NYC DOT publishes the Staten Island Ferry under the department's legal name, which is not what
// anyone at the terminal calls it and would fill the operator filter with it.
test("the Staten Island Ferry is labelled by its own name, not its publisher's", async () => {
  const data = await buildDisplayData({ landingNumber: 28 });
  const siferry = data.departures.filter((item) => String(item.routeId).startsWith("sif:"));
  assert.ok(siferry.length > 0);
  for (const item of siferry) {
    assert.equal(item.operator, "Staten Island Ferry");
    assert.equal(item.mode, "ferry");
    // The feed leaves every trip_headsign empty, so the destination falls through to the trip's
    // final stop — which is what the terminal's own signage says.
    assert.equal(item.destination, "St. George Ferry Terminal");
  }
  assert.equal(data.meta.siferry.enabled, true);
  assert.deepEqual(data.meta.siferry.stopIds, ["whitehall"]);
});

// St. George is the other end of the Whitehall crossing, so it reads the same feed from the other
// side. It is also where that feed's one defect shows up.
test("St. George shows the Staten Island Ferry, and never a boat sailing to itself", async () => {
  const data = await buildDisplayData({ landingNumber: 22 });
  const siferry = data.departures.filter((item) => String(item.routeId).startsWith("sif:"));
  assert.ok(siferry.length > 0);
  assert.deepEqual(data.meta.siferry.stopIds, ["stgeorge"]);
  // Everything leaving St. George is bound for Whitehall; there is nowhere else on the route.
  for (const item of siferry) {
    assert.equal(item.operator, "Staten Island Ferry");
    assert.equal(item.destination, "Whitehall Ferry Terminal");
  }
  // NYC Ferry still calls here and must be untouched by the partner arriving.
  assert.ok(data.departures.some((item) => item.operator === "NYC Ferry"));

  // The feed carries fifteen trips that leave St. George and arrive at St. George twenty-five
  // minutes later — the Whitehall crossing with the wrong stop id on the far end. They sit on the
  // dormant "threeboat" service, so nothing renders them today, but the feed is a drop-in download
  // and the guard has to hold whatever a fresh one turns on.
  const raw = await readFile(path.join(summerRoot, "gtfs/siferry/stop_times.txt"), "utf8");
  const byTrip = new Map();
  for (const row of parseCsv(raw)) byTrip.set(row.trip_id, [...(byTrip.get(row.trip_id) || []), row]);
  const degenerate = [...byTrip.values()].filter((times) => new Set(times.map((item) => item.stop_id)).size === 1);
  assert.equal(degenerate.length, 15, "the upstream defect this guard exists for is still in the bundled feed");
  for (const item of data.departures) {
    assert.notEqual(item.destination, "St. George Ferry Terminal");
  }
});

// The Statue of Liberty boats run loops, which is the one thing about this feed that needs care:
// a loop's last stop is also its first, so the usual "destination is the trip's final stop"
// fallback would tell someone boarding at Battery Park that the boat is bound for Battery Park.
test("the Statue of Liberty loops name the island they are bound for, not where they started", async () => {
  const [whitehall, liberty, ellis] = await Promise.all([
    buildDisplayData({ landingNumber: 28 }),
    buildDisplayData({ landingNumber: 30 }),
    buildDisplayData({ landingNumber: 31 })
  ]);
  const statue = (data) => data.departures.filter((item) => String(item.routeId).startsWith("sta:"));

  // Battery Park shares landing 28 with the Whitehall terminal, a couple of hundred metres away.
  assert.ok(statue(whitehall).length > 0);
  assert.deepEqual([...new Set(statue(whitehall).map((item) => item.destination))], ["Liberty Island"]);

  // The islands are landings of their own, and every boat leaving them is going somewhere else.
  // "here" is the island as the NPS feed names it, not as config/landings.json labels the landing:
  // the destination on a row comes from the feed, and a board's display name is free to change
  // without that meaning anything about which boat goes where.
  for (const [data, number, here] of [[liberty, 30, "Liberty Island"], [ellis, 31, "Ellis Island"]]) {
    assert.ok(statue(data).length > 0);
    assert.equal(data.meta.landingNumber, number);
    for (const item of statue(data)) {
      assert.equal(item.operator, "Statue City Cruises");
      assert.notEqual(item.destination, here, "a loop must never advertise a boat to the pier it leaves from");
    }
  }

  // NPS spells Liberty State Park correctly on sixteen calls and "Libery State Park" on one. The
  // correction is a spelling fix to a destination label and nothing else.
  const raw = await readFile(path.join(summerRoot, "gtfs/statue/stop_times.txt"), "utf8");
  assert.ok(parseCsv(raw).some((row) => row.stop_headsign === "Libery State Park"),
    "the upstream misspelling this correction exists for is still in the bundled feed");
  for (const data of [liberty, ellis]) {
    for (const item of statue(data)) assert.notEqual(item.destination, "Libery State Park");
  }
  assert.ok(statue(liberty).some((item) => item.destination === "Liberty State Park"));
});

// The switch a deployment cannot ship.
//
// config/display.json is the one file a deploy never overwrites, because it holds the box's own
// landingNumber. So an operator added in a release arrives with its switch missing from the live
// config, and a missing switch read as false hid the new operator on the very deploy that shipped
// it — silently, with the landings present and the boats absent.
test("an operator whose switch is missing from display.json is on, not off", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "did-switch-"));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const name of ["gtfs", "content", "public"]) await symlink(path.join(repo, name), path.join(root, name));
  await mkdir(path.join(root, "config"));
  for (const name of ["landings.json", "crew-shuttles.json"]) {
    await symlink(path.join(repo, "config", name), path.join(root, "config", name));
  }
  const display = JSON.parse(await readFile(path.join(repo, "config/display.json"), "utf8"));
  // A live box that has never heard of these two, which is exactly what the drift looks like.
  delete display.statueEnabled;
  delete display.siferryEnabled;
  await writeFile(path.join(root, "config/display.json"), JSON.stringify(display), "utf8");

  const liberty = await buildDisplayData({ root, landingNumber: 30 });
  assert.equal(liberty.meta.statue.enabled, true);
  assert.ok(liberty.departures.length > 0, "Liberty Island must not deploy as an empty board");

  const whitehall = await buildDisplayData({ root, landingNumber: 28 });
  assert.equal(whitehall.meta.siferry.enabled, true);

  // Off still means off: the switch has to say so rather than be left out.
  await writeFile(path.join(root, "config/display.json"), JSON.stringify({ ...display, statueEnabled: false }), "utf8");
  const disabled = await buildDisplayData({ root, landingNumber: 30 });
  assert.equal(disabled.meta.statue.enabled, false);
  assert.equal(disabled.departures.length, 0);

  // And an operator no landing has stop ids for stays off regardless, which is what actually
  // decides where an operator appears.
  const astoria = await buildDisplayData({ root, landingNumber: 2 });
  assert.equal(astoria.meta.statue.enabled, false);
  assert.equal(astoria.meta.seastreak.enabled, false);
});
