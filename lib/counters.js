// What this server has been asked for, counted rather than logged.
//
// A departure board wants to answer a few operational questions — which landings are actually
// dialled up, whether a route is erroring, whether the board is getting slower — and every ordinary
// way of answering them costs more hardware than the board itself. An access log grows without
// bound and needs rotating; a hosted analytics tag is blocked outright by this server's own
// Content-Security-Policy; a self-hosted one wants a database and half a gigabyte of RAM.
//
// So: fixed keys, integer counts, held in a Map. The set of keys is bounded by the routes this
// server has and the landings it was built with, so memory is flat no matter how long it runs and
// however much traffic it takes. Counting a request costs a Map increment and touches no disk.
//
// What is counted here is only ever the recent delta. Every few minutes it is handed to
// lib/stats-store.js, which folds it into an hourly bucket and owns the long history — so this file
// stays small and synchronous, and the question "when" is answered somewhere that can afford it.
//
// It counts requests, not people. There is no identifier here, nothing per-visitor, and no record
// of the order anything happened in: a counter cannot reconstruct a journey, which on a public
// kiosk is a feature and on a phone is the point.

import { latencyBucket } from "./stats-store.js";

// Long enough that a busy board rolls up seconds of work at a time, short enough that a restart
// loses little. A crash costs at most this much counting, which is the right thing to be cheap
// about.
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// A served file — the shell, the stylesheet, a font — is counted as one key rather than one per
// asset, because "the board loaded" is the fact worth having and a per-file breakdown is what the
// browser's own network tab is for.
export const STATIC_ROUTE = "static";
export const OTHER_ROUTE = "other";
export const ROUTES = ["/healthz", "/api/health", "/api/landings", "/api/display-data", "/api/realtime", "/api/alerts", "/api/stats", "/stats", "/api/map", "/api/boats", "/api/harbor/vessels", "/api/slips", "/gtfs-rt/tripupdate", "/map", STATIC_ROUTE, OTHER_ROUTE];

// Requests that are not one of this server's routes split by how they ended: a file that was
// served is the board working, and a 404 or a 403 is somebody probing paths that do not exist.
// Without this, a scanner walking a wordlist would mint a counter key per guess, which is the one
// way a fixed-key design can leak memory.
export function routeKey(pathname, status) {
  if (ROUTES.includes(pathname)) return pathname;
  return Number.isInteger(status) && status < 400 ? STATIC_ROUTE : OTHER_ROUTE;
}

function emptyDeltas() {
  return { counts: { route: {}, landing: {}, status: {}, event: {} }, latency: {} };
}

export function createCounterService({ store, flushIntervalMs = FLUSH_INTERVAL_MS, now = () => Date.now() } = {}) {
  if (!store) throw new Error("A stats store is required.");

  let pending = emptyDeltas();
  let timer = null;
  let dirty = false;

  function bump(kind, key) {
    const bucket = pending.counts[kind];
    if (!bucket) return;
    bucket[key] = (bucket[key] || 0) + 1;
    dirty = true;
  }

  // Called on the request path, so it does no I/O and never rejects: a counter that can fail a
  // request is worse than no counter at all.
  function record({ route, landingId, status, durationMs } = {}) {
    const key = routeKey(route, status);
    bump("route", key);
    if (Number.isInteger(landingId)) bump("landing", String(landingId));
    if (Number.isInteger(status)) bump("status", String(status));
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      const edge = latencyBucket(durationMs);
      const buckets = pending.latency[key] || (pending.latency[key] = {});
      // Infinity cannot be a SQLite integer or a JSON number, so the open-ended top bucket is
      // stored as -1 and read back as "slower than every edge".
      const stored = Number.isFinite(edge) ? edge : -1;
      buckets[stored] = (buckets[stored] || 0) + 1;
      dirty = true;
    }
  }

  // For the things worth counting that are not requests — a realtime fetch served from cache, a
  // feed that answered at all. Callers pass a name from a fixed set of their own.
  function event(name) {
    if (typeof name === "string" && name) bump("event", name);
  }

  function drain() {
    const drained = pending;
    pending = emptyDeltas();
    dirty = false;
    return drained;
  }

  function flush() {
    if (!dirty) return false;
    const deltas = drain();
    try {
      store.record(deltas, now());
      return true;
    } catch (error) {
      // Losing a few minutes of counts is not worth taking the board down for, and the next flush
      // starts clean rather than retrying a write that may be failing for a durable reason.
      console.error(`Counters could not be rolled up: ${error.message}`);
      return false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void flush(), flushIntervalMs);
    // The board's own timers keep the process alive; this one should never be the reason it stays up.
    timer.unref?.();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return flush();
  }

  // What has been counted but not yet rolled up, so /api/stats can add it to the stored totals and
  // answer with the current minute included rather than the last flush.
  function peek() {
    return { counts: structuredClone(pending.counts), latency: structuredClone(pending.latency) };
  }

  return { record, event, flush, drain, peek, start, stop };
}
