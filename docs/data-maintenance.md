# Schedule and operator maintenance

The server builds every active landing at startup. Changes to bundled inputs require a restart. The default landing does not limit which operators are polled.

## October 7, 2026 feed refresh

Reviewed `schedules/fall-2026-sources/nycferry-20261007.zip` (SHA-256 `7543100c010d9faa33aed1cf735ea7e74951b1c9dc26d333f060229eaab71f5a`). Regenerate the current mapping with `python3 scripts/import-post-sukkot-live.py schedules/fall-2026-sources/nycferry-20261007.zip`. All 555 seasonal trips match on supported dates, with 21 date-specific trips and zero ambiguous matches. Existing live identities are unchanged; the feed adds verified IDs for all 21 October 24 SB3 cruise trips. The 63 remaining unmatched trip dates cover expired October 3 service and unpublished October 31 and November 1 cruise service, which retain scheduled times without a direct live identity. Historical Sukkot maps remain tied to their reviewed archive.

## October 4, 2026 feed refresh

Reviewed `schedules/fall-2026-sources/nycferry-20261004.zip` (SHA-256 `b5345307d5365ccdcc293ed381933bc75f50400e6955a970162814d40af1c026`). Regenerate the current mapping with `python3 scripts/import-post-sukkot-live.py schedules/fall-2026-sources/nycferry-20261004.zip`. Current trip identities are unchanged; the publisher removed the expired October 3 cruise service. All 555 seasonal trips still match on supported dates, with 21 date-specific trips and zero ambiguous matches. The 84 unmatched trip dates include 21 expired October 3 trips and the existing October 24, October 31, and November 1 cruise gaps. Those dates retain scheduled times without a direct live identity.

## October 3, 2026 live identities and NY Waterway refresh

NYC Ferry's `20261003` feed reused 437 September live IDs for different sailings. The reviewed archive is `schedules/fall-2026-sources/nycferry-20261003.zip` (SHA-256 `9f0db6181c999960782d67ee84f9b368f128086caa9d9784558d5558ce74cda9`). Regenerate `schedules/fall-2026-post-sukkot-live.json` with `python3 scripts/import-post-sukkot-live.py schedules/fall-2026-sources/nycferry-20261003.zip`.

All 555 fall trips have reviewed matches: 534 have one ID throughout their active dates, and 21 SB3 cruise trips need date-specific IDs. Matching requires the same route, working number, full stop order, and arrival/departure times on each service date. The new archive has no matching cruise trips for October 24, October 31, and November 1. Their previously confirmed timetable remains visible, with no direct live match until a later feed is reviewed. Missing IDs use the `nyc:unmapped:` namespace to prevent accidental joins to reused numeric IDs.

Departures and trip schedules carry `liveTripIdsByDate`; Pier C starts carry `predictTripIdsByDate`; turnarounds carry `nextLiveTripIdsByDate` when needed. Web/native boards, realtime normalization, connections, ride history, and map descriptions resolve them for the service date. Ordinary schedules also carry their common live alias so arrival-only terminals and the next trip's delay remain available. Sukkot's archived crew and live mappings stay on `20260928`. The freshness check only compares feeds that still cover current or upcoming service.

NY Waterway's prior Trillium snapshot expired October 1. The replacement from [the publisher's GTFS download](https://data.trilliumtransit.com/gtfs/nywaterway-nj-us/nywaterway-nj-us.zip) is version `UTC: 31-Aug-2026 20:05`, covering October 1, 2026–April 1, 2027. Its raw archive is `schedules/waterway-sources/nywaterway-20260831.zip` (SHA-256 `7f95f02b61dc0c5c08450b5a9787c32131c05316c85a83491070f5b3524ae874`). The bundled `gtfs/waterway` files match that archive; absent fare files were removed. Existing landing IDs and ferry route corrections still apply. Belford and IKEA retain their separate sources.

Verification: `npm test`, `node scripts/check-post-sukkot-browser.cjs`, and `node scripts/build-ios-service-contract.mjs /tmp/post-sukkot-service-parity`. Browser screenshots, traces, and results are written under `artifacts/browser/post-sukkot-*`. Native source includes the same date resolution; run `npm run test:ios-core` on a machine with Swift installed.

## NYC Ferry feed refresh — September 20, 2026

The root `gtfs/` files are a curated seasonal snapshot checked against Connexionz feed `20260920`, downloaded from
`https://nycferry.connexionz.net/rtt/public/resource/gtfs.zip`. The archive SHA-256 is
`f08d8455b1c9286f19bb7f0a994124fe23b7e7f18fd467cfd2d92883e1e0e100`.
Partner feed directories are independent and were not changed by this refresh.

Both official archives are preserved under `schedules/fall-2026-sources/`. Run
`npm run build:nyc-fall` to reproduce the snapshot. The generator verifies that all 555 current
trips have identical IDs, working numbers, and stop times in the September 13 and September 20
archives. The latter only consolidates service IDs and removes expired trips. We retain the
original service IDs and historical trips so the verified crew data and date navigation remain
valid. The curated calendar retains the ten confirmed cruise dates, five Sukkot exclusions,
and November 1 season boundary; it is not an unmodified copy of either archive.

Local `mobile`'s fall assignments and confirmed weekday/weekend crew notes are integrated.
Their original corrections and unresolved fields are preserved, including the explicit AS3
weekday correction. Holiday crew operations remain unconfirmed. Runtime scheduling now lives
in `lib/schedule-builder.js` and `lib/out-of-service.js`; script entrypoints remain compatible.
After regenerating inputs, run `npm run build`, `node scripts/export-hardcoded-data.js`, the
schedule tests, and restart the server. Replacing the root feed with a raw download bypasses
these calendar corrections and is intentionally rejected by the holiday integration.

## settings

everything lives in [`config/display.json`](../config/display.json).
`showDwellTimes` controls dwell labels (default off); `showLayoverTimes` controls
layover labels on departures and trip details (default on). These only hide labels,
not schedule calculations. Rebuild data and restart the server after changing them:

```json
{
  "landingNumber": 26,
  "departureWindowMinutes": 1440,
  "departuresShown": 5,
  "showDwellTimes": false,
  "showLayoverTimes": true,
  "waterwayEnabled": true,
  "waterwayBelfordEnabled": true,
  "seastreakEnabled": true,
  "nyuEnabled": true,
  "libertyEnabled": true,
  "ikeaEnabled": true,
  "giEnabled": true,
  "siferryEnabled": true,
  "statueEnabled": true,
  "busesEnabled": false
}
```

| setting | range | what it does |
|---|---|---|
| `landingNumber` | active ID | default landing before a device makes its own selection. `1` is unused. |
| `departureWindowMinutes` | `1`–`1440` | a route only appears if its next departure is within this many minutes. once it qualifies, the board still fills every departure column, even with later trips outside the window. |
| `departuresShown` | `1`–`5` | departures per route card; the timeline shows all departures within the window. |
| `waterwayEnabled` | `true` / `false` | merge in NY Waterway departures. see below. |
| `waterwayBelfordEnabled` | `true` / `false` | include the separate Belford feed. |
| `seastreakEnabled` | `true` / `false` | merge in Seastreak departures. see below. |
| `nyuEnabled` | `true` / `false` | merge in NYU Langone ferry departures. see below. |
| `libertyEnabled` | `true` / `false` | merge in Liberty Landing Ferry departures. see below. |
| `ikeaEnabled`, `giEnabled`, `siferryEnabled`, `statueEnabled` | `true` / `false` | include each corresponding operator's bundled feed. |
| `busesEnabled` | `true` / `false` | show connecting shuttle buses. see below. |

the staff board shows every route direction at once and never pages. each departure shows its crew boat assignment, plus the boat name when the live feed has that assignment.

## landings

[`config/landings.json`](../config/landings.json) is the source of truth for which landings exist and which GTFS stops they map to. the build validates against that file, not a hardcoded range, so adding a landing there is all it takes.

landings `2` through `24` are alphabetical. `25` and `26` were added later so existing kiosk numbers stayed put, and `28` through `31` later still for the same reason. `1` is unused and `27` (Pier C) is the virtual home-port landing. Rockaway (`18`) covers both the ferry landing and the shuttle-bus stop next to it.

Governors Island is two landings because it is two piers a walk apart: `11` Yankee Pier takes NYC Ferry's South Brooklyn boat and the Trust's Red Hook and Brooklyn Bridge Park boats, `29` Soissons Landing takes the Trust's Manhattan boat from the Battery Maritime Building. `28` Whitehall is the Manhattan end of that crossing, shared with the Staten Island Ferry, Seastreak and the Statue of Liberty boats from Battery Park a couple of hundred metres away. `30` Liberty Island and `31` Ellis Island are the far end of that last one. none of `28`, `29`, `30` or `31` is an NYC Ferry stop — see *partner operators* below.

## shuttle buses

`busesEnabled: false` drops every bus route (GTFS `route_type` 3) from the board and leaves the ferries. it affects:

- Rockaway (`18`) — removes the Rockaway East and Rockaway West shuttles.
- any landing showing NY Waterway — removes their shuttle-bus routes, keeps their ferries.

leave the key out entirely and it defaults to `true`.

## out of service, Pier C and crew shuttles

NYC Ferry only, and staff-facing: the board shows what a boat does once it stops carrying passengers.

- **`DROP OFF ONLY`** on a departure — the trip a boat works before it stops, whether that is the end of its day or a shift ending mid-morning. it will drop off and go out of service rather than turn round. not the same as `LAST`: a boat can finish while its route keeps running for hours, and that is precisely the case an agent cannot otherwise see.
- **`DROP OFF?`** — the same, inferred from a gap long enough that nobody should board but short enough that the boat is probably tied up where it is rather than gone. no Pier C row is drawn for these.
- **a `Pier C` card marked `Out of service`** — the home-port run, at the landing where the boat finishes. `NO PICKUP`. it follows the live timing of the revenue trip it comes off, so a boat running late ties up late: the card's time and countdown move with the boat and it carries `+N min` alongside `NO PICKUP`. never `ON TIME` or `SCHEDULED` — a boat going home empty has no schedule status to keep.
- **a `Pier C` card marked `Crew shuttle`** — a mid-day crew change, shown as a window (`2:35 – 3:05 PM`) because the shuttle waits for its boats to sail. one departure carries the relieved crews off every boat it names, and those boats keep running. no live timing: a shuttle has no trip in any feed, so its window is the published one.

the first three are derived from the boat assignments: group the trips by boat and a boat going out of service becomes a hole in its own day. it works because layovers and shift breaks are cleanly separated in this schedule — layovers reach 44 minutes, the next gap up is 90 — so the two thresholds in `config/crew-shuttles.json` sit in an empty valley. that valley is a property of the schedule, not a law, so re-check them when it changes. routes with no boat number get nothing (Governors Island is crewed off-schedule; the Rockaway shuttles are buses), and partner operators never do, because none of them publishes a crew schedule.

the crew shuttles are derived from nothing at all — neither the GTFS feed nor the schedule workbook mentions them. they live in [`config/crew-shuttles.json`](../config/crew-shuttles.json), are maintained by hand, and **go stale exactly when the schedule changes**. holidays matter here: `gtfs/calendar_dates.txt` is empty, so the feed runs an ordinary weekday on a holiday and the `holidays.dates` list is the only thing that switches the shuttles to the weekend pattern. see [ferryAssignments.md](../ferryAssignments.md).

nothing in this feature edits a published time. every row is an addition.

## partner operators

landings that share a dock with another ferry operator can show its departures next to NYC Ferry's. each operator ships its own GTFS directory, merged at build time by [`lib/schedule-builder.js`](../lib/schedule-builder.js).

| operator | feed | id prefix | mark |
|---|---|---|---|
| NY Waterway | [`gtfs/waterway/`](../gtfs/waterway) | `wtr:` | [`public/assets/waterway.png`](../public/assets/waterway.png) |
| NY Waterway — Belford | [`gtfs/waterway-belford/`](../gtfs/waterway-belford) — transcribed, see below | `wbf:` | [`public/assets/waterway.png`](../public/assets/waterway.png) |
| Seastreak | [`gtfs/seastreak/`](../gtfs/seastreak) — transcribed, see below | `sea:` | [`public/assets/seastreak.png`](../public/assets/seastreak.png) |
| NYU Langone Ferry | [`gtfs/nyu/`](../gtfs/nyu) — generated, see below | `nyu:` | [`public/assets/nyu.png`](../public/assets/nyu.png) |
| Liberty Landing Ferry | [`gtfs/liberty/`](../gtfs/liberty) — transcribed, see below | `lib:` | [`public/assets/cityferry.png`](../public/assets/cityferry.png) |
| IKEA Brooklyn Ferry | [`gtfs/ikea/`](../gtfs/ikea) — transcribed, see below | `ike:` | text badge, `IKEA` |
| The Trust for Governors Island | [`gtfs/gi/`](../gtfs/gi) — transcribed, see below | `gi:` | [`public/assets/gi.png`](../public/assets/gi.png) |
| Staten Island Ferry | [`gtfs/siferry/`](../gtfs/siferry) — NYC DOT download | `sif:` | text badge, `SIF` |
| Statue City Cruises | [`gtfs/statue/`](../gtfs/statue) — NPS download, seasonal | `sta:` | text badge, route id |

which landings pull which operator:

| landing | NYC Ferry stop | partner stop |
|---|---|---|
| `8` East 34th Street | `17` East 34th Street | Seastreak `168` East 35th St., NYC · NYU `13138` East 34th Street |
| `16` Pier 11 / Wall St | `87` Wall St/Pier 11 | NY Waterway `2439146` Pier 11 / Wall Street, Belford `2439146` the same pier · IKEA `pier11` Pier 11 / Wall Street |
| `24` Sunset Park / BAT | `118` Sunset Park/BAT | NYU `13139` Brooklyn Army Terminal |
| `25` Battery Park City / Brookfield Place | `136` Battery Park City/Vesey St. | NY Waterway `2729332` Brookfield Place/Battery Park City, Belford `2729332` the same pier · Seastreak `9825` Brookfield Place, NY · Liberty Landing `2557122` Brookfield Place Terminal |
| `26` Midtown West / Pier 79 | `138` Midtown West/W 39th St-Pier 79 | NY Waterway `2439145` Midtown / W 39th Street, Belford `2439145` the same pier · IKEA `midtown` Midtown / W 39th Street |
| `11` Governors Island / Yankee Pier | `111` Governors Island | Trust `govisland` Governors Island / Yankee Pier |
| `28` Battery / Whitehall | none — NYC Ferry does not call here | Staten Island Ferry `whitehall` Whitehall Ferry Terminal · Seastreak `170` Battery Maritime Building Slip 5 · Trust `bmb` Battery Maritime Building / Slip 7 |
| `29` Governors Island / Soissons Landing | none — NYC Ferry does not call here | Trust `soissons` Governors Island / Soissons Landing |
| `22` St. George | `137` St. George | Staten Island Ferry `stgeorge` St. George Ferry Terminal |
| `30` Liberty Island / Statue of Liberty | none — NYC Ferry does not call here | Statue City Cruises `LI` Liberty Island |
| `31` Ellis Island | none — NYC Ferry does not call here | Statue City Cruises `EI` Ellis Island |

each operator has two switches, and either one off means none of its data is read:

- `waterwayEnabled` / `waterwayBelfordEnabled` / `seastreakEnabled` / `nyuEnabled` / `libertyEnabled` / `ikeaEnabled` / `giEnabled` / `siferryEnabled` / `statueEnabled` in `config/display.json` — all landings served by the app.
- `waterwayStopIds` / `waterwayBelfordStopIds` / `seastreakStopIds` / `nyuStopIds` / `libertyStopIds` / `ikeaStopIds` / `giStopIds` / `siferryStopIds` / `statueStopIds` in `config/landings.json` — per landing. only landings with the array populated pull that operator in.

a missing `...Enabled` key means **on**, not off. `config/display.json` is the one file a deploy never overwrites — it holds the box's own `landingNumber` — so a release that adds an operator arrives with its switch absent from the live config, and reading that as off hid the new operator on the very deploy that shipped it, silently. defaulting to on is safe because the switch is not what decides where an operator appears: the per-landing `...StopIds` arrays do, and those live in `config/landings.json`, which every deploy ships. to turn an operator off, say `false` — omitting the key no longer does it.

good to know:

- every departure and route carries an `operator` taken from its feed's `agency.txt`, and the board prints a small operator label under the route name. one feed overrides it: NYC DOT publishes the Staten Island Ferry under the department's legal name, so `operatorName` in `PARTNER_FEEDS` labels those rows `Staten Island Ferry` instead. the override lives in code so a fresh download can't undo it.
- a landing does not have to be an NYC Ferry stop. `28` Whitehall and `29` Soissons Landing are real docks NYC Ferry does not serve, so they carry an empty `stopIds` plus their own `latitude`/`longitude` and are built entirely from partner feeds. a landing with no `stopIds` and no coordinates is rejected by the build.
- partner ids are namespaced with the prefix above so they can't collide with NYC Ferry ids or each other.
- partner badges show the operator's mark instead of the GTFS short name, because those short names are useless to riders — NY Waterway publishes internal all-digit route ids, Seastreak names every route "Seastreak", and NYU and Liberty Landing publish no short name at all. a partner route with a real short name (W44, Greenwich) keeps it.
- Seastreak's headsigns only name a region ("Manhattan", "New Jersey"), so its rows show the trip's last stop instead — Highlands NJ, Atlantic Highlands NJ, Battery Maritime Building. NY Waterway headsigns already name the terminal and are used as published.
- four NY Waterway routes are tagged `route_type` 3 (bus) in the Trillium feed although they are ferries: `19750` Edgewater – Brookfield Place, `19751` Edgewater – Pier 11, `74376` Port Liberte – Pier 11 and `76080` Hoboken/14th St – Pier 11. with `busesEnabled: false` that dropped them from the board entirely — about a third of NY Waterway's service at Pier 11. `WATERWAY_FERRIES_TYPED_AS_BUS` in [`lib/schedule-builder.js`](../lib/schedule-builder.js) reclassifies exactly those four. it changes no times, and it lives in code so that dropping in a fresh feed can't quietly reintroduce the bug. everything else typed as a bus in that feed really is one.
- a feed can list the same sailing under two trip ids, which used to render as two identical rows. the build drops a departure only when another one already matches it on service, route, stop, minute *and* destination — a duplicate row, never a time.
- NY Waterway, Seastreak, Liberty Landing, the IKEA boat, the Trust and the Staten Island Ferry publish no realtime feed here, so their rows show scheduled times only: no boat name, no delay badge. that's expected. NYU does have live estimates — see below.
- the Statue of Liberty boats run loops — Battery Park, Liberty Island, Ellis Island, Battery Park, and the mirror of that from Liberty State Park — so a trip's last stop is also its first. rows show the `stop_headsign` NPS puts on each call, naming the island that call is bound for, rather than the trip's final stop, which would tell someone at Battery Park the boat is going to Battery Park. `30` Liberty Island and `31` Ellis Island are landings of their own; Battery Park shares `28` with the Whitehall terminal a couple of hundred metres away.
- **known bad, upstream:** NPS spells Liberty State Park correctly on sixteen calls and `Libery State Park` on one. `headsignFixes` in `PARTNER_FEEDS` corrects that one destination label. it is the only text correction in the build and it touches nothing else — no time, no route, no stop — and a headsign that is merely terse is left as published.
- **known bad, upstream:** the Staten Island Ferry feed has fifteen trips that leave St. George and arrive at St. George twenty-five minutes later — the Whitehall crossing with the wrong stop id on the far end. all fifteen sit on the `threeboat` service, whose calendar is all zeros with no exception dates, so nothing renders them today. the build drops any leg whose next stop is the stop it just left, so St. George cannot advertise boats to itself if a fresh download turns that service on. no published time is changed and no far end is guessed at.
- the Staten Island Ferry feed carries no vehicle data at all: `block_id`, `trip_headsign` and `direction_id` are empty on all 416 trips, and NYC DOT publishes no GTFS-realtime for it. destinations fall through to each trip's final stop, which is what the terminal signs say anyway.
- **known bad, upstream:** at Brookfield Place the board shows the South Amboy boat leaving at 6:50 AM, 7:55 AM, 3:50 PM and 4:50 PM. NY Waterway publishes 6:25 AM, 7:30 AM, 3:25 PM and 4:25 PM. route `77347` in the bundled feed carries a stale set of trips that put Brookfield Place *after* Pier 11 rather than before it; the current trips alongside them are right, and Pier 11's own times are right, so the two afternoon ones are also the duplicates the build now drops there. this is not patched here — correcting it means editing published times, and the real fix is a fresher NY Waterway feed. the `UTC: 31-Aug-2026` refresh still contains both sets of times. these South Amboy rows need a separate comparison with the current printed timetable.
- a partner feed only contributes departures whose service is in effect today. if a third-party feed lapses, its rows silently vanish, so the build prints a `WARNING: the <operator> feed ... expired on <date>` line rather than leaving you to debug an empty row.

to add a partner at another landing, find its `stop_id` in that feed's `stops.txt` and add the matching `...StopIds` array to the landing in `config/landings.json`.

the Seastreak feed is **transcribed, not downloaded** — regenerate it with `node scripts/build-seastreak-gtfs.js`. it used to be the operator's own GTFS (via [transit.land `f-drk-seastreak`](https://www.transit.land/feeds/f-drk-seastreak), published at `https://seastreak.com/api/transit/google_transit.zip`), which carried a 2020 `feed_start_date`, times that no longer matched the printed schedule, and — because every sailing appears in both of Seastreak's printed tables — the same boat offered as two separate boardings at the same pier at the same minute, eighteen times over at the three piers this board watches.

it is now read from the operator's published sheets — two weekday tables *Effective September 8, 2026* and a weekend one *Effective September 12, 2026*.

Both weekday sheets were checked again against user-supplied images on September 25, 2026.
All 34 rows already matched the feed, including the blue Monday–Wednesday and purple
Thursday–Friday trips. The [saved source images and CSV transcriptions](../schedules/seastreak-2026-09-08/README.md)
now back tests of every weekday time, stop order and boarding restriction. The rebuild updates
`feed_version` to `transcribed-2026-09-25`; sailing times and service dates are unchanged. Weekend
service remains from the September 12 sheet last checked on September 7; no new weekend sheet
was supplied.

Three things about that source are worth knowing before re-reading it:

- **the tables are headed `Departures` on the boarding side and `Arrivals` on the far side, and that is taken literally.** on a New Jersey departure the Manhattan calls are drop-off only; on a New York departure the New Jersey calls are. this is what stops one boat being advertised as two. the 06:20 out of Highlands is the clearest case: it is printed in both weekday tables and is one vessel, so Brookfield Place 06:55 boards on the New York row and is a drop-off on the New Jersey one.
- **the columns are read by clock, not by heading order.** several rows call at the piers in a different order than the headings suggest — the 15:55 out of East 35th reaches Brookfield Place *after* Battery Maritime although Brookfield is printed first, and the 18:15 New Jersey departure boards Atlantic Highlands before Highlands. a stop out of order in the rebuilt feed means a misread column, and the build asserts on it.
- **times printed in blue run Monday to Wednesday, and times in purple Thursday and Friday.** that is the last boat of the night each way: it leaves at one time for the first half of the week and later for the second. colour does not survive a text extraction, so those four rows are carried as `ss-mon-wed` and `ss-thu-fri`, with the restrictions recorded in the saved source CSVs and checked by [`test/seastreak-gtfs.test.js`](../test/seastreak-gtfs.test.js). this replaces the August sheet's red *not on Fridays* rows, which are gone.

the weekday calendar runs `20260908`–`20271231` and the weekend one `20260912`–`20271231`, both then lapsing, so a transcription cannot quietly outlive the timetable it came from. note the weekday sheet takes effect *before* the weekend one this time; in August it was the other way round. Seastreak's Massachusetts routes (New Bedford, Nantucket, Martha's Vineyard) were in the download this replaced and are deliberately not here: no landing on this board is within two hundred miles of them.

**four piers left the Seastreak feed on 8 September 2026.** Belford, Paulus Hook and West 39th St went with the Belford route — every call at the last two was on a Belford working — and the new weekend sheet drops Sandy Hook Beach as well. the September sheets print no column for any of them, so the stops, the `ss-belford` and `ss-belford-mon-thu` calendars and every trip that used them are deleted rather than given an end date. West 39th is the one with a board consequence: it was Pier 79's Seastreak mapping, so landing `26` no longer names Seastreak at all.

**Brookfield Place is a Seastreak pier now.** it used to be an intermediate call on the Belford runs; the weekday sheet is titled *Brookfield Place, East 35th St & BMB-Slip 5* and it boards in its own right, three times a weekday. landing `25` gained `seastreakStopIds` for the first time.

the NY Waterway Belford feed is **transcribed, not downloaded** — regenerate it with `node scripts/build-waterway-belford-gtfs.js`. it sits in its own directory rather than in `gtfs/waterway/` because that one is a Trillium download whose contract is "drop in a fresh copy", and a fresh copy would erase anything hand-written into it. the same reasoning already gives the IKEA boat its own feed. three things about the printed sheets are worth knowing before re-reading them:

- **the `Depart` / `Arrive` column headings are taken literally**, the same way Seastreak's are: an `Arrive` call is drop-off only and never advertises a boarding. the evening table heads its last column `Depart Belford`, but Belford is the end of the run there, so it is an arrival like the rest.
- **the four rows noted `Pier 79 Via Transfer at Pier 11` are two vessels, not one.** the morning gives it away by the clock — the 05:45 from Belford is printed at Paulus Hook 06:50 and Midtown 06:50, and no boat is in both places at once. the Pier 79 call is dropped on those rows because it is a connection made at Pier 11 onto a boat `gtfs/waterway/` already carries; transcribing it would advertise one sailing twice. the intermediate calls are kept.
- **two rows do not run all week, and neither runs on a Monday.** the 05:15 from Belford is `Tuesday - Thursday` and the 18:15 from Pier 79 is `Tuesday - Friday`, both transcribed exactly as printed (`wbf-tue-thu`, `wbf-tue-fri`). the notes column sits well right of the times it qualifies and is easy to miss — read it before assuming a row is ordinary weekday service.

the weekday calendar starts `20260908` and the weekend one `20260912`, both printed on the sheets; they run to `20271231` and then lapse. the route calls at Pier 11 rather than the Battery Maritime Building, so landing `16` gains the Belford boats and landing `28` loses them. when NY Waterway puts Belford in the GTFS it publishes, delete this feed and its `waterwayBelfordStopIds` keys — the stop ids here are the operator's own so that day is a deletion, not a migration.

The Statue of Liberty ferry feed is the National Park Service's, published at [the NPS GTFS download](https://www.nps.gov/external-resources/gtfs/stli/statue-of-liberty-ferries.zip) and listed on [NPS developer resources](https://www.nps.gov/subjects/developer/gtfs.htm). The bundled copy is feed version `20261013`, imported November 12, 2026. Its fall, weekday, and weekend calendars run **October 12–November 20, 2026**. Rows stop appearing after November 20 until a fresh copy is imported. The downloaded archive's SHA-256 is `6bd511db75dd47767bc3bec66906f0274be1895b06006033d36ddeabfb115ec7`; the bundled files are its tables with the byte-order marks and carriage returns removed, as before. All 12 published GTFS tables are retained; fares and transfers are not currently consumed by the board.

The badge shows the feed's route id (`NY`, `NJ`, `LIBP`, `EILILSP`) because NPS publishes no route short names and no operator mark ships with this repo — the route's full name sits beside it.

the Staten Island Ferry feed is NYC DOT's own, published at `https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip` and listed on [NYC Open Data](https://data.cityofnewyork.us/Transportation/Staten-Island-Ferry-Schedule-General-Transit-Feed-/b57i-ri22). the bundled copy is `siferry-gtfs_2026.1`, feed version `18`, covering `20260101`–`20280117`. it is a plain download: drop in a fresh one and restart.

## the Liberty Landing Ferry timetable is transcribed

Liberty Landing Ferry crosses between Liberty Landing Marina and Warren Street in Jersey City and Brookfield Place Terminal, whose dock is ~35 m from NYC Ferry's Battery Park City/Vesey St. — so it belongs at landing `25`.

**the ferry runs; its GTFS does not.** the operator rebranded to Liberty Landing City Ferry under Statue City Cruises/Hornblower and moved to [libertylandingcityferry.com](https://www.libertylandingcityferry.com/), leaving the old domain in the feed's `agency.txt` dead. the only GTFS ever published — [transit.land `f-libertylandingferry~ny~us`](https://www.transit.land/feeds/f-libertylandingferry~ny~us), via Trillium — was last modified **30 Aug 2019** and its calendar lapsed on **2020-08-01**.

that feed is not reused, and its dates were not rolled forward. service went hourly in 2020, so the 2019 half-hourly feed would have put **16 sailings a weekday on the board that do not exist** — every `:15` departure plus the 20:45. that is the static-schedule version of an early departure, and [`gtfsferry.md`](../gtfsferry.md) covers it.

instead [`scripts/build-liberty-gtfs.js`](../scripts/build-liberty-gtfs.js) generates `gtfs/liberty/` from the timetable the operator publishes today:

```
node scripts/build-liberty-gtfs.js
```

| | departs Liberty Landing | departs Warren St | departs Brookfield Place | departs Warren St |
|---|---|---|---|---|
| weekdays | `:30`, 6:30am–7:30pm | `:32` | `:45`, 6:45am–7:45pm | `:55` |
| weekends | `:30`, 9:30am–7:30pm | `:32` | `:45`, 9:45am–7:45pm | `:55` |

**this one is a transcription, not a download** — there is no machine-readable source, so it carries obligations the other feeds don't:

- re-check it against the operator's page when `SOURCE_CHECKED_ON` in the script gets old. the generated calendar is deliberately bounded to 180 days so it expires loudly (the build warns on a lapsed partner feed) rather than drifting silently.
- the operator publishes departure times only. the two arrivals it doesn't print are derived from the 2019 feed's running times, which still hold exactly: 6:30 +2 = 6:32, +13 = 6:45, +10 = 6:55 reproduces every printed time.
- the operator says "weekdays except major holidays" but publishes no list, so **no holiday exceptions are encoded** and a holiday will show sailings that don't run. check official service alerts before relying on holiday departures.
- stop ids are carried over from the Trillium feed unchanged so `config/landings.json` keeps working; only `2557122` was renamed, World Financial Center → Brookfield Place.

## the IKEA Brooklyn ferry is transcribed, and seasonal

**NY Waterway runs it; their GTFS doesn't mention it.** [`gtfs/waterway/`](../gtfs/waterway) has no IKEA route, no Red Hook stop, and no weekend service on any Pier 11 route. the only place the operator publishes this timetable is [nywaterway.com/ikea.aspx](https://www.nywaterway.com/ikea.aspx), and there only as a **JPEG of a table**. so [`scripts/build-ikea-gtfs.js`](../scripts/build-ikea-gtfs.js) transcribes it, the same way Liberty Landing is handled.

- free, Saturdays and Sundays only, between Midtown / W 39th St, Pier 11 / Wall St and the pier behind the store at 1 Beard Street.
- six sailings each way. the last one out of Midtown (5:55 PM) is printed with its Pier 11 cell blacked out — it runs non-stop, so Pier 11 sees five southbound boats and Midtown six.
- the badge reads `IKEA` rather than an operator mark: NY Waterway's other routes are all commuter runs across the Hudson, so the mark would tell a rider less than the name does.

two things to know before trusting it:

- **the operator's "Arrive Midtown" column is not usable.** it prints five minutes after the Pier 11 arrival on every row, for a leg the same page gives as thirty minutes southbound — and on the 2:20 PM sailing it prints an arrival at Midtown *before* the boat reaches Pier 11. every departure is transcribed as published; that one terminal arrival is derived as Pier 11 + 30 min. it is never shown, because a trip's last stop is never a departure.
- **it expires on purpose.** the service pauses over the winter and NY Waterway reissues the image under a new filename every month or two, with no end date on the page. `SEASON_DAYS` bounds the generated calendar to 90 days so the feed lapses loudly — the build warns and the IKEA rows stop — rather than advertising sailings that don't run. re-read the page and re-run the script when `SOURCE_CHECKED_ON` gets old.

## the NYU Langone ferry

NYU runs a weekday ferry between East 34th Street and the Brooklyn Army Terminal, so it shows up at landings `8` and `24` — opposite ends of the same crossing. it is the only partner here that publishes no GTFS at all: the service exists only inside its [Passio GO](https://nyu.passiogo.com) app, and Passio's own `google_transit.zip` export is access-denied.

so `gtfs/nyu/` is **generated, not downloaded**. [`scripts/fetch-nyu-gtfs.js`](../scripts/fetch-nyu-gtfs.js) reconstructs an equivalent static feed from Passio's JSON backend and writes the `.txt` files, which are committed so a build never touches the network:

```
node scripts/fetch-nyu-gtfs.js
```

it probes a full week to see which days actually run rather than assuming, which is how the Mon–Fri calendar and the 30-minute crossing in the feed were derived. re-run it when NYU changes its timetable. no API key is involved — Passio's `deviceId` parameter is a client id, not a credential.

live estimates come from the same backend via [`lib/nyu-realtime.js`](../lib/nyu-realtime.js) and ride along in `/api/realtime` under the same `nyu:` ids, so the board matches both operators through one lookup. two things about that feed are worth knowing:

- Passio predicts when a boat **arrives** at a terminal, and a ferry that ties up early then waits for its timetable is not an early departure. the [no-early-departure rule](../gtfsferry.md) applies to NYU exactly as it does to NYC Ferry.
- Passio's `solidEta.scheduledDeparture` names the *block's* first sailing, not the one the boat is about to work — a 09:22 arrival comes back tagged `06:00`. it is deliberately ignored; the sailing is resolved from the timetable instead. see the comments in `lib/nyu-realtime.js`.

if Passio is unreachable the board falls back to the last snapshot, then to published times. NYU rows never block NYC Ferry's own estimates and vice versa.

## boat assignments

full explanation and the update runbook: [`ferryAssignments.md`](../ferryAssignments.md).

crews refer to a boat by its route and number — "East River 5" — so the staff board prints that
next to the vessel name as a compact `ER5` badge. boat numbers restart per route, so the route
code is part of the label: `ER5` and `AS5` are different boats.

the mapping lives in [`content/boat-assignments.json`](../content/boat-assignments.json), keyed by
GTFS `trip_short_name`. that column in [`gtfs/trips.txt`](../gtfs/trips.txt) holds the same trip
number the published crew schedule uses (`1101`, `4102`), which is what joins the two.

regenerate it when a new seasonal schedule is published, then commit the result:

```bash
pip install openpyxl
python3 scripts/import-boat-assignments.py schedules/summer-2026.xlsx
```

the importer is an offline maintenance step — the Node app never run Python. it
reads every sheet with a `Trip No.` and `Boat` column, tells the two columns apart by magnitude
(trip numbers are four digits, boat numbers are not) because a couple of sheets in the published
workbook fill them in the opposite order, and fails loudly if one trip number claims two boats.

not every trip gets a badge, and that's expected:

- the Rockaway East/West shuttles (`RES`, `RWS`) are buses, not boats.
- the Governors Island shuttle (`GI`) is crewed off-schedule and has no `Boat` column.
- NY Waterway publishes no crew schedule, so those rows stay unlabeled.

the bundled feed and [`schedules/summer-2026.xlsx`](../schedules) cover the same period, and every
other ferry route matches: `AS`, `ER`, `RR`, `SB`, and `SG` at 100%, `RS` at 93 of 96 trips. the
importer prints this coverage per route on every run. a missing or unreadable
`content/boat-assignments.json` is not fatal — the build just omits the badges.

**this has to be redone whenever the GTFS feed changes.** trip numbers are reissued each schedule
period, so an old mapping silently stops matching. [`ferryAssignments.md`](../ferryAssignments.md)
is the step-by-step runbook.
