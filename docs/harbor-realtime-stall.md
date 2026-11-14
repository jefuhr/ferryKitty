# Operator realtime collection stall — November 13, 2026

## Finding and current state

The confirmed code defect is demand-driven operator refresh in a headless collector. At base revision `e6f88ba`, starting `node server.js` starts AIS and the harbor maintenance timer, but never starts a NYC Ferry realtime poller. Once clients stop requesting realtime-consuming routes, operator fetches stop, the cache and ride history stop changing, and the harbor tracker continues with AIS and schedule inference alone. Restarting the same code does not resume operator collection without a consumer request.

This is the strongly supported cause of the observed stall, rather than evidence of a continuing upstream outage. The cache remained unchanged throughout this investigation, including after the 20:48 restart. Both public feeds returned fresh, advancing protobuf messages at 20:52 and 20:58 EST. A small background refresh lifecycle fixes the missing trigger in this branch; it has **not** been installed in or used to restart the running collector.

All local times below are America/New_York (EST, UTC−05:00). Inspection took place on November 13 at approximately 20:52–21:02 local, which is November 14 in UTC.

## Direct observations

The live directory was read only: `/Users/julie/orca/workspaces/ferryKitty/DiD_Open/harbor-ais-api/state`. Both SQLite files were opened with `node:sqlite` using `{ readOnly: true }`. No HTTP request was made to the running collector, because requesting a realtime-consuming route would change the evidence and initiate more upstream requests.

| Item | Observed value |
|---|---|
| Collector process | PID 14790, `node server.js`, started November 13 at 20:48:00 |
| `realtime.json` | 36,603 bytes; mtime `2026-11-13T23:13:43.560Z` |
| Snapshot `fetchedAt` | `2026-11-13T23:13:43.426Z` (18:13:43 local) |
| Snapshot content | `available: true`, `stale: false`, `vehiclesStale: false`; 261 updates, 51 vehicle assignments, 24 positions |
| `vessel-trip-history.json` | mtime `2026-11-13T23:13:43.408Z` |
| `nyu-realtime.json` | mtime `2026-11-12T23:27:49.921Z`; `fetchedAt: 2026-11-12T23:27:49.918Z` |
| `harbor-tracks.json` | Continued advancing, including `2026-11-14T01:56:17.219Z` |
| Saved operator trips | No `trip.source === "operator-rt"` tracks in the snapshot inspected at 20:52 |
| Push subscriptions | No `ride-push-subscriptions.json` in the live state directory |

Persisted request counters in `stats.db` corroborate the loss of consumers. In the 18:00 local hour (`2026-11-13T23` UTC), `/api/boats` has 116 requests and `/api/harbor/vessels` has 262. There are no later request buckets through the inspection. Previous hours contain regular map and harbor traffic. These are hourly aggregates, not a timestamped access log, so they cannot establish the exact final request within the 18:00 hour. No successful operator polling follows the 18:13 snapshot.

The collector's stdout and stderr are attached to `/dev/ttys093`, not a log file. No `*.log` file was found within two levels of its checkout. Read-only Orca discovery found the collector terminal `term_820cec67-bf69-4912-9c77-ba9c41323c40`, associated with the parent `New-Age` workspace. Its retained, truncated 128-line output includes the latest startup, 49 landings, 93 slips, 96 remembered vessels, and the listening address. The selected server/error lines contain no fetch error. This does **not** prove historical fetch success: normal realtime failures are caught and returned in snapshots, not logged, and the terminal history is incomplete. The sanitized excerpt is in `artifacts/realtime-stall/collector-log-filtered.json`.

## Refresh path at the base revision

`createCachedSnapshotService` in `lib/cached-snapshot.js` has one entry point: `getCurrent()`. It loads the disk snapshot, returns it if its `fetchedAt` age is under 15 seconds, and otherwise calls `refresh()`. There is no timer in that service or in the original `createRealtimeService`.

The routes that request NYC Ferry realtime are `/api/realtime`, `/api/boats`, `/api/ride`, `/api/harbor/vessels`, `/api/harbor/vessels/{id}`, `/gtfs-rt/tripupdate`, and `/api/connections`. Health, stats, static pages, harbor operator/terminal lists, and the slip catalog do not request it. Ride notifications can also request it, but their scheduler immediately returns when there are no subscriptions. The missing subscription state means that scheduler supplies no fallback here.

The harbor service does not fetch a separate `vehicleFeed`. `createRealtimeService.refresh()` fetches trip updates and vehicle positions together, then calls the `onRefresh` listener in `server.js`. That listener passes the decoded feeds to the ride observer and, in a `finally` block, to `harborService.observeOperatorFeed(update)`. Harbor normalizes that raw `vehicleFeed` into positions and trip assignments. Its own 15-second `tick()` ages tracks, expires operator trips, learns patterns, and persists state; it does not fetch the operator feed. Thus AIS can be healthy while operator collection is completely idle.

NYU is a separate demand-driven service, used only by `/api/realtime` and `/api/connections`. Harbor does not consume its Passio ETA data; NYU harbor boats are observed through AIS and schedules. The last persisted `/api/realtime` requests are two in the November 12 18:00 local hour, and there are no `/api/connections` entries. The November 12 18:27 NYU cache is therefore expected for this collector's request pattern, not evidence of an independent NYU outage. Passio was not contacted, so its current health is unknown. This change deliberately leaves NYU demand-driven.

## Did attempts stop or fail?

| Candidate | Evidence for | Evidence against or limit | Assessment |
|---|---|---|---|
| No consumer, therefore no refresh attempts | No poller at base; no push subscriptions; request buckets stop; cache stays frozen across restart while AIS state advances | Hourly counters cannot pinpoint the last request at 18:13 | Confirmed architectural defect and strongest explanation of the continuing stall |
| Trip-update timeout, HTTP error, or decode failure | Each can leave the last successful file untouched | No retained attempt/error timeline; current feed is fresh; a failure does not permanently disable subsequent attempts | Possible transient near the final request, not established |
| Rejected promise permanently stopped a loop | An error could explain a single missed refresh | There is no realtime loop to stop; the cached service clears `inflight` in `finally` and catches failed refreshes | Ruled out as the persistent mechanism for ordinary rejected fetches |
| Empty feed or unchanged payload suppresses file writes | Evening service has fewer entities | A valid empty feed is a successful refresh; every successful snapshot is written even if entities are identical | Ruled out as an explanation for the unchanged file |
| Vehicle-position endpoint alone failed | Positions are allowed to fail independently | Trip-update success still writes `realtime.json` with `vehiclesStale: true`; it does not freeze the whole cache | Does not explain the observed cache stall by itself |
| Local read/write or observer problem | Input read/normalization/write failure could prevent a completed snapshot | No supporting error evidence; ride observer exceptions are isolated; other live state continues writing | Lower-ranked, unverified historical possibility |

The existing network timeout aborts the real fetch after seven seconds, including body reading. It relies on the fetch implementation honoring `AbortSignal`; an arbitrary injected implementation that never settles could hold the shared request indefinitely. There is no evidence that this happened in the live process, and the restart rules out retaining an earlier in-memory hung promise.

## What the cache does and does not prove

A successful refresh always writes a new temporary JSON file and renames it to `realtime.json`. It is **not** a change-only writer. `fetchedAt` advances even when the upstream content is unchanged or the decoded feed contains no entities. It records the application's successful fetch/normalization time, not the upstream header time.

On failure, callers get the old data with `stale: true` and an error. That fallback is not written to disk. Consequently the old file can say `available: true, stale: false` for hours; those are historical values, not a live health check. Mtime and `fetchedAt` show the last completed snapshot write, but cannot distinguish no attempt from failed attempts. A successful response also does not by itself establish that the upstream feed contents are recent; compare its header and vehicle timestamps.

## Public feed checks

Only the following public endpoints were contacted, twice each, about five minutes apart, with a neutral diagnostic User-Agent. No redirects were followed, no internal Hornblower endpoint was contacted, and there were no refusal responses or retries.

- [Trip updates](https://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/tripupdate)
- [Vehicle positions](https://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/vehicleposition)

| Check time, UTC | Feed | HTTP | Bytes | Entities | Header timestamp, UTC | Header age |
|---|---|---|---|---|---|---|
| `2026-11-14T01:52:47.570Z` | Trip updates | 200 | 771 | 13 | `2026-11-14T01:52:44Z` | 4 seconds |
| `2026-11-14T01:52:47.744Z` | Vehicle positions | 200 | 722 | 13 | `2026-11-14T01:52:44Z` | 4 seconds |
| `2026-11-14T01:58:03.698Z` | Trip updates | 200 | 802 | 13 | `2026-11-14T01:57:59Z` | 5 seconds |
| `2026-11-14T01:58:03.825Z` | Vehicle positions | 200 | 722 | 13 | `2026-11-14T01:57:59Z` | 5 seconds |

All four bodies decoded successfully using the repository's `gtfs-realtime-bindings`. The header advances by 315 seconds between checks. This establishes healthy, advancing feeds at those times, not continuous upstream availability between 18:13 and 20:52. Raw check metadata is retained in `artifacts/realtime-stall/public-feed-check.json`. A final read-only state check at `2026-11-14T02:01:36.321Z` still showed the unchanged 18:13 realtime snapshot, while harbor state had advanced to `2026-11-14T02:01:32.253Z`; see `artifacts/realtime-stall/final-live-state.json`.

## Effect on matched trips

The reported 84/87 and 27/66 counts were reproduced. Count **distinct trip IDs**, favoring `operator-rt` when several observations exist, and group by scheduled `departsAt` in the live database's `runs.trips_json` for service date `20261113`. Do not group operator rows by `trip_observations.departed_at`: those rows have null actual departure times because the feed assignment itself, rather than a detected departure, created them.

| Scheduled departure window, local | Matched trips | Operator feed | Schedule only |
|---|---|---|---|
| 10:00–16:40 | 87 | 84 | 3 |
| 16:40–20:00 | 66 | 27 | 39 |
| 16:40–18:13:44 | 33 | 27 | 6 |
| 18:13:44–20:00 | 33 | 0 | 33 |

The later portion still has 33 observed sailings, so the absence of operator credit cannot be dismissed as no evening service. The strong discontinuity coincides with the stopped cache, and operator-backed trips resume after the earlier 16:39 restart while consumers are active. That earlier restart alone therefore does not explain the complete later loss. The six schedule-only trips before 18:13 may involve coverage or matching differences; this investigation does not assign them to the refresh defect. Trip matching is outside this worker's edit scope. The schedule basis is the live collector's own persisted schedule, not independent validation of that timetable.

A reproducible read-only query basis is:

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/path/to/live/state/harbor.db", { readOnly: true });
const rows = db.prepare(`
  WITH scheduled AS (
    SELECT json_extract(t.value, '$.tripId') AS trip_id,
           json_extract(t.value, '$.departsAt') AS departs_at
    FROM runs r, json_each(r.trips_json) t
    WHERE r.operator_id = 'nycf' AND r.service_date = '20261113'
  ), observed AS (
    SELECT trip_id, MAX(source = 'operator-rt') AS operator_rt
    FROM trip_observations
    WHERE operator_id = 'nycf' AND service_date = '20261113'
    GROUP BY trip_id
  )
  SELECT s.trip_id, s.departs_at, o.operator_rt
  FROM scheduled s JOIN observed o USING (trip_id)
`).all();
// Filter departs_at against Date.parse("2026-11-13T18:13:44-05:00"), etc.
db.close();
```

The recorded grouped results are in `artifacts/realtime-stall/scheduled-trip-counts.json`, and request counters are in `artifacts/realtime-stall/live-request-counts.json`.

## Behavior when operator data disappears

`OPERATOR_TRIP_MS` is `180_000` (three minutes). A live `operator-rt` trip is authoritative only while its vehicle timestamp is younger than three minutes. Harbor removes aged authority during operator observations and its 15-second maintenance tick, so an idle feed does not keep a live operator trip forever: expiration occurs at or after three minutes, normally by the next tick. A stale position returned by the feed can clear its trip during reconciliation as well.

Harbor marks the source stale after its last callback is over 60 seconds old, on a tick. AIS positions continue independently, and later dock departures can receive schedule guesses. Persisted historical `trip_observations` and inferred run memory remain historical evidence; expiring a live trip does not delete them. The unchanged ride history likewise remains a record of what was previously observed, not a fresh operator statement.

## Changes

- `lib/realtime.js` now provides explicit `start()` and `stop()` methods. Startup requests the shared cache immediately; a 15-second background timer checks it thereafter. The existing 15-second cache TTL remains authoritative, so completion-time offsets can make consecutive background writes roughly 30 seconds apart. Both remain comfortably inside harbor's 60-second source-age threshold. HTTP and timer consumers share the same in-flight operation, including the initial disk load.
- Both endpoint requests settle before the refresh lock is released, even if trip updates fail. Ordinary fetch/decode failures preserve the existing fallback and do not stop future timer checks. Vehicle-only failures remain separately visible.
- Passive `status()` reports `polling`, `inFlight`, `lastAttemptAt`, `lastSuccessAt`, `lastError`, cache `stale`, and per-feed attempt/success/error, header timestamp, and entity count. `lastSuccessAt` is the latest known successful snapshot time, including one loaded from disk. Status is process-local and resets on restart; it is not a durable incident log. A feed's header/entity fields describe its last successful decode and remain available beside its last error.
- `server.js` starts realtime collection after initialization, stops it before shutting down its observers/stores, and exposes passive status under `realtime` on `/healthz` and `/api/health`. Health still returns HTTP 200 for server liveness; maintainers must inspect the realtime fields for feed health. `stale` uses the cache TTL, so it can briefly be true between background checks even without an error.
- Added injected-clock/fetch lifecycle tests and a real-process headless collector regression test. No NYU, harbor matching, package, live state, or live process changes were made.

## Verification

Failure modes covered before implementation: no startup/background attempt, unchanged valid content, simultaneous timer/API reads, failed refresh retry, partial endpoint failure, malformed protobuf, passive status, and clean stop. The unit regression was written and run first. At base, it recorded no startup fetches (`actual: []`, expected `['trips', 'positions']`); all five new cases failed because the required lifecycle/status behavior was absent.

| Exact command | Result | Artifact |
|---|---|---|
| `node --test test/realtime-service.test.js` before implementation | 0 passed, 5 failed, exit 1 as expected | `artifacts/realtime-stall/red.txt` |
| `node --test test/realtime-service.test.js` after implementation | 5 passed, 0 failed | `artifacts/realtime-stall/focused.txt` |
| `node --test test/realtime-collector.test.js` | 1 passed, 0 failed; real server, no AIS key, fake fetch, isolated temporary state, two writes before the first HTTP read | `artifacts/realtime-stall/collector-test.txt`, `artifacts/realtime-stall/collector.json` |
| `npm test` | 831 passed, 0 failed, 0 skipped; exit 0 | `artifacts/realtime-stall/npm-test.txt` |
| `npm run test:harbor` | All 10 E2E steps passed; exit 0; local fake AIS and operator endpoints | `artifacts/realtime-stall/harbor-test.txt`, `artifacts/harbor/e2e.json` |
| `git diff --check` | Passed | Terminal output |

The full-suite headless run recorded successive cache writes at `2026-11-14T01:57:01.496Z` and `2026-11-14T01:57:31.496Z`, then checked `/healthz`. Its log confirms AIS disabled and its own process exited cleanly with code 0. The standalone run passed in 31.9 seconds; the full suite passed in 40.1 seconds. All automated feed inputs were fake; only loopback servers were used by integration tests. The four public checks above were separate manual diagnostics, not tests. Artifacts are preserved in this worktree's ignored `artifacts/` directory.

## Next incident checklist and remaining work

1. Read `/healthz` or `/api/health` first. These are passive with respect to upstream fetches. Record process start time, `polling`, `inFlight`, top-level and per-feed attempt/success/error fields, entity counts, and upstream header ages. An unchanged attempt time distinguishes an idle collector from repeated failed fetches. A recent decode with an old header distinguishes upstream stale content from local collection failure.
2. Compare cache `fetchedAt` and filesystem mtime with current UTC time. Ignore a saved `stale: false` as evidence of present freshness. Capture the request counters and any available logs before requesting `/api/boats` or a harbor vessel endpoint, because those routes can trigger a refresh.
3. Inspect the actual failure: trip updates, vehicle positions, local display/fleet reads, decoding, or persistence. A vehicle-only error can coexist with a successful trip-update cache. Record status periodically if durable incident history is needed; this small change does not persist diagnostics.
4. Check a public feed sparingly with a bounded timeout and no redirect following, recording status, byte count, successful decode, header time, and entity count. Stop on automated-access refusal. Do not infer header freshness from HTTP 200 alone.
5. After the coordinator integrates and the owner restarts the collector, verify that the cache advances without any board/map/harbor clients and that new operator-backed trip observations appear. This live acceptance remains outstanding: the current collector was deliberately neither restarted nor altered. No historical rows were repaired.

Unknowns remain the exact last attempt/error around 18:13, continuous upstream health during the gap, why the last browser/consumer stopped, and the six pre-stall schedule-only trip matches. There is no evidence here to attribute the continuing outage to upstream.
