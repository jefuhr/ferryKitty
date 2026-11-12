// Failure modes: malformed catalogs, unnamed/duplicate entries, invalid coordinates or stop ids,
// duplicated piers, lost board identities/aliases, input mutation, bus-stop contamination,
// incomplete feed aliases, invented positions, and terminals too close to an AIS box edge.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harborLandings, loadHarborTerminals } from "../lib/harbor-terminals.js";
import { HARBOR_BOUNDING_BOXES } from "../lib/ais-stream.js";
import { distanceMetres } from "../lib/harbor-geo.js";
import { landingChoices, loadAllLandingData } from "../lib/landing-data.js";
import { parseCsv, PARTNER_FEEDS } from "../lib/schedule-builder.js";

const catalogPath = new URL("../config/harbor-terminals.json", import.meta.url);
const terminal = { id: "nj-test", name: "Test Terminal", town: "Test Town", state: "NJ", latitude: 40.6, longitude: -74.1, stopIds: ["wtr:test", "sea:test"] };
const expectedStops = {
  "nj-edgewater": ["wtr:2439136"], "nj-port-imperial": ["wtr:2439137"],
  "nj-lincoln-harbor": ["wtr:2439138"], "nj-hoboken-14th-street": ["wtr:2439139"],
  "nj-hoboken-terminal": ["wtr:2439140"], "nj-paulus-hook": ["wtr:2439141", "wbf:2439141"],
  "nj-liberty-harbor": ["wtr:2439142"], "nj-port-liberte": ["wtr:2439143"],
  "nj-south-amboy": ["wtr:4251907"], "nj-belford": ["wbf:belford"],
  "nj-highlands": ["sea:176"], "nj-atlantic-highlands": ["sea:175"],
  "nj-liberty-landing-marina": ["lib:2557120"], "nj-warren-street": ["lib:2557121"],
  "nj-liberty-state-park": ["sta:LSP"], "ny-ikea-red-hook": ["ike:ikea"],
  "ny-st-george-ferry-terminal": ["sif:stgeorge"], "ny-whitehall-ferry-terminal": ["sif:whitehall"]
};

test("the loader returns the terminal array and names each invalid entry", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harbor-terminals-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, "terminals.json");
  await writeFile(file, JSON.stringify({ terminals: [terminal] }));
  assert.deepEqual(await loadHarborTerminals(file), [terminal]);
  const invalid = [
    [{ ...terminal, latitude: null }, /nj-test.*latitude/],
    [{ ...terminal, latitude: "40.6" }, /nj-test.*latitude/],
    [{ ...terminal, latitude: 91 }, /nj-test.*latitude/],
    [{ ...terminal, longitude: 1e309 }, /nj-test.*longitude/],
    [{ ...terminal, longitude: -181 }, /nj-test.*longitude/],
    [{ ...terminal, stopIds: [] }, /nj-test.*stopIds/],
    [{ ...terminal, stopIds: [""] }, /nj-test.*stopIds/],
    [{ ...terminal, stopIds: ["   "] }, /nj-test.*stopIds/],
    [{ ...terminal, stopIds: [123] }, /nj-test.*stopIds/],
    [{ ...terminal, name: "" }, /nj-test.*name/],
    [{ ...terminal, id: "" }, /entry 0.*id/],
    [null, /entry 0/]
  ];
  for (const [entry, error] of invalid) {
    await writeFile(file, JSON.stringify({ terminals: [entry] }));
    await assert.rejects(loadHarborTerminals(file), error);
  }
  await writeFile(file, JSON.stringify({ terminals: [terminal, terminal] }));
  await assert.rejects(loadHarborTerminals(file), /nj-test.*duplicate id/);
  await writeFile(file, "{}");
  await assert.rejects(loadHarborTerminals(file), /terminals.*array/);
  await writeFile(file, "{broken");
  await assert.rejects(loadHarborTerminals(file), /terminals\.json.*JSON/);
});

test("overlap uses every board alias, preserves the board row, and appends unique terminal ids", () => {
  const board = { landingStopId: "87", landingId: 16, name: "Board Pier", latitude: 40.7, longitude: -74,
    stopIds: ["87", "wtr:test", "87"] };
  const inputs = { boardLandings: [board], terminals: [terminal] };
  const before = structuredClone(inputs);
  const result = harborLandings(inputs);
  assert.deepEqual(result.landings, [{ landingStopId: "87", landingId: 16, name: "Board Pier", latitude: 40.7, longitude: -74 }]);
  assert.deepEqual(result.stopIdsOfLanding, new Map([["87", ["87", "wtr:test", "sea:test"]]]));
  assert.deepEqual(inputs, before);
});

test("a standalone terminal has its first stop id and no board id; board aliases are optional", () => {
  const board = { landingStopId: "87", landingId: 16, name: "Board Pier", latitude: 40.7, longitude: -74 };
  const result = harborLandings({ boardLandings: [board], terminals: [terminal] });
  assert.deepEqual(result.landings, [board, { landingStopId: "wtr:test", landingId: null, name: terminal.name, latitude: terminal.latitude, longitude: terminal.longitude }]);
  assert.deepEqual(result.stopIdsOfLanding, new Map([["87", ["87"]], ["wtr:test", terminal.stopIds]]));
  assert.deepEqual(harborLandings({ boardLandings: [board], terminals: [{ ...terminal, stopIds: ["87", "sea:test"] }] }).stopIdsOfLanding.get("87"), ["87", "sea:test"]);
});

test("every existing board landing retains its canonical stop id, board id, and aliases", async () => {
  const configured = JSON.parse(await readFile(new URL("../config/landings.json", import.meta.url), "utf8"));
  const data = await loadAllLandingData({ choices: landingChoices(configured), logger: { warn() {} } });
  assert.equal(data.failures.size, 0);
  const boardLandings = data.available.flatMap((landing) => {
    const config = configured[String(landing.id)];
    const stopIds = [...(config.stopIds || []).map(String),
      ...Object.values(PARTNER_FEEDS).flatMap(feed => (config[feed.stopIdsKey] || []).map(id => `${feed.prefix}${id}`))];
    if (!stopIds.length || !Number.isFinite(landing.latitude) || !Number.isFinite(landing.longitude)) return [];
    return [{ landingStopId: stopIds[0], landingId: landing.id, name: landing.displayName || landing.name, latitude: landing.latitude, longitude: landing.longitude, stopIds }];
  });
  assert.equal(boardLandings.length, 31);
  const terminals = await loadHarborTerminals(catalogPath);
  const ownBerthStops = new Set(terminals.filter(row => row.berth).flatMap(row => row.stopIds));
  const result = harborLandings({ boardLandings, terminals });
  for (const { stopIds, ...landing } of boardLandings) {
    assert.deepEqual(result.landings.find(row => row.landingId === landing.landingId), landing);
    // A terminal with its own berth takes its stop ids with it; everything else stays an alias.
    assert.deepEqual(result.stopIdsOfLanding.get(landing.landingStopId), stopIds.filter(id => !ownBerthStops.has(id) || id === landing.landingStopId));
  }
  for (const terminal of terminals.filter(row => row.berth)) {
    const own = result.landings.find(row => row.landingStopId === terminal.stopIds[0]);
    const board = boardLandings.find(row => row.stopIds.includes(terminal.stopIds[0]));
    assert.ok(own && board, terminal.id);
    assert.equal(own.landingId, board.landingId, `${terminal.id} keeps its board landing id`);
    assert.deepEqual(result.stopIdsOfLanding.get(own.landingStopId), terminal.stopIds);
  }
});

test("all eighteen terminals use complete ferry-only GTFS stop ids and a bundled stop coordinate", async () => {
  const terminals = await loadHarborTerminals(catalogPath);
  assert.deepEqual(Object.fromEntries(terminals.map(row => [row.id, row.stopIds])), expectedStops);
  const ferryStops = new Map();
  for (const id of ["waterway", "waterwayBelford", "seastreak", "liberty", "statue", "ikea", "siferry"]) {
    const feed = PARTNER_FEEDS[id];
    const table = async name => parseCsv(await readFile(new URL(`../${feed.directory}/${name}.txt`, import.meta.url), "utf8"));
    const routes = new Set((await table("routes")).filter(row => row.route_type === "4" || feed.ferryRouteIds?.has(row.route_id)).map(row => row.route_id));
    const trips = new Set((await table("trips")).filter(row => routes.has(row.route_id)).map(row => row.trip_id));
    const stopIds = new Set((await table("stop_times")).filter(row => trips.has(row.trip_id)).map(row => row.stop_id));
    for (const stop of await table("stops")) if (stopIds.has(stop.stop_id)) ferryStops.set(`${feed.prefix}${stop.stop_id}`, { latitude: Number(stop.stop_lat), longitude: Number(stop.stop_lon) });
  }
  for (const row of terminals) {
    assert.ok(row.stopIds.every(id => ferryStops.has(id)), row.id);
    assert.deepEqual({ latitude: row.latitude, longitude: row.longitude }, ferryStops.get(row.stopIds[0]), row.id);
    // A berth is where the boats were seen to lie, so it stays close to the published stop.
    if (row.berth) assert.ok(distanceMetres(row, row.berth) <= 400 && row.berth.radiusMetres >= 120, `${row.id} berth`);
  }
});

test("a terminal with its own berth becomes its own landing at the berth and leaves the board pier's aliases", () => {
  // Failure modes: the berth is ignored because a board pier already answers to the stop id, the
  // board pier keeps the stop id so both claim the same timetable, the board identity is lost.
  const board = { landingStopId: "87", landingId: 16, name: "Board Pier", latitude: 40.7, longitude: -74, stopIds: ["87", "wtr:test", "sif:big"] };
  const big = { id: "ny-big", name: "Big Ferry Terminal", town: "Test", state: "NY", latitude: 40.7001, longitude: -74.0001, stopIds: ["sif:big"],
    berth: { latitude: 40.6985, longitude: -74.0005, radiusMetres: 180 } };
  const inputs = { boardLandings: [board], terminals: [terminal, big] };
  const before = structuredClone(inputs);
  const result = harborLandings(inputs);
  assert.deepEqual(result.landings, [
    { landingStopId: "87", landingId: 16, name: "Board Pier", latitude: 40.7, longitude: -74 },
    { landingStopId: "sif:big", landingId: 16, name: "Big Ferry Terminal", latitude: 40.6985, longitude: -74.0005, radiusMetres: 180 }
  ]);
  assert.deepEqual(result.stopIdsOfLanding, new Map([["87", ["87", "wtr:test", "sea:test"]], ["sif:big", ["sif:big"]]]));
  assert.deepEqual(inputs, before);
  // With no board pier it is simply a standalone terminal at its berth.
  assert.deepEqual(harborLandings({ boardLandings: [], terminals: [big] }).landings,
    [{ landingStopId: "sif:big", landingId: null, name: "Big Ferry Terminal", latitude: 40.6985, longitude: -74.0005, radiusMetres: 180 }]);
});

test("the loader refuses a berth without a usable position or radius", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harbor-terminals-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, "terminals.json");
  const berth = { latitude: 40.6, longitude: -74.1, radiusMetres: 180 };
  await writeFile(file, JSON.stringify({ terminals: [{ ...terminal, berth }] }));
  assert.deepEqual((await loadHarborTerminals(file))[0].berth, berth);
  for (const bad of [{ ...berth, latitude: 91 }, { ...berth, longitude: "x" }, { ...berth, radiusMetres: 0 }, { ...berth, radiusMetres: 1001 }, { ...berth, radiusMetres: null }, "here", []]) {
    await writeFile(file, JSON.stringify({ terminals: [{ ...terminal, berth: bad }] }));
    await assert.rejects(loadHarborTerminals(file), /nj-test.*berth/);
  }
});

test("every catalog terminal is at least two kilometres inside the single AIS bounding box", async () => {
  assert.equal(HARBOR_BOUNDING_BOXES.length, 1);
  const [[south, west], [north, east]] = HARBOR_BOUNDING_BOXES[0];
  for (const terminal of await loadHarborTerminals(catalogPath)) {
    const { latitude, longitude } = terminal;
    assert.ok(latitude > south && latitude < north && longitude > west && longitude < east, terminal.id);
    for (const edge of [{ latitude: south, longitude }, { latitude: north, longitude }, { latitude, longitude: west }, { latitude, longitude: east }]) {
      assert.ok(distanceMetres(terminal, edge) >= 2000, `${terminal.id} needs 2 km clearance`);
    }
  }
});
