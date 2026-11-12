# Architecture and native-client preparation

The current product is a responsive staff web app. The iOS UI technology remains undecided; native UI, distribution, authentication, and native-only features are outside this change.

## Boundaries

- **Backend:** `lib/schedule-builder.js` builds landing schedules from bundled feeds. `lib/out-of-service.js` enriches them with crew and home-port movements. `scripts/build-data.js` writes the default fallback; existing script imports remain compatible through re-exports.
- **Portable rules:** `public/assets/schedule.js` has no DOM, storage, networking, or framework dependencies. Supply schedule data, realtime snapshot, selected date, current instant, and result limit. It returns plain departure groups or a timeline. Backend connections reuse its calendar and timezone helpers.
- **Client infrastructure:** `MobileRuntime` supplies browser `request(url, options)`, `poll(callback, interval)`, and resilient `storage.getItem/setItem/removeItem/json` adapters. `createScheduleStore({ storage, prefix })` isolates saved schedules by landing. A native implementation can supply equivalent capabilities without reproducing browser APIs.
- **Application shell:** `assets/app-shell.js` owns URL/history navigation, the fixed shared header, theme changes, and service-worker registration. Root, prefixed, and `map.html` URLs serve the same document. `map.html` is an identical static-host compatibility copy of `index.html`; update both together.
- **Presentation:** `app.js` exports `mountBoard`; `assets/map.js` exports `mountMap`. Each accepts its view root and an optional `header` element, and returns `ready`, `activate(url)`, `deactivate()`, and `dispose()`. Element lookups cover only that root and heading group. Mount once per view. Hidden views and headings are inert, release dialogs, stop polling and camera animation, and retain their DOM/state. `view-lifecycle.js` keeps in-flight poll guards across activations. Map geometry is fetched once per shell and its drawing is reused. Idle preloading starts after the initial view's first load and respects data-saving mode.
- **Riding:** `assets/ride.js` implements the same view lifecycle at `/ride`. A shell-owned controller holds the device-local session and polls the ride response while visible, including when minimized. Returning to the foreground restores the ride; exit invalidates outstanding requests. Its small SVG map shares Mercator projection helpers and the shell's geometry cache. `lib/ride.js` observes successful shared feed refreshes, stores bounded assignment history, and exposes `/api/vessels` and `/api/ride`. Only feed assignments confirm trips; selecting a vessel or resolving its workbook working does not. Arrival and departure events remain separate, keyed by stop sequence and service date. Confirmed assignment history is not proof of actual arrivals or an exhaustive operating log.
- **Layout:** `assets/app-shell.css` owns the real header grid (title, secondary controls, right-aligned navigation) and shared theme-aware control/font tokens. The shell measures the header with ResizeObserver so view bounds follow safe areas and enlarged text without overlapping headings. Fonts prefer each theme's system stack, with bundled Lato as the sans-serif fallback. The Board landing rail is permanent at 821px and wider; below that it is a dismissible drawer. `panels.js` binds sheet controls, `preferences.js` owns persistent keys and theme choices, and `styles.css` owns theme palettes and the Board layout. Map-specific drawing and layout styles remain separate.

There is no requirement for a future native app to execute JavaScript. It can implement the documented contract in its own language and verify the same fixtures.

## Offline schedule contract

The wire schedule remains schema version 11. IDs are opaque strings (including operator prefixes); landing IDs are integers. Preserve source IDs rather than parsing their numeric-looking contents.

Store the complete landing payload, including calendars, exceptions, routes, departures, trip stop lists, and stop names. Successful refreshes replace the saved snapshot; a failed refresh must not discard it. Reject payloads for a different landing. Retain the current browser storage keys so existing installations keep their schedules and preferences.

Dates are local calendar dates in `meta.timezone`; timestamps are ISO instants. Departure seconds are measured from service-day midnight and can exceed 86400. Calendar exceptions override regular weekdays. After-midnight departures may belong to the previous service day. Coverage follows each service calendar and dated exception, not merely the primary feed's date range.

Live timing requires a non-stale snapshot and a finite delay. Negative delays never move a departure earlier than its published time. Existing cancellation and vessel-assignment behavior is retained for cached snapshots; freshness must remain visible to the user. Predictions are distinct from confirmed vessel assignments. A browsed date ignores live enrichments.

Departure-only holiday rows (`scheduleOnly` / `timetableOnly`) never acquire live delays,
cancellations, or vessel predictions. Crew confirmation is scoped by weekday/weekend coverage,
season dates, and excluded holidays in `meta.crewScheduleStatus`; outside that coverage,
shift-end badges must not imply confirmation. These rules live in the portable schedule module.

A saved schedule continues to calculate departures as time advances. No matching service outside its coverage is not evidence that service ended for the day. The web app reports unavailable date coverage and prevents browsing outside its advertised range. A native client must show coverage and stale-data state explicitly.

Connections across landings still need a cached server response or additional landing schedules. The prepared contract does not promise offline access to landings or connections never downloaded.

## Cross-platform verification

`test/fixtures/schedule-contract.json` contains a shared schedule, fixed current instants, realtime inputs, and expected departure projections. Compare only the expected fields, in order. It covers advancing offline time, overnight service, holidays, cancellations, delay floors, stale timing, vessel predictions, crew movements, and expired coverage. Timezone cases cover both daylight-saving transitions.

`test/schedule-contract.test.js` executes these cases directly against the portable module. A future native implementation should execute the same JSON cases before UI parity work.

The current HTTP surface is recorded in `docs/api.openapi.json`. Unknown JSON fields are additive. A future incompatible schedule format needs a new supported schema version and a migration strategy; this cleanup does not renumber the existing format.

`npm run test:staff-app` verifies persistent navigation at root and prefixed URLs across 390px,
768px, and 1440px widths: exact header coordinates, 820/821px resizing, legacy hidden-rail
preferences, retained date/scroll/camera/search/geometry, Back/Forward, deep links, offline
reloads, and synchronous warmed switches below 100ms. Run with a local app on port 8094 (or
`MOBILE_TEST_ORIGIN`). Node lifecycle tests cover inactive polling, focus-trap release,
disposal, and in-flight requests across rapid switches; worker tests cover saved-data migration.

`npm run test:visual-polish` uses deterministic schedules and vessel positions without an app
server. It checks both views in all nine themes at 320, 390, 768, 820, 821, 1440, and 1920px,
including matched control/text fonts, title hierarchy, right-aligned navigation, 44px controls,
contrast on navigation/filter/status surfaces, long names, card actions, keyboard focus, empty
states, and enlarged text. Representative screenshots and the matrix report are written under
`artifacts/browser/`. This is Chromium coverage, not a claim of physical-device Safari testing.

Map route filters live in a modal drawer opened by the Map header hamburger at every width.
The Board's desktop landing sidebar remains independent. Route selection is retained while the
drawer itself closes on view deactivation; modal focus and background inertness are released
without focusing an inactive view. `npm run test:map-drawer` checks phone/desktop breakpoints,
route selection, keyboard trapping/dismissal, history navigation, offline use, and enlarged text.

## Departure notifications

`lib/ride-notifications.js` schedules published departures for recently confirmed physical-vessel assignments. It shares `realtimeService` with the board and refreshes only while push subscriptions exist. `lib/ride-push.js` owns the Web Push transport, persistent VAPID identity, and uncached per-device subscription API. Bearer tokens stay on the device; only token hashes are stored on the server. Known HTTPS browser-push hosts and valid P-256 keys are required. Subscription endpoints and keys are private state, never client-readable roster data.

`public/assets/ride-notifications.js` handles gesture-bound permission, subscription persistence, and cancellation before switching/exiting. Browser unsubscribe lets an offline device stop alerts; failed server cleanup is retained for the next connection. If both cancellation paths fail, the ride stays open with a retry message. `public/sw.js` displays push notifications without an open page and routes notification taps to the appropriate `/ride` deployment path. Notification settings bypass both service-worker and HTTP caching.

## Harbor tracker

The harbor tracker answers where every passenger ferry is and what it is doing, for every operator, from AIS. It is separate from the board's own boat positions (`/api/boats`), which come from NYC Ferry's feed and cover NYC Ferry only. `docs/harbor-contract.md` fixes the shapes and thresholds its modules share; read that before changing any of them.

`lib/harbor-service.js` is the one stateful piece. It holds a track per transponder, feeds each fix through the pure reducer in `lib/harbor-state.js` (docked, arriving, departing, underway, laid-up, unknown), and turns the reducer's events into trips with `lib/harbor-schedule.js`. Positions arrive on one server-side websocket to aisstream.io (`lib/ais-stream.js`), which reconnects on its own and is never opened from a browser. The operator's GTFS-realtime feeds are an enrichment, read only when a harbor endpoint is asked for, exactly as `/api/boats` reads them: they confirm trip ids, place a hull AIS cannot currently see, and let the tracker learn which transponder a boat carries by watching the two keep station (`lib/harbor-fusion.js`). AIS is the position of record whenever it is fresh.

Vessels are known by `content/harbor-roster.json`, which keeps the ids of `content/vessels.json`. MMSIs there may be null; the tracker binds them by exact AIS name or by proximity and remembers what it learned. A committed MMSI always wins. Passenger-type vessels that are not in the roster are logged for curation and shown only with `?include=unrostered`.

Berth positions come from a personal survey committed as `content/harbor-slips.csv` (override with `HARBOR_SLIPS_CSV`). Without the file the tracker reports landings and leaves slips blank. A slip is reported with a confidence, and two berths on one face are reported as ambiguous rather than guessed.

Routes, all additive:

- `/api/harbor/vessels` is the `Boats` envelope with a `HarborVessel` per rostered vessel: the `Boat` fields plus state, landing, slip, identity and trip provenance.
- `/api/slips` and `/gtfs-rt/tripupdate` reproduce the two shapes `ios/FerryCore/Sources/FerryCore/FerryRT.swift` reads. The trip update is NYC Ferry's own feed with a call's `stop_id` and `assigned_stop_id` replaced by the slip id while that trip's vessel is docked there with confidence of at least 0.8. A slip is named once a boat is in it, not before it arrives.

Configuration is by environment: `AISSTREAM_API_KEY` (without it the stream is disabled and the endpoint says so), `AISSTREAM_URL`, `HARBOR_SLIPS_CSV`, `AIS_REPLAY_PATH` (replay a capture made with `scripts/record-ais.js` when there is no key) and `STATE_DIR`. The live picture restarts from two JSON files beside the board's own (`harbor-tracks.json`, `harbor-identities.json`), written atomically; a restart reloads them and ages what it finds.

### Fleet database and assignments

Everything the tracker learns over days lives in `state/harbor.db` (SQLite through `node:sqlite`; schema in `lib/harbor-db.js`, access through `lib/harbor-store.js`). The reviewed fleet list in `content/harbor-roster.json` seeds it at boot: seven operators, and vessels with a reference for every researched fact. The tracker writes to it as things happen (`lib/harbor-memory.js`): each ferry-like transponder seen, each dwell at a terminal, each link between a transponder and a hull, each trip a boat was matched to, and any two transponders claiming one name, which is kept as a conflict for a person to settle.

Terminals the board does not show, mostly in New Jersey, come from `config/harbor-terminals.json` (public GTFS stop positions) and are 120 m zones until someone surveys their slips.

Only NYC Ferry's operator says which boat runs which trip. For everyone else it is estimated. `lib/harbor-runs.js` chains each operator's timetable into runs, the sequence of trips one boat can work in a day. A boat matched to a trip is on that trip's run; between trips it keeps the run; before its first trip of the day the estimate comes from patterns learned from earlier confirmed days, and failing that from an estimate Claude wrote overnight. Every estimate carries its source (`operator-rt`, `schedule`, `run`, `pattern`, `model`) and a confidence. Claude is never in a request path: `scripts/harbor-assign.mjs` submits one batch a night to `claude-haiku-5-5`, sends what that flags to `claude-opus-5-5`, stores the results with their evidence, and stops at a daily spend cap (`HARBOR_LLM_DAILY_USD`, default 1).

`scripts/harbor-research.mjs` turns unknown transponders that keep docking at one operator's terminals into roster proposals with references (AIS evidence, FCC ship licences), written to `content/harbor-roster.proposed.json` for review; it never edits the roster. `scripts/harbor-calibrate.mjs` replays captures against the slip survey and reports how each slip-model setting would have named the dwells.

`npm run test:harbor` starts the real server against a fake AIS socket and a fake operator feed, replays an arrival, a dwell and a departure, checks all three routes and an AIS outage, and writes `artifacts/harbor/e2e.json`. It needs no key and no network. Live behaviour against aisstream.io is not covered by any automated check.
