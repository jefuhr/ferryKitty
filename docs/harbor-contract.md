# Harbor tracker contract

The harbor tracker answers one question: where is every passenger ferry in New York Harbor, and what is it doing. AIS is the primary source. This document fixes the shapes and thresholds that the harbor modules share, so that each can be built and tested on its own and still fit the others. If a module needs something this document does not give, the document changes first.

All modules are ES modules in flat `lib/`, with tests in flat `test/`. Pure functions are named `normalizeX` or a plain verb; anything with state or I/O is a `createXService({ ...deps })` factory that takes `now`, `fetchImpl`, `WebSocketImpl` and paths as parameters. JSON is camelCase. Units are metres, knots, degrees clockwise from true north, and epoch **milliseconds** unless a field name says otherwise.

## Privacy rule

Berth coordinates come from a private file that is read at runtime and is never in this repository. No test, fixture, log line, API response or state file may contain a real berth coordinate. Tests use `test/fixtures/harbor/`, whose landings and coordinates are invented. Code must never log a slip point, and no API output carries one.

## Modules

| Module | Exports |
|---|---|
| `lib/harbor-geo.js` | `distanceMetres`, `bearingDegrees`, `angleDifference`, `offsetPoint`, `median` |
| `lib/harbor-slips.js` | `parseSlipCsv`, `slipId`, `buildSlipIndex`, `assignSlip` |
| `lib/harbor-roster.js` | `loadRoster`, `buildRoster`, `rosterFromFleet`, `resolveIdentity` |
| `lib/ais-stream.js` | `createAisStream`, `normalizeAisMessage`, `HARBOR_BOUNDING_BOXES` |
| `lib/harbor-state.js` | `advanceTrack`, `refreshTrack`, `emptyTrack`, `THRESHOLDS` |
| `lib/harbor-schedule.js` | `buildHarborSchedule`, `matchDeparture`, `confirmArrival` |
| `lib/harbor-fusion.js` | `joinOperatorPositions`, `proximityBindings`, `operatorFix` |
| `lib/harbor-api.js` | `describeHarborVessels`, `encodeSlips`, `encodeTripUpdates` |
| `lib/harbor-service.js` | `createHarborService` |

`lib/harbor-geo.js` exists already. Use it; do not write a second distance function.

## Fix

One position report, whatever its source.

```js
{
  mmsi: "367000001",          // 9-character string, or null for an operator fix with no MMSI yet
  latitude: 40.5, longitude: -74,
  sogKnots: 11.2,             // null when unavailable
  cogDegrees: 91.5,           // null when unavailable
  headingDegrees: 90,         // true heading, null when unavailable
  navStatus: 0,               // AIS navigational status, null for Class B and operator fixes
  at: 1794400000000,          // when the position was measured or, failing that, received
  source: "ais",              // "ais" | "operator"
  aisClass: "A"               // "A" | "B" | null
}
```

AIS "not available" values become null on the way in: true heading 511, course 360, speed 102.3 or more, latitude 91, longitude 181. A fix without a usable latitude and longitude is dropped.

## Static data

Arrives separately from positions and is cached per MMSI.

```js
{ mmsi, name: "TEST FERRY ONE", callSign: "WDX0001", shipType: 60, imo: null,
  dims: { a: 10, b: 16, c: 3, d: 4 },   // metres from the antenna to bow, stern, port, starboard; null when all zero
  aisClass: "A", at }
```

Names and call signs are trimmed, and AIS padding (`@` and trailing spaces) is removed. An empty string becomes null.

## AIS stream

`normalizeAisMessage(raw)` takes one decoded aisstream.io JSON message and returns `{ kind: "fix", fix }`, `{ kind: "static", static }`, `{ kind: "error", message }` or `null` for anything else. The wire shape is `{ MessageType, MetaData, Message: { [MessageType]: body } }`. Field names in the bodies are aisstream's and are confirmed against its published models:

- `PositionReport` (Class A): `UserID`, `Latitude`, `Longitude`, `Sog`, `Cog`, `TrueHeading`, `NavigationalStatus`, `Timestamp` (second of the minute), `Valid`.
- `StandardClassBPositionReport`, `ExtendedClassBPositionReport` (Class B): `UserID`, `Latitude`, `Longitude`, `Sog`, `Cog`, `TrueHeading`, `Valid`. The extended report also carries `Name`, `Type`, `Dimension` and so yields a fix; its static part may be ignored in v1.
- `ShipStaticData`: `UserID`, `Name`, `CallSign`, `Type`, `ImoNumber`, `Dimension: { A, B, C, D }`, `Destination`.
- `StaticDataReport`: `UserID`, `PartNumber` (a boolean: false is part A, true is part B), `ReportA: { Valid, Name }`, `ReportB: { Valid, ShipType, CallSign, Dimension }`. Merge whichever part is valid into the cached static record. A null in a newer record never erases a known value.
- An error is `{ "error": "..." }` (also accept `Error`).

`MetaData` is an untyped map. In practice it carries `MMSI`, `ShipName`, `latitude`, `longitude` and `time_utc` (for example `"2026-11-11 15:00:00.123456789 +0000 UTC"`), but that is from observation, not from a schema. Read the MMSI from the body's `UserID` first and `MetaData.MMSI` second. Read the time from `MetaData.time_utc` when it parses and is no more than 60 seconds ahead of the receive time, and otherwise use the receive time: a timestamp from the future would outrank every honest fix after it. A body with `Valid === false` is dropped.

```js
createAisStream({
  url = "wss://stream.aisstream.io/v0/stream",
  apiKey,                          // absent → the stream reports "disabled" and never connects
  boundingBoxes = HARBOR_BOUNDING_BOXES,
  mmsiFilter = null,               // optional array of up to 200 MMSI strings
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
  onFix = () => {}, onStatic = () => {}, onStatus = () => {}
}) → { start(), stop(), status() }
```

- The subscription is sent inside the socket's `open` handler: `{ APIKey, BoundingBoxes, FilterMessageTypes, FiltersShipMMSI? }`. Each box is `[[lat, lon], [lat, lon]]`. `HARBOR_BOUNDING_BOXES` is `[[[40.38, -74.12], [41.22, -73.75]]]`.
- `binaryType` is `"arraybuffer"`. A frame may be an `ArrayBuffer`, a typed array or a string; all decode as UTF-8 JSON. A frame that does not parse is counted and skipped.
- `status()` returns `{ state, connected, lastMessageAt, connectedAt, reconnects, messages, dropped, lastError }` where `state` is `"disabled" | "connecting" | "open" | "waiting" | "stopped"`. `onStatus` is called with the same object on every change of `state`.
- Watchdog: a socket with no message for 120 s is closed and reconnected. It is armed when the socket is created, so a handshake that never completes is caught too.
- Reconnect delay doubles from 1 s to a ceiling of 60 s, with ±20% jitter from `random`, and resets after a connection has stayed open for 60 s. After an error message from the server (a bad key, for instance) the delay is 5 minutes.
- One connection at a time. `stop()` closes the socket, cancels every timer and prevents any reconnect.
- TLS verification is never disabled, and the API key is never logged or included in `status()`.

## Roster

`content/harbor-roster.json`, committed:

```json
{ "version": 1,
  "operators": [{ "id": "nycf", "name": "NYC Ferry", "feedPrefix": "" }],
  "vessels": [{ "id": "waves-of-wonder", "operatorId": "nycf", "name": "Waves of Wonder", "number": "H-101",
                "mmsi": null, "callSign": null, "aisNames": [], "active": true }] }
```

NYC Ferry entries are generated from `content/vessels.json` by `rosterFromFleet(fleet)` and keep the same `id`, so a harbor vessel joins `/api/vessels`. Other operators use a prefixed id such as `sif:<slug>` and the `feedPrefix` their GTFS ids carry in this repo (`wtr:`, `sea:`, `sif:` and so on; see `PARTNER_FEEDS` in `lib/schedule-builder.js`). MMSIs are filled in later; `null` is normal.

`loadRoster({ rosterPath, learned = [] })` is async, reads the file and returns what the pure `buildRoster({ operators, vessels }, learned)` builds: `{ operators, vessels, byMmsi: Map, byId: Map }`. `byMmsi` maps an MMSI to `{ vesselId, source, at }` (`source` is `"roster"` for a committed MMSI, with `at: null`). `byId` maps a vessel id to its record, with its effective `mmsi` and a `learned` flag. `rosterFromFleet(fleet)` returns the array of vessel entries. `learned` is a list of `{ mmsi, vesselId, source, at }` bindings from state; a committed MMSI always wins over a learned one, and a learned binding for an MMSI or vessel the roster already binds is ignored.

`resolveIdentity({ mmsi, staticData }, roster)` returns `{ vesselId, source }` or null, trying in order:

1. `"roster"` — the MMSI is in the roster (committed or learned; a learned one reports its own stored source).
2. `"ais-name"` — the AIS name, passed through `normalizeIdentity` from `lib/realtime.js`, exactly equals a roster vessel's normalized `name` or one of its `aisNames`, and exactly one vessel matches. No substring matching. A vessel already bound to a different MMSI is not a candidate, so one hull is never claimed by two transponders.

Proximity binding is the fusion module's job and arrives as a learned binding.

## Slips

The private file is a CSV with the header `landing,slip,latitude,longitude`. `landing` is a stop name as it appears in the root `gtfs/stops.txt`, except the home-port yard, which is named `Pier C`.

```js
parseSlipCsv(text, { stops, aliases = {}, yardLandings = { "Pier C": { landingStopId: "home-port", token: "PIERC" } }, warn = () => {} })
  → [ slip ]
```

`stops` is a list of `{ stopId, name, latitude, longitude }` (root GTFS stops). A row whose landing matches neither a stop name nor a yard landing is skipped with one call to `warn` that names the landing and never the coordinates. Rows that share a landing and slip label are one slip with several points.

```js
slip = {
  id: "NYCF_9001_SLIP_2",
  name: "Slip 2",                // the label exactly as written
  platformCode: "2",
  landingStopId: "9001",         // "home-port" for the yard
  kind: "passenger",             // "passenger" | "yard" | "fuel" | "drydock"
  points: [{ latitude, longitude }]
}
```

`slipId(landingToken, label, { aliases = {}, landingStopId = landingToken, yard = false })` returns `{ id, token, platformCode, kind }`, where `id` is `NYCF_<landingToken>_<TOKEN>` and `landingToken` is the stop id or the yard token:

| Label | Token | platformCode | kind |
|---|---|---|---|
| `Slip 2`, `SLIP_25`, `slip 2` | `SLIP_2`, `SLIP_25` | `2`, `25` | passenger (yard at a yard landing) |
| `Slip B1` | `B1` | `B1` | passenger |
| `North`, `South` | `NORTH`, `SOUTH` | `N`, `S` | passenger |
| `East`, `West` | `NORTH`, `SOUTH` | `E`, `W` | passenger |
| `<WORDS> #1` | `<WORDS>_1` | `1` | yard (overnight storage beside a landing) |
| `Dry Dock` | `DRY_DOCK` | `DD` | drydock |
| `Slip <n> Fuel Tanks` | `SLIP_<n>` | `<n>` | fuel |
| `Slip <n> <other words>` | `SLIP_<n>` | `<n>` | yard |

East and West map to `NORTH` and `SOUTH` because that is what the Ferry RT catalog does in `test/fixtures/ferry-rt-slips.json` (`NYCF_23_SOUTH` is named "West", `NYCF_115_NORTH` is named "East"). `aliases` overrides the token for one slip, keyed `"<landingStopId>|<label>"` with the real landing stop id (`home-port|<label>` in the yard); its value is the replacement token. `yard: true` forces a non-passenger kind. The fixture's catalog also lists the landing itself (`id: "87"`, no platform code); that row is not a slip and the id scheme does not apply to it. Anything else becomes the label upper-cased with every run of non-alphanumerics turned into `_`. Every slip at a yard landing has a non-passenger kind.

`buildSlipIndex(slips, { stops, landings = [] })` returns:

```js
{
  slips: [...],
  byId: Map,
  landings: [{ landingStopId, landingId, name, latitude, longitude, radiusMetres, slipIds: [...], yard: false }],
  nearestLanding(point) → { landing, distanceMetres } | null,
  slipsNear(point, radiusMetres) → [{ slip, distanceMetres }]   // distance is to the nearest of the slip's points
}
```

A landing with slips is centred on the mean of its slip points, and its `radiusMetres` is the greatest distance from that centre to any slip point plus 60 m, with a floor of 120 m. A landing with none (`landings` supplies `{ landingStopId, landingId, name, latitude, longitude }` for partner terminals) is centred on its stop coordinate. `landingId` is the board's landing number when known, else null.

`assignSlip(points, index, { landingStopId, headingDegrees = null, slipHeadings = new Map(), storage = false })` takes the docked fixes' positions and returns:

```js
{ slipId: "NYCF_9001_SLIP_2" | null, confidence: 0.83, ambiguous: false,
  candidates: [{ slipId, p, distanceMetres }] }   // sorted by p, best first
```

- The test point is the per-axis median of up to the last 10 points.
- Each slip of that landing within 60 m gets weight `exp(-d² / (2 · 12²))`. A "none" hypothesis gets the weight of a slip 45 m away. `p` is the weight over the sum of all weights, the none hypothesis included.
- `slipId` is the best candidate when its `p` is at least 0.6, otherwise null. `confidence` is the best `p` either way, and 0 with no candidates.
- When the two best slips are less than 25 m apart, `confidence` is capped at 0.6 and `ambiguous` is true.
- At a landing with at least one passenger slip, non-passenger slips (overnight storage berths, where boats raft up a few metres from the boarding slips) are candidates only when `storage` is true. The reducer passes `storage: true` once the dwell reaches the passenger lay-up time (90 minutes). A landing with no passenger slip ignores the switch.
- `slipHeadings` (slip id → degrees) is optional learned data. A candidate whose heading differs from the vessel's by more than 90° is dropped before weighting. With no entry, heading is ignored.

## Track and states

A track is everything known about one MMSI (or one operator-only vessel).

```js
{
  key: "367000001",             // the MMSI, or "vessel:<vesselId>" for an operator-only track
  mmsi, vesselId: null, identitySource: null,   // "roster" | "ais-name" | "proximity" | null
  static: null,
  fix: null,                    // the latest Fix
  recent: [],                   // up to the last 20 fixes, oldest first
  state: "unknown", stateSince: 0,
  moving: false,
  stale: false,                 // the fix is older than its freshness limit but the state still stands
  pending: null,                // { landingStopId, since, fixes, points } while a stop is being confirmed as a docking
  dock: null,                   // non-null only while docked or laid-up
  lastDock: null,               // the previous dock with `until`, kept for departure matching
  trip: null
}

dock = { landingStopId, landingId, slipId, kind, confidence, ambiguous, candidates, since, points: [...] }
// kind is the assigned slip's kind, "passenger" with no slip, and "yard" with no slip at a yard landing
trip = { tripId, routeId, serviceDate, source: "operator-rt" | "schedule", confidence, nextSequence }
```

`advanceTrack(track, fix, { slipIndex, assignSlip, now, slipHeadings })` is pure. It returns `{ track, events }` and never mutates its input. `assignSlip` is passed in (it is the function from `lib/harbor-slips.js`, with the signature given above) so that the reducer depends on the slip index's shape and not on its module. `refreshTrack(track, { now })` applies every purely time-driven change for the moments between fixes (stale, unknown at 20 minutes, `departing` expiring at 3 minutes, `docked` becoming `laid-up`) and returns `{ track, events }` too. `advanceTrack` computes the state from its fix and then applies the same time rules against `now`, so a late fix still updates the track and is marked stale. `emptyTrack(key)` gives a new track. Trip fields are set by the service, not by the reducer.

States, and the constants in `THRESHOLDS`:

| State | Enters when | Leaves when |
|---|---|---|
| `docked` | speed ≤ 0.5 kn within 35 m of a slip point (or inside the landing radius where a landing has no slips) across ≥ 2 fixes spanning ≥ 30 s; or a single such fix with nav status 5 (moored) while `arriving` | speed ≥ 2 kn on 2 consecutive fixes, or > 60 m from every slip point of the landing (outside radius + 25 m where there are none) |
| `arriving` | within 400 m of a landing, range closing across 3 fixes, speed < 12 kn | it docks, or the range opens across 2 fixes |
| `departing` | it left `docked` or `laid-up` less than 3 min ago and is within 400 m with range opening | beyond 400 m, or 3 min pass |
| `underway` | none of the above and the fix is fresh | |
| `laid-up` | docked at a non-passenger slip for ≥ 5 min, or at any landing for ≥ 90 min | as for `docked` |
| `unknown` | no fix yet, or the fix is more than 20 min old | a fresh fix arrives |

- `dock.since` is the time of the first qualifying stopped fix. Until a stop is confirmed it is held in `pending`, never in `dock`.
- A range is closing when the last three samples show two successive decreases and a net decrease of at least 5 m, and opening when they show two successive increases and a net increase of at least 5 m.
- `moving` is true when speed is 2 kn or more. A vessel stopped away from any berth is `underway` with `moving: false`.
- Landing radius for a landing with no slips is 120 m.
- Freshness: a fix is `stale` after 90 s when the last known speed is 2 kn or more and after 6 minutes otherwise. Staleness alone does not change the state; 20 minutes does.
- While docked, each new fix is appended to `dock.points` (last 10) and the slip is re-assigned with `assignSlip`, so confidence can improve during a dwell. A docked vessel's slip does not change to a different slip unless the new one has `p` ≥ 0.6.
- Jitter must not flap the state: a docked vessel reporting 0.6 kn once, or 40 m once, stays docked.
- Short calls: relayed AIS can be minutes apart, so a turnaround often yields one stopped fix, not two. When a `pending` stop is followed between 60 s and 10 min later by a fix that has left the berth (speed ≥ 2 kn, or beyond the exit distance above), the tracker emits `docked` and `departed` together, both with `brief: true`, and sets `lastDock`; the vessel is never in the `docked` state. `docked.at` and `dockedAt` are the first stopped fix. `departedAt` is the leaving fix's time less its distance from the stopped fix at its reported speed, and never earlier than the last stopped fix.

Events, each `{ type, key, at, ... }`:

- `docked` — `{ landingStopId, slipId, confidence }`, plus `brief: true` for a short call
- `slip-changed` — `{ landingStopId, slipId, confidence }`
- `departed` — `{ landingStopId, slipId, dockedAt, departedAt }` (emitted on leaving `docked` or `laid-up`), plus `brief: true` for a short call
- `laid-up` — `{ landingStopId, slipId }`
- `lost` — the track went `unknown` from age

## Schedule

`buildHarborSchedule({ root })` reads every GTFS directory the board bundles (root NYC Ferry plus the partner directories in `PARTNER_FEEDS`) with the existing `parseCsv` and `timeToSeconds`, and returns an index. Trips on bus routes (`route_type` 3 in the feed's `routes.txt`) are left out, except routes listed in that feed's `ferryRouteIds` in `PARTNER_FEEDS`, which the feed mistypes; `operators.get(id).tripCount` counts the trips kept. The index:

```js
{
  timezone: "America/New_York",
  operators: Map<operatorId, { prefix, tripCount }>,
  departuresFrom(landingStopId, operatorId) → [{ tripId, routeId, serviceId, sequence, departureSeconds, nextStopId, nextSequence }],
  trip(tripId) → { tripId, routeId, serviceId, operatorId, stops: [{ stopId, sequence, arrivalSeconds, departureSeconds }] } | null,
  activeOn(dateKey) → Set<serviceId>
}
```

Ids are the namespaced ones the rest of the board uses (`wtr:…`, `sea:…`). Service days follow the existing calendar logic in `public/assets/schedule.js` and `lib/connections.js`; times past 24:00:00 belong to the previous service day.

`matchDeparture({ schedule, operatorId, landingStopId, departedAt, taken = new Set() })` returns `{ tripId, routeId, serviceDate, nextSequence, confidence: 0.5, source: "schedule" }` or null. Candidates are trips of that operator active on that service day (today's, yesterday's for after-midnight calls, and tomorrow's for a boat that leaves just before midnight on a trip timed just after it) with a scheduled departure from that landing between 4 minutes after and 20 minutes before the observed departure, in other words the boat left no more than 4 minutes early and no more than 20 minutes late. The nearest wins. A trip in `taken` (already matched to another vessel, keyed `"<serviceDate>|<tripId>"`) is skipped.

`confirmArrival({ schedule, trip, landingStopId })` returns the trip with `confidence: 0.9` and `nextSequence` advanced when the landing is the trip's next call, the trip unchanged when the landing is a later call, and null when the landing is not on the rest of the trip. After the final call `nextSequence` is null.

## Fusion with operator realtime

The board already polls NYC Ferry's GTFS-realtime feeds. `normalizeVehiclePositions(vehicleFeed, fleet)` in `lib/realtime.js` gives `{ id, tripId, latitude, longitude, bearing, speed /* m/s */, status, stopSequence, boatName, vesselNumber, updatedAtEpochSeconds }`.

- `operatorFix(position, { fallbackAt = null })` turns one of those into a Fix with `source: "operator"`, `mmsi: null`, speed converted to knots. `at` is the position's own timestamp, else `fallbackAt`, else the result is null.
- `joinOperatorPositions({ tracks, positions, roster, now })` returns `[{ key, vesselId, tripId, stopSequence, position, ageSeconds, authoritative }]`: each operator position matched to the track of the same rostered vessel, when there is one (`key` is null when there is none). A position less than 180 s old is `authoritative` and its trip id stands for that vessel, for as long as the operator keeps reporting it: the service drops the trip once the last report is 180 s old, whether or not the vessel is still in the feed. A trip the operator gives to one hull is withdrawn from any other hull that held it as a timetable guess, and is never offered to another hull by the matcher; an older one still joins, with `tripId` and `stopSequence` null at the top level and the raw values left inside `position`.
- `proximityBindings({ samples, now, boundMmsis = new Set(), boundVesselIds = new Set() })` proposes `{ mmsi, vesselId, source: "proximity", at }` bindings. `samples` is a list of `{ at, vesselId, operator: {latitude, longitude, at}, candidates: [{ mmsi, latitude, longitude, sogKnots, docked }] }` the service has collected, where each candidate position is already interpolated to the operator timestamp. A binding needs, for one MMSI and one vessel: at least 5 samples spanning at least 3 minutes; every one within 75 m; the vessel making 5 kn or more and covering at least 500 m across them; no other unbound MMSI within 150 m in any of them; and no sample taken while docked. An MMSI in `boundMmsis` or a vessel in `boundVesselIds` is never proposed, and a bound MMSI nearby does not count as a rival.

A rostered vessel whose AIS fix is stale while its operator position is fresh is advanced with the operator fix through the same reducer, and reports `positionSource: "operator"`.

## API

`describeHarborVessels({ tracks, roster, slipIndex, routes, serviceTrips, sources, now, includeUnrostered = false })` returns the `/api/harbor/vessels` body:

```js
{
  available: true, stale: false, fetchedAt: "<ISO>", error: null,
  sources: { ais: { state, connected, lastMessageAt, reconnects }, nycFerry: { available, stale, fetchedAt } },
  vessels: [{
    // the Boat fields of /api/boats (see docs/api.openapi.json), all present, null when unknown
    id, name, number, tripId, latitude, longitude, bearing, speedKnots, ageSeconds,
    routeId, route, routeName, color, status, stop, reportedAt, destination, mode, vesselId,
    // harbor additions
    operatorId, mmsi, state, stateSince, stale, moving, positionSource, identitySource, rostered,
    landing: { id, stopId, name } | null,
    slip: { id, name, confidence } | null,
    slipCandidates: [{ id, name, p }],
    slipAmbiguous: false,
    tripSource, tripConfidence
  }]
}
```

- `id` is the roster vessel id, or `mmsi:<n>` for an unrostered vessel.
- Every active rostered vessel is listed, as `state: "unknown"` with null position if it has never been seen. An inactive rostered vessel is listed only while its track has a fix and a state other than `unknown`. Unrostered vessels are listed only with `includeUnrostered`. `tracks` may be an array or a Map.
- `status` is the GTFS-style value the map already understands: `stopped` for `docked` and `laid-up`, `incoming` for `arriving`, `in-transit` for `departing` and `underway`, null for `unknown`.
- `bearing` is the true heading, or the course when the vessel is making more than 1 kn and reports no heading.
- `slip` is given when the dock has a slip id; `slipCandidates` is always given while docked. Neither ever carries a coordinate.
- The envelope is `stale` when the AIS stream is not open or has been silent for 120 s.

`encodeSlips(slipIndex, { includeYard = false })` returns the Ferry RT catalog shape, `{ slips: [{ id, name, platformCode, landingStopId }] }`, sorted by landing and then id. Non-passenger slips are left out unless `includeYard`.

`encodeTripUpdates({ feed, tracks, slipIndex, roster, fleet, now, minConfidence = 0.8 })` returns a `Uint8Array`: the NYC Ferry trip-update feed re-encoded with `gtfs-realtime-bindings`, where a stop-time update's `stopId` and `stopTimeProperties.assignedStopId` are both replaced by the slip id when the trip's vessel is `docked` or `arriving` at that stop's landing and the dock's slip confidence is at least `minConfidence`. Everything else passes through unchanged. With no feed it returns a valid empty feed with a current header. A port of the decoder in `ios/FerryCore/Sources/FerryCore/FerryRT.swift` must read the result into the same `"tripId|landingStopId" → slip` map the app expects.

## Fixtures

`test/fixtures/harbor/` holds invented data only:

- `slips.csv` — three made-up landings in open water with every label scheme, plus a yard.
- `stops.json` — the matching `{ stopId, name, latitude, longitude }` list.
- `roster.json` — a small two-operator roster.
- `ais-arrival.ndjson` — one aisstream message per line: static data, then a vessel approaching, docking, dwelling and departing.

A test that needs more builds its own points with `offsetPoint` from a fixture landing.

## Phase 2: fleet database, terminals, runs and assignments

Phase 2 adds every operator that docks in NYC, links hulls to AIS with references, adds New Jersey terminals, and estimates which boat is on which trip. This section is the shared contract for that work. Where it disagrees with an earlier section, this section wins.

### What changed from phase 1

- **Slip coordinates are no longer private.** The survey is committed as `content/harbor-slips.csv` (the default for `HARBOR_SLIPS_CSV`) and the API may return slip coordinates. Tests may use it, though unit tests still prefer the invented fixtures because their geometry is known.
- **A position report names the ship.** `normalizeAisMessage` returns `{ kind: "fix", fix, name }` when `MetaData.ShipName` is present. The stream and the service use it as the static name until a static report supplies one.
- **Observed history lives in SQLite**, not in JSON logs. `harbor-tracks.json` stays as the restart snapshot.

### Database

`lib/harbor-db.js` is the schema and the only place it is defined. `openHarborDb({ databasePath })` returns `{ database, schemaVersion, transaction(work), close() }`; `seedRoster(store, roster)` loads the committed roster. Read the SQL there for column names. Conventions: times are epoch milliseconds, service dates are `YYYYMMDD` text, `*_json` columns hold JSON text, booleans are 0 or 1. Nobody else creates or alters tables; a needed change is raised with the coordinator.

`lib/harbor-store.js` wraps the database for everyone else. `createHarborStore(store)` returns functions that take and return camelCase objects (never raw rows, never JSON text):

```js
recordSighting({ mmsi, name, callSign, shipType, dims, aisClass, at, sogKnots, terminalId })  // upsert; counts fixes and terminal visits
listSightings({ since, limit })
recordDwell({ trackKey, mmsi, vesselId, terminalId, slipId, confidence, ambiguous, since, until, latitude, longitude, headingDegrees, dims })
listDwells({ vesselId, mmsi, terminalId, since, limit })
linkAis({ mmsi, vesselId, source, confidence, at, name, callSign })   // returns false and changes nothing when a roster link holds that MMSI or that vessel
listAisLinks({ vesselId })
recordConflict({ kind, mmsi, vesselId, detail, at })                  // upsert on (kind, mmsi, vesselId)
listConflicts({ resolved = false })
recordTripObservation({ trackKey, mmsi, vesselId, operatorId, tripId, routeId, runId, serviceDate, terminalId, departedAt, arrivedTerminalId, arrivedAt, confidence, source })  // upsert on (trackKey, tripId, serviceDate)
listTripObservations({ operatorId, serviceDate, vesselId })
saveRuns(operatorId, serviceDate, runs)     // replaces that operator-day
listRuns(operatorId, serviceDate)
replacePatterns(operatorId, rows)           // rows: { vesselId, runSignature, dayType, count, lastSeen }
listPatterns({ operatorId, vesselId })
saveEstimate({ vesselId, operatorId, serviceDate, runId, runSignature, routeId, confidence, source, reasoning, evidence, model, createdAt })  // upsert on (vesselId, serviceDate, source)
listEstimates({ serviceDate, operatorId, vesselId })
recordLlmRun({ purpose, model, serviceDate, batchId, status, inputTokens, outputTokens, cacheReadTokens, costUsd, createdAt })
llmSpendSince(at)                           // total costUsd
syncTerminals(terminals, slips)             // replaces both tables from the in-memory index
listTerminals()                             // each with its slips
listOperators(), listVessels({ operatorId }), vesselDetail(id)   // detail: vessel, links, references, conflicts
importLegacy({ stateDir })                  // one-time import of harbor-discovery.json, harbor-dwells.json and learned identities; safe to run twice
```

### Roster

`content/harbor-roster.json` gains optional vessel fields `class`, `capacity`, `builder`, `year`, and `references: [{ field, value, url, retrievedAt, note }]`, and optional operator fields `website`, `realtime`. Non-NYC-Ferry vessel ids are `<operatorId>:<slug>`. Operator ids match `PARTNER_FEEDS` ids in `lib/schedule-builder.js` where a feed exists (`waterway`, `seastreak`, `siferry`, `liberty`, `statue`, `gi`); `feedPrefix` is that feed's prefix. An operator whose routes are spread over several bundled feeds lists the others in `extraFeedPrefixes` (NY Waterway: `wbf:` for Belford and `ike:` for the IKEA shuttle); its boats are matched against every one, and a trip matched in an extra feed carries `feedOperatorId`. The NYU Langone ferry is operator `nyu` with prefix `nyu:`.

A terminal in `config/harbor-terminals.json` may carry `berth: { latitude, longitude, radiusMetres }` when its boats lie too far from the published stop for the default 120 m circle (the Staten Island Ferry terminals). It then becomes its own landing at the berth, keeps the board landing's `id`, and takes its stop ids with it.

### Terminals

`config/harbor-terminals.json` lists terminals that are not board landings:

```js
{ "terminals": [{ "id": "nj-port-imperial", "name": "Port Imperial", "town": "Weehawken", "state": "NJ",
    "latitude": 40.7757, "longitude": -74.0124, "stopIds": ["wtr:2439137"] }] }
```

`lib/harbor-terminals.js` exports `harborLandings({ boardLandings, terminals })` returning `{ landings, stopIdsOfLanding }` in the shapes `createHarborService` already takes (`landings: [{ landingStopId, landingId, name, latitude, longitude }]`). For a terminal, `landingStopId` is its first stop id and `landingId` is null. Board landings keep the `landingStopId` they have today. A terminal has no slips until someone surveys it, so it is a 120 m zone.

### Slip model

`lib/harbor-slips.js` exports `SLIP_MODEL = { sigmaMetres: 12, noneMetres: 45, minP: 0.6, ambiguity: { mode: "spacing", metres: 25 } }` and `assignSlip(points, index, { ..., model = SLIP_MODEL })`. `ambiguity.mode` is `"spacing"` (the phase 1 rule) or `"margin"` (`{ mode: "margin", p: 0.2 }`: ambiguous only when the best two candidates' probabilities differ by less than `p`; no confidence cap otherwise). Defaults do not change until the calibration report on real dwells says so.

### Runs and patterns

A run is the chain of trips one boat can work on one service date.

```js
run = { runId: "waterway:20261112:3", signature: "wtr:2439137>07:10>wtr:rt-1", source: "block" | "synthesized",
        trips: [{ tripId, routeId, firstStopId, lastStopId, departsAt, arrivesAt }] }   // times are epoch ms, in order
```

`lib/harbor-runs.js` exports:

- `buildRuns({ schedule, operatorId, serviceDate, minTurnMs = 120_000, maxTurnMs = 2_700_000 })` → `run[]`. Uses `block_id` where the feed fills it. Otherwise it chains greedily: a trip ending at a terminal is followed by the earliest unclaimed trip of that operator leaving the same terminal (any stop id of the same landing counts) within the turn window. Every trip is in exactly one run.
- `signature` identifies the same run on another date: first stop id, local departure time `HH:MM`, and route id of its first trip.
- `runOfTrip(runs, tripId)`, `tripsAfter(run, tripId)`.
- `dayType(serviceDate)` → `"weekday" | "saturday" | "sunday"`.
- `buildPatterns(observations, runs)` → rows for `replacePatterns`. An observation counts once per vessel, run signature and service date, and only with confidence ≥ 0.9 or source `operator-rt`.
- `estimateFromPatterns({ vesselId, operatorId, dayType, patterns, runs })` → `{ runId, runSignature, routeId, confidence, source: "pattern", evidence } | null`. Confidence is the vessel's share of that run's observations on that day type, capped at 0.8, and null below 3 observations.

Precedence when sources disagree, highest first: `operator-rt`, a confirmed `schedule` match (0.9), `run` (inherited from a confirmed trip earlier in the run), `pattern`, `model`.

### Claude

`lib/harbor-llm.js` exports `createHarborLlm({ client, store, now, dailyCapUsd = 1, models = { routine: "claude-haiku-5-5", review: "claude-opus-5-5" } })`. `client` is an `@anthropic-ai/sdk` client, injected so tests use a fake. It is never called from a request handler.

```js
estimateCost({ model, inputTokens, outputTokens, batch })      // USD, from the price table in the module
dayRequest({ operator, serviceDate, runs, observations, unmatched, patterns, vessels })   // the request params for one operator-day
submitDay(requests)        // Batches API; returns { batchId }, records an llm_runs row
collectDay(batchId)        // when ended: saves estimates (source "model"), updates llm_runs; returns { done, saved, flagged }
reviewFlagged(items)       // review model, one request each, for what the routine model flagged
confirmVessel(candidate)   // review model with web search; see Research
```

Every call first checks `store.llmSpendSince(start of UTC day)` against `dailyCapUsd` and refuses with a typed error when the cap is reached. Results are parsed from structured output and rejected (not saved) when a vessel id, run id or observation id in them is not in the request.

### Research

`lib/harbor-research.js` is pure; `scripts/harbor-research.mjs` does the I/O.

```js
candidates({ sightings, dwells, terminals, roster })   // unrostered MMSIs ranked by how exclusively they dock at one operator's terminals
  → [{ mmsi, name, callSign, shipType, operatorGuess, share, dwellCount, terminals: [{ terminalId, count }] }]
parseFccShips(text)                                    // FCC ULS ship records → [{ callSign, name, mmsi, licensee }]
propose({ candidates, fcc, confirmations, roster })    // → { vessels: [...roster vessel records with references], conflicts: [...] }
```

`confirm(candidate)` is injected: `({ mmsi, name, callSign, operatorGuess, evidence }) → { operatorId | null, name, class, capacity, builder, year, confidence, references: [{ field, value, url, note }], notes }`. The script writes `content/harbor-roster.proposed.json` and never edits the roster.

### API additions

- `GET /api/slips`: each slip gains `points: [{ latitude, longitude }]` and `kind`. Yard slips are included with `?include=yard` as before.
- `GET /api/harbor/vessels`: each vessel gains `operatorName` and `assignment: { routeId, runId, tripId, nextTrips: [{ tripId, routeId, departsAt, fromStopId }], confidence, source } | null`. Query filters `operator` and `state`.
- `GET /api/harbor/vessels/{id}`: `{ vessel, links, references, conflicts, track, assignment, estimates, dwells, trips }`.
- `GET /api/harbor/operators`, `GET /api/harbor/terminals` (terminals with their slips and points).
