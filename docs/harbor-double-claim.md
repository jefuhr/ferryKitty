# Harbor trip ownership investigation

Base: `e6f88ba7de2f17a4da938a2f2cda02d318c08fc7` (`jefuhr/harbor-ais-api`). All times below are America/New_York (EST). The collector and its database were never modified, copied over, stopped, or restarted.

## Live evidence and its limits

A read-only `node:sqlite` transaction at **2026-11-13 20:53:13 EST** reproduced all four reported NYC Ferry windows. The query joins observations to the stored run's scheduled **first departure**, rather than filtering the observation's departure or arrival time.

| Scheduled window | Matched trips | Multiple tracks | Realtime + schedule | Two schedule rows | Three schedule rows | Two realtime rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Nov 12 16:40–20:00 | 69 | 9 | 8 | 1 | 0 | 0 |
| Nov 13 06:00–10:00 | 69 | 12 | 9 | 3 | 0 | 0 |
| Nov 13 10:00–16:40 | 87 | 16 | 13 | 1 | 0 | 2 |
| Nov 13 16:40–20:00 | 66 | 17 | 10 | 6 | 1 | 0 |
| **Total** | **291** | **54** | **40** | **11** | **1** | **2** |

Across both complete service dates, there were 57 NYC Ferry collisions (43 mixed-source, 11 two-schedule, one three-schedule, two two-realtime), plus two Statue and one NY Waterway schedule/schedule collisions. The three extra NYC Ferry collisions fall outside these windows.

The evidence artifact lists **every one of the 54 window collisions**, both/all track keys, boat names, sources, row ids, event times, nearby dwells, and saved trip/run state: `artifacts/harbor/double-claim/live-evidence.json`. Reproduce with `node artifacts/harbor/double-claim/inspect.mjs`; the script opens only `new DatabaseSync(path, { readOnly: true })`. It reads the live JSON snapshot separately, so that snapshot and the database are not an atomic pair.

**Ordering limit:** `trip_observations` has neither insertion/update timestamps nor an event log. Increasing row ids establish initial insertion order in this base collector, but an upsert can change a row's source and event fields later without changing its id. Exact source-write order and the time of an operator observation cannot be recovered. In 27 mixed-source collisions the current realtime row has the earlier id; in 13 the current schedule row does. These are insertion-order groups, not proof of which source spoke first.

The saved snapshot was timestamped 20:53:02. No collided trip was held by two tracks in that snapshot; only Munsee still held `2321` and Koalafied Cruiser still held `1910`, one claimant each. Other colliding rows represented tracks whose current trip was null or different. There is no withdrawn flag in the table: the obsolete claims still look like accepted observations and remain available to history and pattern learning. The snapshot cannot establish whether both boats were believed simultaneously earlier.

## Causes

### 1. Withdrawal did not reach storage; later guesses ignored historical ownership

All **40 mixed-source collisions** are consistent with these two independently reproduced paths. `withdrawGuesses` cleared another track's `trip` only: it neither deleted its observation nor cleared its inherited run. Conversely, `matchFreeTrip` reserved only other tracks' *current* trips; a completed, expired, or replaced realtime trip stopped reserving its service-day sailing even though its observation remained. The database unique constraint names the track as well as the trip/date, allowing both rows.

Four examples from the 13 mixed collisions whose schedule row was initially inserted first:

| Trip / service date | Scheduled first departure | Earlier row | Later row |
| --- | --- | --- | --- |
| `606` / Nov 13 | 07:14 | Opportunity #250, schedule departure 07:59:04, stop `114` | Jewel of the Harbor #299, operator-rt, event time unavailable |
| `923` / Nov 13 | 08:08 | Sunset Crossing #258, schedule departure 08:10:17, stop `87` | Great Eagle #292, operator-rt, event time unavailable |
| `1012` / Nov 13 | 08:35 | Traversity #271, schedule departure 08:32:25, stop `113` | Koalafied Cruiser #301, operator-rt, event time unavailable |
| `1488` / Nov 13 | 08:30 | Owl’s Head #274, schedule departure 08:34:56, stop `87` | Bay Hopper #302, operator-rt, event time unavailable |

Four examples from the 27 mixed collisions whose realtime row was initially inserted first:

| Trip / service date | Scheduled first departure | Earlier row | Later row |
| --- | --- | --- | --- |
| `2281` / Nov 12 | 18:21 | Traversity #87, operator-rt, event time unavailable | Purpose #129, schedule departure 19:45:23, stop `17` |
| `2282` / Nov 12 | 19:05 | Jewel of the Harbor #104, operator-rt, event time unavailable | Dream Boat #144, schedule departure 20:08:52, stop `87` |
| `2293` / Nov 12 | 18:58 | Dream Boat #105, operator-rt, event time unavailable | Starlight #141, schedule departure 20:04:13, stop `87` |
| `2244` / Nov 12 | 19:26 | Starlight #117, operator-rt, event time unavailable | Happy Hauler #134, schedule departure 19:52:46, stop `20` |

The later departure can be at an intermediate call, explaining why its clock time is much later than the trip's first scheduled departure. This is not evidence of an out-of-window match without checking that call's scheduled time.

### 2. Timetable guesses were exclusive only while the first trip stayed live

There are **12 timetable-only collided trips: 11 pairs and one triple**. Once the first track dropped or changed its trip, another boat could claim the same service-day trip at a subsequent call. While the first track still held it, the code instead excluded the trip completely; it could not reconsider an earlier, weaker guess when a better departure arrived. Two boats leaving one landing therefore used first-ingested ownership, rather than comparing the evidence. The live rows demonstrate reuse across calls; they do not establish that two boats left the same landing simultaneously.

| Trip / service date | Earlier row | Later row(s) |
| --- | --- | --- |
| `2927` / Nov 12 | McShiny #135, schedule departure 19:53:38, stop `17` | Urban Journey #147, schedule departure 20:13:16, stop `87` |
| `602` / Nov 13 | Unity #224, schedule departure 07:01:18, stop `113` | Owl’s Head #244, schedule departure 07:43:42, stop `87` |
| `1655` / Nov 13 | Time Traveler #262, schedule departure 08:11:07, stop `17` | Bay Hopper #281, schedule departure 08:41:46, stop `20` |
| `2239` / Nov 13 | Great Eagle #658, schedule departure 18:50:51, stop `19` | Urban Journey #674, schedule arrival 19:12:43, stop `87`; Bay Hopper #684, schedule departure 19:20:10, stop `20` |

### 3. Realtime-to-realtime transfers were not arbitrated

There are **two** such collisions, both on Nov 13; these are all available examples. `withdrawGuesses` only handled `source === "schedule"`. A second authoritative hull naming the trip could coexist with the first in memory and storage. Whether the upstream feed actually contained simultaneous conflicting reports, or these were successive reports, cannot be established from the observation table.

| Trip | Scheduled first departure | Earlier row | Later row |
| --- | --- | --- | --- |
| `2285` | 11:58 | Jewel of the Harbor #389, operator-rt | Rainbow Cruise #424, operator-rt |
| `1902` | 12:23 | City Fishy #399, operator-rt | Purpose #425, operator-rt |

Both observation event times are unavailable for both trips. The fix chooses between supplied reports; it does not claim to repair or explain the upstream feed.

### 4. Arrival updates erased evidence; allocation bypassed its own run reservation

The store upsert replaced absent departure fields with null on arrival confirmation. A second read-only query at 21:02:53 verified all **84 Friday evening observation rows**: 27 operator-rt rows with no event time, 46 schedule rows with a departure, and 11 schedule rows with an arrival only. Four of those 11 arrival-only rows occur in collided trips: Ferry Godmother #628 on `2234` (18:42:14 at `8`), Great Eagle #647 on `2203` (18:37:35 at `20`), Urban Journey #674 on `2239` (19:12:43 at `87`), and Great Eagle #699 on `2242` (19:37:13 at `87`). This is an overlapping evidence-loss defect, not 11 additional collisions.

Run inheritance does **not** write trip observations. The separate `allocate` defect accepted every direct trip and inherited run before checking any reservation, so a withdrawn trip's uncleared run could still be assigned alongside the winning boat. Stored pattern/model fallback also applied precedence per boat instead of across the fleet. These paths are demonstrated by invented-fixture tests; the historical live state has no allocation log from which to count their occurrences.

## Ownership rule and implementation

Ownership is scoped to **operator + trip id + normalized service date**, independent of whether the date was supplied dashed or compact. A completed or expired live trip remains reserved by its accepted observation for that service date. Source precedence is: **operator realtime, confirmed schedule, inherited run, tentative schedule, pattern, model**. A tentative departure does not displace an inherited run in allocation.

Between timetable claims of equal standing, an observed confirming arrival beats a departure without an arrival; otherwise the smaller absolute difference from the scheduled departure **at the observed landing** wins. Missing or invalid landing/time evidence sorts last. Exact ties use the lexicographically smaller track key, making replay order irrelevant. This keeps the boat nearest the correct call's time while allowing a confirmed continuation to outrank a coincidental on-time departure.

Between realtime reports, the newest operator report timestamp wins; exact timestamp ties use the same stable track-key rule. Operator timestamps are present in live/saved tracks but absent from the observation schema. For legacy realtime-only duplicates, startup reconciliation therefore retains the most recently inserted realtime row; its physical correctness is unknown. Newly accepted operator transfers replace that durable owner after live timestamp arbitration.

The store acquires its write lock, reads competing claims, deletes superseded rows, and writes the winner **in one transaction**. A failed insertion restores the previous claim; a failed durable transfer leaves the previous live owner intact and emits a warning. Same-owner arrival updates retain known departure evidence, and a contradicted schedule guess is explicitly removed. Startup reconciles legacy duplicates with the same precedence before restored tracks are accepted. No table, column, index, or schema version changed; nested store calls use savepoints.

**Superseded rows are deleted rather than retained as history.** This intentionally removes false observations from vessel history and future learning. A rejected guess is not stored as a second believable claim. Other trips and other service dates remain intact. Retaining a separate withdrawal/audit history would require a later agreed schema change.

The service clears a losing boat's trip and inherited run, keeps service-day reservations after live expiry, compares competing departures rather than excluding every existing guess, and applies ownership during snapshot restoration, including run-only anchors. Fleet allocation reserves direct and inherited assignments in source order, then applies pattern-before-model fallback across the fleet.

## Verification

Tests were added before implementation. The first focused run failed **7 of 67 tests**, reproducing the principal persistence, reuse, source arbitration, departure-ranking, arrival-evidence, and run-precedence defects. Additional tests exposed the expired-trip/inherited-run case (1 failure) and fleet-wide stored pattern/model precedence (1 failure) before those fixes. Further tests exposed a failed durable transfer changing the live owner and a saved run-only anchor reviving transferred ownership (one failure each), also fixed before final verification. Transcripts are retained under `artifacts/harbor/double-claim/`.

Final commands (all exit 0):

- `node --test test/harbor-db.test.js test/harbor-memory.test.js test/harbor-schedule.test.js test/harbor-service.test.js test/harbor-store.test.js`: **125 passed**, 0 failed (`artifacts/harbor/double-claim/focused.log`).
- `npm test`: **840 passed**, 0 failed, up from 825 at the base revision (`artifacts/harbor/double-claim/npm-test.log`).
- `npm run test:harbor`: **10 E2E steps passed** (`artifacts/harbor/double-claim/test-harbor.log`, plus `artifacts/harbor/e2e.json`).
- `git diff --check`: passed.

All test fixtures are invented; service callbacks use fake AIS/operator feeds. The harbor E2E starts only loopback fake feeds and an isolated server/database, and writes `artifacts/harbor/e2e.json`.

The live database verified the collision counts, source pairs, first-insert ordering, saved-state comparison, and evidence loss only. **This fix has not run in the live collector, which remains on the base revision.** Tests establish behavior in this checkout; no post-fix live acceptance or physical hull assignment is claimed.

## Open issues

- Exact historical operator timestamps, upsert order, withdrawals, and simultaneous in-memory ownership cannot be reconstructed from the current schema. No audit-history schema was added.
- The origin of the two realtime/realtime conflicts remains for the operator-feed investigation. The service now enforces one owner for conflicting reports but cannot establish which physical boat was correct.
- Legacy arrival-only rows have already lost their departure evidence. The fix preserves future evidence but cannot reconstruct the lost fields. Legacy equal-standing claims with missing timing fall back to the stable key.
- Timetable matching and synthesized runs remain inferences. Exclusivity prevents duplicate credit, not every wrong route/trip match; no GTFS, roster, slip survey, or upstream feed was changed.
- Startup cleanup and future learning omit deleted false observations, but already saved `assignment_patterns` are rebuilt on the existing learning cadence, not migrated immediately. Pattern/model estimates remain subordinate to direct evidence.
