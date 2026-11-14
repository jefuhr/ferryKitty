import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { createRealtimeService } from "../lib/realtime.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "realtime-service-"));
  const fleetPath = path.join(directory, "fleet.json"), cachePath = path.join(directory, "realtime.json");
  await writeFile(fleetPath, JSON.stringify({ vessels: [] }));
  let clock = Date.parse("2026-11-13T23:13:43Z"), timer = null, failure = null;
  const requests = [], observations = [];
  const bytes = FeedMessage.encode(FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: "2.0", timestamp: clock / 1000 }, entity: []
  })).finish();
  const service = createRealtimeService({
    loadDisplay: async () => ({ meta: { landing: { stopIds: [] } }, departures: [] }),
    fleetPath, cachePath, url: "trips", vehicleUrl: "positions", now: () => clock,
    setIntervalImpl: (callback, ms) => { assert.equal(ms, 15_000); timer = callback; return 1; },
    clearIntervalImpl: (id) => { assert.equal(id, 1); timer = null; },
    fetchImpl: async (url) => {
      requests.push(url);
      if (failure?.url === url) return failure.response();
      return { ok: true, arrayBuffer: async () => bytes };
    },
    onRefresh: async (value) => observations.push(value), ...options
  });
  t.after(async () => { await service.stop?.(); await rm(directory, { recursive: true, force: true }); });
  return { service, cachePath, requests, observations,
    advance: (ms) => { clock += ms; },
    tick: () => { assert.ok(timer, "a refresh timer must be installed"); return timer(); },
    fail: (url, response) => { failure = url ? { url, response } : null; }
  };
}

test("a headless collector refreshes both feeds at startup and after TTL without any API reads", async (t) => {
  const f = await fixture(t);
  await f.service.start?.();
  assert.deepEqual(f.requests, ["trips", "positions"]);
  const initial = JSON.parse(await readFile(f.cachePath, "utf8"));
  f.advance(15_000);
  await f.tick();
  assert.deepEqual(f.requests, ["trips", "positions", "trips", "positions"]);
  assert.equal(f.observations.length, 2, "harbor and ride observers receive each raw refresh");
  assert.ok(f.observations[1].vehicleFeed);
  const next = JSON.parse(await readFile(f.cachePath, "utf8"));
  assert.notEqual(next.fetchedAt, initial.fetchedAt, "unchanged feed content still writes a newer snapshot");
  assert.equal(f.service.status().lastSuccessAt, next.fetchedAt);
  await f.service.start();
  assert.equal(f.requests.length, 4, "starting twice does not duplicate polling");
  await f.service.stop();
  assert.equal(f.service.status().polling, false);
});

test("timer and API callers share one refresh while a slow fetch is in flight", async (t) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    await pending;
    return { ok: true, arrayBuffer: async () => FeedMessage.encode({ header: { gtfsRealtimeVersion: "2.0" } }).finish() };
  } });
  const start = f.service.start();
  const tick = f.tick();
  const request = f.service.getCurrent();
  release();
  await Promise.all([start, tick, request]);
  assert.equal(calls, 2);
});

test("failed refreshes retain the cache, expose the attempt and error, and retry on the next tick", async (t) => {
  const f = await fixture(t);
  await f.service.start();
  const original = await readFile(f.cachePath, "utf8");
  const lastSuccessAt = f.service.status().lastSuccessAt;
  f.advance(15_000);
  f.fail("trips", () => ({ ok: false, status: 503 }));
  await f.tick();
  assert.equal(await readFile(f.cachePath, "utf8"), original);
  assert.equal(f.service.status().lastSuccessAt, lastSuccessAt);
  assert.notEqual(f.service.status().lastAttemptAt, lastSuccessAt);
  assert.match(f.service.status().lastError, /503/);
  assert.match(f.service.status().feeds.tripUpdates.lastError, /503/);
  assert.equal(f.service.status().stale, true);
  f.advance(15_000);
  f.fail(null);
  await f.tick();
  assert.equal(f.service.status().lastError, null);
  assert.equal(f.service.status().stale, false);
  assert.equal(f.requests.length, 6);
});

test("a vehicle-only failure is visible even while the trip update cache succeeds", async (t) => {
  const f = await fixture(t);
  f.fail("positions", () => { throw new Error("Vehicle request timed out"); });
  await f.service.start();
  assert.equal(f.service.status().stale, false);
  assert.match(f.service.status().feeds.vehiclePositions.lastError, /timed out/);
  assert.equal(f.service.status().feeds.vehiclePositions.lastSuccessAt, null);
  assert.equal(f.service.status().feeds.tripUpdates.entityCount, 0, "a valid empty feed is observable");
  assert.equal(f.service.status().feeds.tripUpdates.headerTimestamp, Date.parse("2026-11-13T23:13:43Z") / 1000);
  assert.equal(JSON.parse(await readFile(f.cachePath, "utf8")).vehiclesStale, true);
});

test("decode failures do not stop future refreshes and status reads never fetch", async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.status().lastAttemptAt, null);
  assert.equal(f.requests.length, 0);
  f.fail("trips", () => ({ ok: true, arrayBuffer: async () => new Uint8Array([255]) }));
  await f.service.start();
  assert.ok(f.service.status().lastError);
  assert.equal(f.service.status().lastSuccessAt, null);
  f.advance(15_000);
  f.fail(null);
  await f.tick();
  assert.equal(f.service.status().lastError, null);
  assert.equal(f.requests.length, 4);
  f.advance(15_000);
  assert.equal(f.service.status().stale, true, "status ages independently of a consumer request");
  assert.equal(f.requests.length, 4);
});
