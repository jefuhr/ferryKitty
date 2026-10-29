# Ferry Kitty

An offline-capable staff app for ferry departures, crew assignments, trip connections, service alerts, and vessel positions. One responsive interface serves phones, tablets, and desktops.

The [fall schedule](docs/schedule-comparison/fall-2026-update.md) and
[weekend crew notes](docs/schedule-comparison/fall-weekend-2026.md) are integrated.
See [feed maintenance](docs/data-maintenance.md) for the September 20 refresh and preserved calendar corrections.

## Run

Clone [jefuhr/ferryKitty](https://github.com/jefuhr/ferryKitty) into `~/ferryKitty`.

The native iPhone and iPad app is in [`ios/`](ios/README.md). Run `scripts/ios.sh open` on a Mac with Xcode and XcodeGen installed. It shares the API with this web app and keeps its own offline data and preferences.

The native Android app is in [`android/`](android/README.md). It supports Android 12 and later with Jetpack Compose, an offline harbor chart, and configurable Home Screen widgets. Use `scripts/android.sh build` for local checks and `scripts/android.sh test` for isolated emulator journeys.

Requires Node.js 22 or newer.

```sh
npm ci
npm start
```

Open http://127.0.0.1:8090. Use `npm run dev` for server watch mode. The default host is loopback; set `HOST` and `PORT` for deployment.

Startup builds the configured landing's fallback file, then the server builds every active landing in memory from bundled schedules. Realtime and alerts are optional enrichments: published schedules remain usable when upstream services fail.

## Using the app

Choose a landing from the drawer or desktop sidebar. The choice, favorites, operator filters, theme, sort order, and clock format persist on the device. Browse dates within the bundled service calendars, or open a departure for its stops and connections. The map shows reporting NYC Ferry vessels.

Choose **Riding this boat?** from a vessel card, a current-day NYC Ferry trip, or a selected map route to pin a physical vessel. Riding mode opens at `/ride` (also `/ferryTimesMobile/ride`) and returns whenever the app comes back to the foreground. **Minimize** keeps a return bar while browsing; **Exit boat** clears the session. Unknown assignments open a vessel picker. The dashboard shows arrival estimates separately from departure times, speed, a small harbor map, and recorded confirmed trip assignments.

The day view contains confirmations observed during normal app use, so it can have gaps. It does not extrapolate future trips or synthetic crew/home-port movements from a route working. Assignment history is saved atomically in `state/vessel-trip-history.json` for the current and previous service days; there is no background collector. Offline snapshots retain their date and show scheduled times instead of stale estimates. No device location permission is needed.

Run `npm run test:riding-mode` for deterministic Chromium coverage of boarding, picking/switching vessels, minimizing, foreground restoration, reloads, offline use, exit races, both deployment paths, and responsive themes. Screenshots, traces, and results are written to `artifacts/browser/riding-*`. This is browser emulation, not physical iOS/Android certification.

### Departure notifications

In riding mode, **Turn on notifications** requests permission and subscribes this device to scheduled departures for its selected physical vessel. Alerts continue when minimized, locked, or closed. **Turn off notifications**, **Exit boat**, and switching boats stop the subscription; enable notifications again for a new boat. iPhone/iPad users must install the app with Safari’s **Add to Home Screen** and open that installation first (iOS/iPadOS 16.4+). HTTPS is required except for local development on localhost. Phone settings control sound and delivery; these are scheduled-time reminders, not confirmation that the boat has left.

The server refreshes the shared ferry feed every 15 seconds only while notification subscriptions exist, and checks departures every second. It sends one Web Push per scheduled call on a recently confirmed vessel trip, excluding skipped/canceled/reassigned calls and final drop-offs. The next confirmed trip supplies the departure after a terminal layover. Times use the original GTFS service day, including overnight calls. Stale assignments suppress alerts; missed alerts are discarded after 60 seconds. Short-lived push messages and saved delivery IDs avoid catch-up bursts and restart duplicates.

On first startup the server generates private VAPID keys in ignored `state/ride-push-keys.json`; subscriptions and delivery IDs are stored in `state/ride-push-subscriptions.json`, both with mode `0600`. Keep these files and the writable `state/` directory across restarts/deploys; do not publish or commit them. This scheduler assumes one app process owns the state directory. `WEB_PUSH_SUBJECT` can override the default contact URL `https://juliet.nyc/ferryTimesMobile/`. Outbound HTTPS to browser push services must be available. No external account is required. A broken notification store disables notifications while leaving the board available.

Run `npm run test:ride-notifications` for browser coverage of enabling, minimizing, reload, disabling, exit, both deployment paths, and responsive layouts. It mocks notification permission and push registration; `node --test test/ride-notifications.test.js test/ride-notification-client.test.js test/ride-push.test.js` checks scheduling, persistence, permission/exit races, API restrictions, and the worker’s notification/click handlers. Artifacts are saved as `artifacts/browser/ride-notifications-*`. Actual lock-screen delivery needs a subscribed physical device and is not certified by these checks.

The responsive staff layout is identical at the root and under the existing `/ferryTimesMobile/` deployment prefix. The fixed-screen kiosk mode has been retired.

## Configuration and data

- `config/display.json`: default landing, lookahead window, departure count, and operator switches.
- `config/landings.json`: active landing IDs and operator stop mappings.
- `gtfs/`: bundled operator feeds; `content/` and `config/crew-shuttles.json`: fleet and operational data.
- `state/`: runtime feed snapshots and aggregate statistics. Keep this directory persistent.

After updating feeds or configuration, run `npm run build` and restart the server. Maintain transcribed feeds and crew assignments using the procedures in [Schedule and operator maintenance](docs/data-maintenance.md). Geographic refresh procedures and attribution are in [Harbor map](docs/harbor-map.md).

### Sukkot live trip mapping

The September 28–October 2 timetable remains in `schedules/sukkot-2026.json`. NYC Ferry's
GTFS version `20260928` gives its departures real trip ids, archived in
`schedules/fall-2026-sources/nycferry-20260928.zip`. The supplied assignment board is retained
as operational notes without crew names. Ordinary October service uses the separately reviewed
`20261028` feed. Rebuild each mapping from its own archive:

```sh
python3 scripts/import-sukkot-board.py /path/to/sukkot.xlsx
python3 scripts/import-sukkot-live.py schedules/fall-2026-sources/nycferry-20260928.zip
python3 scripts/import-sukkot-crew.py
python3 scripts/import-post-sukkot-live.py schedules/fall-2026-sources/nycferry-20261028.zip
npm run build
npm run stamp:bump
```

Sukkot cells link to live data only when route, stop, and time identify one operator trip. Fall
trips link to reissued October ids only when the route, working, stops, and times match on the
service date. Cruise-day identities are date-specific; dates without a verified match stay
scheduled. The feed freshness check excludes completed historical supplements. Unmatched
rows remain scheduled. The Pier C board uses the assignment notes' first pickups, matched to
the operator's holiday trips. Its times mean first pickup at the destination; the captain chooses
the Pier C departure. The four crew shuttles replace the corresponding afternoon boat departures.
Verified last drops add out-of-service rows toward Pier C at the arrival landing, except when a
shuttle relieves that working. Four conflicting returns use the published trip's final arrival,
with their original notes retained in `schedules/sukkot-2026-crew.json`. Two return notes remain
withheld there until dispatch confirms them. Two corrected pickups use the
published trip times at `Board!K2` and `Board!C26` with the original note times retained in the
crew data. `npm run check:nyc-feed` and the daily GitHub workflow flag a new operator feed version,
and fail once no reviewed map covers today. A failed workflow run uploads the fetched ZIP and a
regenerated post-Sukkot map as the `nyc-ferry-feed-candidate` artifact to start the review from.
The production host can run the same check daily with the units in `deploy/systemd/`; their
failures appear in `journalctl -u nyc-ferry-feed-check.service`. GitHub scheduled workflows run
only after this workflow reaches the repository's default branch. Shift-end notes that conflict
with the timetable remain unconfirmed, including their Pier C movements.

Verified feed stop lists now restore through-trip details and layovers. The separate printed
Pier 11 arrival/departure pairs restore 65 dwells; realtime retains the original feed arrival
baseline and separate arrival/departure delays. See [Sukkot verification and the two withheld
returns](docs/schedule-comparison/sukkot-2026.md).

## Offline behavior

Previously loaded landing schedules remain available and departures are recalculated as time advances. Live timings become stale when refreshes fail; browsing another date never applies today's realtime updates. A landing that has never been saved needs a connection first. Coverage is limited to the bundled calendars and exceptions.

The service worker caches the board, map, modules, and API snapshots. It updates independently of the device's saved preferences. After changing shipped assets, run `npm run stamp:bump`.

SFTP landing notices and `/api/override` have been removed. Official service alerts and crew notices remain. Existing SFTP configuration, credentials, and notice state files are no longer read; this migration does not delete files from deployed systems.

## Development and verification

```sh
npm test
npm run test:staff-app
npm run test:mobile-route-layout
npm run test:mobile-viewport
npm run test:installed-ride-layout
npm run test:map-selection
npm run test:map-rendering
```

Browser checks require installed Playwright browsers and a running app. Set `MOBILE_TEST_ORIGIN` to its origin (default `http://127.0.0.1:8094`). Reports and screenshots go to ignored `artifacts/browser/`. Historical screenshots remain in `docs/mobile-upgrade/`.

`test:installed-ride-layout` uses bundled fixtures and needs no app server. It checks home-screen safe-area spacing with a minimized ride, larger text, search-field font sizes, keyboard/zoom recovery, and restoring bottom padding after exiting a ride. Chromium emulates the insets and viewport changes; native Safari keyboard focus zoom still needs a physical iPhone check.

The browser uses native ES modules with no bundler. Backend schedule construction lives in `lib/`; scripts are maintenance entrypoints. [Architecture and native-client preparation](docs/architecture.md) describes the boundaries, offline rules, and portable fixtures. The existing API is documented in [OpenAPI](docs/api.openapi.json).

## Deployment

```sh
docker compose up --build -d
```

Compose persists `./state`, binds port 8090 to loopback, and checks `/healthz`. Keep the existing reverse-proxy forwarding for `/ferryTimesMobile/`, `/api/`, `/assets/`, `/app.js`, `/styles.css`, and `/sw.js`. The deployed web manifest retains its existing prefix and installation identity. See [Deployment](docs/deployment.md).

Product changes are maintained in `content/changelog.json`.

### Browser checks in GitHub Actions

`Critical browser E2E` runs on pull requests, pushes to `mobile`, daily at
12:45 UTC, and manually from the Actions tab. Three independent jobs cover live
boat names/delays and trip connections at mobile/desktop widths, riding mode on
both deployment paths, and map vessel selection/rendering. Each job installs the
lockfile dependencies and Chromium, builds schedules, and starts a local server.
Live timing and vessel assertions use fixtures rather than the operator's live API.

Each job uploads logs, screenshots, and Playwright traces for 14 days, including
failed runs. Download its `browser-*` artifact and open a trace with
`npx playwright show-trace path/to/trace.zip`. To reproduce locally, start
`HOST=127.0.0.1 PORT=8094 node server.js`, then run the corresponding scripts from
`.github/workflows/browser-e2e.yml` in another terminal. These Chromium checks do
not replace native iOS or Safari testing.

## Automated deployment

Production pushes and manual runs deploy through the self-hosted Mac runner. See [GitHub Actions deployment](docs/github-actions-deploy.md) for triggers, dry runs, runner management, backups, and verification.
