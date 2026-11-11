// Failure modes: AIS sentinels and invalid positions, malformed identities/times,
// Class B static-part loss, binary decoding, secret leakage, premature subscription,
// reconnect backoff/reset, server rejection, silent sockets, stale socket events,
// stop/start races, and RFC 6455 interoperability and clean loopback shutdown.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAisStream, normalizeAisMessage, HARBOR_BOUNDING_BOXES } from "../lib/ais-stream.js";
import { startFakeAisServer } from "./helpers/fake-ais-server.js";

const fixture = (await readFile(new URL("./fixtures/harbor/ais-arrival.ndjson", import.meta.url), "utf8")).trim().split("\n").map(JSON.parse);
const position = fixture[1];
const staticMessage = fixture[0];
const secret = "test-secret-never-display";
function message(type, body, metadata = position.MetaData) {
  return { MessageType: type, MetaData: metadata, Message: { [type]: body } };
}
function report(patch = {}, metadata) {
  return message("PositionReport", { ...position.Message.PositionReport, ...patch }, metadata);
}
function clock() {
  let time = 1000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimer(key) { timers.delete(key); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      time = target;
    },
    pending: () => timers.size,
    delay: () => Math.min(...[...timers.values()].map((timer) => timer.at - time))
  };
}
function harness(options = {}) {
  const timers = clock();
  const sockets = [];
  const fixes = [], statics = [], states = [];
  class Socket {
    constructor(url) { this.url = url; this.listeners = {}; this.sent = []; this.closed = false; sockets.push(this); }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    emit(type, event = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; this.emit("close"); }
    data(value) { this.emit("message", { data: typeof value === "object" && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value) ? JSON.stringify(value) : value }); }
  }
  const stream = createAisStream({ apiKey: secret, WebSocketImpl: Socket, ...timers, random: () => 0.5,
    onFix: (fix) => fixes.push(fix), onStatic: (data) => statics.push(data), onStatus: (status) => states.push(status), ...options });
  return { stream, timers, sockets, fixes, statics, states };
}

test("the entire invented arrival fixture normalizes in order", () => {
  const normalized = fixture.map((raw) => normalizeAisMessage(raw));
  assert.equal(normalized[0].kind, "static");
  assert.deepEqual(normalized[0].static, { mmsi: "367000001", name: "TEST FERRY ONE", callSign: "WDX0001", shipType: 60, imo: null,
    dims: { a: 10, b: 16, c: 3, d: 4 }, aisClass: "A", at: Date.parse("2026-11-11T15:00:00Z") });
  for (const value of normalized.slice(1, -1)) { assert.equal(value.kind, "fix"); assert.equal(value.fix.mmsi, "367000001"); }
  assert.equal(normalized.at(-1), null);
  assert.deepEqual(normalized[1].fix, { mmsi: "367000001", latitude: position.Message.PositionReport.Latitude,
    longitude: position.Message.PositionReport.Longitude, sogKnots: 14, cogDegrees: 270, headingDegrees: 270,
    navStatus: 0, at: Date.parse("2026-11-11T15:00:00Z"), source: "ais", aisClass: "A" });
});

test("sentinels, position validity, Class B, MMSI and receive timestamps", () => {
  const normalized = normalizeAisMessage(report({ TrueHeading: 511, Cog: 360, Sog: 102.3 }));
  assert.equal(normalized.fix.headingDegrees, null);
  assert.equal(normalized.fix.cogDegrees, null);
  assert.equal(normalized.fix.sogKnots, null);
  for (const patch of [{ Latitude: 91 }, { Longitude: 181 }, { Latitude: null }, { Longitude: undefined }, { Valid: false }, { Latitude: -91 }, { Sog: Infinity, Latitude: NaN }]) {
    assert.equal(normalizeAisMessage(report(patch)), null);
  }
  for (const type of ["StandardClassBPositionReport", "ExtendedClassBPositionReport"]) {
    const value = normalizeAisMessage(message(type, position.Message.PositionReport));
    assert.equal(value.fix.aisClass, "B"); assert.equal(value.fix.navStatus, null);
  }
  assert.equal(normalizeAisMessage(report({ UserID: 123 }, { MMSI: 999, time_utc: "bad" }), 4321).fix.mmsi, "000000123");
  assert.equal(normalizeAisMessage(report({ UserID: null }, { MMSI: 367000002, time_utc: "bad" }), 4321).fix.at, 4321);
  assert.equal(normalizeAisMessage(report({ UserID: null }, { MMSI: 367000002 })).fix.mmsi, "367000002");
  assert.equal(normalizeAisMessage(report({ UserID: "bad" }, {})), null);
  assert.equal(normalizeAisMessage(report({}, { time_utc: "2026-11-11 15:00:00.123456789 +0000 UTC" })).fix.at, Date.parse("2026-11-11T15:00:00.123Z"));
  assert.equal(normalizeAisMessage(report({}, { time_utc: "2026-11-11T15:00:00Z" })).fix.at, Date.parse("2026-11-11T15:00:00Z"));
  for (const value of [null, [], 3, {}, { MessageType: "PositionReport" }]) assert.equal(normalizeAisMessage(value), null);
  assert.deepEqual(normalizeAisMessage({ error: "bad key" }), { kind: "error", message: "bad key" });
  assert.deepEqual(normalizeAisMessage({ Error: "bad key" }), { kind: "error", message: "bad key" });
});

test("static normalization strips padding, preserves partial updates and rejects invalid parts", () => {
  const partA = message("StaticDataReport", { UserID: 367000001, PartNumber: 0, ReportA: { Valid: true, Name: "  FERRY TWO@@  " } });
  const partB = message("StaticDataReport", { UserID: 367000001, PartNumber: 1, ReportB: { Valid: true, ShipType: 60, CallSign: "WDX0002@@ ", Dimension: { A: 0, B: 0, C: 0, D: 0 } } });
  assert.deepEqual(normalizeAisMessage(partA).static, { mmsi: "367000001", name: "FERRY TWO", aisClass: "B", at: Date.parse("2026-11-11T15:00:00Z") });
  assert.deepEqual(normalizeAisMessage(partB).static, { mmsi: "367000001", shipType: 60, callSign: "WDX0002", dims: null, aisClass: "B", at: Date.parse("2026-11-11T15:00:00Z") });
  assert.equal(normalizeAisMessage(message("StaticDataReport", { UserID: 367000001, PartNumber: 0, ReportA: { Valid: false, Name: "NO" } })), null);
  assert.equal(normalizeAisMessage(message("StaticDataReport", { UserID: 367000001, PartNumber: 2 })), null);
  assert.equal(normalizeAisMessage(message("ShipStaticData", { ...staticMessage.Message.ShipStaticData, Valid: false })), null);
  assert.equal(normalizeAisMessage(message("ShipStaticData", { UserID: 367000001, Name: "@@ ", CallSign: " " })).static.name, null);
  const h = harness(); h.stream.start(); const socket = h.sockets[0]; socket.emit("open");
  socket.data(partA); socket.data(partB); socket.data(partA);
  assert.deepEqual(h.statics.at(-1), { mmsi: "367000001", name: "FERRY TWO", callSign: "WDX0002", shipType: 60, imo: null, dims: null, aisClass: "B", at: Date.parse("2026-11-11T15:00:00Z") });
  h.stream.stop();
});

test("subscription happens on open, frame variants decode and malformed frames are counted", () => {
  const h = harness({ mmsiFilter: ["367000001"] });
  h.stream.start(); h.stream.start();
  assert.equal(h.sockets.length, 1); const socket = h.sockets[0];
  assert.equal(socket.binaryType, "arraybuffer"); assert.equal(socket.sent.length, 0);
  socket.emit("open");
  assert.deepEqual(socket.sent, [{ APIKey: secret, BoundingBoxes: HARBOR_BOUNDING_BOXES,
    FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"], FiltersShipMMSI: ["367000001"] }]);
  socket.data(JSON.stringify(position));
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  socket.data(bytes.buffer);
  const padded = new Uint8Array(bytes.length + 8); padded.set(bytes, 4); socket.data(padded.subarray(4, -4));
  socket.data(new DataView(bytes.buffer));
  socket.data("{"); socket.data(staticMessage); socket.data(fixture.at(-1));
  assert.equal(h.fixes.length, 4); assert.equal(h.statics.length, 1);
  assert.equal(h.stream.status().messages, 7); assert.equal(h.stream.status().dropped, 1);
  assert.equal(h.stream.status().lastMessageAt, h.timers.now());
  assert.deepEqual(h.states.map((s) => s.state), ["connecting", "open"]);
  assert.equal(h.stream.status().connected, true);
  h.stream.stop(); assert.equal(socket.closed, true); assert.equal(h.timers.pending(), 0);
  assert.equal(h.states.at(-1).state, "stopped");
  const plain = harness(); plain.stream.start(); plain.sockets[0].emit("open");
  assert.equal("FiltersShipMMSI" in plain.sockets[0].sent[0], false); plain.stream.stop();
});

test("backoff doubles, caps, jitters and resets after sixty open seconds", () => {
  const h = harness(); h.stream.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    h.sockets.at(-1).emit("close"); assert.equal(h.timers.delay(), delay);
    assert.equal(h.stream.status().state, "waiting"); h.timers.advance(delay);
  }
  h.sockets.at(-1).emit("open"); h.timers.advance(60000); h.sockets.at(-1).emit("close");
  assert.equal(h.timers.delay(), 1000); assert.equal(h.stream.status().reconnects, 8);
  h.stream.stop();
  for (const [random, expected] of [[0, 800], [1, 1200]]) {
    const j = harness({ random: () => random }); j.stream.start(); j.sockets[0].emit("close");
    assert.equal(j.timers.delay(), expected); j.stream.stop();
  }
});

test("server rejection waits five minutes and never exposes an echoed API key", () => {
  const h = harness(); h.stream.start(); h.sockets[0].emit("open");
  h.sockets[0].data({ error: `rejected ${secret}` });
  assert.equal(h.sockets[0].closed, true); assert.equal(h.timers.delay(), 300000);
  assert.equal(h.stream.status().state, "waiting");
  assert.equal(JSON.stringify([h.stream.status(), h.states]).includes(secret), false);
  h.timers.advance(299999); assert.equal(h.sockets.length, 1);
  h.timers.advance(1); assert.equal(h.sockets.length, 2); h.stream.stop();
});

test("watchdog uses last activity, closes silent sockets and stop blocks stale callbacks", () => {
  const h = harness(); h.stream.start(); const first = h.sockets[0]; first.emit("open");
  h.timers.advance(119999); assert.equal(first.closed, false); first.data("not json");
  h.timers.advance(119999); assert.equal(first.closed, false);
  h.timers.advance(1); assert.equal(first.closed, true); assert.equal(h.timers.delay(), 1000);
  h.timers.advance(1000); const second = h.sockets[1];
  first.emit("open"); first.data(position); first.emit("close");
  assert.equal(h.fixes.length, 0); assert.equal(h.stream.status().state, "connecting");
  h.stream.stop(); second.emit("open"); second.emit("close"); h.timers.advance(1000000);
  assert.equal(h.sockets.length, 2); assert.equal(h.timers.pending(), 0);
  h.stream.start(); assert.equal(h.sockets.length, 3); h.stream.stop();
  const waiting = harness(); waiting.stream.start(); waiting.sockets[0].emit("close"); waiting.stream.stop(); waiting.timers.advance(1000000);
  assert.equal(waiting.sockets.length, 1); assert.equal(waiting.timers.pending(), 0);
});

test("disabled clients never connect and transport failures are sanitized", () => {
  const h = harness({ apiKey: "" }); assert.equal(h.stream.status().state, "disabled"); h.stream.start();
  assert.equal(h.sockets.length, 0); h.stream.stop();
  const broken = harness({ WebSocketImpl: class { constructor() { throw new Error(secret); } } });
  assert.doesNotThrow(() => broken.stream.start()); assert.equal(broken.stream.status().state, "waiting");
  assert.equal(JSON.stringify(broken.stream.status()).includes(secret), false); broken.stream.stop();
  const error = harness(); error.stream.start(); error.sockets[0].emit("error", { message: secret });
  assert.equal(error.stream.status().state, "waiting"); assert.equal(JSON.stringify(error.states).includes(secret), false); error.stream.stop();
});

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "loopback condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real WebSocket exchanges masked subscription, text and binary and reconnects after drop", { timeout: 5000 }, async (t) => {
  const subscriptions = [], fixes = [];
  const server = await startFakeAisServer({ onSubscribe: (subscription) => subscriptions.push(subscription) });
  t.after(() => server.close());
  const stream = createAisStream({ url: server.url, apiKey: secret, random: () => 0.5,
    setTimer: (fn, ms) => setTimeout(fn, ms === 1000 ? 10 : ms), onFix: (fix) => fixes.push(fix) });
  t.after(() => stream.stop()); stream.start();
  await until(() => subscriptions.length === 1);
  assert.equal(subscriptions[0].APIKey, secret);
  assert.equal(server.connections[0].frames[0].masked, true);
  server.send(position); server.sendRaw(new TextEncoder().encode(JSON.stringify(position)));
  await until(() => fixes.length === 2);
  assert.equal(stream.status().state, "open");
  server.connections[0].drop(); await until(() => subscriptions.length === 2);
  assert.equal(server.connections.length, 2); assert.equal(stream.status().reconnects, 1);
  stream.stop();
});

test("subscription failures, callback shutdown and reconnect snapshots leave no timers", () => {
  const failed = harness(); failed.stream.start();
  failed.sockets[0].send = () => { throw new Error(secret); };
  failed.sockets[0].emit("open");
  assert.equal(failed.stream.status().state, "waiting");
  assert.equal(JSON.stringify(failed.stream.status()).includes(secret), false);
  failed.stream.stop(); assert.equal(failed.timers.pending(), 0);
  let stopOnOpen;
  const open = harness({ onStatus(status) { if (status.state === "open") stopOnOpen(); } });
  stopOnOpen = () => open.stream.stop(); open.stream.start(); open.sockets[0].emit("open");
  assert.equal(open.stream.status().state, "stopped"); assert.equal(open.timers.pending(), 0);
  let stopOnWait;
  const waiting = harness({ onStatus(status) { if (status.state === "waiting") stopOnWait(); } });
  stopOnWait = () => waiting.stream.stop(); waiting.stream.start(); waiting.sockets[0].emit("close");
  assert.equal(waiting.stream.status().state, "stopped"); assert.equal(waiting.timers.pending(), 0);
  const early = harness(); early.stream.start(); early.sockets[0].emit("close"); early.timers.advance(1000);
  early.sockets[1].emit("open"); early.timers.advance(59999); early.sockets[1].emit("close");
  assert.equal(early.timers.delay(), 2000); early.stream.stop();
});

test("static cache isolates MMSIs and callback mutations", () => {
  const h = harness(); h.stream.start(); h.sockets[0].emit("open");
  h.sockets[0].data(staticMessage); h.statics[0].dims.a = 999;
  h.sockets[0].data(message("StaticDataReport", { UserID: 367000001, PartNumber: 0, ReportA: { Valid: true, Name: "UPDATED" } }));
  assert.equal(h.statics[1].dims.a, 10); assert.equal(h.statics[1].callSign, "WDX0001");
  h.sockets[0].data(message("StaticDataReport", { UserID: 367000002, PartNumber: 0, ReportA: { Valid: true, Name: "OTHER" } }));
  assert.equal(h.statics[2].callSign, null); assert.equal(h.statics[2].dims, null);
  h.sockets[0].data(new Uint8Array([0xff])); assert.equal(h.stream.status().dropped, 1);
  h.stream.stop();
});

test("fake server sends long text and binary frames, can go silent and closes idempotently", { timeout: 5000 }, async (t) => {
  const server = await startFakeAisServer(); t.after(() => server.close());
  const client = new WebSocket(server.url); client.binaryType = "arraybuffer";
  t.after(() => client.close());
  const received = [];
  client.addEventListener("message", ({ data }) => received.push(data));
  await new Promise((resolve, reject) => { client.addEventListener("open", resolve, { once: true }); client.addEventListener("error", reject, { once: true }); });
  const text = "x".repeat(70000), bytes = new Uint8Array(70000).fill(120);
  server.sendRaw(text); server.sendRaw(bytes.buffer);
  await until(() => received.length === 2);
  assert.equal(received[0], text); assert.deepEqual(new Uint8Array(received[1]), bytes);
  client.send(JSON.stringify({ text })); await until(() => server.connections[0].frames.length === 1);
  assert.equal(JSON.parse(server.connections[0].frames[0].text).text, text);
  server.connections[0].silent(); server.sendRaw("hidden");
  server.connections[0].silent(false); server.sendRaw("visible");
  await until(() => received.length === 3); assert.equal(received[2], "visible");
  await server.close(); await server.close(); assert.equal(server.connections[0].closed, true);
});
