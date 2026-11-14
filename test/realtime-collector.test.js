import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const root = fileURLToPath(new URL("../", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error("Timed out waiting for the headless collector cache");
}

test("server refreshes the operator cache without a browser or AIS connection", { timeout: 75_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "headless-realtime-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const bytes = GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", timestamp: Math.floor(Date.now() / 1000) }, entity: []
  }).finish();
  // The subprocess never contacts an upstream server, even if another caller is added later.
  const preload = path.join(directory, "fake-fetch.mjs");
  await writeFile(preload, `globalThis.fetch = async url => {
    if (!["https://operator.invalid/trips", "https://operator.invalid/positions"].includes(String(url))) {
      throw new Error("Unexpected outbound fetch in headless collector test");
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array(${JSON.stringify([...bytes])}) };
  };\n`);
  const server = spawn(process.execPath, ["--import", preload, "server.js"], { cwd: root, env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port), STATE_DIR: directory,
    AISSTREAM_API_KEY: "", AISSTREAM_URL: "", AIS_REPLAY_PATH: "", HARBOR_SLIPS_CSV: path.join(directory, "no-slips.csv"),
    NYCF_TRIP_UPDATES_URL: "https://operator.invalid/trips", NYCF_VEHICLE_POSITIONS_URL: "https://operator.invalid/positions"
  }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", failure = null;
  const exit = new Promise(resolve => server.once("exit", (code, signal) => resolve({ code, signal })));
  server.stdout.on("data", chunk => { log += chunk; });
  server.stderr.on("data", chunk => { log += chunk; });
  const evidence = { at: new Date().toISOString(), port, stateDirectory: directory, liveAis: false, upstream: "Injected fake fetch" };
  try {
    const snapshot = async () => JSON.parse(await readFile(path.join(directory, "realtime.json"), "utf8"));
    evidence.initial = await until(snapshot, 25_000);
    evidence.next = await until(async () => {
      const next = await snapshot();
      return next.fetchedAt !== evidence.initial.fetchedAt && next;
    }, 35_000);
    // These are the first HTTP reads: polling already wrote two successful snapshots.
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json();
    evidence.status = health.realtime;
    assert.equal(health.realtime.polling, true);
    assert.equal(health.realtime.lastSuccessAt, evidence.next.fetchedAt);
    assert.equal(health.realtime.lastError, null);
    assert.equal(health.realtime.feeds.vehiclePositions.entityCount, 0);
    assert.equal(health.realtime.feeds.tripUpdates.entityCount, 0);
    assert.equal(await readFile(path.join(directory, "nyu-realtime.json"), "utf8").catch(() => null), null,
      "NYU remains demand-driven and is not a harbor input");
    assert.match(log, /AIS disabled/);
  } catch (error) {
    failure = error;
  } finally {
    server.kill("SIGTERM");
    evidence.exit = await exit;
    evidence.success = !failure;
    evidence.error = failure?.message ?? null;
    evidence.log = log;
    await mkdir(path.join(root, "artifacts/realtime-stall"), { recursive: true });
    await writeFile(path.join(root, "artifacts/realtime-stall/collector.json"), JSON.stringify(evidence, null, 2) + "\n");
    await rm(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  assert.equal(evidence.exit.code, 0);
});
