// End-to-end check of the harbor tracker: the real server process, fed by a fake AIS websocket and
// a fake copy of the operator's realtime feeds, asked the questions a client would ask.
//
// Nothing here leaves the machine. The slip file is written for the run from the public stop
// coordinate of Pier 11 plus invented offsets, so no real berth position is involved, and the
// server's runtime state goes to a temporary directory.
//
//   npm run test:harbor
//
// Leaves a record of what it saw in artifacts/harbor/e2e.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import GtfsRealtimeBindings from "gtfs-realtime-bindings";

import { offsetPoint } from "../lib/harbor-geo.js";
import { startFakeAisServer } from "../test/helpers/fake-ais-server.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACT = path.join(ROOT, "artifacts/harbor/e2e.json");
const MMSI = 367000101;
const TRIP = "E2E1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function until(label, check, { timeoutMs = 15_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
    await sleep(everyMs);
  }
}

const steps = [];
const record = (name, detail) => { steps.push({ name, at: new Date().toISOString(), ...detail }); console.log(`ok  ${name}`); };

const work = await mkdtemp(path.join(os.tmpdir(), "harbor-e2e-"));
const stops = (await readFile(path.join(ROOT, "gtfs/stops.txt"), "utf8")).split("\n").map((line) => line.split(","));
const pier = stops.find((row) => row[0] === "87");
assert.ok(pier, "the bundled feed still has stop 87");
const landing = { latitude: Number(pier.at(-3)), longitude: Number(pier.at(-2)) };
const pierName = pier.slice(2, -3).join(",").replace(/^"|"$/g, "");
// Two invented berths, 90 m apart, so the assignment is unambiguous.
const slipA = offsetPoint(landing, 0, 30), slipD = offsetPoint(landing, 180, 60);
const slipsCsv = path.join(work, "slips.csv");
await writeFile(slipsCsv, `landing,slip,latitude,longitude\n${pierName},Slip A1,${slipA.latitude},${slipA.longitude}\n${pierName},Slip D1,${slipD.latitude},${slipD.longitude}\n`);

const subscriptions = [];
const ais = await startFakeAisServer({ onSubscribe: (message) => subscriptions.push(message) });

// The operator's two feeds, built on request so their timestamps are always current.
const operator = http.createServer((request, response) => {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { gtfsRealtimeVersion: "2.0", timestamp: seconds };
  let message = null;
  if (request.url.startsWith("/tripupdate")) {
    message = { header, entity: [{ id: "1", tripUpdate: { trip: { tripId: TRIP }, vehicle: { id: "H101", label: "H101" }, stopTimeUpdate: [
      { stopSequence: 1, stopId: "87", arrival: { time: seconds - 60 }, departure: { time: seconds + 120 } },
      { stopSequence: 2, stopId: "20", arrival: { time: seconds + 600 } }] } }] };
  } else if (request.url.startsWith("/vehicleposition")) {
    message = { header, entity: [{ id: "v1", vehicle: { trip: { tripId: TRIP }, position: { latitude: slipA.latitude, longitude: slipA.longitude, speed: 0 },
      currentStopSequence: 1, vehicle: { id: "H101", label: "H101" }, timestamp: seconds } }] };
  }
  if (!message) { response.writeHead(404); response.end(); return; }
  const body = FeedMessage.encode(FeedMessage.fromObject(message)).finish();
  response.writeHead(200, { "Content-Type": "application/x-protobuf", "Content-Length": body.length });
  response.end(body);
});
await new Promise((resolve) => operator.listen(0, "127.0.0.1", resolve));
const feeds = `http://127.0.0.1:${operator.address().port}`;

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
let log = "";
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env,
  PORT: String(port), HOST: "127.0.0.1", STATE_DIR: path.join(work, "state"), HARBOR_SLIPS_CSV: slipsCsv,
  AISSTREAM_API_KEY: "e2e-key", AISSTREAM_URL: ais.url, AIS_REPLAY_PATH: "",
  NYCF_TRIP_UPDATES_URL: `${feeds}/tripupdate`, NYCF_VEHICLE_POSITIONS_URL: `${feeds}/vehicleposition`,
  NYCF_ALERTS_URL: `${feeds}/none`, NYCF_WEBSITE_ALERTS_URL: `${feeds}/none` } });
server.stdout.on("data", (chunk) => { log += chunk; });
server.stderr.on("data", (chunk) => { log += chunk; });

const getJson = async (pathname) => { const response = await fetch(origin + pathname); return { status: response.status, body: await response.json() }; };
const vessel = async () => (await getJson("/api/harbor/vessels")).body.vessels.find((item) => item.id === "waves-of-wonder");
const tripUpdate = async () => {
  const response = await fetch(`${origin}/gtfs-rt/tripupdate`);
  assert.equal(response.headers.get("content-type"), "application/x-protobuf");
  const feed = FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
  return feed.entity.find((entity) => entity.tripUpdate?.trip?.tripId === TRIP)?.tripUpdate.stopTimeUpdate[0];
};
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "000000 +0000 UTC");
const fix = (point, at, { sog, cog = 270, heading = 270, nav = 0 }) => ais.send({ MessageType: "PositionReport",
  MetaData: { MMSI, ShipName: "WAVES OF WONDER", latitude: point.latitude, longitude: point.longitude, time_utc: stamp(at) },
  Message: { PositionReport: { UserID: MMSI, Valid: true, Latitude: point.latitude, Longitude: point.longitude, Sog: sog, Cog: cog, TrueHeading: heading, NavigationalStatus: nav } } });

let failure = null;
try {
  await until("the server to answer", async () => (await fetch(`${origin}/healthz`)).ok, { timeoutMs: 30_000 });
  await until("the AIS subscription", () => subscriptions.length > 0);
  assert.equal(subscriptions[0].APIKey, "e2e-key");
  assert.ok(Array.isArray(subscriptions[0].BoundingBoxes) && subscriptions[0].BoundingBoxes.length > 0);
  assert.ok(subscriptions[0].FilterMessageTypes.includes("PositionReport"));
  record("server started and subscribed to AIS", { boundingBoxes: subscriptions[0].BoundingBoxes });

  const before = await getJson("/api/harbor/vessels");
  assert.equal(before.status, 200);
  assert.equal(before.body.available, true);
  assert.equal(before.body.sources.ais.connected, true);
  // AIS has said nothing yet, so the one boat the operator's feed reports is placed from that feed
  // and every other rostered boat is listed as unknown.
  const early = before.body.vessels.find((item) => item.id === "waves-of-wonder");
  assert.equal(early.positionSource, "operator");
  assert.equal(early.mmsi, null);
  assert.equal(early.tripId, TRIP);
  assert.equal(before.body.sources.nycFerry.available, true);
  assert.ok(before.body.vessels.filter((item) => item.state === "unknown").length >= 30);
  record("before any AIS fix: roster listed, operator feed fills in", { vessels: before.body.vessels.length, positionSource: early.positionSource });

  // The boat announces itself by name, runs in from 600 m east, and stops in Slip A1.
  ais.send({ MessageType: "ShipStaticData", MetaData: { MMSI }, Message: { ShipStaticData: { UserID: MMSI, Valid: true,
    Name: "WAVES OF WONDER@@@@@", CallSign: "WDE2E01", Type: 60, ImoNumber: 0, Dimension: { A: 12, B: 14, C: 4, D: 4 } } } });
  const start = Date.now() - 200_000;
  for (let step = 0; step <= 12; step += 1) fix(offsetPoint(slipA, 90, 600 - step * 48), start + step * 10_000, { sog: step > 9 ? 4 : 9 });
  for (const [index, ago] of [60_000, 40_000, 20_000, 1000].entries()) fix(offsetPoint(slipA, 45 * index, 2), Date.now() - ago, { sog: 0.1, cog: 360, heading: 268, nav: 5 });

  const docked = await until("the vessel to dock", async () => { const item = await vessel(); return item?.state === "docked" && item.tripId ? item : null; });
  assert.equal(docked.mmsi, String(MMSI));
  assert.equal(docked.identitySource, "ais-name");
  assert.equal(docked.positionSource, "ais");
  assert.equal(docked.status, "stopped");
  assert.equal(docked.landing.stopId, "87");
  assert.equal(docked.landing.id, 16);
  assert.equal(docked.slip.id, "NYCF_87_A1");
  assert.ok(docked.slip.confidence >= 0.8);
  assert.equal(docked.slipAmbiguous, false);
  assert.equal(docked.tripId, TRIP);
  assert.equal(docked.tripSource, "operator-rt");
  record("vessel docked in the right slip on the operator's trip", { state: docked.state, landing: docked.landing, slip: docked.slip, tripId: docked.tripId, identitySource: docked.identitySource });

  const catalog = await getJson("/api/slips");
  assert.deepEqual(catalog.body.slips.map((slip) => slip.id), ["NYCF_87_A1", "NYCF_87_D1"]);
  assert.deepEqual(Object.keys(catalog.body.slips[0]).sort(), ["id", "landingStopId", "name", "platformCode"]);
  const everything = JSON.stringify(catalog.body) + JSON.stringify({ ...(await getJson("/api/harbor/vessels")).body, vessels: [] });
  for (const value of [slipA.latitude, slipA.longitude, slipD.latitude, slipD.longitude]) assert.ok(!everything.includes(String(value).slice(0, 9)), "a slip coordinate leaked");
  record("slip catalog in the Ferry RT shape, without coordinates", { slips: catalog.body.slips });

  const tagged = await until("the trip update to name the slip", async () => { const call = await tripUpdate(); return call?.stopId === "NYCF_87_A1" ? call : null; });
  assert.equal(tagged.stopTimeProperties.assignedStopId, "NYCF_87_A1");
  record("trip update carries the slip in both fields", { stopId: tagged.stopId, assignedStopId: tagged.stopTimeProperties.assignedStopId });

  // The boat backs out to the east and gets under way.
  const leave = Date.now();
  for (let step = 1; step <= 6; step += 1) fix(offsetPoint(slipA, 90, step * 45), leave + step * 10_000, { sog: 8, cog: 90, heading: 90 });
  const away = await until("the vessel to leave", async () => { const item = await vessel(); return item && item.state !== "docked" ? item : null; });
  assert.ok(["departing", "underway"].includes(away.state));
  assert.equal(away.landing, null);
  assert.equal(away.slip, null);
  assert.equal(away.status, "in-transit");
  const untagged = await until("the trip update to name the landing again", async () => { const call = await tripUpdate(); return call?.stopId === "87" ? call : null; });
  assert.equal(untagged.stopId, "87");
  record("vessel departed and the trip update went back to the landing", { state: away.state, stopId: untagged.stopId });

  // AIS goes away. The harbor is shown as it last stood, and says so.
  await ais.close();
  const stale = await until("the stream to be reported down", async () => { const current = await getJson("/api/harbor/vessels"); return current.body.stale && !current.body.sources.ais.connected ? current : null; });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.available, true);
  assert.ok(stale.body.vessels.find((item) => item.id === "waves-of-wonder").latitude != null);
  record("AIS outage reported as stale with the last positions kept", { stale: stale.body.stale, ais: stale.body.sources.ais });

  const stats = await getJson("/api/stats");
  assert.equal(stats.status, 200);
  record("requests counted", { harborRequests: stats.body.routes?.["/api/harbor/vessels"] ?? null });
} catch (error) {
  failure = error;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 5000); });
  await ais.close().catch(() => {});
  await new Promise((resolve) => operator.close(resolve));
  await mkdir(path.dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify({ passed: !failure, ranAt: new Date().toISOString(), node: process.version, steps,
    failure: failure ? String(failure.stack || failure) : null, serverLog: log.split("\n").filter((line) => !/^(WARNING|NOTE)/.test(line)).slice(-25) }, null, 2)}\n`);
  await rm(work, { recursive: true, force: true });
}
if (failure) { console.error(failure); console.error(`\nServer log tail:\n${log.split("\n").slice(-15).join("\n")}`); process.exit(1); }
console.log(`\nharbor E2E passed: ${steps.length} steps. Record: ${path.relative(ROOT, ARTIFACT)}`);
