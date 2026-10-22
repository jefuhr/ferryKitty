import { buildSummerDisplayData } from "./helpers/summer-schedule.js";
import { runtimeStub } from "./helpers/runtime-stub.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile as readDisk } from "node:fs/promises";
import { clientSource } from "./helpers/client-source.js";
import { NOW as SCHEDULED_NOW, scheduledBoardPayload, scheduledBoardRealtime } from "./helpers/scheduled-board-fixture.js";
import { activeServices } from "../public/assets/schedule.js";
const readFile = (file, encoding) => file.pathname?.endsWith("/public/app.js") ? clientSource(file) : readDisk(file, encoding);
import vm from "node:vm";

const appPath = new URL("../public/app.js", import.meta.url);
const cssPath = new URL("../public/styles.css", import.meta.url);
const indexPath = new URL("../public/index.html", import.meta.url);
const workerPath = new URL("../public/sw.js", import.meta.url);
const serverPath = new URL("../server.js", import.meta.url);

test("marks the final trip in each route-direction slot as LAST", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const slotKey = `\$\{departure\.routeId\}\|\$\{departure\.variant \|\| ""\}\|\$\{departure\.directionId\}`/);
  assert.match(app, /isLastOfDay: lastDepartures\.get/);
  assert.match(app, /class="departure-last-badge"[^>]*>LAST<\/strong>/);
  assert.doesNotMatch(app, /const slotKey = .*destination/);
});

test("marks the final South Brooklyn trip serving Governors Island", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /departure\.routeId === "SB" && departure\.servesGovernorsIsland/);
  assert.match(app, /isLastGovernorsIsland: departure\.servesGovernorsIsland/);
  assert.match(app, /Last South Brooklyn departure serving Governors Island/);
  assert.match(app, /item\.isLastOfDay \|\| item\.isLastGovernorsIsland/);
});

test("uses the kiosk yellow LAST badge styling", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.match(css, /--warning:#ffd100/);
  assert.match(app, /<span class="departure-last-slot">\$\{lastLabel\}/);
  assert.match(css, /\.departure-last-slot\{[^}]*min-height:/);
  assert.match(css, /\.departure-last-badge\{[^}]*background:var\(--warning\)[^}]*border:2px solid #d89a26[^}]*border-radius:8px/);
});

test("shows fresh late and on-time status in the reserved badge row", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.match(app, /hasFreshTiming = !realtime\.stale && item\.hasLiveTiming/);
  assert.match(app, /delaySeconds >= 60/);
  assert.match(app, />\+\$\{Math\.max\(1, Math\.round\(delaySeconds \/ 60\)\)\} min<\/span>/);
  assert.match(app, /class="on-time-badge"[^>]*>ON TIME<\/span>/);
  assert.match(app, /class="scheduled-badge"[^>]*aria-label="Status: Scheduled"[^>]*>\$\{scheduledClock\(\)\}<\/span>/);
  assert.match(app, /!isLast && !delayLabel && !onTimeLabel/);
  // ARRIVAL sits with the other "what kind of move is this" badges, ahead of the running status,
  // because whether a boat can be boarded at all is read before whether it is late.
  assert.match(app, /departure-last-slot">\$\{lastLabel\}\$\{arrivalLabel\}\$\{noPickupLabel\}\$\{delayLabel \|\| onTimeLabel \|\| scheduledLabel\}/);
  assert.match(css, /\.vessel-delay-badge\{background:#b83224\}/);
  assert.match(css, /\.on-time-badge\{background:#218a4b\}/);
  assert.match(css, /\.scheduled-badge\{color:var\(--navy\);background:#e6eef2/);
});

// A home-port run used to sit at its published minute however late the boat was, because its trip id
// is minted by the build and matches nothing in the feed. It now inherits the timing of the revenue
// trip it comes off — so the printed time, the countdown and how long the row survives all follow
// the boat. Crew shuttles name no such trip and are untouched.
test("a boat going to Pier C ties up as late as it ran", async () => {
  const app = await readFile(appPath, "utf8");

  // One lookup for every row: the row's own trip normally, the trip behind it for a synthetic one.
  assert.match(app, /updates\.get\(`\$\{departure\.liveTripId \|\| departure\.tripId\}\|\$\{departure\.stopId\}`\)/);

  // The delay badge is not gated on being in service — that is the whole point — but ON TIME is.
  // A boat going home empty is never on time or merely scheduled; it can only be late.
  const status = app.slice(app.indexOf("function departureStatus"), app.indexOf("function contrastOnWhite"));
  assert.match(status, /const noPickup = item\.outOfService \|\| item\.crewShuttle;/);
  assert.match(status, /hasFreshTiming && delaySeconds >= 60\n/);
  assert.match(status, /hasFreshTiming && delaySeconds < 60 && !noPickup\n/);
  // noPickup has to be settled before the badges that read it.
  assert.ok(status.indexOf("const noPickup") < status.indexOf("const onTimeLabel"));
});

// The badge on a boat's last working trip reads FINAL. Nothing about it is published: it is inferred
// from the shape of the boat's day against the crew sheet, so a shorter gap that could be a break
// rather than a finish keeps the question mark instead of claiming certainty.
test("a boat's last trip is badged FINAL", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, />FINAL\$\{item\.endsShift === "unsure" \? "\?" : ""\}<\/span>/);
  // Scoped to this badge rather than the whole file: an arriving boat that terminates here does
  // say DROP OFF ONLY, and means it literally. What must not come back is FINAL wearing those
  // words, because FINAL is inferred and DROP OFF ONLY reads as published fact.
  assert.doesNotMatch(app, /class="drop-off-badge[^"]*"[^>]*>[^<]*DROP OFF/,
    "the FINAL badge no longer says DROP OFF ONLY");
  // The reason survives for anyone reading by screen reader, where the word alone is thinner.
  assert.match(app, /aria-label="\$\{item\.endsShift === "unsure" \? "Probably this boat's final trip: drop off only, unconfirmed" : "This boat's final trip: drop off only"\}"/);
  // Distinct from LAST, which marks the last sailing a passenger can take on that route direction.
  assert.match(app, /class="departure-last-badge"[^>]*>LAST<\/strong>/);
});

test("never displays a realtime departure earlier than its scheduled time", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const delay = hasLiveTiming \? Math\.max\(0, liveDelay\) : 0/);
});

test("service alert freshness sits beside its heading", async () => {
  const [index, css] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(cssPath, "utf8")
  ]);
  assert.match(index, /class="service-alert-heading">\s*<strong>Service alerts<\/strong>\s*<small id="serviceAlertFreshness">/);
  assert.match(css, /\.service-alert-heading\{display:flex;align-items:baseline/);
});

// Sorted by route, the board used to divide its height by however many route directions the landing
// had. Pier 11 has twenty, so every row got a twentieth of the screen and its own overflow:hidden
// cut the destination and the status badges in half; a landing with two got half a screen each.
// Rows are a fixed height now and the list scrolls, which is what the timeline view already did.
test("the route board keeps its rows one size and scrolls past the bottom", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  const rule = css.match(/\.departures\{[^}]*\}/)[0];

  assert.match(rule, /grid-auto-rows:var\(--route-row\)/, "every row is the same height");
  assert.match(rule, /--route-row:clamp\(/, "and that height is bounded, not a fraction of the screen");
  assert.doesNotMatch(rule, /minmax\(0,1fr\)/, "a fractional row is what squashed twenty of them");
  // Without this the rows stretch to fill a landing that only has two.
  assert.match(rule, /align-content:start/);
  assert.match(rule, /overflow-y:auto/);
  // Firefox and Chrome take scrollbar-width; older WebKit needs the pseudo-element.
  assert.match(css, /\.departures\{[^}]*scrollbar-width:thin/);
  assert.match(css, /\.departures::-webkit-scrollbar\{width:/);

  // The row count no longer drives the layout, so nothing should still be setting it.
  assert.doesNotMatch(css, /--routes-shown/);
  assert.doesNotMatch(app, /--routes-shown/);

  // The phone stacks cards, and scrolls the list rather than the page, so the footer and the alert
  // bar stay pinned to the bottom of the screen instead of drifting with the content.
  const phone = css.slice(css.indexOf("@media(max-width:820px)"));
  assert.match(phone, /\.departures\{flex:1;min-height:0;display:flex[^}]*overflow-y:auto/);
  // Scroll chaining is what would otherwise let the gesture escape into a page that cannot move.
  assert.match(css, /\.departures\{[^}]*overscroll-behavior:contain/);
});

// A home-port row's trip id is minted by the build, not taken from the feed, so no live vehicle can
// ever match it and its own boatName is always empty. The vessel worth showing is the one currently
// working the trip the boat is about to pick up. The route board fell back to that; the timeline did
// not, so every Pier C row lost its boat the moment the board was sorted by departure time.
test("both views name the predicted boat on a home-port row", async () => {
  const app = await readFile(appPath, "utf8");

  // One helper renders the guess, so both views mark it the same way: italic, muted, question mark.
  assert.match(app, /function predictedName\(item\)/);
  assert.match(app, /predictedBoatName[\s\S]{0,200}boat-name-predicted[^`]*\}\?<\/em>/);
  assert.match(app, /predictTripId\s*\?\s*\n?\s*vehicles\.get\(String\(departure\.predictTripId\)\)/);

  // The route board's slot and the timeline's row both reach for it, and neither may stop at
  // boatName alone.
  assert.match(app, /item\.boatName \? escapeHtml\(item\.boatName\) : predictedName\(item\)/);
  assert.match(app, /departure\.predictedBoatName \? `<span class="tl-boat">\$\{predictedName\(departure\)\}<\/span>`/);

  const timeline = app.slice(app.indexOf("function renderTimeline"));
  const boatLine = timeline.slice(timeline.indexOf("const boat = crewBoats"), timeline.indexOf("Three lines"));
  assert.match(boatLine, /predictedName\(departure\)/, "the timeline must not stop at boatName");
});

// Every scheduled sailing, not just the home-port rows. The feed names a vessel only for trips it
// has reached, so anything later today has none of its own — but the workbook puts a boat on it, and
// the server says which vessel is on that boat right now.
test("a scheduled sailing predicts its vessel from the boat working it", async () => {
  const app = await readFile(appPath, "utf8");

  // Freshest report wins: a boat shows up on two trips as it hands over between them.
  assert.match(app, /const vessels = new Map\(\)/);
  assert.match(app, /if \(!item\.boat \|\| !item\.boatName\) continue/);
  assert.match(app, /updatedAtEpochSeconds \|\| 0\) >= \(seen\.updatedAtEpochSeconds \|\| 0\)/);

  // Looked up by the boat the workbook assigns, which partner rows and crew shuttles do not have.
  assert.match(app, /Number\.isInteger\(departure\.boatAssignment\)\s*\n?\s*\? vessels\.get\(`\$\{departure\.routeId\}\$\{departure\.boatAssignment\}`\)/);

  // A live vessel always wins; the guess only fills the gap, never competes with a real match.
  assert.match(app, /predictedBoatName: \(departure\.scheduleOnly && !departure\.liveTripId\)\s*\|\| vehicles\.get\(String\(departure\.liveTripId \|\| departure\.tripId\)\)\?\.boatName\s*\? null/);
});

test("staff board shows every route direction with config-driven departure columns", async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(cssPath, "utf8")
  ]);
  assert.match(app, /displayCount\("departuresShown"\)/);
  assert.match(app, /dataset\.departuresShown/);
  assert.doesNotMatch(app, /slideTimer|startSlideshow|slideIndex|PAGE_SIZE|TIMES_PER_DIRECTION/);
  assert.match(css, /repeat\(var\(--departures-shown\),minmax\(0,1fr\)\)/);
  for (let count = 1; count <= 5; count += 1) {
    assert.match(css, new RegExp(`data-departures-shown="${count}"`));
  }
});

test("shows the crew boat assignment beside the boat name", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.match(app, /Number\.isInteger\(item\.boatAssignment\)/);
  assert.match(app, /routeShortName\(item\.routeId\)\}\$\{item\.boatAssignment\}/);
  assert.match(app, /class="boat-assignment"/);
  // The assignment sits between the status badge and the boat name in the same row.
  assert.match(app, /\$\{delayLabel \|\| onTimeLabel \|\| scheduledLabel\}\$\{viaTerminals\}\$\{dropOffLabel\}\$\{assignment\}<span class="boat-name">/);
  assert.match(css, /\.boat-assignment\{[^}]*flex:0 0 auto/);
});

test("staff board keeps navigation without rider-facing advertising", async () => {
  const [index, worker] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(workerPath, "utf8")
  ]);
  assert.doesNotMatch(index, /ferry-mart|ad\.jpg|nyc-ferry-logo/);
  assert.doesNotMatch(worker, /ad\.jpg|nyc-ferry-logo/);
  assert.match(index, /id="clockTime"/);
  assert.match(index, /id="routeCount"/);
});

test("phone layout stacks the board into scrolling route cards", async () => {
  const [css, index] = await Promise.all([readFile(cssPath, "utf8"), readFile(indexPath, "utf8")]);
  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /name="apple-mobile-web-app-capable"/);
  const phone = css.match(/@media\(max-width:820px\)\{[\s\S]*?\n\}/);
  assert.ok(phone, "expected a max-width:820px phone block");
  const rules = phone[0];
  // A phone keeps the viewport-sized shell the tablet and the kiosk use: the screen is the screen,
  // and only the list inside it moves. It used to release that and scroll the whole page, which
  // left the footer and the alert bar wherever the scroll had put them.
  assert.doesNotMatch(rules, /html,body\{height:auto;overflow:visible\}/);
  // Pinned to the viewport's edges rather than measured against it. 100dvh came up short of the
  // screen on an installed iOS board and left a strip of page background under the bottom bars;
  // anchoring both edges means there is no unit left to disagree with.
  assert.match(rules, /\.screen\{position:fixed;inset:0/);
  assert.doesNotMatch(rules, /\.screen\{[^}]*\bheight:100dvh/);
  // The footer is a fixed row at the foot of the board rather than something trailing the list.
  assert.match(rules, /\.board-footer\{flex:0 0 auto/);
  // The landing name shares its line with the hamburger and the nearest-landing button. flex-basis
  // must stay 0: a wrapping flex container breaks lines on hypothetical sizes, so a heading that
  // asks for its full untruncated width pushes the button onto a row of its own. The auto margin
  // has to go with it, or it eats the free space before flex-grow can.
  assert.match(rules, /\.board-heading h1\{flex:1 1 0;min-width:0;margin-right:0/);
  // Departures stack vertically instead of sitting in columns.
  assert.match(rules, /\.departure-slots\{display:flex;flex-direction:column/);
  assert.match(rules, /\.departures\{flex:1;min-height:0;display:flex;flex-direction:column/);
  // Padding slots and the desktop column header are noise on a phone.
  assert.doesNotMatch(await readFile(appPath, "utf8"), /slots\.push\(null\)|No scheduled trip/);
  assert.match(rules, /\.column-head\{display:none\}/);
  // Notch and home-indicator clearance.
  assert.match(rules, /env\(safe-area-inset-top\)/);
  assert.match(rules, /env\(safe-area-inset-bottom\)/);
  // Landscape phones get two columns without inheriting the kiosk's fixed row count.
  assert.match(css, /@media\(max-width:820px\) and \(orientation:landscape\)/);
  assert.match(css, /grid-template-rows:none;grid-auto-rows:auto/);
});

// The bar has only ever had room for the first alert, clipped to two lines, and a count telling you
// there were others you could not reach. Tapping it opens the rest.
test("the alert bar expands into the full list of alerts", async () => {
  const [app, css, index] = await Promise.all([
    readFile(appPath, "utf8"), readFile(cssPath, "utf8"), readFile(indexPath, "utf8")
  ]);
  // A button, not a section, so it is reachable by keyboard and announces that it expands.
  assert.match(index, /<button type="button" class="service-alert-bar loading" id="serviceAlerts"[^>]*aria-expanded="false" aria-controls="alertMenu" disabled>/);
  assert.match(index, /<ul class="filter-list alert-list" id="alertList">/);
  // Disabled when there is nothing behind it, so a bar that cannot open does not invite a tap.
  assert.match(app, /elements\.serviceAlerts\.disabled = !expandable/);
  assert.match(app, /elements\.serviceAlertChevron\.hidden = !expandable/);
  // Every alert, not just the first.
  assert.match(app, /alerts\.map\(alertRow\)\.join\(""\)/);
  // Third-party text: only http(s) links are ever rendered as links.
  assert.match(app, /\/\^https\?:\\\/\\\/\/i\.test\(alert\.url \|\| ""\)/);
  assert.match(app, /rel="noopener noreferrer"/);
  // The feed reloads every minute. An open sheet follows it without stealing focus mid-read.
  assert.match(app, /if \(expandable\) renderAlertMenu\(\);/);
  assert.match(css, /\.alert-item\{/);
});

test("phone layout adapts the shared board", async () => {
  const css = await readFile(cssPath, "utf8");
  // Compact card rules apply at the phone breakpoint.
  const base = css.slice(0, css.indexOf("@media(max-width:820px)"));
  assert.match(base, /\.screen\{width:100vw;height:100vh/);
  assert.match(base, /\.departures\{flex:1;min-height:0;display:grid/);
  // The board itself carries no phone-only safe-area padding outside the media query. The
  // landing drawer does use env() in the base rules, since it overlays every screen size.
  assert.doesNotMatch(base.match(/\.board\{[^}]*\}/)[0], /env\(/);
  assert.doesNotMatch(base.match(/\.board-heading\{[^}]*\}/)[0], /env\(/);
});

test("landing menu lets an agent switch the board's landing", async () => {
  const [app, css, index, server] = await Promise.all([
    readFile(appPath, "utf8"), readFile(cssPath, "utf8"),
    readFile(indexPath, "utf8"), readFile(serverPath, "utf8")
  ]);
  // Server serves the list, and every landing is loaded up front rather than built on demand:
  // switching must not depend on a first-request build, and the realtime feeds have to see all
  // of them. See test/landing-data.test.js.
  assert.match(server, /url\.pathname === "\/api\/landings"/);
  assert.match(server, /loadAllLandingData/);
  assert.match(server, /!displayDataJson\.has\(landingNumber\)/);
  assert.match(server, /return json\(response, 400, \{ error: "Unknown landing\." \}\)/);
  // No landingId still resolves to the configured landing, so the kiosk contract is unchanged.
  assert.match(server, /requested === null \? Number\(displayConfig\.landingNumber\) : Number\(requested\)/);
  // The client names its landing so realtime comes back scoped to it.
  assert.match(app, /\/api\/realtime\?landingId=/);
  // Menu markup and the accessible toggle.
  assert.match(index, /id="menuButton"[^>]*aria-expanded="false"[^>]*aria-controls="landingMenu"/);
  assert.match(index, /id="landingMenu"[^>]*hidden/);
  assert.match(index, /id="landingList"/);
  // Selection is persisted and restored, including for an offline start.
  assert.match(app, /storage\.setItem\(landingKey/);
  assert.match(app, /function selectedLanding\(\)/);
  assert.match(app, /scheduleStore\.read\(/);
  assert.match(app, /\/api\/display-data\$\{query\}/);
  // Close paths: the Done button, the scrim, and Escape.
  assert.match(app, /bindSheet\(setMenuOpen, \{ menu: elements\.landingMenu, trigger: elements\.menuButton, close: elements\.landingMenuClose, scrim: elements\.landingMenuScrim/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /setAttribute\("aria-expanded", String\(open\)\)/);
  // Touch targets stay finger-sized.
  assert.match(css, /\.landing-option\{[^}]*min-height:48px/);
});

test("retired landing notices cannot replace the staff board", async () => {
  for (const file of [appPath, cssPath, indexPath, serverPath]) {
    assert.doesNotMatch(await readFile(file, "utf8"), /sftpOverride|manualOverride|manual-override|api.override/);
  }
});

test("partner operators show their mark in the route badge", async () => {
  const [app, css, worker] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(workerPath, "utf8")
  ]);
  assert.match(app, /prefix: "wtr:", src: "\/assets\/waterway\.png"/);
  assert.match(app, /prefix: "sea:", src: "\/assets\/seastreak\.png"/);
  assert.match(app, /prefix: "nyu:", src: "\/assets\/nyu\.png"/);
  assert.match(app, /prefix: "lib:", src: "\/assets\/cityferry\.png"/);
  assert.match(app, /class="route-badge-logo" src="\$\{partnerLogo\.src\}"/);
  assert.match(css, /\.route-badge-logo\{[^}]*object-fit:contain/);
  assert.match(worker, /\/assets\/waterway\.png/);
  assert.match(worker, /\/assets\/seastreak\.png/);
  assert.match(worker, /\/assets\/nyu\.png/);
  assert.match(worker, /\/assets\/cityferry\.png/);
});

test("two buttons at the bottom of the landing drawer swap the departure view", async () => {
  const [app, css, index] = await Promise.all([
    readFile(appPath, "utf8"), readFile(cssPath, "utf8"), readFile(indexPath, "utf8")
  ]);
  // Both buttons sit above the landing list, and each reports its own pressed state so the
  // active view is announced rather than only shown by colour.
  const panel = index.slice(index.indexOf('id="landingMenuPanel"'), index.indexOf('</nav>', index.indexOf('id="landingMenuPanel"')));
  assert.match(panel, /class="sort-toggle" role="group" aria-label="Sort departures"/);
  assert.match(panel, /id="sortByRoute" data-sort="route" aria-pressed="false"/);
  assert.match(panel, /id="sortByTime" data-sort="time" aria-pressed="true"/);
  assert.match(css, /\.sort-option\[aria-pressed="true"\]\{[^}]*background:var\(--navy\)/);

  // Departure time is the default; only an explicit choice of "route" opts out of it.
  assert.match(app, /storage\.getItem\(sortKey\) === "route" \? "route" : "time"/);
  assert.match(app, /storage\.setItem\(sortKey, next\)/);
  assert.match(app, /sortedBy\(\) === "route" \? renderRouteBoard\(\) : renderTimeline\(\)/);
});

test("the timeline lists every upcoming sailing in departure order, route on each row", async () => {
  const [app, css, index] = await Promise.all([
    readFile(appPath, "utf8"), readFile(cssPath, "utf8"), readFile(indexPath, "utf8")
  ]);
  // Every sailing across every route is flattened into one list ordered by time, so route
  // grouping cannot survive into the ordering.
  assert.match(app, /limitPerGroup: Infinity/);
  assert.match(app, /\.flatMap\(\(group\) => group\.departures\.map\(\(departure\) => \(\{ departure, group \}\)\)\)/);
  assert.match(app, /left\.departure\.delta - right\.departure\.delta \|\| byRoute\(left\.group, right\.group\)/);

  // All of them, bounded only by the board's existing lookahead — no fixed row cap. The bound is
  // about what a rider at the dock needs next, so it applies to the live board only; browsing a
  // day is a request for the whole day.
  assert.match(app, /\.filter\(\(\{ departure \}\) => !live \|\| departure\.delta <= windowSeconds\)/);
  assert.doesNotMatch(app, /TIMELINE_ROWS/);
  assert.doesNotMatch(app, /\.slice\(0, TIMELINE_ROWS\)/);

  // Three compact lines, with route identity travelling on the row. The destination owns the middle
  // line — it is the longest field and the one that reads worst truncated.
  assert.match(app, /<div class="tl-head">/);
  assert.match(app, /class="route-badge\$\{visual\.partnerLogo \? " route-badge-image" : ""\}"/);
  // The far end, plus the stops on the way for a boat that calls at several, and the turn it makes
  // when it arrives — all one line, because the turn is taken at the destination beside it.
  assert.match(app, /<strong class="tl-dest"><span class="tl-dest-name">\$\{escapeHtml\(group\.destination\)\}\$\{group\.via\?\.length/);
  assert.match(app, /<\/span>\$\{departureLayoverLabel\(departure\)\}<\/strong>/);
  assert.match(app, /<div class="tl-meta">/);

  // Countdown and status hug the right edge so both scan as columns down the list.
  assert.match(css, /\.tl-relative\{[^}]*margin-left:auto/);
  assert.match(css, /\.tl-status\{[^}]*margin-left:auto/);
  // Long destinations must ellipsis rather than spill out of the card, and the name is what gives
  // way: a layover shown half is worse than a pier name shown half.
  assert.match(css, /\.tl-dest-name\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.departure-layover\{[^}]*flex:0 0 auto/);

  // The vessel name, which only NYC Ferry publishes: rendered when a live vehicle supplies one and
  // omitted outright otherwise, so partner rows carry no empty element or stray separator.
  // A real vessel name when one is matched, otherwise the predicted one, otherwise no line at all —
  // never a placeholder. Partner operators publish no vessel and fall through to nothing.
  assert.match(app, /departure\.boatName \? `<span class="tl-boat">\$\{escapeHtml\(departure\.boatName\)\}<\/span>`/);
  assert.match(app, /: ""/);
  assert.match(css, /\.tl-boat::before\{content:"·"/);

  // The phone stylesheet sets .departure{display:block}, so the row must set its own display at
  // higher specificity or it silently stacks into a full-screen-tall card.
  assert.match(css, /\.departure\.timeline-row\{display:flex/);
  // .departure also sets align-items:center for the kiosk grid, which in a column flex box centres
  // the lines horizontally and lets them overflow both edges. The row must reset it.
  assert.match(css, /\.departure\.timeline-row\{[^}]*align-items:stretch/);
  assert.match(css, /\.departures\[data-view="timeline"\]\{display:flex[^}]*overflow-y:auto/);
  // Fixed row height, not squished to fit: the list scrolls instead.
  assert.match(css, /\.departure\.timeline-row\{[^}]*flex:0 0 auto/);
  // Phone overrides must exist inside the max-width block, after .departure{display:block}.
  const phone = css.slice(css.indexOf("@media(max-width:820px)"));
  assert.match(phone, /\.departures\[data-view="timeline"\]\{gap:8px/);
  assert.match(phone, /\.timeline-row \.route-badge\{width:46px/);

  // The column head describes the route board only, and is hidden on the timeline.
  assert.match(index, /id="columnHead" hidden/);
  assert.match(app, /elements\.columnHead\.hidden = true/);
  assert.match(app, /elements\.columnHead\.hidden = false/);

  // Both views share one status source, so they cannot disagree about a late boat.
  assert.match(app, /function departureStatus\(item\)/);
  assert.match(app, /function routeVisual\(routeId, variant\)/);
});

// The crews, the workbook and the radio all speak 24-hour time, so the board does too. Every clock
// on screen is covered: the departure times, the range a crew shuttle prints, the header clock and
// the service-notice timestamp.
test("24-hour is the default, and one helper decides it for every printed time", async () => {
  const app = await readFile(appPath, "utf8");

  // One place decides, so a formatter added later cannot quietly print in the other cycle.
  assert.match(app, /function hourOptions\(\) \{/);
  assert.match(app, /return clockFormat\(\) === "12"\s*\n\s*\? \{ hour: "numeric", hourCycle: "h12" \}\s*\n\s*: \{ hour: "2-digit", hourCycle: "h23" \}/);
  // Absent a stored choice it is 24-hour: this is a crew board and the schedule, the workbook and
  // the radio all speak in it.
  assert.match(app, /storage\.getItem\(clockKey\) === "12" \? "12" : "24"/);

  // Every formatter that prints an hour for someone to read goes through the helper. Counting them
  // is what stops a fourth being added later in a fixed cycle and going unnoticed.
  const spread = app.match(/\.\.\.hourOptions\(\)/g) || [];
  assert.equal(spread.length, 3,
    "the departure times, the clock and the alert window");

  // zonedParts is the exception and must stay one: it reads the hour to do arithmetic with, and a
  // 1-12 hour would put "now" twelve hours out for half of every day.
  const zoned = app.slice(app.indexOf("function zonedParts"), app.indexOf("function addDays"));
  assert.match(zoned, /hourCycle: "h23"/);
  assert.doesNotMatch(zoned, /hourOptions/);

  // hour12 is the tempting spelling and the wrong one in both directions — hour12:false yields a
  // 24:00 hour in some locales, so the cycle is always named outright. Checked against the code
  // with its comments stripped, since explaining the trap necessarily names it.
  const code = app.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /hour12:/);

  // A range needs no meridiem trimming, and the slicing that once did it would silently eat the
  // last two digits of the minutes if it were left behind.
  assert.doesNotMatch(app, /slice\(-2\)/);
  assert.match(app, /return `\$\{start\}<span class="time-range-dash">–<\/span>\$\{escapeHtml\(end\)\}`/);
});


// Browsing the schedule by date.
//
// These run the real public/app.js against a stub DOM rather than matching its source, because the
// question here is behavioural: does tomorrow's board show tomorrow's boats, all of them, in order,
// and without today's live estimates painted onto them. A regex cannot answer that.

const SERVICES = { weekday: "WKD", weekend: "WKE", holiday: "HOL" };

function sailing(serviceId, time, index) {
  const [hours, minutes] = time.split(":").map(Number);
  return {
    tripId: `${serviceId}-${index}`, routeId: "ER", serviceId, directionId: "0",
    stopId: "1", departureTime: `${time}:00`, seconds: hours * 3600 + minutes * 60,
    destination: "East 34th Street", variant: null, nextStop: null, servesGovernorsIsland: false,
    boatAssignment: null, mode: "ferry", operator: "NYC Ferry", via: [],
    endsShift: null, outOfService: false, crewShuttle: false, crewBoats: null,
    departureTimeEnd: null, secondsEnd: null, endsDay: false
  };
}

const SAMPLE = {
  meta: {
    timezone: "America/New_York", agencyName: "NYC Ferry", landingNumber: 16,
    departureWindowMinutes: 180, departuresShown: 4,
    landing: { name: "Pier 11", displayName: "Wall St / Pier 11", stopIds: ["1"] }
  },
  routes: { ER: { id: "ER", shortName: "ER", name: "East River", color: "#004E72", textColor: "#FFFFFF", mode: "ferry", operator: "NYC Ferry" } },
  calendars: [
    { serviceId: SERVICES.weekday, weekdays: [false, true, true, true, true, true, false], startDate: "2026-01-01", endDate: "2026-12-31" },
    { serviceId: SERVICES.weekend, weekdays: [true, false, false, false, false, false, true], startDate: "2026-01-01", endDate: "2026-12-31" }
  ],
  // Labor Day: the weekday service is pulled and a holiday one added in its place, which is exactly
  // the shape the crew calendars use and the case a weekday-versus-weekend guess would get wrong.
  exceptions: [
    { serviceId: SERVICES.weekday, date: "2026-09-07", added: false },
    { serviceId: SERVICES.holiday, date: "2026-09-07", added: true }
  ],
  departures: [
    ...["06:00", "09:00", "12:00", "18:00", "21:00"].map((time, index) => sailing(SERVICES.weekday, time, index)),
    ...["09:30", "13:30", "20:30"].map((time, index) => sailing(SERVICES.weekend, time, index)),
    ...["10:00", "16:00"].map((time, index) => sailing(SERVICES.holiday, time, index))
  ],
  tripSchedules: {}
};

async function board({ now = "2026-08-13T14:30:00Z", payload = SAMPLE, stored = {}, query = "", realtime = null } = {}) {
  const [app, index] = await Promise.all([readFile(appPath, "utf8"), readFile(indexPath, "utf8")]);
  const ids = [...index.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const nodes = new Map(), classes = new Map(), listeners = new Map(), store = new Map(Object.entries(stored));
  const requested = [];
  const node = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const made = {
      id, dataset: {}, hidden: false, disabled: false, textContent: "", innerHTML: "", title: "", attrs: {},
      style: { setProperty() {}, removeProperty() {} },
      classList: {
        toggle(name, on) { const set = classes.get(id) || new Set(); if (on) set.add(name); else set.delete(name); classes.set(id, set); },
        add() {}, remove() {}, contains: (name) => Boolean(classes.get(id)?.has(name))
      },
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key] ?? null; }, removeAttribute() {},
      addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
      focus() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, appendChild() {}, insertAdjacentHTML() {}
    };
    nodes.set(id, made);
    return made;
  };
  const Real = Date;
  class Frozen extends Real {
    constructor(...args) { return args.length ? super(...args) : super(now); }
    static now() { return new Real(now).getTime(); }
  }
  const context = {
    console, Promise, Intl, Math, JSON, Number, String, Object, Array, Boolean, Error, Set, Map, RegExp,
    isNaN, parseInt, parseFloat, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, Date: Frozen,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    // Standard in every browser this ships to, and used by the filter, theme and trip panels to
    // find the control that opened them. Without it here the harness is a browser the client does
    // not actually support.
    CSS: { escape: (value) => String(value).replace(/["\\\]]/g, "\\$&") },
    document: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      querySelector: (selector) => (selector.startsWith("#") && ids.includes(selector.slice(1)) ? node(selector.slice(1)) : null),
      querySelectorAll: () => [], addEventListener() {}
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key)
    },
    // A desktop-shaped window: the landing rail docks only on a tablet, so under test the menu is
    // the drawer every other assertion here expects it to be.
    navigator: {}, location: { search: query, reload() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    async fetch(url) {
      const path = String(url);
      requested.push(path);
      // Cloned, because a real fetch hands back a fresh object every time. Returning the shared
      // fixture by reference lets one test's `data.calendars = []` reach every later test.
      const body = path.startsWith("/api/display-data") ? structuredClone(payload)
        : path.startsWith("/api/landings") ? { landings: [] }
          : path.startsWith("/api/realtime") ? (realtime ? structuredClone(realtime) : { available: false, stale: true, updates: [], vehicles: [] })
            : path.startsWith("/api/alerts") ? { available: true, stale: false, alerts: [] }
              : { active: false, message: "", updatedAt: null };
      return { ok: true, json: async () => body };
    }
  };
  const flush = runtimeStub(context);
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(app, context, { filename: "app.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  return {
    context,
    requested,
    node,
    click: (id) => { listeners.get(`${id}:click`)?.(); flush(); },
    run: (source) => { const result = vm.runInContext(source, context); flush(); return result; },
    stored: () => [...store.entries()],
    times: () => [...node("departures").innerHTML.matchAll(/<time>(\d\d:\d\d)/g)].map((match) => match[1]),
    text: () => node("departures").innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  };
}

test("Pier 11 renders the bundled weekday STG 15:04 departure before boarding", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  const payload = await buildDisplayData({ root: new URL("..", import.meta.url).pathname, landingNumber: 16 });
  const view = await board({ now: "2026-09-15T18:59:00Z", payload, query: "?landing=16" });
  const active = activeServices(payload, "2026-09-15");
  const departure = payload.departures.find(item => item.routeId === "SG" && active.has(item.serviceId) && item.departureTime === "15:04:00");
  assert.ok(departure, "the published 15:04 sailing must survive the build");
  assert.equal(departure.outOfService, false);
  assert.ok(view.times().includes("15:04"), "the live board must render 15:04 at 14:59 Eastern without realtime");
  const groups = view.run("routeDirectionGroups()");
  assert.ok(groups.some(group => group.routeId === "SG" && group.departures.some(item => item.tripId === departure.tripId)));
});

test("a landing link overrides the saved board once, then allows another selection", async () => {
  const view = await board({ query: "?landing=27", stored: { "nyc-ferry-did-selected-landing": "16" } });
  assert.ok(view.requested.includes("/api/display-data?landingId=27"));
  view.run('localStorage.setItem(landingKey, "17")');
  assert.equal(view.run("selectedLanding()"), 17);
  const invalid = await board({ query: "?landing=not-a-landing", stored: { "nyc-ferry-did-selected-landing": "16" } });
  assert.ok(invalid.requested.includes("/api/display-data?landingId=16"));
});

test("the date stepper walks the schedule forwards and back, and returns to today", async () => {
  const view = await board();
  assert.equal(view.node("dateCurrent").textContent, "Today");
  assert.equal(view.node("dateBar").dataset.state, "today");

  view.click("dateNext");
  assert.equal(view.node("dateCurrent").textContent, "Tomorrow");
  assert.equal(view.node("dateBar").dataset.state, "browsing");
  // Friday 14 August 2026 runs the weekday pattern.
  assert.deepEqual(view.times(), ["06:00", "09:00", "12:00", "18:00", "21:00"]);

  view.click("dateNext");
  assert.equal(view.node("dateCurrent").textContent, "Sat, Aug 15");
  assert.deepEqual(view.times(), ["09:30", "13:30", "20:30"]);

  view.click("datePrev");
  assert.equal(view.node("dateCurrent").textContent, "Tomorrow");

  view.click("dateCurrent");
  assert.equal(view.node("dateCurrent").textContent, "Today");
  assert.equal(view.node("dateBar").dataset.state, "today");
});

test("a browsed day shows the whole day, where the live board shows a lookahead window", async () => {
  const view = await board({ now: "2026-08-13T14:30:00Z" });
  // 10:30 local, and the window is three hours: only the 12:00 is in reach today.
  assert.deepEqual(view.times(), ["12:00"]);
  view.click("dateNext");
  // Tomorrow is a question about the day, not about the next three hours, so the cap lifts —
  // including the boats that sail before the hour it is now.
  assert.deepEqual(view.times(), ["06:00", "09:00", "12:00", "18:00", "21:00"]);
});

test("a browsed day carries no live estimates and no countdown", async () => {
  const view = await board();
  view.click("dateNext");
  const html = view.node("departures").innerHTML;
  // A delay reported for a boat on the water today says nothing about tomorrow's sailing.
  assert.doesNotMatch(html, /on-time-badge|departure-delay-badge/);
  // "in 12 min" measured from midnight would be nonsense, so the row shows the time and stops.
  assert.doesNotMatch(html, /class="tl-relative">[^<]/);
  assert.doesNotMatch(html, /class="slot-relative">[^<]/);
  // The schedule facts a browsed day genuinely does know are still there.
  assert.match(html, /departure-last-badge/);
});

test("a browsed day honours dated exceptions rather than guessing from the weekday", async () => {
  const view = await board();
  // Labor Day 2026 is a Monday, so a weekday-shaped guess would show the weekday boats.
  view.run(`viewDate = "2026-09-07"; render();`);
  assert.deepEqual(view.times(), ["10:00", "16:00"]);
  assert.deepEqual([...activeServices(SAMPLE, "2026-09-07")], ["HOL"]);
  // The ordinary Monday either side of it is unaffected.
  view.run(`viewDate = "2026-09-14"; render();`);
  assert.deepEqual(view.times(), ["06:00", "09:00", "12:00", "18:00", "21:00"]);
});

test("the stepper stops at the ends of the bundled schedule", async () => {
  const view = await board();
  // Read field by field: the object is minted inside the vm realm, so its prototype is not this
  // realm's Object.prototype and a strict deepEqual would reject it on that alone.
  const range = view.run("scheduleRange()");
  assert.equal(range.first, "2026-01-01");
  assert.equal(range.last, "2026-12-31");

  view.run(`viewDate = ${JSON.stringify(range.last)}; render();`);
  assert.equal(view.node("dateNext").disabled, true);
  assert.equal(view.node("datePrev").disabled, false);
  view.click("dateNext");
  assert.equal(view.run("viewDate"), range.last, "a step past the last served day is refused");

  view.run(`viewDate = ${JSON.stringify(range.first)}; render();`);
  assert.equal(view.node("datePrev").disabled, true);
  view.click("datePrev");
  assert.equal(view.run("viewDate"), range.first, "a step before the first served day is refused");
});

// The efficiency requirement. A schedule only varies by weekday and by the dated exceptions, so
// computing a board per date would be redoing the same work all week.
test("browsed departures retain the selected service date", async () => {
  const view = await board();
  for (const date of ["2026-08-14", "2026-08-21", "2026-08-14"]) {
    view.run(`viewDate = "${date}"; render();`);
    assert.equal(view.run("timelineDepartures()[0].departure.serviceDate"), date);
  }
});

test("an empty browsed day is not reported as service having concluded", async () => {
  const view = await board();
  // A date inside the calendar range that no service covers.
  view.run(`data.departures = []; viewDate = "2026-08-20"; render();`);
  assert.match(view.text(), /NO SCHEDULED BOATS/);
  assert.match(view.text(), /Nothing is scheduled here on Thursday, August 20/);
  assert.doesNotMatch(view.text(), /concluded for the day/);

  view.run("viewDate = null; render();");
  assert.match(view.text(), /NO MORE BOATS/);
  assert.match(view.text(), /concluded for the day/);
});

test("expired saved schedules do not claim that service has ended", async () => {
  const view = await board({ now: "2027-01-02T15:00:00Z" });
  assert.match(view.text(), /SCHEDULE UNAVAILABLE/);
  assert.match(view.text(), /No saved schedule covers this date/);
  assert.doesNotMatch(view.text(), /concluded for the day/);
});

// A date is a lookup, not a setting. A board reopened the next morning still showing yesterday's
// pick of "tomorrow" would be confidently wrong about the only thing it is for.
test("the browsed date is never persisted and resets when the landing changes", async () => {
  const view = await board();
  view.click("dateNext");
  assert.equal(view.run("viewDate"), "2026-08-14");
  // Nothing the client wrote to storage mentions the browsed date, so a cold start cannot restore
  // it. The landing choice and the sort preference are still persisted, as they should be.
  const written = JSON.stringify(view.stored());
  assert.doesNotMatch(written, /2026-08-14/);
  assert.ok(view.stored().some(([key]) => key === "nyc-ferry-did-selected-landing"), "the landing choice is still remembered");

  // And a landing switch re-runs load(), which clears both the memoized days and the date.
  view.run(`viewDate = "2026-09-01";`);
  await view.run("load()");
  assert.equal(view.run("viewDate"), "2026-09-01", "same-landing refresh keeps the date");
  await view.run("load(4)");
  assert.equal(view.run("viewDate"), null);
});

// "Calls at another Manhattan terminal on the way".
//
// Only NY Waterway's South Amboy route threads Pier 11, Brookfield Place and Pier 79 together, and
// two rows can both read "South Amboy" while only one of them stops at Brookfield Place.
function waterwaySailing(time, viaTerminals, destination = "South Amboy") {
  const [hours, minutes] = time.split(":").map(Number);
  return {
    tripId: `wtr:t-${time}`, routeId: "wtr:77347", serviceId: "WKD", directionId: "0",
    stopId: "wtr:2439146", departureTime: `${time}:00`, seconds: hours * 3600 + minutes * 60,
    destination, variant: null, nextStop: null, servesGovernorsIsland: false, viaTerminals,
    boatAssignment: null, mode: "ferry", operator: "NY Waterway", via: [],
    endsShift: null, outOfService: false, crewShuttle: false, crewBoats: null,
    departureTimeEnd: null, secondsEnd: null, endsDay: false
  };
}

const BPC = { code: "BPC", name: "Brookfield Place / Battery Park City" };
const PIER11 = { code: "PIER 11", name: "Pier 11 / Wall Street" };
const P79 = { code: "P79", name: "Midtown West / Pier 79" };

test("a boat calling at another Manhattan terminal is badged with it", async () => {
  const payload = {
    ...SAMPLE,
    routes: { ...SAMPLE.routes, "wtr:77347": { id: "wtr:77347", shortName: "77347", name: "South Amboy - Pier 11/Wall St.", color: "#00558C", textColor: "#FFFFFF", mode: "ferry", operator: "NY Waterway" } },
    departures: [
      waterwaySailing("09:10", [BPC]),
      waterwaySailing("09:20", []),
      waterwaySailing("09:40", [BPC, PIER11]),
      waterwaySailing("09:50", [P79])
    ]
  };
  const view = await board({ payload });
  view.run(`viewDate = "2026-08-14"; render();`);
  const html = view.node("departures").innerHTML;

  // One badge per intermediate terminal, each with its own colour class.
  assert.match(html, /<span class="via-terminal-badge via-terminal-bpc"[^>]*>VIA BPC<\/span>/);
  assert.match(html, /<span class="via-terminal-badge via-terminal-pier11"[^>]*>VIA PIER 11<\/span>/);
  assert.match(html, /<span class="via-terminal-badge via-terminal-p79"[^>]*>VIA P79<\/span>/);
  // The full terminal name reaches a screen reader; the badge itself only has room for the code.
  assert.match(html, /aria-label="Calls at Brookfield Place \/ Battery Park City on the way"/);

  // A boat calling at two of them carries both, in the order it reaches them.
  const both = html.slice(html.indexOf("09:40"));
  assert.ok(both.indexOf("VIA BPC") < both.indexOf("VIA PIER 11"));

  // Four sailings carrying one, none, two and one terminal: four badges, and the direct 09:20 is
  // not badged at all rather than being labelled "direct".
  assert.equal([...html.matchAll(/via-terminal-badge/g)].length, 4);
  const direct = html.slice(html.indexOf("09:20"), html.indexOf("09:40"));
  assert.doesNotMatch(direct, /via-terminal-badge/);
});

test("the via-terminal badge borrows the SCHEDULED shape but none of the status colours", async () => {
  const css = await readFile(cssPath, "utf8");
  const badge = /\.via-terminal-badge\{([^}]*)\}/.exec(css)[1];
  // Same silhouette as .scheduled-badge, so it reads as the same class of information.
  for (const property of ["display:inline-flex", "padding:2px 5px", "border-radius:6px", "font-weight:950", "white-space:nowrap"]) {
    assert.ok(badge.includes(property), `via badge should share ${property} with the scheduled badge`);
  }
  // Its own hue per terminal, and none of them a status colour: on-time green, late red, LAST
  // yellow, FINAL amber or NO PICKUP grey would each make the badge mean the wrong thing.
  const hues = ["via-terminal-bpc", "via-terminal-p79", "via-terminal-pier11"]
    .map((name) => new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(css)[1]);
  assert.equal(new Set(hues).size, 3, "each terminal needs its own colour");
  for (const rule of hues) {
    for (const taken of ["#218a4b", "#b83224", "#ffd100", "#ffe6bf", "#4a5b68", "#e6eef2"]) {
      assert.ok(!rule.includes(taken), `via badge must not reuse the status colour ${taken}`);
    }
  }
});

// The clock-format button, beside the date stepper at the foot of the board.
test("the clock toggle flips every printed time and remembers the choice", async () => {
  const view = await board();
  const times = () => [...view.node("departures").innerHTML.matchAll(/<time>([^<]+)</g)].map((match) => match[1]);

  // 24-hour is what a device sees before anyone touches it.
  assert.equal(view.node("clockToggle").textContent, "24 h");
  assert.equal(view.node("clockToggle").getAttribute("aria-pressed"), "false");
  view.run(`viewDate = "2026-08-14"; render();`);
  assert.deepEqual(times(), ["06:00", "09:00", "12:00", "18:00", "21:00"]);
  const clock24 = view.node("clockTime").textContent;
  assert.match(clock24, /^\d{2}:\d{2}$/);

  view.click("clockToggle");
  assert.equal(view.node("clockToggle").textContent, "12 h");
  assert.equal(view.node("clockToggle").getAttribute("aria-pressed"), "true");
  assert.match(view.node("clockToggle").getAttribute("aria-label"), /Switch to 24-hour/);
  // Midnight and noon are the two the wrong cycle gets wrong, so the fixture brackets the day.
  assert.deepEqual(times(), ["6:00 AM", "9:00 AM", "12:00 PM", "6:00 PM", "9:00 PM"]);
  // The header clock moves with the rows rather than being left behind in the other cycle.
  assert.match(view.node("clockTime").textContent, /(AM|PM)$/);

  // And back, with the choice persisted for the next start.
  view.click("clockToggle");
  assert.deepEqual(times(), ["06:00", "09:00", "12:00", "18:00", "21:00"]);
  assert.equal(view.node("clockTime").textContent, clock24);
  view.click("clockToggle");
  assert.ok(view.stored().some(([key, value]) => key === "nyc-ferry-did-clock" && value === "12"));
});

test("a device that chose 12-hour starts in it", async () => {
  const view = await board({ stored: { "nyc-ferry-did-clock": "12" } });
  assert.equal(view.node("clockToggle").textContent, "12 h");
  view.run(`viewDate = "2026-08-14"; render();`);
  assert.match(view.node("departures").innerHTML, /<time>6:00 AM</);
});

// The stepper and the toggle share the footer, and the stepper takes the space the toggle does not.
test("the clock toggle sits beside the date stepper at the foot of the board", async () => {
  const [index, css] = await Promise.all([readFile(indexPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.match(index, /<div class="board-footer">[\s\S]*id="dateBar"[\s\S]*id="clockToggle"[\s\S]*<\/div>/);
  // Below the list, not above it.
  assert.ok(index.indexOf('id="departures"') < index.indexOf("board-footer"));
  assert.match(css, /\.board-footer\{[^}]*display:flex/);
  assert.match(css, /\.date-bar\{flex:1 1 auto/, "the stepper takes the leftover width");
  assert.match(css, /\.clock-toggle\{flex:0 0 auto/);
  // Thumb-sized on a phone, like everything else in that row.
  const phone = css.slice(css.indexOf("@media(max-width:820px)"));
  assert.match(phone, /\.clock-toggle\{[^}]*min-height:48px/);
});

// The version these assert against is read rather than written down. Pinning the literal here meant
// a bump had to be made in six places at once — five shipped files and this test — and the one that
// gets missed is invisible until an installed board is quietly running last week's code.
test("every asset reference carries the configured version", async () => {
  const { readAssetVersion, findDrift } = await import("../scripts/stamp-assets.js");
  const version = await readAssetVersion();
  const drift = await findDrift(version);
  assert.deepEqual(drift, [], `run \`npm run stamp\`: these references are not on version ${version}`);
});

// The stored data this board keeps is not an asset and does not ride the asset version. Its prefix
// only looks like the service worker's cache names, and a stamp that rewrote it would log every
// device out of its landing, its favourites and its theme on every release.
test("the localStorage prefix is not versioned with the assets", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /^const cacheKey = "nyc-ferry-did-data-v6";$/m,
    "public/app.js cacheKey must stay pinned at v6");
});

test("offline shell includes the current departure-link script", async () => {
  const { readAssetVersion } = await import("../scripts/stamp-assets.js");
  const version = await readAssetVersion();
  const [index, worker] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(workerPath, "utf8")
  ]);
  assert.ok(index.includes(`styles.css?v=${version}`));
  assert.ok(index.includes(`app-shell.js?v=${version}`));
  assert.ok(worker.includes(`nyc-ferry-did-shell-v${version}`));
  assert.ok(worker.includes(`styles.css?v=${version}`));
  assert.ok(worker.includes(`app.js?v=${version}`));

  // The app icon, on the same version as everything else. It is what an installed board shows on a
  // home screen, so it has to be in the precache: an icon that only exists online is missing on
  // exactly the phone that installed the board to use it offline. iOS reads the apple-touch-icon
  // link specifically and falls back to a screenshot of the page without one.
  assert.ok(index.includes(`rel="icon" href="/assets/app-icon.png?v=${version}"`));
  assert.ok(index.includes(`rel="apple-touch-icon" href="/assets/app-icon-180.png?v=${version}"`));
  assert.ok(index.includes(`rel="manifest" href="/assets/site.webmanifest?v=${version}"`));
  for (const asset of ["app-icon.png", "app-icon-180.png", "app-icon-192.png", "app-icon-512.png", "app-icon-maskable-512.png"]) {
    assert.ok(worker.includes(`'/assets/${asset}?v=${version}'`), `${asset} is missing from the offline shell`);
  }
  assert.ok(worker.includes(`'/assets/site.webmanifest?v=${version}'`));
});

// The Trust's boats are badged with its wordmark, so the logo has to be precached with the rest of
// the shell — a partner badge that 404s offline leaves an empty box where the operator should be.
test("the Governors Island badge ships with the offline shell", async () => {
  const [app, worker] = await Promise.all([readFile(appPath, "utf8"), readFile(workerPath, "utf8")]);
  assert.match(app, /\{ prefix: "gi:", src: "\/assets\/gi\.png"/);
  assert.match(worker, /'\/assets\/gi\.png'/);
});

// The nearest-landing button. Two things here are easy to break and invisible when broken: the
// button must never read position without a tap, and it has to sit on the heading's first line —
// .board-state wraps to a line of its own on a phone, which is what puts this in the top right.
test("the nearest-landing button locates on tap and then shortcuts", async () => {
  const [index, app, css] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(cssPath, "utf8")
  ]);

  assert.match(index, /id="nearestButton"/);
  assert.match(index, /id="nearestLabel"/);
  // Between the landing name and the chips, so the phone wrap leaves it in the corner.
  assert.ok(
    index.indexOf('id="nearestButton"') > index.indexOf('id="landingName"'),
    "the button must follow the landing name"
  );
  assert.ok(
    index.indexOf('id="nearestButton"') < index.indexOf('class="board-state"'),
    "the button must precede the chips that wrap onto the second line"
  );

  // Position is read on an explicit tap and nowhere else: no watchPosition, and no getCurrentPosition
  // on load, so anyone who never asks is never prompted.
  assert.doesNotMatch(app, /watchPosition/);
  assert.equal(app.match(/getCurrentPosition/g)?.length, 1, "position is requested in exactly one place");
  assert.match(app, /function locateNearest\(\)/);
  assert.match(app, /elements\.nearestButton\.addEventListener\("click"/);

  // Ranking needs a position per landing, which only reaches the client through /api/landings.
  assert.match(app, /function nearestLanding\(latitude, longitude\)/);
  assert.match(app, /function distanceMetres\(/);
  assert.match(app, /Number\.isFinite\(landing\.latitude\)/);

  // Tapping always does something: jump to the landing, or take a fresh fix when already there.
  assert.match(app, /saved\.id !== data\?\.meta\?\.landingNumber\) return void selectLanding\(saved\.id\)/);
  assert.match(app, /setNearest\("here"/);

  // A denied permission is a different problem from a fix that did not arrive, and says so.
  assert.match(app, /PERMISSION_DENIED/);

  assert.match(css, /\.nearest-button\{[^}]*flex:0 0 auto/);
  // The label is a landing name and some are long, so it truncates rather than widening the header.
  assert.match(css, /\.nearest-label\{[^}]*text-overflow:ellipsis/);
  // Icon only, since the map button now shares that row. The name stays in the markup and stays
  // announced — a button whose whole content is an SVG is one a screen reader cannot describe.
  assert.match(index, /class="nearest-label visually-hidden"/);
  assert.match(app, /elements\.nearestButton\.setAttribute\("aria-label", description\)/);
  const phoneStyles = css.slice(css.indexOf("@media(max-width:820px)"));
  assert.match(phoneStyles, /\.nearest-button\{height:40px/);
});

// The map lives at its own path on a server that answers from two different roots, so the one thing
// that can silently break here is the link: rooted at /map it works on a kiosk and 404s on
// juliet.nyc, where this board is proxied under /ferryTimesMobile/ and the site root belongs to
// somebody else. Relative is the only spelling that is right in both places.
test("the shared header owns one Board/Map navigation above both views", async () => {
  const index = await readFile(indexPath, "utf8");
  const alias = await readFile(new URL("../public/map.html", import.meta.url), "utf8");
  assert.equal(alias, index, "static map alias must ship the same shell");
  assert.equal((index.match(/class="product-nav"/g) || []).length, 1);
  assert.match(index, /id="mapButton" href="map" data-view="map"/);
  assert.ok(index.indexOf('id="mapButton"') < index.indexOf('id="boardView"'));
  assert.ok(index.indexOf('id="boardView"') < index.indexOf('id="mapView"'));
});

// The trip sheet already answers "where does this boat go". This is the other half — "and where is
// it now" — and it is a link rather than a second sheet, because the board only has one gesture for
// a departure and it was already spoken for.
test("the trip sheet offers its vessel on the map, by name", async () => {
  const [index, app, css] = await Promise.all([
    readFile(indexPath, "utf8"), readFile(appPath, "utf8"), readFile(cssPath, "utf8")
  ]);

  // Inside the trip panel, between the summary and the stops, and relative like the heading's.
  assert.match(index, /<a class="trip-map-link" id="tripMapLink" href="map" hidden>/);
  assert.ok(index.indexOf('id="tripMapLink"') > index.indexOf('id="tripSummary"'));
  assert.ok(index.indexOf('id="tripMapLink"') < index.indexOf('id="tripStops"'));

  // By vessel name, never by trip id: the predicted case is a vessel working a different trip
  // entirely, and this trip's id would find nothing on the map.
  assert.match(app, /map\?boat=\$\{encodeURIComponent\(vessel\.name\)\}/);
  assert.doesNotMatch(app, /map\?trip=/);
  assert.match(app, /function vesselForTrip\(tripId\)/);
  // Hidden rather than shown empty when the feed has not named a boat for this sailing.
  assert.match(app, /elements\.tripMapLink\.hidden = !vessel/);
  // Redrawn with the sheet, so a boat named while it is open turns the link on.
  assert.match(app, /renderTripMapLink\(\);/);
  // A browsed day has no boats on the water at all, so it has nothing to point at.
  assert.match(app, /viewFrame\(new Date\(\)\)\.live \? vesselForTrip/);

  assert.match(css, /\.trip-map-link\{[^}]*background:var\(--card\)/);
});

// The map page is a second document on the same server, with the same two roots and the same
// Content-Security-Policy. Its assets have to be under /assets/ for the proxy to forward them, and
// nothing on it may reach off this origin: default-src 'self' would block a tile server outright,
// and an offline-first board should not be asking one for permission to draw a map anyway.
test("the map page draws itself from this origin alone", async () => {
  const root = new URL("../", import.meta.url);
  const [page, script, styles, server] = await Promise.all([
    readFile(new URL("public/map.html", root), "utf8"),
    readFile(new URL("public/assets/map.js", root), "utf8"),
    readFile(new URL("public/assets/map.css", root), "utf8"),
    readFile(serverPath, "utf8")
  ]);

  const forwarded = /^\/(?:app\.js|styles\.css|sw\.js|assets\/|api\/|ferryTimesMobile\/)/;
  for (const url of [...page.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1])) {
    assert.match(url, forwarded, `${url} is not a path the proxy forwards to the board`);
  }

  // The tile hosts are the one deliberate exception, so this pins them rather than forbidding them:
  // exactly two, both over TLS, and nothing else off this origin anywhere on the page. Adding a
  // third — an analytics beacon, a font, a CDN — has to be a decision somebody makes here.
  // Attribution links are navigation, not resources loaded by the page.
  const OFF_ORIGIN = /https?:\/\/(?!www\.w3\.org\/|www\.openseamap\.org\b|www\.openstreetmap\.org\/copyright|carto\.com\/attributions)[^\s"'`)]+/g;
  const hosts = new Set();
  for (const source of [page, script, styles]) {
    for (const url of source.match(OFF_ORIGIN) || []) hosts.add(new URL(url).host);
  }
  assert.deepEqual([...hosts].sort(), ["tile.openstreetmap.org", "tiles.openseamap.org"]);
  for (const url of script.match(OFF_ORIGIN) || []) assert.match(url, /^https:/, `${url} is not over TLS`);

  // Both spellings of the path, the same way the stats page is reached.
  assert.match(server, /\["\/map", "index\.html"\], \["\/map\.html", "index\.html"\]/);
  assert.match(server, /url\.pathname === "\/api\/boats"/);
  assert.match(server, /url\.pathname === "\/api\/map"/);

  // Rendered through textContent, never innerHTML: a vessel name falls back to whatever string the
  // realtime feed put in vehicle.label, and that is third-party text going onto a page.
  assert.doesNotMatch(script, /\.innerHTML\b/);

  // The board's own payload must not grow a coordinate per vessel to feed this page.
  assert.match(server, /const \{ positions, \.\.\.departureData \} = ferry/);

  // The policy has to actually let the tiles through, and has to let nothing else through with
  // them. A tile host in script-src or connect-src would be a different and much larger decision.
  const policy = server.match(/"Content-Security-Policy", "([^"]+)"/)[1];
  const directives = Object.fromEntries(policy.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  assert.deepEqual(directives["img-src"], ["'self'", "data:", "https://tile.openstreetmap.org", "https://tiles.openseamap.org"]);
  for (const directive of ["default-src", "script-src", "style-src", "connect-src", "font-src"]) {
    assert.deepEqual(directives[directive], ["'self'"], `${directive} should still be 'self' alone`);
  }
});

// The tile layer. Two things here are easy to get wrong and hard to see: tiles drawn in the wrong
// projection sit plausibly but a few hundred metres off the water, and a tile set recomputed on
// every frame of a drag turns a pan into a stutter of network requests.
test("the tile layer is Web Mercator, and is only rebuilt when it has to be", async () => {
  const script = await readFile(new URL("../public/assets/map.js", import.meta.url), "utf8");

  // Mercator, not the equirectangular approximation that came before it: the tiles are cut to it.
  const projection = await readFile(new URL("../public/assets/map-projection.js", import.meta.url), "utf8");
  assert.match(script, /import \{ worldX, worldY \} from "\.\/map-projection\.js"/);
  assert.match(projection, /function worldY\(latitude\)/);
  assert.match(projection, /Math\.log\(\(1 \+ sine\) \/ \(1 - sine\)\)/);
  // A tile's box is the same arithmetic as any other point, which is what keeps them in register.
  assert.match(script, /tile\(x, y, span\)/);

  // Rebuilt on a signature of the tile set rather than on every view change.
  assert.match(script, /if \(signature === tilesDrawnFor\) return;/);
  assert.match(script, /const signature = `\$\{zoom\}\|\$\{fromX\}\|\$\{toX\}\|\$\{fromY\}\|\$\{toY\}`/);

  // Drawn first, so everything this server knows about is drawn over the top of it.
  assert.ok(script.indexOf('svgNode("g", { class: "tiles" })') < script.indexOf('svgNode("g", { class: "casings" })'));
});

// The pulse under a moving boat, which shipped animating about the middle of the harbor instead of
// about its own boat: transform-box starts out as view-box on SVG, so transform-origin: center was
// resolving against the whole viewBox.
//
// This is a source assertion and not a behavioural one, and the difference is worth stating: the
// fake DOM the map page is otherwise tested against has no layout and no animation, so it cannot
// tell a wake in the right place from one flung across the harbor. Nothing here proves the pulse
// looks right — only that the property it needs has not been dropped again.
test("anything given a transform-origin in the map's SVG also gets a transform-box", async () => {
  const styles = await readFile(new URL("../public/assets/map.css", import.meta.url), "utf8");
  for (const rule of styles.match(/[^{}]*\{[^}]*transform-origin[^}]*\}/g) || []) {
    assert.match(rule, /transform-box:\s*fill-box/, `a transform-origin without a transform-box:\n${rule}`);
  }
  // Wakes are now static; if animation returns, the loop above still guards its origin.
  assert.doesNotMatch(styles, /\.boat-wake\s*\{[^}]*animation:/);
});

// A merge once shipped conflict markers in index.html and sw.js. Nothing caught it: the contract
test("the LOCAL badge is allowed the width its own word needs", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  // Both views name the variant, so both have to carry the class the width hangs off. The timeline
  // did not, which is where LOCAL was being cut off against the edge of its own badge.
  assert.match(app, /const variantClass = group\.variant \? ` variant-\$\{group\.variant\.toLowerCase\(\)\}` : ""/);
  assert.match(app, /class="departure timeline-row route-\$\{visual\.routeClass\}\$\{variantClass\}/);
  assert.match(app, /class="departure route-\$\{routeClass\}\$\{variantClass\}/);
  // Only this variant widens. A and B fit the fixed width and stay in a column with every other route.
  assert.match(css, /\.departure\.variant-local \.route-badge\{width:auto/);
  assert.doesNotMatch(css, /\.departure\.variant-a \.route-badge\{width:auto/);
});

test("anything wider than a phone gets the roomy layout and a permanent landing rail", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  // The gap the phone breakpoint leaves behind: above 820px the kiosk board was being handed to
  // everything, and it sizes itself in vh, so it sprawls on any screen that is not the one it was
  // drawn for. This was portrait-only and capped at 1200px, which left a tablet turned sideways and
  // every desktop on the kiosk layout. Width is the thing that matters, not orientation.
  assert.match(css, /@media\(min-width:821px\)\{/);
  assert.doesNotMatch(css, /@media\(min-width:821px\) and \(max-width:1200px\) and \(orientation:portrait\)\{/);
  // Two columns of sailings, which is the whole point of having the width. Wrapping flex, not a
  // grid: grid row sizing takes the container's height as an input, and at a 246-sailing landing it
  // handed back rows a fraction of the height their cards needed, clipping every one mid-text.
  assert.match(css, /:root \.departures\[data-view="timeline"\]\{display:flex;flex-direction:row;flex-wrap:wrap/);
  assert.match(css, /:root \.departure\.timeline-row\{flex:0 0 calc\(50% - 4px\)/);
  // The route board's percentage columns collapse once the rail takes its share of the width, which
  // is what set partner wordmarks one letter per line.
  assert.match(css, /:root \.column-head, :root \.departure\{grid-template-columns:172px minmax\(0,1fr\) minmax\(0,2\.4fr\)\}/);
  assert.match(css, /:root \.departure-slot:nth-child\(n\+4\)\{display:none\}/);
  // iPadOS draws its status bar over a home-screen app, and the kiosk layout made no room for it.
  assert.match(css, /:root \.board\{padding:calc\(4px \+ env\(safe-area-inset-top\)\)/);
  // Docked, the rail sits beside the board rather than over it: no scrim, and the board moves over.
  assert.match(css, /#boardView\.sidebar-docked \.screen\{padding-left:var\(--rail\)\}/);
  assert.match(css, /#boardView\.sidebar-docked \.landing-menu-scrim\{display:none\}/);
  // And it stops being a full-viewport sheet, or an invisible layer eats every tap on the board.
  assert.match(css, /#boardView\.sidebar-docked \.landing-menu\{z-index:40;right:auto;width:var\(--rail\)\}/);
  // Width, and then the surface. A mouse is no longer a reason to hide the list — a desktop docks
  // it too — so the kiosk is the only thing held back, and it is held back by what it is.
  assert.match(app, /matchMedia\("\(min-width:821px\)"\)/);
  assert.match(app, /const railDocked = \(\) => railMedia\.matches/);
  assert.doesNotMatch(app, /railKey/);
  assert.match(app, /elements.menuButton.hidden = docked/);
  assert.match(app, /elements.landingMenuClose.hidden = docked/);
  // Rotating an iPad crosses the boundary, so the rail cannot be decided once at startup.
  assert.match(app, /railMedia\.addEventListener\("change", applyRail\)/);
});

// The roomy layout is now width-only, which puts it one missing attribute away from reflowing the
// signage display and giving away a quarter of its screen to a list nobody standing at a terminal
// can tap. Everything that keeps the kiosk out of it is asserted here, because none of it is
// visible from the kiosk itself until it is already wrong on a wall.
test("the staff layout does not depend on its deployment path", async () => {
  const [app, css, index] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8"), readFile(indexPath, "utf8")]);
  assert.doesNotMatch(app + css + index, /dataset.surface|data-surface/);
  assert.match(index, /src="\/assets\/map-theme.js/);
});

// No row on the home port's board is a departure time: the operator does not publish when a boat
// lets go of Pier C, so every row carries the boat's first pickup and is starred for it. The star
// has a tooltip, which is worth nothing on a phone, so the board states it once above the list.
test("the home port board says what its stars mean", async () => {
  const [app, css, index] = await Promise.all([
    readFile(appPath, "utf8"), readFile(cssPath, "utf8"), readFile(indexPath, "utf8")
  ]);
  assert.match(app, /"\*actual departure times at discretion of the captain, listed time is the first pickup time"/);
  // Keyed off the stop id the payload already carries, not off landing 27, so renumbering the
  // landings cannot quietly take the note away.
  assert.match(app, /\(data\?\.meta\?\.landing\?\.stopIds \|\| \[\]\)\.includes\("home-port"\)/);
  assert.match(app, /elements\.boardNote\.hidden = notes\.length === 0/);
  // Rendered on every pass, so switching landings puts it away again.
  assert.match(app, /renderBoardNote\(\);/);
  // Outside the departures list: that list scrolls, and the kiosk view sizes its rows to a fixed
  // height that a one-line legend would be stretched to fill.
  assert.match(index, /<p class="board-note" id="boardNote" hidden><\/p>[\s\S]*?<div class="departures"/);
  assert.match(css, /\.board-note\{/);
});

// A board on a home screen is resumed rather than reloaded, so a check that only runs on load never
// runs again on the one install that most needs it — the phone in someone's pocket, days behind the
// browser tab on the same handset.
test("an installed board checks for a new shell when it comes back to the front", async () => {
  const app = await readFile(new URL("../public/assets/app-shell.js", import.meta.url), "utf8");
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /document\.visibilityState !== "visible"/);
  assert.match(app, /registration\.update\(\)\.catch/);
  // Resuming happens dozens of times a shift; a deploy does not.
  assert.match(app, /Date\.now\(\) - lastCheck < 60_000/);
});

// tests only look for patterns they expect, so text nobody asserts on rode all the way to a live
// board and rendered as "<<<<<<< HEAD ======= >>>>>>> staff" above the departures. This is the
// cheap guard that would have.
test("no file carries an unresolved merge conflict", async () => {
  const root = new URL("../", import.meta.url);
  const files = [
    "public/index.html", "public/app.js", "public/styles.css", "public/sw.js",
    "scripts/build-data.js", "scripts/out-of-service.js", "server.js",
    "config/display.json", "config/landings.json", "config/crew-shuttles.json"
  ];
  for (const name of files) {
    const text = await readFile(new URL(name, root), "utf8");
    for (const marker of ["<<<<<<<", "=======", ">>>>>>>"]) {
      assert.doesNotMatch(text, new RegExp(`^${marker}`, "m"), `${name} still has a ${marker} conflict marker`);
    }
  }
});

// The manifest is what makes an Android home-screen install an app rather than a bookmark: without
// it the board gets no name, no standalone launch and no icon of its own. It is also the kind of
// file that fails silently — a wrong icon path is not an error, it is just an install with a blank
// tile — so every path it names is checked to exist.
test("the web app manifest names a real icon for every size it claims", async () => {
  const [raw, index] = await Promise.all([
    readFile(new URL("../public/assets/site.webmanifest", import.meta.url), "utf8"),
    readFile(indexPath, "utf8")
  ]);
  const manifest = JSON.parse(raw);
  assert.equal(manifest.display, "standalone");
  // The deployment proxies the board at /ferryTimesMobile/ and serves a different site at the
  // root, so an installed board that started at "/" would open the landing page instead. The
  // scope keeps the installed window on the board rather than wandering onto the rest of the host.
  assert.equal(manifest.start_url, "/ferryTimesMobile/");
  assert.equal(manifest.scope, "/ferryTimesMobile/");
  assert.ok(manifest.start_url.startsWith(manifest.scope), "start_url has to sit inside the scope");
  // The label under the icon. It matches what iOS is told in apple-mobile-web-app-title, so the
  // same board does not land on two phones under two different names.
  assert.equal(manifest.name, "Ferry Kitty");
  assert.equal(manifest.short_name, "Ferry Kitty");
  assert.match(index, /name="apple-mobile-web-app-title" content="Ferry Kitty"/);
  // The theme colour is the board's navy, and it agrees with the meta tag the browser reads first.
  assert.match(index, new RegExp(`name="theme-color" content="${manifest.theme_color}"`));

  // Android needs a 192 and a 512 to treat this as installable, plus a maskable one so launchers
  // that crop to a circle do not cut the whiskers off.
  const sizes = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`);
  assert.ok(sizes.includes("192x192 any"));
  assert.ok(sizes.includes("512x512 any"));
  assert.ok(sizes.includes("512x512 maskable"));

  for (const icon of manifest.icons) {
    const file = icon.src.split("?")[0].replace(/^\//, "");
    const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
    // A PNG header, and the dimensions the manifest promises — a 512 entry pointing at a 128 file
    // installs as a blurry tile and nothing anywhere says so.
    assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${file} is not a PNG`);
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes, `${file} is ${width}x${height}, not ${icon.sizes}`);
  }
});

// Everything the page asks the browser to fetch by absolute path has to be a path the deployment's
// proxy actually forwards to this server. juliet.nyc serves a different site at the root and
// forwards only /ferryTimesMobile/, /app.js, /styles.css, /assets/ and /api/, so a file added at
// the site root — a manifest, an icon, a worker — is quietly served by the landing page instead.
// This is the check that would have caught the manifest 404ing in production.
test("the page only fetches absolute paths the deployment proxies", async () => {
  const [index, app, worker] = await Promise.all([
    readFile(indexPath, "utf8"), readFile(new URL("../public/assets/app-shell.js", import.meta.url), "utf8"), readFile(workerPath, "utf8")
  ]);
  const forwarded = /^\/(?:app\.js|styles\.css|sw\.js|assets\/|api\/|ferryTimesMobile\/)/;
  const referenced = [...index.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0);
  for (const url of referenced) {
    assert.match(url, forwarded, `${url} is not a path the proxy forwards to the board`);
  }

  // The worker is registered from JavaScript rather than a tag, so it has to be checked separately
  // — and it is the one that was actually broken: /sw.js 404ed on juliet.nyc for as long as the
  // offline shell has existed, because nothing forwarded it.
  const registration = app.match(/serviceWorker\.register\(`([^`]+)`/)?.[1];
  assert.ok(registration, "the service worker registration URL should be findable");
  assert.match(registration, forwarded);

  // Every precached path is fetched by the worker at install time, and one 404 fails the whole
  // install, so they have to be forwarded too. The list's first entry is BASE — the document's own
  // directory, supplied by the page — which is in scope by construction and is not a literal here.
  const files = worker.match(/const FILES=\[([^\]]+)\]/)?.[1];
  assert.ok(files, "the precache list should be findable");
  assert.ok(files.startsWith("BASE,"), "the document entry should come from the page, not a hardcoded path");
  for (const url of [...files.matchAll(/'(\/[^']*)'/g)].map((match) => match[1])) {
    assert.match(url, forwarded, `${url} is precached but not forwarded, so the install would fail`);
  }
});

// The route colour on a card's left edge is the fastest read on the board, and every theme that
// restyles the card has to leave it alone. The Hello Kitty theme did not: it set `border` wholesale
// in ink and put back only the left border's *width*, so the colour was lost on every row -- most
// visibly on the partner operators, whose badges are white logo chips and whose edge is therefore
// the only colour they have. Its own comment said the route colour keeps the left edge.
test("no theme takes the route colour off the card's left edge", async () => {
  const css = await readFile(cssPath, "utf8");
  const themed = [...css.matchAll(/:root\[data-theme="([a-z-]+)"\] \.departure\{([^}]*)\}/g)];
  assert.ok(themed.length >= 4, "expected the themes that restyle the card to be found");
  for (const [, theme, body] of themed) {
    // Only the shorthand and the left edge itself can take the colour off. A theme rounding the
    // corner or dropping a shadow is not a threat, and flagging it would teach whoever hits this
    // to add a line they do not need.
    if (!/border\s*:|border-left/.test(body)) continue;
    assert.match(body, /border-left:[^;]*var\(--route-color\)/,
      `the ${theme} theme must keep the route colour on the left edge`);
  }
});

// The countdown takes the route's colour, which only works if a colour nobody can see is refused.
// South Brooklyn's yellow is 1.5:1 against a white card and the Staten Island Ferry's orange is
// 2.4:1; the floor has to sit between them, so it is checked against the real liveries rather than
// against invented ones.
test("the countdown accent keeps legible route colours and drops the invisible ones", async () => {
  const app = await readFile(appPath, "utf8");
  const from = app.indexOf("function contrastOnWhite");
  const to = app.indexOf("// The route's own colour");
  assert.ok(from > 0 && to > from, "expected the accent helpers to be found");
  const { contrastOnWhite, accentColor } =
    new Function(`${app.slice(from, to)}\nreturn { contrastOnWhite, accentColor };`)();

  // Known ratios, so a change to the maths shows up here rather than on the board.
  assert.ok(Math.abs(contrastOnWhite("#FF8330") - 2.46) < 0.02, "Staten Island Ferry orange");
  assert.ok(Math.abs(contrastOnWhite("#ffd100") - 1.46) < 0.02, "South Brooklyn yellow");

  // Carried: the partner liveries this was asked for, and the darker ferry routes.
  for (const color of ["#FF8330", "#013067", "#00BBE3", "#E6550D", "#00839c", "#4e008e"]) {
    assert.equal(accentColor(color), color, `${color} is legible enough to use`);
  }
  // Refused: the yellows, which vanish on a white card.
  for (const color of ["#ffd100", "#F7D87D", "#FFE628"]) {
    assert.equal(accentColor(color), null, `${color} must fall back to the board accent`);
  }
  // A missing or malformed colour is not a crash and not a colour.
  for (const color of [undefined, "", "red", "#fff"]) assert.equal(accentColor(color), null);

  // The stylesheet has to actually read the property, with the old blue as its fallback.
  const css = await readFile(cssPath, "utf8");
  assert.match(css, /\.tl-relative\{[^}]*color:var\(--route-accent,#00749e\)/);
});

// ---------------------------------------------------------------------------------------------
// The trip view.
// ---------------------------------------------------------------------------------------------

// lib/connections.js is a hand port of the scheduling rules in public/app.js, because the client is
// run here through vm.runInContext as a classic script and so cannot import a shared module. Two
// copies of a rule drift, and this one drifts silently: the failure is a boat offered on a day it
// does not run. So the two are made to answer the same question at the same instant and compared.
test("the server picks the same connections the client would", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  const { createConnectionIndex, nextDepartures } = await import("../lib/connections.js");
  // Pier 11: the busiest landing on the board, fourteen routes and 450-odd departures.
  const payload = await buildDisplayData({ landingNumber: 16 });
  const index = createConnectionIndex(new Map([[16, payload]]));

  const instants = [
    "2026-08-27T16:00:00Z", // a Thursday lunchtime
    "2026-08-29T16:00:00Z", // a Saturday
    "2026-09-07T16:00:00Z", // Labor Day, a Monday running Sunday service
    "2026-08-28T04:30:00Z"  // 00:30, where yesterday's service day is still sailing
  ];
  for (const now of instants) {
    const view = await board({ now, payload });
    // The client's own answer for this stop, minus the rows nobody can board -- which is the same
    // cut lib/connections.js makes when it builds its index.
    const client = JSON.parse(view.run(`JSON.stringify(
      timelineDepartures(new Date()).filter((row) =>
        row.departure.stopId === "87" &&
        !row.departure.outOfService && !row.departure.crewShuttle && !row.departure.arrival)
        .slice(0, 2).map((row) => String(row.departure.tripId) + "@" + row.departure.departureTime))`));
    const server = nextDepartures({ index, stopId: "87", now: new Date(now), limit: 2, stale: true })
      .map((item) => `${item.tripId}@${item.departureTime}`);
    assert.deepEqual(server, client, `client and server disagree at ${now}`);
  }
});

test("a departure row opens its trip, and a stop in it switches landing", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  const payload = await buildSummerDisplayData({ landingNumber: 16 });
  const view = await board({ now: "2026-08-27T16:00:00Z", payload });

  // Every openable row carries the trip it belongs to, in whichever view is rendered.
  const rendered = view.node("departures").innerHTML;
  assert.match(rendered, /data-trip-id="/);
  assert.match(rendered, /role="button"/);
  const tripId = rendered.match(/data-trip-id="([^"]+)"/)[1];
  const stopId = rendered.match(/data-stop-id="([^"]+)"/)[1];

  view.run(`openTripView(${JSON.stringify(tripId)}, ${JSON.stringify(stopId)}, 0)`);
  assert.equal(view.node("tripMenu").hidden, false, "the trip view opens");
  const stops = view.node("tripStops").innerHTML;
  assert.match(stops, /class="trip-stop/);
  assert.match(stops, /Wall St\/Pier 11/, "the stop list names its piers from the payload, with no network");
  assert.match(stops, /data-landing-id="/, "a served pier is tappable");

  // Closing puts the view away and forgets the trip.
  view.run("setTripOpen(false)");
  assert.equal(view.node("tripMenu").hidden, true);
});

test("a terminating trip shows its scheduled and live layover beside the eta", async () => {
  const payload = structuredClone(SAMPLE);
  payload.meta.showDwellTimes = true;
  payload.stops = {
    1: { name: "Wall St/Pier 11", landingId: 16 },
    2: { name: "East 34th Street", landingId: 8 }
  };
  payload.departures = [sailing(SERVICES.weekday, "12:00", 0)];
  payload.departures[0].tripId = "turning";
  payload.tripSchedules = {
    turning: {
      stops: [
        { stopId: "1", sequence: 1, arrivalSeconds: 43080, departureSeconds: 43200 },
        { stopId: "2", sequence: 2, arrivalSeconds: 44100, departureSeconds: 44100 }
      ],
      turnaround: {
        stopId: "2", nextTripId: "return", nextDepartureSeconds: 44400,
        scheduledLayoverSeconds: 300
      }
    }
  };
  const view = await board({ payload });
  for (const sort of ["time", "route"]) {
    for (const [dwell, layover] of [[false, true], [true, false], [false, false], [true, true]]) {
      view.run(`data.meta.showDwellTimes = ${dwell}; data.meta.showLayoverTimes = ${layover}`);
      const label = view.run(`departureLayoverLabel(data.departures[0])`);
      assert.equal(label.includes("Dwell 2m"), dwell);
      assert.equal(label.includes("Layover 5m"), layover);
      const tripLabel = view.run(`layoverLabel({ scheduledSeconds: 300 }, "trip-stop-layover")`);
      assert.equal(tripLabel.includes("scheduled 5 min"), layover);
    }
    view.run(`selectSort("${sort}"); render()`);
    assert.match(view.node("departures").innerHTML, /class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover 5m<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/small>/);
  }
  // A turn is taken at the trip's last stop, which is the destination the label sits beside in the
  // timeline — so the pier is named once, by the destination, and the turn shares its line.
  view.run(`selectSort("time"); render()`);
  const timeline = view.node("departures").innerHTML;
  assert.doesNotMatch(timeline, /Layover at East 34th Street/);
  assert.match(timeline, /<strong class="tl-dest">[\s\S]*<small class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover 5m<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/small><\/strong>/);
  view.run(`realtime = { stale: false, vehicles: [], updates: [
    { tripId: "turning", stopId: "1", delaySeconds: 60 },
    { tripId: "turning", stopId: "2", delaySeconds: 480 },
    { tripId: "return", stopId: "2", delaySeconds: 120 }
  ] }; render()`);
  assert.match(view.node("departures").innerHTML, /class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover -1m<\/small>/);
  view.run(`realtime.updates[2].canceled = true; render()`);
  assert.match(view.node("departures").innerHTML, /class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover 5m<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/small>/);
  view.run(`realtime.updates[2].canceled = false; realtime.stale = true; render()`);
  assert.match(view.node("departures").innerHTML, /class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover 5m<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/small>/);
  view.run(`realtime.stale = false; viewDate = "2026-08-14"; render()`);
  assert.match(view.node("departures").innerHTML, /class="departure-layover"[^>]*>Dwell 2m<\/small><small class="departure-layover[^"]*"[^>]*>Layover 5m<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/small>/);
  assert.equal(view.run(`departureLayoverLabel({ ...data.departures[0], outOfService: true })`), "");
  assert.equal(view.run(`departureLayoverLabel({ ...data.departures[0], endsShift: "certain" })`), "");

  // Browsed days intentionally make no realtime request, but the schedule still knows the break.
  view.run(`viewDate = "2026-08-14"; openTripView("turning", "1", 43200)`);
  let html = view.node("tripStops").innerHTML;
  assert.match(html, /scheduled 5 min/);
  assert.equal((html.match(/trip-stop-layover/g) || []).length, 1, "only the terminal gets a layover");

  // Today, the terminal clock and the remaining break move together. A delay may consume more
  // than the whole turn, and that negative value is operationally useful rather than clamped away.
  view.run(`viewDate = null; tripView.timings = new Map([[2, {
    estimatedArrivalSeconds: 44700,
    turnaround: { scheduledSeconds: 300, estimatedSeconds: -180, hasLiveTiming: true }
  }]]); renderTripView()`);
  html = view.node("tripStops").innerHTML;
  assert.match(html, /12:25/);
  assert.match(html, /5 → -3 min/);
  assert.match(html, /aria-label="Scheduled layover 5 minutes, currently -3 minutes"/);

  const css = await readFile(cssPath, "utf8");
  assert.match(css, /\.trip-stop-timing\{[^}]*display:flex/);
  assert.match(css, /\.trip-stop-layover\{[^}]*white-space|\.trip-stop-timing\{[^}]*white-space:nowrap/);
});

// Rows need a published stop list, either their own or the arriving trip behind a home-port run.
test("only published trips and explicit timetable entries are openable", async () => {
  const app = await readFile(appPath, "utf8");
  const helper = app.slice(app.indexOf("function tripAttrs"), app.indexOf("function departureCell"));
  assert.match(helper, /const schedule = scheduleForDeparture\(item\)/);
  assert.match(helper, /stops\.length < 2 && !schedule\.timetableOnly/);
  // Both views go through the one helper, so they cannot disagree about which rows open.
  assert.equal((app.match(/\$\{tripAttrs\(/g) || []).length, 2);
});

test("the trip view is wired into the surfaces that can bury it", async () => {
  const [app, index, css] = await Promise.all([
    readFile(appPath, "utf8"), readFile(indexPath, "utf8"), readFile(cssPath, "utf8")
  ]);
  // Escape closes it, and it is tested first because it is the topmost surface.
  assert.match(app, /const sheets = \[\s*bindSheet\(setTripOpen/);
  assert.match(app, /event\.key === "Escape" && openSheet/);
  // The arrow keys must not step the date underneath an open sheet.
  assert.match(app, /if \(openSheet \|\| event\.metaKey/);
  // Switching landing invalidates the trip: a new payload has different trip schedules.
  assert.match(app, /if \(changed\) \{[\s\S]*?setTripOpen\(false\)/);
  // It reuses the sheet's own classes, which is what gets it themed on all eight boards for free.
  assert.match(index, /class="filter-menu trip-menu" id="tripMenu" hidden/);
  assert.match(index, /class="filter-menu-panel trip-panel"/);
  assert.match(css, /\.trip-menu \.filter-menu-panel\{height:100%/);
});


test("Pier C home-port rows open previous stops and map the arriving vessel", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  const payload = await buildSummerDisplayData({ landingNumber: 16 });
  const row = payload.departures.find((item) => item.tripId.startsWith("oos:") && item.serviceId === "1" && item.seconds > 43200);
  assert.ok(row);
  const schedule = payload.tripSchedules[row.liveTripId];
  assert.ok(schedule?.stops.length >= 2, "the terminal retains the incoming trip's stop list");
  assert.equal(schedule.stops.at(-1).stopId, row.stopId);
  for (const stop of schedule.stops) assert.ok(payload.stops[stop.stopId]?.name);
  const view = await board({ now: "2026-08-27T16:00:00Z", payload });
  for (const sort of ["time", "route"]) {
    view.run(`selectSort("${sort}"); render()`);
    assert.ok(view.node("departures").innerHTML.includes(`data-trip-id="${row.tripId}"`));
  }
  view.run(`realtime = { stale: false, updates: [], vehicles: [
    { tripId: ${JSON.stringify(row.liveTripId)}, boatName: "Ferry & Away" }
  ] }`);
  const requested = [];
  const fetch = view.context.fetch;
  view.context.fetch = (url) => { requested.push(String(url)); return fetch(url); };
  view.run(`openTripView(${JSON.stringify(row.tripId)}, ${JSON.stringify(row.stopId)}, ${row.seconds})`);
  assert.equal(view.node("tripMenu").hidden, false);
  assert.match(view.node("tripSummary").textContent, /to Pier C · Out of service · Previous stops/);
  assert.equal((view.node("tripStops").innerHTML.match(/is-past/g) || []).length, schedule.stops.length - 1);
  assert.equal(view.node("tripMapLink").hidden, false);
  assert.equal(view.node("tripMapLink").href, "map?boat=Ferry%20%26%20Away");
  assert.ok(requested.includes(`/api/connections?tripId=${encodeURIComponent(row.liveTripId)}`));
  view.run("refreshTripConnections()");
  assert.equal(requested.at(-1), `/api/connections?tripId=${encodeURIComponent(row.liveTripId)}`);
  view.run(`realtime.vehicles = [{ tripId: "other", boat: "${row.routeId}${row.boatAssignment}", boatName: "Predicted Ferry" }]; renderTripView()`);
  assert.match(view.node("tripMapLabel").textContent, /Predicted Ferry\?/);
  view.run(`realtime.vehicles = []; renderTripView()`);
  assert.equal(view.node("tripMapLink").hidden, true);
  view.run(`setTripOpen(false)`);
  assert.equal(view.node("tripMenu").hidden, true);
  assert.equal(view.run(`tripAttrs({ tripId: "crew:unknown", stopId: "87" })`), "");
});

test("crew confirmation follows the viewed date, including Pier C", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  for (const landingNumber of [16,27]) {
    const payload = await buildDisplayData({landingNumber});
    const view = await board({now:"2026-09-14T12:00:00Z",payload});
    view.run("renderBoardNote()");
    assert.equal(view.node("boardNote").hidden,landingNumber !== 27);
    assert.doesNotMatch(view.node("boardNote").textContent,/Weekday crew schedule loaded|AS3 AM|unconfirmed/i);
    assert.equal(Boolean(view.run("confirmedCrewCoverage()")),true);
    for (const date of ["2026-09-19", "2026-09-20", "2026-11-01"]) {
      view.run(`viewDate = "${date}"; renderBoardNote()`);
      assert.ok(view.run("confirmedCrewCoverage()"));
      assert.doesNotMatch(view.node("boardNote").textContent,/Weekend crew schedule loaded|remain unconfirmed/i);
      if (landingNumber === 27) {
        const rows = view.run("routeDirectionGroups(new Date(),1000).flatMap(g=>g.departures)");
        assert.equal(rows.filter(r=>r.crewShuttle).length,5);
        assert.equal(rows.filter(r=>r.routeId==='SB'&&r.boatAssignment===3).length,date==='2026-09-20'?0:1);
      }
    }
    for (const date of ["2026-09-13", "2026-11-02"]) {
      view.run(`viewDate = "${date}"; renderBoardNote()`);
      assert.equal(Boolean(view.run("confirmedCrewCoverage()")),false);
      const visible = view.run("routeDirectionGroups(new Date(),1000).flatMap(g=>g.departures)");
      assert.equal(visible.some(r=>r.endsShift || r.crewShuttle || r.fromHomePort),false,date);
      assert.match(view.node("boardNote").textContent,/Crew shifts \/ Pier C shuttles: UNCONFIRMED/);
    }
    if (landingNumber === 27) {
      assert.match(view.run("emptyBoard()"), /CREW TIMES UNCONFIRMED/);
      assert.doesNotMatch(view.run("emptyBoard()"), /concluded/);
    }
  }
});

test("Unmatched Sukkot rows stay scheduled and explain why onward trip connections are unavailable", async () => {
  const { buildDisplayData } = await import("../scripts/build-data.js");
  const payload = await buildDisplayData({landingNumber:16});
  const row = payload.departures.find(r => r.scheduleOnly && !r.liveTripId && r.seconds > 43200);
  assert.ok(row);
  const view = await board({now:"2026-09-28T16:00:00Z",payload});
  view.run(`realtime = {stale:false, updates:[{tripId:${JSON.stringify(row.tripId)},stopId:"87",delaySeconds:600}], vehicles:[{tripId:${JSON.stringify(row.tripId)},boatName:"Wrong boat"}]}`);
  const matches = view.run(`routeDirectionGroups(new Date(),1000).flatMap(g=>g.departures).filter(r=>r.tripId===${JSON.stringify(row.tripId)})`);
  assert.equal(matches.length,1);
  assert.equal(matches[0].hasLiveTiming,false);
  assert.equal(matches[0].delay,0);
  assert.equal(matches[0].boatName,null);
  assert.equal(matches[0].predictedBoatName,null);
  view.run(`openTripView(${JSON.stringify(row.tripId)},"87",${row.seconds})`);
  assert.equal(view.node("tripMenu").hidden,false);
  assert.match(view.node("tripStops").innerHTML,/Trip connections and arrival estimates are unavailable/);
  assert.equal(view.node("tripMapLink").hidden,true);
  view.run("renderBoardNote()");
  assert.match(view.node("boardNote").textContent,/Sukkot: published departures/);
});

// Compact scheduled indicators.
//
// A boat that has no live timing shows a small clock, not the word SCHEDULED, and a layover taken
// from the timetable carries the same clock after it. The clock is decoration: the accessible name
// stays the full sentence it always was, and a layover that is an estimate gets no clock at all, so
// the two read differently without anyone having to know the colours.
//
// Failure modes covered: the clock leaking into the accessibility tree, a delayed / on-time /
// service-status badge losing its slot to the scheduled one, an estimate wearing the timetable's
// clock, a layover shown after the setting hides it, and any of that differing by sort order, by
// connectivity (offline, saved snapshot, partly live) or by browsing another day.

const CLOCK = /<svg[^>]*class="scheduled-clock"[^>]*aria-hidden="true"[^>]*focusable="false"[\s\S]*?<\/svg>/;

async function scheduledView({ realtime = "offline", sort = "time", layovers = true } = {}) {
  const view = await board({
    now: SCHEDULED_NOW, payload: scheduledBoardPayload({ layovers }), realtime: scheduledBoardRealtime(realtime),
    stored: { "nyc-ferry-did-selected-landing": "16", "nyc-ferry-did-sort": sort }
  });
  view.run("loadRealtime()");
  await new Promise((resolve) => setImmediate(resolve));
  view.run("render()");
  return view;
}

function rowFor(html, tripId) {
  const marker = `data-trip-id="${tripId}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `${tripId} should be on the board`);
  const end = [html.indexOf('data-key="', start), html.indexOf("</article>", start)].filter((i) => i > 0).sort((a, b) => a - b)[0];
  return html.slice(start, end);
}

test("a scheduled boat shows a clock badge that keeps the full accessible status", async () => {
  for (const sort of ["time", "route"]) {
    for (const realtime of ["offline", "stale"]) {
      const view = await scheduledView({ sort, realtime });
      const html = view.node("departures").innerHTML;
      const badges = [...html.matchAll(/<span class="scheduled-badge"[^>]*>[\s\S]*?<\/span>/g)].map((match) => match[0]);
      assert.ok(badges.length >= 4, `${sort}/${realtime}: expected scheduled badges, got ${badges.length}`);
      for (const badge of badges) {
        assert.match(badge, /role="img"/);
        assert.match(badge, /aria-label="Status: Scheduled"/);
        assert.match(badge, CLOCK);
        assert.equal(badge.replace(/<[^>]+>/g, "").trim(), "", "the word is gone, the icon replaces it");
      }
      assert.doesNotMatch(view.text(), /SCHEDULED/);
    }
  }
});

test("a scheduled layover is Layover Nm and a clock, with the full wording for assistive technology", async () => {
  for (const sort of ["time", "route"]) {
    const view = await scheduledView({ sort });
    const html = view.node("departures").innerHTML;
    const layovers = [...html.matchAll(/<small class="departure-layover[^"]*"[^>]*>[\s\S]*?<\/small>/g)].map((match) => match[0]);
    assert.ok(layovers.length >= 4, `${sort}: a layover per visible sailing`);
    for (const layover of layovers) {
      assert.match(layover, /aria-label="Scheduled layover \d+ minutes"/);
      assert.match(layover, /Layover \d+m<svg/);
      assert.match(layover, CLOCK);
      assert.match(layover, /role="img"/);
      assert.doesNotMatch(layover.replace(/<[^>]+>/g, ""), /sched/i, "no 'sched' suffix");
    }
    assert.match(rowFor(html, "t5"), /aria-label="Scheduled layover 10 minutes"[^>]*>Layover 10m</);
  }
});

test("an estimated layover stays distinguishable: no clock, and it says it is estimated", async () => {
  const view = await scheduledView({ realtime: "live" });
  const html = view.node("departures").innerHTML;
  const estimated = rowFor(html, "t4").match(/<small class="departure-layover[^"]*"[^>]*>[\s\S]*?<\/small>/)[0];
  assert.match(estimated, /aria-label="Estimated layover 3 minutes"/);
  assert.match(estimated, /class="departure-layover departure-layover-estimated"/);
  assert.match(estimated, />Layover 3m<\/small>$/);
  assert.doesNotMatch(estimated, /<svg/);
  const scheduled = rowFor(html, "t1").match(/<small class="departure-layover[^"]*"[^>]*>[\s\S]*?<\/small>/)[0];
  assert.match(scheduled, /class="departure-layover departure-layover-scheduled"/);
  assert.match(scheduled, CLOCK);
});

test("late, on-time and service-status badges still outrank the scheduled clock", async () => {
  const view = await scheduledView({ realtime: "live" });
  const html = view.node("departures").innerHTML;
  const late = rowFor(html, "t2");
  assert.match(late, /aria-label="Status: \+4 min"/);
  assert.doesNotMatch(late, /scheduled-badge/);
  const onTime = rowFor(html, "t4");
  assert.match(onTime, /aria-label="Status: On time"/);
  assert.doesNotMatch(onTime, /scheduled-badge/);
  // The rest of the board has no live timing yet, so it is still the timetable.
  assert.match(rowFor(html, "t1"), /aria-label="Status: Scheduled"/);

  const status = (item) => view.run(`departureStatus(${JSON.stringify(item)})`);
  const base = view.run("data.departures[0]");
  for (const [name, override] of [
    ["crew shuttle", { crewShuttle: true }], ["out of service", { outOfService: true }],
    ["arrival", { arrival: true }], ["last of day", { isLastOfDay: true }], ["last to Governors Island", { isLastGovernorsIsland: true }]
  ]) {
    assert.equal(status({ ...base, ...override }).scheduledLabel, "", `${name} must not also read as scheduled`);
  }
  assert.match(status({ ...base, hasLiveTiming: true, delay: 300 }).delayLabel, /\+5 min/);
  assert.equal(status({ ...base, hasLiveTiming: true, delay: 300 }).scheduledLabel, "");
  // Boarding is the countdown column, not a badge, and does not displace the clock.
  assert.equal(view.run("relativeTime(60, true)"), "Boarding");
  assert.match(status({ ...base, delta: 60 }).scheduledLabel, /Status: Scheduled/);
});

test("a saved snapshot never promotes a delay to a live status", async () => {
  const view = await scheduledView({ realtime: "stale" });
  const html = view.node("departures").innerHTML;
  assert.match(rowFor(html, "t2"), /aria-label="Status: Scheduled"/);
  assert.doesNotMatch(html, /Status: \+|Status: On time/);
});

test("a browsed day is all timetable: clocks, no countdown", async () => {
  const view = await scheduledView({ realtime: "live" });
  view.click("dateNext");
  const html = view.node("departures").innerHTML;
  assert.doesNotMatch(html, /Status: \+|Status: On time/);
  assert.match(html, /aria-label="Status: Scheduled"/);
  assert.match(html, /aria-label="Scheduled layover \d+ minutes"/);
  assert.doesNotMatch(html, /Estimated layover/);
});

test("the layover setting still hides the layover, clock and all", async () => {
  const view = await scheduledView({ layovers: false });
  const html = view.node("departures").innerHTML;
  assert.doesNotMatch(html, /departure-layover/);
  assert.match(html, /Status: Scheduled/);
});

test("the clock and the layover are drawn inline so they can never wrap onto a line of their own", async () => {
  const [app, css] = await Promise.all([readFile(appPath, "utf8"), readFile(cssPath, "utf8")]);
  assert.match(css, /\.scheduled-clock\{[^}]*width:1\.1em[^}]*height:1\.1em/);
  assert.match(css, /\.scheduled-badge\{[^}]*display:inline-flex/);
  assert.match(css, /\.departure-layover\{[^}]*display:inline-block[^}]*white-space:nowrap/);
  // The late :root block makes everything wrap; the layover must be exempted after it.
  assert.ok(css.lastIndexOf(":root .departure-layover { display: inline-block; white-space: nowrap") > css.lastIndexOf(".destination strong, .via, .route-name"));
  assert.doesNotMatch(css, /:root :is\([^)]*\.departure-layover[^)]*\) \{ white-space: normal/, "the broader wrapping selector must exclude the layover; :is inherits its most specific member");
  assert.doesNotMatch(css, /\.departure-layover::before\{[^}]*content:"\|"/, "a leading bar is orphaned when the layover wraps");
  assert.doesNotMatch(app.replace(/^\s*\/\/.*$/gm, ""), /SCHEDULED<\/span>/);
});
