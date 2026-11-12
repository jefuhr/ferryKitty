import test from "node:test";
import assert from "node:assert/strict";

import { createCounterService, OTHER_ROUTE, routeKey, STATIC_ROUTE } from "../lib/counters.js";

// The store is the thing that touches disk, and it has its own tests. What matters here is what
// gets handed to it, so it is stood in for by something that just remembers.
function recorder() {
  const written = [];
  return {
    written,
    record(deltas, at) { written.push({ deltas, at }); },
    last() { return written.at(-1)?.deltas; }
  };
}

test("requests are counted by route, landing and status", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  counters.record({ route: "/api/display-data", landingId: 18, status: 200 });
  counters.record({ route: "/api/display-data", landingId: 18, status: 200 });
  counters.record({ route: "/api/display-data", landingId: 2, status: 200 });
  counters.record({ route: "/api/realtime", status: 503 });
  counters.flush();

  const { counts } = store.last();
  assert.deepEqual(counts.route, { "/api/display-data": 3, "/api/realtime": 1 });
  assert.deepEqual(counts.landing, { 18: 2, 2: 1 });
  assert.deepEqual(counts.status, { 200: 3, 503: 1 });
});

// The one way a fixed-key counter can grow without bound is by minting a key per path it is asked
// for, which is exactly what a scanner walking a wordlist would do.
test("unknown paths share one key rather than minting their own", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  for (let attempt = 0; attempt < 500; attempt += 1) {
    counters.record({ route: `/wp-admin/${attempt}.php`, status: 404 });
  }
  counters.record({ route: "/assets/fonts/lato-regular-latin.woff2", status: 200 });
  counters.flush();

  const { counts } = store.last();
  assert.equal(counts.route[OTHER_ROUTE], 500);
  assert.equal(counts.route[STATIC_ROUTE], 1);
  assert.equal(Object.keys(counts.route).length, 2);
});

test("a served file and a missing one are told apart", () => {
  assert.equal(routeKey("/api/realtime", 200), "/api/realtime");
  assert.equal(routeKey("/styles.css", 200), STATIC_ROUTE);
  assert.equal(routeKey("/styles.css", 404), OTHER_ROUTE);
  assert.equal(routeKey("/../../etc/passwd", 403), OTHER_ROUTE);
});

// A landing count answers "how often was this board opened", so it has to come off the payload a
// board fetches once per view. The polled routes carry landingId too, and counting those would
// quietly turn the metric into how long a screen was left switched on.
test("polling a landing does not count as viewing it", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  counters.record({ route: "/api/display-data", landingId: 18, status: 200 });
  for (let poll = 0; poll < 240; poll += 1) counters.record({ route: "/api/realtime", status: 200 });
  for (let poll = 0; poll < 720; poll += 1) counters.record({ route: "/api/alerts", status: 200 });
  counters.flush();

  const { counts } = store.last();
  assert.deepEqual(counts.landing, { 18: 1 });
  assert.equal(counts.route["/api/realtime"], 240);
  assert.equal(counts.route["/api/alerts"], 720);
});

test("response times land in histogram buckets, keyed by route", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  counters.record({ route: "/api/realtime", status: 200, durationMs: 3 });
  counters.record({ route: "/api/realtime", status: 200, durationMs: 7 });
  counters.record({ route: "/api/realtime", status: 200, durationMs: 9_000 });
  counters.flush();

  // -1 is the open-ended top bucket: neither SQLite nor JSON has an infinity to store.
  assert.deepEqual(store.last().latency["/api/realtime"], { 5: 1, 10: 1, "-1": 1 });
});

test("counting drains, so the same request is never rolled up twice", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  counters.record({ route: "/api/alerts", status: 200 });
  counters.flush();
  counters.record({ route: "/api/alerts", status: 200 });
  counters.flush();

  assert.equal(store.written.length, 2);
  assert.deepEqual(store.written[0].deltas.counts.route, { "/api/alerts": 1 });
  assert.deepEqual(store.written[1].deltas.counts.route, { "/api/alerts": 1 });
});

// A board that takes no traffic between two ticks should not write an empty rollup every five
// minutes for as long as it runs.
test("an empty interval writes nothing", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  assert.equal(counters.flush(), false);
  counters.record({ route: "/healthz", status: 200 });
  assert.equal(counters.flush(), true);
  assert.equal(counters.flush(), false);
  assert.equal(store.written.length, 1);
});

test("peeking shows what has not been rolled up yet, without consuming it", () => {
  const store = recorder();
  const counters = createCounterService({ store });

  counters.record({ route: "/stats", status: 200 });
  assert.deepEqual(counters.peek().counts.route, { "/stats": 1 });
  assert.deepEqual(counters.peek().counts.route, { "/stats": 1 }, "peeking twice must show the same thing");

  counters.flush();
  assert.deepEqual(counters.peek().counts.route, {});
});

// A store that throws must not take the board down with it: losing a few minutes of counting is a
// far smaller problem than failing requests.
test("a failing store costs counts, not requests", () => {
  const counters = createCounterService({
    store: { record() { throw new Error("disk is on fire"); } }
  });

  counters.record({ route: "/healthz", status: 200 });
  assert.doesNotThrow(() => counters.flush());
  assert.equal(counters.flush(), false, "the failed batch is dropped rather than retried forever");
});

// Counting must never be the reason a request fails, so the record path takes anything the server
// can hand it without throwing.
test("recording never throws on odd input", () => {
  const counters = createCounterService({ store: recorder() });
  assert.doesNotThrow(() => counters.record());
  assert.doesNotThrow(() => counters.record({ route: undefined, landingId: NaN, status: undefined, durationMs: NaN }));
  assert.doesNotThrow(() => counters.event(null));
});

test("stopping rolls up what is still only in memory", () => {
  const store = recorder();
  const counters = createCounterService({ store, flushIntervalMs: 60_000 });
  counters.start();
  counters.record({ route: "/api/landings", status: 200 });
  counters.stop();

  assert.equal(store.last().counts.route["/api/landings"], 1);
});

test("every vessel page counts under one key, and a made-up id counts as a probe", () => {
  assert.equal(routeKey("/api/harbor/vessels/waves-of-wonder", 200), "/api/harbor/vessels/{id}");
  assert.equal(routeKey("/api/harbor/vessels/mmsi:367000001", 200), "/api/harbor/vessels/{id}");
  assert.equal(routeKey("/api/harbor/vessels/no-such-boat", 404), routeKey("/definitely/not/here", 404));
  assert.equal(routeKey("/api/harbor/vessels", 200), "/api/harbor/vessels");
});
