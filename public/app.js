import { createScheduleStore, validSchedule } from "./assets/schedule-store.js";
import { cacheKey, landingKey, landingsKey, sortKey, clockKey, hiddenOperatorsKey, operatorsKey, favouriteLandingsKey, themeKey, THEMES, changelogSeenKey, nearestKey, nearestMaxAgeMs } from "./assets/preferences.js";
import { bindSheet, setSheetOpen } from "./assets/panels.js";
import { zonedParts, addDays, tripIdentityForDate, scheduleRange as scheduleBounds, viewFrame as scheduleFrame, routeDirectionGroups as scheduleGroups, timelineDepartures as scheduleTimeline, confirmedCrewCoverage as scheduleCrewCoverage } from "./assets/schedule.js";
import { createViewLifecycle } from "./assets/view-lifecycle.js";

export function mountBoard(root, { header = document.querySelector("#boardHeading"), setTheme, onRide = () => {} } = {}) {
const findViewElement = selector => root.querySelector(selector) || header?.querySelector(selector);
const lifecycle = createViewLifecycle();
const { poll } = lifecycle;
const { storage, request, html: reconcileHTML, panel, contentTransition } = MobileRuntime;
const scheduleStore = createScheduleStore({ storage, prefix: cacheKey });
const elements = {
  screen: findViewElement("#screen"),
  landing: findViewElement("#landingName"),
  time: findViewElement("#clockTime"),
  date: findViewElement("#clockDate"),
  departures: findViewElement("#departures"),
  status: findViewElement("#dataStatus"),
  routeCount: findViewElement("#routeCount"),
  columnHead: findViewElement("#columnHead"),
  boardNote: findViewElement("#boardNote"),
  serviceAlerts: findViewElement("#serviceAlerts"),
  serviceAlertSummary: findViewElement("#serviceAlertSummary"),
  serviceAlertFreshness: findViewElement("#serviceAlertFreshness"),
  serviceAlertCount: findViewElement("#serviceAlertCount"),
  serviceAlertChevron: findViewElement("#serviceAlertChevron"),
  alertMenu: findViewElement("#alertMenu"),
  alertMenuScrim: findViewElement("#alertMenuScrim"),
  alertMenuClose: findViewElement("#alertMenuClose"),
  tripMenu: findViewElement("#tripMenu"),
  tripMenuScrim: findViewElement("#tripMenuScrim"),
  tripMenuClose: findViewElement("#tripMenuClose"),
  tripMenuTitle: findViewElement("#tripMenuTitle"),
  tripSummary: findViewElement("#tripSummary"),
  tripMapLink: findViewElement("#tripMapLink"),
  tripMapLabel: findViewElement("#tripMapLabel"),
  tripStops: findViewElement("#tripStops"),
  tripRide: findViewElement("#tripRide"),
  alertList: findViewElement("#alertList"),
  changelogButton: findViewElement("#changelogButton"),
  changelogBang: findViewElement("#changelogBang"),
  changelogMenu: findViewElement("#changelogMenu"),
  changelogMenuScrim: findViewElement("#changelogMenuScrim"),
  changelogMenuClose: findViewElement("#changelogMenuClose"),
  changelogList: findViewElement("#changelogList"),
  menuButton: findViewElement("#menuButton"),
  landingMenu: findViewElement("#landingMenu"),
  landingMenuPanel: findViewElement("#landingMenuPanel"),
  landingMenuScrim: findViewElement("#landingMenuScrim"),
  landingMenuClose: findViewElement("#landingMenuClose"),
  landingList: findViewElement("#landingList"),
  nearestButton: findViewElement("#nearestButton"),
  nearestLabel: findViewElement("#nearestLabel"),
  dateBar: findViewElement("#dateBar"),
  datePrev: findViewElement("#datePrev"),
  dateNext: findViewElement("#dateNext"),
  dateCurrent: findViewElement("#dateCurrent"),
  clockToggle: findViewElement("#clockToggle"),
  filterButton: findViewElement("#filterButton"),
  filterCount: findViewElement("#filterCount"),
  filterMenu: findViewElement("#filterMenu"),
  filterMenuScrim: findViewElement("#filterMenuScrim"),
  filterMenuClose: findViewElement("#filterMenuClose"),
  filterList: findViewElement("#filterList"),
  filterReset: findViewElement("#filterReset"),
  themeButton: findViewElement("#themeButton"),
  themeMenu: findViewElement("#themeMenu"),
  themeMenuScrim: findViewElement("#themeMenuScrim"),
  themeMenuClose: findViewElement("#themeMenuClose"),
  themeList: findViewElement("#themeList"),
  sortOptions: [...root.querySelectorAll("[data-sort]")]
};

let nearestTimer = null;
// Which service date the board is showing, as YYYY-MM-DD, or null for "today, live".
//
// Deliberately not persisted. A landing choice is a setting; a date is a lookup. A board left
// showing tomorrow and then picked up cold the next morning would be confidently wrong about the
// one thing it exists to state, so every start and every landing switch returns to today.
let viewDate = null;
// The trip the fullscreen view is showing, and a token that lets a slow response for a trip the
// user has already navigated away from be dropped rather than painted over the new one.
let tripView = null;
let tripRequest = 0;
let data;
// `stale` gates whether live timings may be trusted; `cached` says whether there is saved data
// behind them at all. A device that has never reached the feed is stale without being cached, and
// the two have to be told apart because only one of them can honestly be called "Saved".
let realtime = { updates: [], vehicles: [], available: false, stale: true, cached: false };
let serviceAlerts = null;

function sortedBy() {
  return storage.getItem(sortKey) === "route" ? "route" : "time";
}

function renderSortToggle() {
  const active = sortedBy();
  for (const button of elements.sortOptions) {
    button.setAttribute("aria-pressed", String(button.dataset.sort === active));
  }
}

function selectSort(next) {
  if (next !== "route" && next !== "time") return;
  storage.setItem(sortKey, next);
  renderSortToggle();
  // Re-order in place: the menu stays open so the choice can be changed again, and nothing
  // needs refetching because sorting only touches the order cards are laid out in.
  render();
}

// Hiding operators.
//
// A landing like Pier 79 carries NYC Ferry, NY Waterway and the shuttles on one list, and an agent
// working one of them is reading past the other two all day. The filter is purely a display cut:
// nothing is refetched, and the hidden operators keep loading so that unhiding is instant and a
// service alert about them still reaches the bar at the bottom.

function agencyName() {
  return data?.meta?.agencyName || "NYC Ferry";
}

function operatorOf(routeId) {
  return data?.routes?.[routeId]?.operator || agencyName();
}

// Every operator the system serves, not merely the ones calling at the landing on screen: the
// filter is one per-device setting that follows the agent between docks, so the panel has to offer
// the same rows everywhere and the badge has to count the same hidden operators everywhere. A
// panel that changed shape at every landing would read as a per-landing setting, which it is not.
//
// The roster comes from /api/landings, which builds it across every landing. Falling back to the
// current payload covers the one case the roster cannot: a device that has never reached the
// server. Ordering is the same either way — home agency first, partners alphabetically.
function operatorList() {
  try {
    const stored = JSON.parse(storage.getItem(operatorsKey) || "[]");
    const roster = Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [];
    if (roster.length) return roster;
  } catch {
    // Fall through to the landing's own operators.
  }
  const names = new Set(Object.keys(data?.routes || {}).map(operatorOf));
  const home = agencyName();
  const partners = [...names].filter((name) => name !== home).sort((left, right) => left.localeCompare(right));
  return names.has(home) ? [home, ...partners] : partners;
}

function hiddenOperators() {
  try {
    const stored = JSON.parse(storage.getItem(hiddenOperatorsKey) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

function isVisibleRoute(routeId) {
  return !hiddenOperators().has(operatorOf(routeId));
}

function setOperatorHidden(name, hidden) {
  const next = hiddenOperators();
  if (hidden) next.add(name);
  else next.delete(name);
  storage.setItem(hiddenOperatorsKey, JSON.stringify([...next]));
  renderFilterMenu();
  // The list is rebuilt from scratch, so put the cursor back on the row that was just toggled —
  // otherwise a keyboard user is dropped to the top of the panel after every single switch.
  elements.filterList.querySelector(`[data-operator="${CSS.escape(name)}"]`)?.focus();
  // Only the cut changes, not the schedule underneath it, so this is a re-render and nothing more.
  render();
}

function showAllOperators() {
  storage.removeItem(hiddenOperatorsKey);
  renderFilterMenu();
  render();
}

function renderFilterMenu() {
  const hidden = hiddenOperators();
  const operators = operatorList();
  // The badge counts against the whole roster, so it reads the same at every landing — the setting
  // is one thing that follows the device, and a count that dropped to zero on arriving somewhere a
  // hidden operator does not call would suggest the filter had been forgotten.
  const hiddenHere = operators.filter((name) => hidden.has(name));
  elements.filterCount.hidden = hiddenHere.length === 0;
  elements.filterCount.textContent = String(hiddenHere.length);
  elements.filterButton.classList.toggle("is-filtering", hiddenHere.length > 0);
  elements.filterButton.setAttribute("aria-label", hiddenHere.length
    ? `Filter operators — ${hiddenHere.length} hidden`
    : "Filter operators");
  elements.filterReset.disabled = hiddenHere.length === 0;

  elements.filterList.innerHTML = operators.map((name) => {
    const shown = !hidden.has(name);
    return `<li><button type="button" class="filter-option${shown ? " is-shown" : ""}" data-operator="${escapeHtml(name)}" role="switch" aria-checked="${shown}">
      <span class="filter-option-name">${escapeHtml(name)}</span>
      <span class="filter-option-state" aria-hidden="true">${shown ? "Shown" : "Hidden"}</span>
    </button></li>`;
  }).join("");
}

function setFilterOpen(open) {
  setSheetOpen({ menu: elements.filterMenu, trigger: elements.filterButton,
    close: elements.filterMenuClose, panel,
    focusTarget: () => elements.filterList.querySelector(".filter-option") }, open);
}

// The change log, written by hand in content/changelog.json and served from /api/changelog. Never
// fatal: a board with no change log is a board, and this is the least important thing on it.
let changelog = [];

function changelogVersion(entry) {
  return String(entry?.version || entry?.date || entry?.title || "");
}

// The "!" is not decoration. It appears when the newest entry is one this device has not been shown
// and goes away when the sheet is opened, which is the only thing that makes it worth a glance.
function renderChangelogBang() {
  const newest = changelogVersion(changelog[0]);
  let seen = "";
  try {
    seen = storage.getItem(changelogSeenKey) || "";
  } catch {
    seen = "";
  }
  elements.changelogBang.hidden = !newest || newest === seen;
}

function renderChangelog() {
  elements.changelogList.innerHTML = changelog.length
    ? changelog.map((entry) => {
        const notes = Array.isArray(entry.notes) ? entry.notes : [];
        const heading = [entry.title, entry.date].filter(Boolean).map(escapeHtml).join(" · ");
        return `<li class="changelog-entry">
          <strong class="changelog-entry-head">${heading || escapeHtml(changelogVersion(entry))}</strong>
          ${notes.length ? `<ul class="changelog-notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
        </li>`;
      }).join("")
    : `<li class="alert-empty">Nothing written down yet.</li>`;
}

function setChangelogOpen(open) {
  if (open) renderChangelog();
  panel(elements.changelogMenu, open);
  elements.changelogButton.setAttribute("aria-expanded", String(open));
  if (open) {
    // Opening it is reading it.
    try {
      storage.setItem(changelogSeenKey, changelogVersion(changelog[0]));
    } catch {
      // A device that will not store the mark simply keeps showing it.
    }
    renderChangelogBang();
    elements.changelogMenuClose?.focus();
  } else {
    elements.changelogButton.focus();
  }
}

async function loadChangelog() {
  try {
    const response = await request("/api/changelog", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    changelog = Array.isArray(payload.entries) ? payload.entries : [];
  } catch {
    changelog = [];
  }
  renderChangelogBang();
}

function activeTheme() {
  const saved = storage.getItem(themeKey);
  return THEMES.some((theme) => theme.id === saved) ? saved : THEMES[0].id;
}

function applyTheme() {
  if (setTheme) return setTheme(activeTheme());
  const theme = THEMES.find((entry) => entry.id === activeTheme()) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  // The status bar of an installed board is painted from this, so it has to move with the theme or
  // a pink board keeps a navy notch.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.color);
}

function renderThemeMenu() {
  const current = activeTheme();
  elements.themeList.innerHTML = THEMES.map((theme) => {
    const chosen = theme.id === current;
    return `<li><button type="button" class="filter-option theme-option${chosen ? " is-shown" : ""}" data-theme="${escapeHtml(theme.id)}" role="radio" aria-checked="${chosen}">
      <span class="filter-option-name">${escapeHtml(theme.name)}<small class="theme-option-note">${escapeHtml(theme.note)}</small></span>
      <span class="filter-option-state" aria-hidden="true">${chosen ? "On" : ""}</span>
    </button></li>`;
  }).join("");
}

function selectTheme(id) {
  if (!THEMES.some((theme) => theme.id === id)) return;
  storage.setItem(themeKey, id);
  applyTheme();
  // The sheet stays open so the themes can be compared against the board behind it, which is the
  // whole reason this lives in the footer rather than in the landing drawer.
  renderThemeMenu();
  // The favourite mark is baked into the landing list's markup, so it only changes when that list
  // is rebuilt. Without this the kitty arrives on the next reload, which reads as the picker having
  // half worked.
  renderLandingList();
  elements.themeList.querySelector(`[data-theme="${CSS.escape(id)}"]`)?.focus();
}

function setThemeOpen(open) {
  setSheetOpen({ menu: elements.themeMenu, trigger: elements.themeButton,
    close: elements.themeMenuClose, panel,
    focusTarget: () => elements.themeList.querySelector(".theme-option") }, open);
}

function clockFormat() {
  return storage.getItem(clockKey) === "12" ? "12" : "24";
}

// The hour half of every formatter that prints a time for someone to read.
//
// Display only. zonedParts() below deliberately does not use this: it reads the hour to do
// arithmetic with, and a 1-12 hour would put "now" twelve hours out for half of every day.
//
// h23 rather than hour12:false, which yields a 24:00 hour in some locales; h12 rather than
// hour12:true for the same reason of asking for the cycle by name.
function hourOptions() {
  return clockFormat() === "12"
    ? { hour: "numeric", hourCycle: "h12" }
    : { hour: "2-digit", hourCycle: "h23" };
}

function renderClockToggle() {
  const twelve = clockFormat() === "12";
  elements.clockToggle.textContent = twelve ? "12 h" : "24 h";
  elements.clockToggle.setAttribute("aria-pressed", String(twelve));
  elements.clockToggle.setAttribute("aria-label",
    twelve ? "Times are shown on a 12-hour clock. Switch to 24-hour." : "Times are shown on a 24-hour clock. Switch to 12-hour.");
}

function toggleClockFormat() {
  storage.setItem(clockKey, clockFormat() === "12" ? "24" : "12");
  renderClockToggle();
  updateClock();
  render();
  if (tripView) renderTripView();
}

function displayCount(key) {
  const value = Number(data?.meta?.[key]);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 4;
}

function applyDisplayCounts() {
  document.documentElement.dataset.departuresShown = String(displayCount("departuresShown"));
}






// The span of dates the bundled schedule can actually answer for. Read off the calendars rather
// than feed_info, because the crew calendars and the partner feeds each carry their own bounds and
// the board is only honest for a date every one of them covers... or rather, for a date any of them
// covers: a day inside NYC Ferry's range but past NY Waterway's simply shows no waterway rows,
// which is the same thing the live board already does when a partner feed lapses.
function scheduleRange() {
  return scheduleBounds(data);
}

// Today and now, or a browsed date and the start of it.
//
// Everything downstream reads the board through this one object, which is what keeps browsing from
// forking the render path: a browsed day is simply "now = 00:00 on that date, and no live feed".
function viewFrame(now = new Date()) {
  return scheduleFrame(data, viewDate, now);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function adjustedTime(raw, delaySeconds = 0) {
  const [hours, minutes, seconds] = raw.split(":").map(Number);
  const total = hours * 3600 + minutes * 60 + seconds + delaySeconds;
  // 24-hour, zero-padded, by default: this is a crew board, and the schedule, the workbook and the
  // radio all speak in it. hourOptions() lets a device switch to 12-hour without that stopping
  // being the default anywhere else.
  //
  // The hour is taken modulo 24 first, so a GTFS 25:10 prints as the 01:10 it is rather than
  // overflowing into the next day.
  return new Intl.DateTimeFormat("en-US", { ...hourOptions(), minute: "2-digit", timeZone: "UTC" })
    .format(new Date(Date.UTC(2020, 0, 1, Math.floor(total / 3600) % 24, Math.floor((total % 3600) / 60))));
}

// A crew shuttle is ready at the listed time but waits for the boats it is collecting from to sail,
// so it prints the window rather than a minute it will not leave on: "14:35 – 15:05".
function departureLabel(item) {
  // A boat leaving the home port has no published departure time — the operator says it is not
  // constant — so the row shows when it is due at its first landing and stars it.
  const star = item.approximate ? `<abbr class="approx" title="Approximate: the boat's home-port departure is not fixed">*</abbr>` : "";
  const start = adjustedTime(item.departureTime, item.delay) + star;
  if (!item.departureTimeEnd) return start;
  const end = adjustedTime(item.departureTimeEnd, 0);
  return `${start}<span class="time-range-dash">–</span>${escapeHtml(end)}`;
}

function relativeTime(deltaSeconds, live = true) {
  // On a browsed day "12 min" would be counting down from midnight, which is nonsense, so the row
  // simply shows the scheduled time and nothing else.
  if (!live) return "";
  if (deltaSeconds <= 90) return "Boarding";
  if (deltaSeconds < 3600) return `${Math.ceil(deltaSeconds / 60)} min`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)} hr ${Math.ceil((deltaSeconds % 3600) / 60)} min`;
  return "Tomorrow";
}

// Uptown and downtown rather than the compass. The feed thinks in direction_id and the compass is
// the literal reading of it, but nobody working the river says "northbound" — a boat going up the
// East River is going uptown, and that is the word an agent and a passenger will both use.
function directionLabel(directionId) {
  if (String(directionId) === "1") return "Uptown";
  if (String(directionId) === "0") return "Downtown";
  return "Direction unavailable";
}

function routeDirectionGroups(now = new Date(), limitPerGroup = displayCount("departuresShown")) {
  return scheduleGroups({ data, realtime, viewDate, now, limitPerGroup });
}

// Route-card order, and the tiebreak the timeline falls back on when two boats leave in the
// same minute.



function routeShortName(routeId) {
  return data?.routes?.[routeId]?.shortName || routeId;
}

// Timeline view: one row per sailing in the order the boats actually leave, so departures read
// top-to-bottom instead of being spread across route cards. Route identity moves onto the row
// itself, which is what makes dropping the route grouping legible.
//
// Every remaining sailing is listed, bounded only by departureWindowMinutes — the same lookahead
// the route view already uses to decide a board is worth showing. The list scrolls; rows stay a
// fixed compact height rather than squishing, because a row too short to read is worse than one
// more flick of the thumb.
function timelineDepartures(now = new Date()) {
  return scheduleTimeline({ data, realtime, viewDate, now });
}

// NY Waterway boats call at more than one terminal, so the stops before the far end are named.
// Shortened because the destination line is already the widest thing on a card: "Hoboken (14th
// Street)" becomes "Hoboken 14th", which is what the terminal is called anyway.
const VIA_SHORTENINGS = [
  [/^Hoboken \(14th Street\)$/, "Hoboken 14th"],
  [/^Hoboken \/ NJ Transit Terminal$/, "Hoboken NJT"],
  [/^Brookfield Place\/Battery Park City$/, "Brookfield Pl"],
  [/^Midtown West\/W 39th St-Pier 79$/, "Midtown"],
  [/^Wall St\/Pier 11$/, "Pier 11"],
  [/^Gov\. Island\/Yankee Pier$/, "Governors Island"],
  [/^Red Hook\/Atlantic Basin$/, "Red Hook"]
];

function shortStop(name) {
  for (const [pattern, short] of VIA_SHORTENINGS) if (pattern.test(name)) return short;
  return name;
}

// Deliberately styled apart from a confirmed vessel name: crews swap boats at short notice, so this
// says which boat is on the working right now, not which one will sail.
function predictedName(item) {
  return item.predictedBoatName
    ? `<em class="boat-name-predicted" title="Currently on this working; boats change at short notice">${escapeHtml(item.predictedBoatName)}?</em>`
    : "";
}

function viaLabel(group) {
  if (!group.via?.length) return "";
  return `<small class="via">via ${escapeHtml(group.via.map(shortStop).join(", "))}</small>`;
}

// The line under the destination. "Uptown" says nothing useful about a boat going home empty,
// so these two say what the move actually is.
function groupContext(group, isOtherOperator) {
  if (group.crewShuttle) return "Crew shuttle";
  if (group.outOfService) return "Out of service";
  return isOtherOperator ? "" : directionLabel(group.directionId);
}

// Status badges for one sailing. Shared so the timeline rows and the route cards can never
// disagree about whether a boat is late, on time, or the last of the day.
function departureStatus(item) {
  const delaySeconds = Number(item.delay);
  const hasFreshTiming = !realtime.stale && item.hasLiveTiming && Number.isFinite(delaySeconds);
  // A boat with no passengers aboard is never on time and never merely scheduled — it is not in
  // service — so NO PICKUP takes that slot instead. It can still be late, though, and on a
  // home-port run that is the one thing worth saying: an agent watching a boat come in to tie up
  // wants the minute it will actually get here, not the minute it was meant to.
  const noPickup = item.outOfService || item.crewShuttle;
  const delayLabel = hasFreshTiming && delaySeconds >= 60
    ? `<span class="vessel-delay-badge departure-delay-badge" dir="ltr" aria-label="Status: +${Math.max(1, Math.round(delaySeconds / 60))} min">+${Math.max(1, Math.round(delaySeconds / 60))} min</span>`
    : "";
  const onTimeLabel = hasFreshTiming && delaySeconds < 60 && !noPickup
    ? `<span class="on-time-badge" aria-label="Status: On time">ON TIME</span>`
    : "";
  const isLast = item.isLastOfDay || item.isLastGovernorsIsland;
  const lastAria = item.isLastGovernorsIsland && !item.isLastOfDay
    ? "Last South Brooklyn departure serving Governors Island"
    : "Last departure of the day";
  const lastLabel = isLast ? `<strong class="departure-last-badge" aria-label="${lastAria}">LAST</strong>` : "";
  // A boat ending its run here. It is in service and full of passengers — it simply cannot be
  // boarded — so it gets its own pair of badges rather than borrowing NO PICKUP, which says the
  // opposite about the boat, or SCHEDULED, which invites someone to wait for it.
  const arrivalLabel = item.arrival
    ? `<span class="arrival-badge" aria-label="Arriving here, ending its run">ARRIVAL</span><span class="drop-off-only-badge" aria-label="Drop off only: this boat cannot be boarded">DROP OFF ONLY</span>`
    : "";
  const scheduledLabel = !noPickup && !item.arrival && !isLast && !delayLabel && !onTimeLabel
    ? `<span class="scheduled-badge" aria-label="Status: Scheduled">SCHEDULED</span>`
    : "";
  const noPickupLabel = noPickup
    ? `<span class="no-pickup-badge" aria-label="Not in service: no passengers">NO PICKUP</span>`
    : "";
  // The trip a boat works before it stops. It still carries passengers to where it is going, but it
  // will not turn round afterwards, so an agent needs to stop sending people to it for a return leg.
  //
  // A boat finishing for the day, or tying up for hours, is unambiguous. A shorter gap could as
  // easily be a crew break with the boat sitting where it is, so that one is marked with a question
  // mark: none of this is published, all of it is inferred from the shape of the boat's day, and
  // saying so is better than a confident label that turns out to be wrong.
  const dropOffLabel = !noPickup && item.endsShift
    ? `<span class="drop-off-badge${item.endsShift === "unsure" ? " drop-off-unsure" : ""}" aria-label="${item.endsShift === "unsure" ? "Probably this boat's final trip: drop off only, unconfirmed" : "This boat's final trip: drop off only"}">FINAL${item.endsShift === "unsure" ? "?" : ""}</span>`
    : "";
  // Which of the other Manhattan terminals this boat calls at on the way.
  //
  // Only NY Waterway's South Amboy route threads Pier 11, Brookfield Place and Pier 79 together,
  // and it does it in four different orders. Two rows can both read "South Amboy" while only one
  // of them stops at Brookfield Place, so the destination alone cannot answer the question an
  // agent is actually asked: can I get from here to there on this boat. Each terminal gets its own
  // colour so the answer is a glance rather than a read.
  const viaTerminals = (item.viaTerminals || [])
    .map((terminal) => {
      const slug = String(terminal.code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return `<span class="via-terminal-badge via-terminal-${slug}" aria-label="Calls at ${escapeHtml(terminal.name || terminal.code)} on the way">VIA ${escapeHtml(terminal.code)}</span>`;
    })
    .join("");
  // Crew boat assignment ("ER5" = East River boat 5). Boat numbers restart per route, so the
  // route code is part of the label. NY Waterway and the shuttles have no assignment.
  const assignment = Number.isInteger(item.boatAssignment)
    ? `<span class="boat-assignment">${escapeHtml(`${routeShortName(item.routeId)}${item.boatAssignment}`)}</span>`
    : "";
  // A crew shuttle is one departure carrying the crews off several boats, so it names them where a
  // revenue departure names its vessel.
  const crewBoats = item.crewShuttle && item.crewBoats?.length
    ? escapeHtml(item.crewBoats.join(" "))
    : "";
  return { delayLabel, onTimeLabel, scheduledLabel, lastLabel, arrivalLabel, assignment, noPickupLabel, dropOffLabel, crewBoats, viaTerminals };
}
// How far a colour stands off a white card, as the WCAG contrast ratio against it.
function contrastOnWhite(hex) {
  const channel = (pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(hex.slice(1, 3)) +
    0.7152 * channel(hex.slice(3, 5)) +
    0.0722 * channel(hex.slice(5, 7));
  return 1.05 / (luminance + 0.05);
}

// The countdown takes the route's colour so an all-partner board is not a column of ferry blue.
//
// Not every livery survives being used as text on a white card: South Brooklyn's yellow comes out
// at 1.5:1 and is effectively invisible, where the Staten Island Ferry's orange manages 2.4:1 and
// reads. The floor sits between the two on purpose. It is well under the 4.5:1 that body text would
// need — this is a bold, short, repeated label sitting beside its own time, not prose — but it is
// enough to keep a colour that cannot be seen at all from being used. Anything below it keeps the
// board's own accent blue, which is what every countdown used before.
const ACCENT_MIN_CONTRAST = 2;

function accentColor(color) {
  return /^#[0-9A-Fa-f]{6}$/.test(color || "") && contrastOnWhite(color) >= ACCENT_MIN_CONTRAST
    ? color
    : null;
}

// The route's own colour, badge and operator labelling, shared by both views.
function routeVisual(routeId, variant) {
  const route = data.routes[routeId] || {};
  const partnerLogo = partnerBadgeLogo(routeId, route.shortName);
  const variantLabel = variant === "LOCAL" ? "Local" : variant;
  const badgeContent = partnerLogo
    ? `<img class="route-badge-logo" src="${partnerLogo.src}" alt="${escapeHtml(partnerLogo.alt)}">`
    : `<b>${escapeHtml(route.shortName || routeId)}</b>`;
  return {
    route,
    partnerLogo,
    variantLabel,
    badgeContent,
    routeClass: String(routeId || "default").replace(/[^A-Za-z0-9_-]/g, ""),
    isOtherOperator: Boolean(route.operator) && route.operator !== (data.meta.agencyName || "NYC Ferry"),
    style: /^#[0-9A-Fa-f]{6}$/.test(route.color || "")
      ? ` style="--route-color:${route.color};--route-text:${/^#[0-9A-Fa-f]{6}$/.test(route.textColor || "") ? route.textColor : "#FFFFFF"}${accentColor(route.color) ? `;--route-accent:${route.color}` : ""}"`
      : ""
  };
}

// What makes a row openable, shared by both views so they cannot disagree about which rows are.
//
// Home-port runs open the revenue trip they follow; crew shuttles without a stop list stay inert.
function scheduleForDeparture(item) {
  return data?.tripSchedules?.[item.tripId] || data?.tripSchedules?.[item.liveTripId];
}

function tripAttrs(item) {
  const schedule = scheduleForDeparture(item);
  const stops = schedule?.stops;
  if (!Array.isArray(stops) || (stops.length < 2 && !schedule.timetableOnly)) return "";
  const label = `${departureLabel(item)} to ${item.destination || "destination unavailable"} — ${schedule.timetableOnly ? "show published departure details" : "show this trip's stops"}`;
  // role/tabindex rather than a real <button>: these sit inside a CSS grid and a flex column with
  // overflow and route-colour custom properties on them, and a button's own layout rules are not
  // worth the regression for an affordance the delegated listener provides either way.
  return ` data-trip-id="${escapeHtml(String(item.tripId))}" data-stop-id="${escapeHtml(String(item.stopId))}"` +
    ` data-departure-seconds="${Number(item.seconds) || 0}"` +
    ` role="button" tabindex="0" aria-haspopup="dialog" aria-label="${escapeHtml(label)}"`;
}

function sailingKey(item) {
  const serviceDate = addDays(viewFrame().dateKey, -Math.floor(item.seconds / 86400));
  return escapeHtml(JSON.stringify([serviceDate, item.tripId, item.stopId, item.seconds]));
}

// This view's destination is the card's, shared by every slot under it, so the layover cannot sit
// beside it the way the timeline's does. It joins the status line instead, which keeps a turn from
// costing each slot a line of its own in a column that is already the narrowest thing on the board.
function departureCell(item) {
  const { delayLabel, onTimeLabel, scheduledLabel, lastLabel, arrivalLabel, assignment, noPickupLabel, dropOffLabel, crewBoats, viaTerminals } = departureStatus(item);
  return `<div class="departure-slot" data-key="${sailingKey(item)}"${tripAttrs(item)}>
    <div class="slot-time-row"><time>${departureLabel(item)}</time><span class="slot-relative">${escapeHtml(relativeTime(item.delta, item.live !== false))}</span></div>
    <span class="departure-last-slot">${lastLabel}${arrivalLabel}${noPickupLabel}${delayLabel || onTimeLabel || scheduledLabel}${viaTerminals}${dropOffLabel}${assignment}<span class="boat-name">${crewBoats || (item.boatName ? escapeHtml(item.boatName) : predictedName(item))}</span>${departureLayoverLabel(item)}</span>
  </div>`;
}

// Partner operators merged in by scripts/build-data.js namespace their route ids with a prefix.
// Their GTFS short names are useless on a passenger board — NY Waterway publishes internal
// all-digit route ids for most routes, Seastreak reuses "Seastreak" for every route, and NYU
// publishes no short name at all (leaving the bare Passio route number) — so those badges show
// the operator's mark instead. A partner route with a real short name (W44, Greenwich) keeps it,
// and NYC Ferry badges are never touched.
const PARTNER_BADGES = [
  { prefix: "wtr:", src: "/assets/waterway.png", alt: "NY Waterway", useLogo: (shortName) => /^\d+$/.test(shortName) },
  // The Belford route is NY Waterway's, and rides in its own feed only so that a refresh of the
  // downloaded one cannot erase it. It carries no short name, so it always shows the wordmark.
  { prefix: "wbf:", src: "/assets/waterway.png", alt: "NY Waterway", useLogo: () => true },
  { prefix: "sea:", src: "/assets/seastreak.png", alt: "Seastreak", useLogo: () => true },
  { prefix: "nyu:", src: "/assets/nyu.png", alt: "NYU Langone Ferry", useLogo: () => true },
  { prefix: "lib:", src: "/assets/cityferry.png", alt: "Liberty Landing Ferry", useLogo: () => true },
  // The Trust's own short names ("RH", "BBP") would read as NYC Ferry route codes on a board that
  // already carries a South Brooklyn boat to the same island, so the wordmark shows instead.
  { prefix: "gi:", src: "/assets/gi.png", alt: "The Trust for Governors Island", useLogo: () => true }
];

function partnerBadgeLogo(routeId, shortName) {
  const badge = PARTNER_BADGES.find((item) => String(routeId || "").startsWith(item.prefix));
  return badge && badge.useLogo(shortName || "") ? badge : null;
}

// Stepping the board through the schedule.
//
// The whole feature is a filter over data the payload already carries: every landing ships every
// service id together with the calendars and exceptions that say which days each one runs. So a
// different day costs no fetch, no rebuild and not one extra byte — it is the same array read
// through a different date.

function dayLabel(dateKey, today) {
  if (dateKey === today) return "Today";
  if (dateKey === addDays(today, 1)) return "Tomorrow";
  if (dateKey === addDays(today, -1)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

function longDayLabel(dateKey) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

function renderDateBar() {
  const frame = viewFrame();
  const range = scheduleRange();
  const label = dayLabel(frame.dateKey, frame.today);
  elements.dateBar.dataset.state = frame.live ? "today" : "browsing";
  elements.dateCurrent.textContent = label;
  elements.dateCurrent.setAttribute("aria-label", frame.live
    ? `Showing today's schedule, ${longDayLabel(frame.dateKey)}`
    : `Showing ${longDayLabel(frame.dateKey)} — tap to return to today`);
  // Nothing outside the bundled schedule: a step past the last served date would show an empty
  // board that looks like cancelled service rather than like the end of the feed.
  elements.datePrev.disabled = Boolean(range) && addDays(frame.dateKey, -1) < range.first;
  elements.dateNext.disabled = Boolean(range) && addDays(frame.dateKey, 1) > range.last;
  // The screen carries the state too, so a browsed board can be told apart at a glance from the
  // live one it otherwise looks exactly like.
  elements.screen.classList.toggle("browsing-schedule", !frame.live);
}

function stepDate(amount) {
  contentTransition(elements.departures);
  const frame = viewFrame();
  const range = scheduleRange();
  const next = addDays(frame.dateKey, amount);
  if (range && (next < range.first || next > range.last)) return;
  viewDate = next === frame.today ? null : next;
  render();
}

function showToday() {
  contentTransition(elements.departures);
  if (viewDate === null) return;
  viewDate = null;
  render();
}

// An empty live board means the boats have finished; an empty browsed one means that day was never
// going to have any. Saying "concluded for the day" about next Sunday would read as a cancellation.
function emptyBoard() {
  if (data?.meta?.crewScheduleStatus?.status === "unconfirmed" && !confirmedCrewCoverage() &&
      (data?.meta?.landing?.stopIds || []).includes("home-port")) {
    return `<div class="empty"><div><strong>CREW TIMES UNCONFIRMED</strong><span>Pier C departures will appear when the crew schedule is confirmed.</span></div></div>`;
  }
  const frame = viewFrame();
  const coverage = scheduleRange();
  if (!coverage || frame.dateKey < coverage.first || frame.dateKey > coverage.last) {
    return '<div class="empty"><div><strong>SCHEDULE UNAVAILABLE</strong><span>No saved schedule covers this date. Connect to refresh the schedule.</span></div></div>';
  }
  return frame.live
    ? `<div class="empty"><div><strong>NO MORE BOATS!</strong><span>NYC Ferry service has concluded for the day.</span></div></div>`
    : `<div class="empty"><div><strong>NO SCHEDULED BOATS</strong><span>Nothing is scheduled here on ${escapeHtml(longDayLabel(frame.dateKey))}.</span></div></div>`;
}

// Pier C is the home port, and no row on it is a departure time. The operator does not publish when
// a boat lets go of the pier — it varies with the captain — so every row carries the boat's first
// pickup instead and is starred for it. The star has always had a tooltip, which is no use at all on
// a phone, so the board now says what it means once, in a line of its own above the list.
const HOME_PORT_NOTE =
  "*actual departure times at discretion of the captain, listed time is the first pickup time";

function confirmedCrewCoverage(date = viewFrame().dateKey) {
  return scheduleCrewCoverage(data, date);
}

// The home port is the one landing with no real stop behind it; it is keyed off the stop id the
// build already puts in the payload rather than off landing 27, so renumbering the landings cannot
// silently take the note away.
function renderBoardNote() {
  const homePort = (data?.meta?.landing?.stopIds || []).includes("home-port");
  const crew = data?.meta?.crewScheduleStatus;
  const holiday = data?.meta?.holidaySchedule;
  const notes = [];
  if (confirmedCrewCoverage()) {
    if (confirmedCrewCoverage().message) notes.push(confirmedCrewCoverage().message);
    if (homePort) notes.push(HOME_PORT_NOTE);
  } else if (crew?.status === "unconfirmed") notes.push(crew.message);
  else if (homePort) notes.push(HOME_PORT_NOTE);
  if (holiday?.dates.includes(viewFrame().dateKey)) notes.push(holiday.message);
  elements.boardNote.hidden = notes.length === 0;
  elements.boardNote.textContent = notes.join(" · ");
}

let renderFrame = null;
function render() {
  if (!lifecycle.active) return;
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = null; renderNow(); });
}
function renderNow() {
  if (!data) return;
  const oldOperations = new Map([...elements.departures.querySelectorAll("[data-key]")].map(node => [node.dataset.key, operationalText(node)]));
  applyDisplayCounts();
  renderDateBar();
  renderBoardNote();
  sortedBy() === "route" ? renderRouteBoard() : renderTimeline();
  let changes = 0;
  for (const node of elements.departures.querySelectorAll("[data-key]")) {
    const previous = oldOperations.get(node.dataset.key);
    if (previous !== undefined && previous !== operationalText(node)) { contentTransition(node); changes++; }
  }
  if (changes) findViewElement("#boardAnnouncement").textContent = `Vessel or service status updated at ${elements.time.textContent}.`;
}

// An empty board caused by the filter is not a schedule fact, and must never be read as one.
function operationalText(node) {
  return [...node.querySelectorAll(".vessel-delay-badge, .tl-boat, .boat-name, .boat-assignment, .no-pickup-badge, .drop-off-badge")].map(item => item.textContent).join("|");
}

function emptyFilterBoard() {
  return `<div class="empty"><div><strong>EVERYTHING IS HIDDEN</strong><span>All operators are filtered out. Tap the filter button to show them again.</span></div></div>`;
}

// Scoped to this landing on purpose, where the panel's list is global: the question here is not
// "has everything been hidden" but "is this board empty because of the filter", and a landing that
// only NYC Ferry calls at goes blank the moment NYC Ferry is hidden — however many partners are
// still shown elsewhere.
function allOperatorsHidden() {
  const hidden = hiddenOperators();
  const here = new Set(Object.keys(data?.routes || {}).map(operatorOf));
  return here.size > 0 && [...here].every((name) => hidden.has(name));
}

function renderTimeline() {
  const rows = timelineDepartures().filter(({ group }) => isVisibleRoute(group.routeId));
  elements.departures.dataset.view = "timeline";
  // The column head describes the route board's three columns; a timeline row is not columnar,
  // and the phone stylesheet hides it anyway.
  elements.columnHead.hidden = true;
  elements.routeCount.textContent = `${rows.length} departure${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    reconcileHTML(elements.departures, allOperatorsHidden() ? emptyFilterBoard() : emptyBoard());
    return;
  }

  reconcileHTML(elements.departures, rows.map(({ departure, group }) => {
    const visual = routeVisual(group.routeId, group.variant);
    const { delayLabel, onTimeLabel, scheduledLabel, lastLabel, arrivalLabel, assignment, noPickupLabel, dropOffLabel, crewBoats, viaTerminals } =
      departureStatus(departure);
    const variantBadge = group.variant ? `<small class="route-variant">${escapeHtml(visual.variantLabel)}</small>` : "";
    // The route board has carried this class all along; the timeline needs it too, because the
    // width a badge needs depends on which variant it is naming.
    const variantClass = group.variant ? ` variant-${group.variant.toLowerCase()}` : "";
    // "Uptown" says nothing about a boat going home empty, so the context line says what the
    // move is instead — the same words the route board puts under the destination.
    const context = group.crewShuttle || group.outOfService
      ? groupContext(group, visual.isOtherOperator)
      : (visual.isOtherOperator ? visual.route.operator : directionLabel(group.directionId));
    // The vessel is only known once a live vehicle is matched to the trip, so partner operators and
    // not-yet-assigned sailings simply omit the line rather than showing a placeholder. A crew
    // shuttle names the boats it relieves in the same place.
    //
    // A home-port row names no trip of its own — its id is minted here, not in the feed — so no
    // vehicle will ever match it and boatName is always empty. The vessel to show is the one
    // currently working the trip the boat is about to pick up, which is what predictTripId is for.
    // The route board has always fallen back to it; this view had not, so every Pier C row lost
    // its boat when the board was sorted by departure time.
    const boat = crewBoats
      ? `<span class="tl-boat">${crewBoats}</span>`
      : departure.boatName ? `<span class="tl-boat">${escapeHtml(departure.boatName)}</span>`
      : departure.predictedBoatName ? `<span class="tl-boat">${predictedName(departure)}</span>`
      : "";
    // Three lines, each reading left-to-right: when and which boat, then where, then who and how.
    // Time and route anchor the left edge; the countdown and the status badges are pushed to the
    // right, so both columns can be scanned straight down the list without the eye wandering.
    // The destination owns the middle line because it is the longest thing on the row and the one
    // that reads worst truncated. The turn the boat makes when it gets there rides along at the end
    // of that line: it is short, it never truncates, and it is the destination it belongs to.
    const notInService = group.outOfService || group.crewShuttle ? " timeline-row-oos" : "";
    return `<article data-key="${sailingKey(departure)}" class="departure timeline-row route-${visual.routeClass}${variantClass}${notInService}"${visual.style}${tripAttrs(departure)}>
      <div class="tl-head">
        <time>${departureLabel(departure)}</time>
        <span class="route-badge${visual.partnerLogo ? " route-badge-image" : ""}">${visual.badgeContent}${variantBadge}</span>
        <span class="tl-relative">${escapeHtml(relativeTime(departure.delta, departure.live !== false))}</span>
      </div>
      <strong class="tl-dest"><span class="tl-dest-name">${escapeHtml(group.destination)}${group.via?.length ? `<span class="tl-via"> via ${escapeHtml(group.via.map(shortStop).join(", "))}</span>` : ""}</span>${departureLayoverLabel(departure)}</strong>
      <div class="tl-meta">
        <span class="tl-context">${escapeHtml(context)}</span>
        ${boat}
        <span class="tl-status">${lastLabel}${arrivalLabel}${noPickupLabel}${delayLabel || onTimeLabel || scheduledLabel}${viaTerminals}${dropOffLabel}${assignment}</span>
      </div>
    </article>`;
  }).join(""));
}

function renderRouteBoard() {
  const departuresShown = displayCount("departuresShown");
  const groups = routeDirectionGroups().filter((group) => isVisibleRoute(group.routeId));
  elements.departures.dataset.view = "routes";
  elements.columnHead.hidden = false;
  elements.routeCount.textContent = `${groups.length} route direction${groups.length === 1 ? "" : "s"}`;

  if (!groups.length) {
    reconcileHTML(elements.departures, allOperatorsHidden() ? emptyFilterBoard() : emptyBoard());
    return;
  }

  reconcileHTML(elements.departures, groups.map((group) => {
    const { route, partnerLogo, variantLabel, badgeContent, routeClass, isOtherOperator, style: routeStyle } =
      routeVisual(group.routeId, group.variant);
    const variantClass = group.variant ? ` variant-${group.variant.toLowerCase()}` : "";
    const routeName = group.variant ? `${route.name || "East River"} ${variantLabel}` : (route.name || "NYC Ferry");
    const variantBadge = group.variant ? `<small class="route-variant">${escapeHtml(variantLabel)}</small>` : "";
    // Partner-operator routes (NY Waterway, Seastreak) keep their own official GTFS color and get
    // a small operator label so they're never mistaken for NYC Ferry service.
    const operatorBadge = isOtherOperator ? `<small class="route-operator">${escapeHtml(route.operator)}</small>` : "";
    return `<article data-key="${escapeHtml(group.key)}" class="departure route-${routeClass}${variantClass}"${routeStyle}>
      <div class="route">
        <span class="route-badge${partnerLogo ? " route-badge-image" : ""}">${badgeContent}${variantBadge}</span>
        <span class="route-name">${escapeHtml(routeName)}${operatorBadge}</span>
      </div>
      <div class="destination"><strong>${escapeHtml(group.destination)}${viaLabel(group)}</strong><span>${groupContext(group, isOtherOperator)}</span></div>
      <div class="departure-slots">${group.departures.map(departureCell).join("")}</div>
    </article>`;
  }).join(""));
}

function ageLabel(timestamp) {
  const ageMs = timestamp ? Date.now() - Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} min ago`;
  return `${Math.floor(ageMs / 3_600_000)} hr ago`;
}


// One alert, in full. The bar above can only ever carry the first one, clipped to two lines; this
// is where the other nine live, and where the whole of any of them can actually be read.
// When a planned closure actually bites. Read off the window rather than the server's activeNow
// flag: alerts are cached for a minute and can be served from the last disk snapshot after a
// restart, so a stored "happening now" can outlive the closure it described. The times cannot.
function alertWindowLabel(window) {
  const start = window?.start ? new Date(window.start) : null;
  const end = window?.end ? new Date(window.end) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) return "";
  if (!start && !end) return "";
  const timeZone = data?.meta?.timezone || "America/New_York";
  const dayOf = (date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const timeOf = (date) => new Intl.DateTimeFormat("en-US", { timeZone, ...hourOptions(), minute: "2-digit" }).format(date);
  const dateOf = (date) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
  // A time on another day needs its date said out loud; one later the same day does not.
  const stamp = (date, reference) => dayOf(date) === dayOf(reference) ? timeOf(date) : `${dateOf(date)}, ${timeOf(date)}`;
  const now = new Date();
  if ((!start || start <= now) && (!end || end >= now)) {
    return end ? `Now until ${stamp(end, now)}` : "Happening now";
  }
  if (!start) return "";
  const opening = `${dateOf(start)}, ${timeOf(start)}`;
  return end ? `${opening} – ${stamp(end, start)}` : `From ${opening}`;
}

function alertRow(alert) {
  const header = alert.header || "NYC Ferry service alert";
  // The bar joins these two with an em dash to make one line. Here there is room to keep them
  // apart, and a description that merely repeats the header is not worth a second paragraph.
  const description = alert.description && alert.description !== alert.header ? alert.description : "";
  // "Unknown effect" and "Unknown cause" are what GTFS says when the publisher left the field at its
  // default, which is most of the time. They are the feed admitting it has nothing to add, and a
  // chip saying so is worse than no chip: it takes the eye and pays nothing back.
  // "Planned" leads the chips because it is the first thing a reader wants settled: scheduled work
  // to plan around, or something that has just gone wrong. It is also what the ordering sorts on,
  // and an order nobody can see the reason for reads as no order at all.
  const chips = [alert.planned ? "Planned" : null, alert.effect, alert.cause]
    .filter((chip) => chip && !/^unknown/i.test(chip))
    .map((chip) => `<span class="alert-chip">${escapeHtml(chip)}</span>`)
    .join("");
  const when = alertWindowLabel(alert.window);
  // Only http(s). An alert is third-party text, and a javascript: URL rendered as a link on a board
  // an agent taps at is not a risk worth taking for a convenience.
  const link = /^https?:\/\//i.test(alert.url || "")
    ? `<a class="alert-link" href="${escapeHtml(alert.url)}" target="_blank" rel="noopener noreferrer">Read the full notice</a>`
    : "";
  return `<li class="alert-item">
    <strong class="alert-item-header">${escapeHtml(header)}</strong>
    ${when ? `<span class="alert-when">${escapeHtml(when)}</span>` : ""}
    ${chips ? `<span class="alert-chips">${chips}</span>` : ""}
    ${description ? `<p class="alert-item-body">${escapeHtml(description)}</p>` : ""}
    ${link}
  </li>`;
}

// Grouped by whose service it is, in the order the server sent them — which puts NYC Ferry first.
// A rider needs to know at a glance whether they are reading about their boat or about the train
// they were going to catch afterwards, and a heading says that faster than reading the alert does.
function renderAlertMenu() {
  const alerts = serviceAlerts?.alerts || [];
  if (!alerts.length) {
    elements.alertList.innerHTML = `<li class="alert-empty">No active NYC Ferry service alerts.</li>`;
    return;
  }
  const groups = [];
  for (const alert of alerts) {
    const agency = alert.agency || "NYC Ferry";
    const group = groups.find((entry) => entry.agency === agency);
    if (group) group.alerts.push(alert);
    else groups.push({ agency, alerts: [alert] });
  }
  elements.alertList.innerHTML = groups.map((group) => `
    <li class="alert-group">
      <h2 class="alert-group-name">${escapeHtml(group.agency)}<span>${group.alerts.length}</span></h2>
      <ul class="alert-group-list">${group.alerts.map(alertRow).join("")}</ul>
    </li>`).join("");
}

// Connections are cached by the service worker with no expiry, so a response fetched hours ago
// comes back offline looking exactly like a fresh one. Times that old are worse than no times.
const TRIP_CONNECTIONS_MAX_AGE_MS = 5 * 60 * 1000;

// A call's own clock time. tripSchedules carries seconds; adjustedTime speaks GTFS "HH:MM:SS", and
// going through it keeps the 12/24-hour toggle working here too.
function stopClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return adjustedTime(`${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:00`, 0);
}

function layoverMinutes(seconds) {
  return Math.round(Number(seconds) / 60);
}

// The final-stop pause before this same working leaves again. Scheduled metadata is bundled with
// the trip so it works offline and on browsed days; today's connection response may enrich it with
// the live time left after delays on either side of the turn.
function turnaroundLabel(stop) {
  const isFinal = stop.sequence === tripView?.stops?.at(-1)?.sequence;
  const local = isFinal && tripView?.scheduleTurnaround?.stopId === stop.stopId
    ? { scheduledSeconds: tripView.scheduleTurnaround.scheduledLayoverSeconds, hasLiveTiming: false }
    : null;
  const turnaround = tripView?.timings?.get(stop.sequence)?.turnaround || local;
  return layoverLabel(turnaround, "trip-stop-layover");
}

function layoverLabel(turnaround, className, prefix = "") {
  if (data?.meta?.showLayoverTimes === false) return "";
  const scheduled = Number(turnaround?.scheduledSeconds);
  if (!Number.isFinite(scheduled)) return "";
  const scheduledMinutes = layoverMinutes(scheduled);
  const estimated = Number(turnaround?.estimatedSeconds);
  if (turnaround.hasLiveTiming && Number.isFinite(estimated)) {
    const estimatedMinutes = layoverMinutes(estimated);
    return `<small class="${className}" aria-label="Scheduled layover ${scheduledMinutes} minutes, currently ${estimatedMinutes} minutes">${escapeHtml(prefix)}${scheduledMinutes} → ${estimatedMinutes} min</small>`;
  }
  return `<small class="${className}" aria-label="Scheduled layover ${scheduledMinutes} minutes">${escapeHtml(prefix)}scheduled ${scheduledMinutes} min</small>`;
}

// Read the terminal's timing, not this landing's delay: a boat can recover time along the route.
//
// The pier goes unnamed because a turn is always taken at the trip's last stop, which is the
// destination the label now sits beside — naming it again cost a line and said the same thing twice.
function departureLayoverLabel(item) {
  if (item.outOfService || item.crewShuttle || item.endsShift) return "";
  const schedule = scheduleForDeparture(item);
  const stop = schedule?.stops?.find((stop) => String(stop.stopId) === String(item.stopId));
  const dwellSeconds = stop?.arrivalSeconds != null && stop?.departureSeconds != null
    ? Number(stop.departureSeconds) - Number(stop.arrivalSeconds) : NaN;
  const dwellMinutes = data?.meta?.showDwellTimes === true && Number.isFinite(dwellSeconds) && dwellSeconds >= 0
    ? layoverMinutes(dwellSeconds) : null;
  const dwellText = dwellMinutes == null ? "" : `Dwell ${dwellMinutes}m`;
  const dwellAria = dwellMinutes == null ? "" : `Estimated dwell ${dwellMinutes} minutes`;
  const dwellOnly = dwellText
    ? `<small class="departure-layover" aria-label="${dwellAria}">${dwellText}</small>` : "";
  const turn = schedule?.turnaround;
  if (!turn || data?.meta?.showLayoverTimes === false) return dwellOnly;
  const live = item.live !== false && !realtime.stale && (!item.scheduleOnly || item.liveTripId);
  const updates = live ? realtime.updates || [] : [];
  const arrivalID = item.liveTripId || schedule.liveTripId || item.tripId;
  const nextID = tripIdentityForDate(turn, item.serviceDate, "nextLiveTripId")
    || tripIdentityForDate(data?.tripSchedules?.[turn.nextTripId], item.serviceDate) || turn.nextTripId;
  const incoming = updates.find((update) => String(update.tripId) === String(arrivalID) && update.stopId === turn.stopId);
  const arrival = incoming && { ...incoming, delaySeconds: incoming.arrivalDelaySeconds ?? incoming.delaySeconds };
  const next = updates.find((update) => String(update.tripId) === String(nextID) && update.stopId === turn.stopId);
  const fresh = (update) => update?.delaySeconds != null && Number.isFinite(Number(update.delaySeconds));
  const hasLiveTiming = !arrival?.canceled && !next?.canceled && (fresh(arrival) || fresh(next));
  const delay = (update) => fresh(update) ? Math.max(0, Number(update.delaySeconds)) : 0;
  const seconds = hasLiveTiming
    ? turn.scheduledLayoverSeconds - delay(arrival) + delay(next)
    : turn.scheduledLayoverSeconds;
  if (seconds == null || !Number.isFinite(Number(seconds))) return dwellOnly;
  const minutes = layoverMinutes(seconds);
  return `<small class="departure-layover" aria-label="${dwellAria ? `${dwellAria}, ` : ""}${hasLiveTiming ? "Estimated" : "Scheduled"} layover ${minutes} minutes">${dwellText ? `${dwellText} ` : ""}Layover ${minutes}m</small>`;
}

function tripStopName(stopId) {
  return data?.stops?.[stopId]?.name || tripView?.names?.get(stopId) || stopId;
}

function tripStopLanding(stopId) {
  const local = data?.stops?.[stopId];
  if (local) return local.landingId ?? null;
  return tripView?.landings?.get(stopId) ?? null;
}

function connectionRow(connection) {
  const style = /^#[0-9A-Fa-f]{6}$/.test(connection.color || "")
    ? ` style="--route-color:${connection.color};--route-text:${/^#[0-9A-Fa-f]{6}$/.test(connection.textColor || "") ? connection.textColor : "#FFFFFF"}"`
    : "";
  const delay = Number(connection.delaySeconds);
  const delayLabel = connection.hasLiveTiming && Number.isFinite(delay) && delay >= 60
    ? `<span class="trip-conn-delay">+${Math.max(1, Math.round(delay / 60))} min</span>`
    : "";
  // Direction is rendered through the board's own vocabulary rather than the server's, so
  // "Uptown" is decided in exactly one place.
  const where = [directionLabel(connection.directionId), connection.destination]
    .filter((part) => part && part !== "Direction unavailable").join(" · ");
  // Same rule as the departure rows: a partner whose GTFS short name is useless to a rider shows
  // the operator's mark instead. Belford is the case that forced it — NY Waterway publishes the
  // route with an empty route_short_name, so the fallback to route_id put a lowercase "belford"
  // on the board where every other row carries a wordmark.
  const connLogo = partnerBadgeLogo(connection.routeId, connection.shortName);
  const connBadge = connLogo
    ? `<img class="trip-conn-badge-logo" src="${connLogo.src}" alt="${escapeHtml(connLogo.alt)}">`
    : escapeHtml(connection.shortName || connection.routeId);
  return `<li class="trip-conn"${style}>
    <span class="trip-conn-badge${connLogo ? " trip-conn-badge-image" : ""}">${connBadge}</span>
    <span class="trip-conn-time">${escapeHtml(adjustedTime(connection.departureTime, 0))}</span>
    <span class="trip-conn-where">${escapeHtml(where)}</span>
    ${delayLabel}
    <span class="trip-conn-boat">${connection.boatName
      ? escapeHtml(connection.boatName)
      : connection.predictedBoatName
        ? `<em class="boat-name-predicted" title="Currently on this working; boats change at short notice">${escapeHtml(connection.predictedBoatName)}?</em>`
        : ""}</span>
  </li>`;
}

// One stop's connections, or the reason there are none. The distinction matters: a stop emptied by
// the operator filter must never read as a stop with no boats left, which is the same principle the
// board's own empty state follows.
function connectionsFor(stop) {
  if (!tripView?.connections) return `<li class="trip-conn-note">${escapeHtml(tripView?.note || "Checking…")}</li>`;
  const all = tripView.connections.get(stop.stopId) || [];
  const visible = all.filter((connection) => !connection.operator || !hiddenOperators().has(connection.operator));
  // The server says how many this pier is worth showing — more at a hub, where several routes meet
  // and there is an actual choice to read.
  if (visible.length) return visible.slice(0, tripView.limits?.get(stop.stopId) || 3).map(connectionRow).join("");
  if (all.length) return `<li class="trip-conn-note">Hidden by the operator filter</li>`;
  if (tripStopLanding(stop.stopId) === null) return `<li class="trip-conn-note">Not served by this board</li>`;
  return `<li class="trip-conn-note">Nothing else leaves after this boat gets in</li>`;
}

// Which vessel is working a trip, for the link out to the map.
//
// The same two answers the row itself gives, in the same order. A vehicle matched to this very trip
// names it outright. Failing that, the boat the workbook puts on this sailing is out on the water
// now under some vessel the feed has named — freshest report wins, which is how a boat handing over
// between two trips resolves to the one that reported last.
function vesselForTrip(tripId) {
  const vehicles = realtime.vehicles || [];
  const departure = (data?.departures || []).find((item) => String(item.tripId) === String(tripId));
  if (departure?.scheduleOnly && !departure.liveTripId) return null;
  const liveTripId = tripIdentityForDate(departure, viewFrame(new Date()).dateKey) || tripId;
  const working = vehicles.find((item) => String(item.tripId) === String(liveTripId) && item.boatName);
  if (working) return { name: working.boatName, number: working.vesselNumber, vesselId: working.vesselId, predicted: false };
  if (!Number.isInteger(departure?.boatAssignment)) return null;
  const boat = `${departure.routeId}${departure.boatAssignment}`;
  const onTheBoat = vehicles
    .filter((item) => item.boat === boat && item.boatName)
    .sort((left, right) => (right.updatedAtEpochSeconds || 0) - (left.updatedAtEpochSeconds || 0))[0];
  return onTheBoat ? { name: onTheBoat.boatName, number: onTheBoat.vesselNumber, vesselId: onTheBoat.vesselId, predicted: true } : null;
}

// The link out to the map, when there is a boat to point it at.
//
// By vessel name rather than trip id, because the predicted case is a vessel working a different
// trip entirely and this trip's id would find nothing on the map. Hidden rather than disabled when
// no vessel is known: a sailing the feed has not reached has nothing to show, and the heading's own
// map button is a tap away for anyone who wants the whole harbor.
function renderTripMapLink() {
  const vessel = tripView && viewFrame(new Date()).live ? vesselForTrip(tripView.tripId) : null;
  const departure = data?.departures?.find(item => String(item.tripId) === String(tripView?.tripId));
  if (elements.tripRide) elements.tripRide.hidden = !tripView || !viewFrame(new Date()).live || operatorOf(departure?.routeId) !== agencyName() || departure?.mode === "bus";
  elements.tripMapLink.hidden = !vessel;
  if (!vessel) return;
  elements.tripMapLink.href = `map?boat=${encodeURIComponent(vessel.name)}`;
  elements.tripMapLabel.textContent = `See ${vessel.name}${vessel.predicted ? "?" : ""} on the map`;
  elements.tripMapLink.setAttribute("aria-label", vessel.predicted
    ? `See ${vessel.name} on the map — currently on this working, boats change at short notice`
    : `See ${vessel.name} on the map`);
}

elements.tripRide?.addEventListener("click", () => {
  if (!tripView) return;
  const vessel = vesselForTrip(tripView.tripId);
  const departure = data?.departures?.find(item => String(item.tripId) === String(tripView.tripId));
  const intent = { ...vessel, confirmed: Boolean(vessel && !vessel.predicted && !realtime.stale && !realtime.cached), routeId: departure?.routeId };
  setTripOpen(false);
  void onRide(intent);
});

function renderTripView() {
  if (!tripView) return;
  const stops = tripView.stops;
  elements.tripSummary.textContent = tripView.summary;
  renderTripMapLink();
  reconcileHTML(elements.tripStops, stops.map((stop) => {
    // Keyed on sequence, not stop id: a loop trip calls at the same pier twice and dimming by id
    // would grey out the wrong half of it.
    const past = stop.sequence < tripView.sequence;
    const current = stop.sequence === tripView.sequence;
    const landingId = tripStopLanding(stop.stopId);
    const timing = tripView.timings?.get(stop.sequence);
    const scheduledTime = stop.arrivalSeconds ?? stop.departureSeconds;
    const time = timing?.estimatedArrivalSeconds != null && Number.isFinite(Number(timing.estimatedArrivalSeconds))
      ? Number(timing.estimatedArrivalSeconds)
      : scheduledTime;
    const layover = turnaroundLabel(stop);
    const head = `<span>${escapeHtml(tripStopName(stop.stopId))}</span>` +
      `${current ? `<span class="trip-stop-you">You are here</span>` : ""}` +
      `<span class="trip-stop-timing"><span class="trip-stop-time">${time == null ? "" : escapeHtml(stopClock(time))}</span>${layover}</span>`;
    const headTag = landingId === null
      ? `<div class="trip-stop-head trip-stop-static">${head}</div>`
      : `<button type="button" class="trip-stop-head" data-landing-id="${landingId}">${head}</button>`;
    return `<li class="trip-stop${past ? " is-past" : ""}${current ? " is-current" : ""}">
      ${headTag}
      <ul class="trip-conns">${connectionsFor(stop)}</ul>
    </li>`;
  }).join(""));
}

async function loadTripConnections(tripId) {
  const token = tripRequest;
  try {
    const response = await request(`/api/connections?tripId=${encodeURIComponent(tripId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Connections responded ${response.status}`);
    const payload = await response.json();
    if (token !== tripRequest || !tripView) return;
    const age = Date.now() - Date.parse(payload.generatedAt || "");
    if (Number.isFinite(age) && age > TRIP_CONNECTIONS_MAX_AGE_MS) {
      tripView.note = "Saved connections were too old to show. These are the trip's stops.";
      renderTripView();
      return;
    }
    tripView.connections = new Map((payload.stops || []).map((stop) => [stop.stopId, stop.connections || []]));
    tripView.limits = new Map((payload.stops || []).map((stop) => [stop.stopId, stop.limit || 3]));
    tripView.timings = new Map((payload.stops || []).map((stop) => [stop.sequence, {
      estimatedArrivalSeconds: stop.estimatedArrivalSeconds,
      turnaround: stop.turnaround || null
    }]));
    // Names and landings for a device whose cached payload predates data.stops.
    for (const stop of payload.stops || []) {
      if (stop.name) tripView.names.set(stop.stopId, stop.name);
      tripView.landings.set(stop.stopId, stop.landingId ?? null);
    }
    tripView.summary = tripView.summary.replace(/ · Saved$/, "") + (payload.stale ? " · Saved" : "");
    renderTripView();
  } catch {
    if (token !== tripRequest || !tripView) return;
    tripView.note = navigator.onLine === false
      ? "No connection. Showing this trip's stops only."
      : "Connections could not be loaded. These are the trip's stops.";
    renderTripView();
  }
}

function openTripView(tripId, stopId, seconds) {
  const departure = data?.departures?.find((item) => item.tripId === tripId);
  const sourceTripId = data?.tripSchedules?.[tripId] ? tripId : departure?.liveTripId || tripId;
  const schedule = data?.tripSchedules?.[sourceTripId];
  if (!schedule?.stops?.length || (schedule.stops.length < 2 && !schedule.timetableOnly)) return;
  const stops = [...schedule.stops].sort((left, right) => left.sequence - right.sequence);
  // Which call was tapped. Time as well as id, because a loop trip calls at the same pier twice.
  const tapped = stops.find((stop) => stop.stopId === stopId &&
    (stop.departureSeconds === seconds || stop.arrivalSeconds === seconds)) ||
    stops.find((stop) => stop.stopId === stopId);
  const route = data?.routes?.[data?.departures?.find((item) => item.tripId === tripId)?.routeId] || {};
  const destination = tripStopName(stops.at(-1).stopId);
  tripRequest += 1;
  tripView = {
    tripId, sourceTripId, stopId, sequence: tapped?.sequence ?? stops[0].sequence, stops,
    connections: null, note: "Checking…",
    scheduleTurnaround: schedule.turnaround || null, timings: new Map(),
    names: new Map(), landings: new Map(),
    // Says out loud what the times underneath are measured from. Read as "what is leaving now"
    // they would be wrong at every stop the boat has not reached yet.
    summary: departure?.outOfService && departure.liveTripId
      ? `${route.shortName || ""} to ${departure.destination} · Out of service · Previous stops before ${tripStopName(stopId)}`.trim()
      : `${route.shortName || ""} ${destination ? `to ${destination}` : ""} · ${stops.length} stops · next boats after each call`.trim()
  };
  if (schedule.timetableOnly) {
    tripView.summary = `${route.shortName || ""} to ${departure.destination} · Published departure`;
    tripView.note = "Published holiday departure. Trip connections and arrival estimates are unavailable.";
    renderTripView();
    setTripOpen(true);
    return;
  }
  renderTripView();
  setTripOpen(true);
  // The endpoint answers for now. On a browsed day that answer would be about the wrong date, and a
  // confidently wrong connection is worse than none, so the stop list stands on its own.
  if (!viewFrame(new Date()).live) {
    tripView.note = "Connections are shown for today only.";
    renderTripView();
    return;
  }
  loadTripConnections(sourceTripId);
}

function refreshTripConnections() {
  if (!tripView || tripView.stops.length < 2 || elements.tripMenu.hidden || !viewFrame(new Date()).live) return;
  loadTripConnections(tripView.sourceTripId || tripView.tripId);
}

function setTripOpen(open) {
  panel(elements.tripMenu, open);
  if (open) {
    elements.tripMenuClose.focus();
    return;
  }
  // Unlike every other sheet the opener is not a fixed button — render() replaces the row that
  // opened this within fifteen seconds — so focus goes back to the row only if it is still there.
  const row = tripView && elements.departures.querySelector(
    `[data-trip-id="${CSS.escape(String(tripView.tripId))}"][data-stop-id="${CSS.escape(String(tripView.stopId))}"]`);
  tripView = null;
  tripRequest += 1;
  row?.focus();
}

function setAlertMenuOpen(open) {
  // Nothing to expand into. The bar is disabled in that state, so this only guards the keyboard.
  if (open && !(serviceAlerts?.alerts || []).length) return;
  if (open) renderAlertMenu();
  setSheetOpen({ menu: elements.alertMenu, trigger: elements.serviceAlerts,
    close: elements.alertMenuClose, panel }, open);
}

function renderServiceAlerts() {
  const alerts = serviceAlerts?.alerts || [];
  const unavailable = Boolean(serviceAlerts && !serviceAlerts.available && alerts.length === 0);
  const stale = Boolean(serviceAlerts?.stale);
  elements.serviceAlerts.classList.toggle("loading", !serviceAlerts);
  elements.serviceAlerts.classList.toggle("active", alerts.length > 0);
  elements.serviceAlerts.classList.toggle("stale", stale && !unavailable);
  elements.serviceAlerts.classList.toggle("unavailable", unavailable);

  // Only a bar with something behind it is worth tapping, and it should look like it.
  const expandable = alerts.length > 0;
  elements.serviceAlerts.disabled = !expandable;
  elements.serviceAlertChevron.hidden = !expandable;
  if (!elements.alertMenu.hidden) {
    // The feed reloads every minute underneath an open sheet. Keep it in step, and close it if the
    // last alert cleared — but without touching focus, because nobody asked for it to move and this
    // is a background refresh, not something they just did.
    if (expandable) renderAlertMenu();
    else {
      panel(elements.alertMenu, false);
      elements.serviceAlerts.setAttribute("aria-expanded", "false");
    }
  }

  if (!serviceAlerts) return;
  if (unavailable) {
    elements.serviceAlertSummary.textContent = "Live service alerts are temporarily unavailable.";
    elements.serviceAlertFreshness.textContent = "Retrying automatically";
    elements.serviceAlertCount.hidden = true;
    return;
  }
  if (alerts.length === 0) {
    elements.serviceAlertSummary.textContent = "No active NYC Ferry service alerts.";
    elements.serviceAlertFreshness.textContent = `${stale ? "Saved update" : "Updated"} ${ageLabel(serviceAlerts.feedTimestamp || serviceAlerts.fetchedAt)}`;
    elements.serviceAlertCount.hidden = true;
    return;
  }
  const first = alerts[0];
  const detail = first.description && first.description !== first.header
    ? `${first.header} — ${first.description}`
    : first.header || first.description || "NYC Ferry service alert";
  // The bar is a ferry bar, and the server puts ferry alerts first, so the only way something else
  // leads is that the ferry has nothing wrong with it. Say whose service it is in that case: an
  // unlabelled subway closure sitting under the words SERVICE ALERTS on a ferry display reads as a
  // boat problem, which is exactly the wrong thing to tell someone waiting for one.
  const agency = first.agency && first.agency !== "NYC Ferry" ? `${first.agency}: ` : "";
  elements.serviceAlertSummary.textContent = alerts.length > 1
    ? `${agency}${detail} · ${alerts.length - 1} more active`
    : `${agency}${detail}`;
  elements.serviceAlertFreshness.textContent = `${stale ? "Saved alert" : "Updated"} ${ageLabel(serviceAlerts.feedTimestamp || serviceAlerts.fetchedAt)}`;
  elements.serviceAlertCount.textContent = String(alerts.length);
  elements.serviceAlertCount.hidden = false;
}

async function loadServiceAlerts() {
  try {
    const response = await request("/api/alerts", { cache: "no-store" });
    if (!response.ok) throw new Error();
    serviceAlerts = await response.json();
    storage.setItem(`${cacheKey}-alerts`, JSON.stringify(serviceAlerts));
  } catch {
    const saved = storage.getItem(`${cacheKey}-alerts`);
    serviceAlerts = saved
      ? { ...storage.json(`${cacheKey}-alerts`, {}), stale: true }
      : { available: false, stale: true, fetchedAt: null, alerts: [] };
  }
  renderServiceAlerts();
}

function updateClock() {
  const now = new Date();
  const timeZone = data?.meta?.timezone || "America/New_York";
  elements.time.textContent = new Intl.DateTimeFormat("en-US", { timeZone, ...hourOptions(), minute: "2-digit" }).format(now);
  elements.date.textContent = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
}

let realtimeRequest = 0;
async function loadRealtime() {
  if (!data) return;
  const landingId = data.meta.landingNumber;
  const generation = landingRequest;
  const token = ++realtimeRequest;
  const key = `${cacheKey}-realtime-${landingId}`;
  try {
    const response = await request(`/api/realtime?landingId=${encodeURIComponent(landingId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    if (generation !== landingRequest || token !== realtimeRequest) return;
    // A snapshot the service worker served is saved data too, just saved a layer further out.
    realtime = { ...payload, cached: Boolean(payload.stale) };
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    if (generation !== landingRequest || token !== realtimeRequest) return;
    const saved = storage.json(key);
    realtime = saved
      ? { ...saved, stale: true, cached: true }
      : { updates: [], vehicles: [], available: false, stale: true, cached: false };
  }
  reconcileHTML(elements.status, `<i></i><span>${
    scheduleSaved ? "Saved schedule" : !realtime.stale ? "Live" : realtime.cached ? "Saved" : "Local schedule"
  }</span>`);
  render();
  refreshTripConnections();
}

// A map link selects the initial board once; subsequent menu choices still work normally.
let linkedLanding = Number(new URLSearchParams(location.search).get("landing"));
function selectedLanding() {
  if (Number.isInteger(linkedLanding) && linkedLanding > 0) {
    const requested = linkedLanding;
    linkedLanding = null;
    return requested;
  }
  const value = Number(storage.getItem(landingKey));
  return Number.isInteger(value) && value > 0 ? value : null;
}



let landingRequest = 0;
let requestedLanding = null;
let scheduleSaved = false;

function applySchedule(payload) {
  data = payload;
  if (lifecycle.active) document.title = `${data.meta.landing.displayName} Departures · Ferry Kitty`;
  elements.landing.textContent = data.meta.landing.displayName;
  renderLandingList();
  renderFilterMenu();
  renderNearest();
  updateClock();
  render();
}
async function load(selected = selectedLanding()) {
  const token = ++landingRequest;
  const changed = selected !== requestedLanding;
  requestedLanding = selected;
  if (changed) {
    viewDate = null;
    setTripOpen(false);


    const savedRealtime = storage.json(`${cacheKey}-realtime-${selected}`);
    realtime = savedRealtime
      ? { ...savedRealtime, stale: true, cached: true }
      : { updates: [], vehicles: [], available: false, stale: true, cached: false };
    data = null;

  }
  const saved = scheduleStore.read(selected);
  if (validSchedule(saved, selected)) {
    scheduleSaved = true;
    applySchedule(saved);
    reconcileHTML(elements.status, '<i></i><span>Saved · refreshing</span>');
  } else if (!data) {
    reconcileHTML(elements.departures, '<div class="empty"><div><strong>Loading schedule…</strong><span>Fetching this landing’s departures.</span></div></div>');
  }
  const query = selected === null ? "" : `?landingId=${encodeURIComponent(selected)}`;
  try {
    const response = await request(`/api/display-data${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    if (token !== landingRequest) return;
    if (!validSchedule(payload, selected)) throw new Error('Invalid schedule');
    storage.setItem(landingKey, String(payload.meta.landingNumber));
    scheduleStore.write(payload);
    requestedLanding = payload.meta.landingNumber;
    scheduleSaved = Boolean(response.saved);
    applySchedule(payload);
    if (changed) contentTransition(elements.departures);
  } catch {
    if (token !== landingRequest) return;
    if (!data) {
      reconcileHTML(elements.departures, '<div class="empty"><div><strong>Landing unavailable</strong><span>No saved schedule for this landing. Choose another landing or retry when connected.</span></div></div>');
      return;
    }
  }
  if (token !== landingRequest) return;

  void loadRealtime();
  void loadServiceAlerts();
}

function favouriteLandings() {
  try {
    const stored = JSON.parse(storage.getItem(favouriteLandingsKey) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}

function setLandingFavourite(landingNumber, favourite) {
  const next = favouriteLandings();
  if (favourite) next.add(landingNumber);
  else next.delete(landingNumber);
  storage.setItem(favouriteLandingsKey, JSON.stringify([...next]));
  renderLandingList();
  // The list is rebuilt and reordered under the tap, so put the cursor back on the star that was
  // just pressed rather than dropping a keyboard user wherever that row landed.
  elements.landingList.querySelector(`[data-favourite-id="${landingNumber}"]`)?.focus();
}

// The favourite marks, drawn rather than shipped as assets: the menu is the one place offline has
// to keep working, and an inline path cannot fail to load.
//
// Every one of these is a single filled path in currentColor with no internal colours, which is
// what lets .landing-star[aria-pressed] keep saying starred-or-not by colour alone — the same
// mechanism the plain star has always used. They are silhouettes on purpose: at the 22px these
// render at, whiskers and facial features turn to grey mush, and the head shape is the only part
// doing any work.
function characterMark(paths) {
  return `<svg class="landing-star-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const starIcon = characterMark(`<path d="M12 3.6l2.6 5.28 5.83.85-4.22 4.11.996 5.8L12 16.9l-5.21 2.74.995-5.8-4.22-4.11 5.83-.85z"/>`);

// Head plus pointed ears, and the bow she is never without — on the left, as she wears it.
const kittyIcon = characterMark(`<path d="M6.4 6.1 4.5 2.9c-.2-.4.2-.8.6-.6l3.6 1.7A9.6 7.9 0 0 1 14.6 3.6l2.9-1.4c.4-.2.8.2.6.6l-1.5 2.7a7.6 7.6 0 0 1 2.3 4.6 5.4 5.4 0 0 1 1.5-.5l1.1-1.5c.3-.4.9-.1.8.4l-.3 1.6.8 1c.3.4-.1.9-.5.7l-1.6-.6-1.6.5a7.2 7.2 0 0 1-6.4 8.9A7.9 7.9 0 0 1 4 12.7a7.6 7.6 0 0 1 2.4-6.6Z"/>`);

// Round head, and the two long ears that hang past his chin.
const cinnamorollIcon = characterMark(`<path d="M12 3.4a6.4 6.4 0 0 1 6 4.1c1.6-.7 3.4-.4 4.2.8.8 1.3.1 3-1.5 4a5.9 5.9 0 0 1-2.7.9 6.4 6.4 0 0 1-1.6 1.9 5.6 5.6 0 0 1 .3 3.9c-.5 1.5-2 2.4-3.3 2-1.3-.4-1.9-2-1.4-3.5a5.2 5.2 0 0 1 .8-1.5 7.4 7.4 0 0 1-2.2-.5c-1 1.3-2.6 2-3.8 1.5-1.3-.5-1.7-2.1-1-3.5a5.3 5.3 0 0 1 1.4-1.7A6.1 6.1 0 0 1 12 3.4Z"/>`);

// Round head under the beret, with its little stalk on top and the ears sitting low and floppy.
const pompompurinIcon = characterMark(`<path d="M12.6 1.6c.5 0 .7.5.5.9l-.4.7a5 5 0 0 1 3.1 2.2 6.7 6.7 0 0 1 2.9 3.4 4.3 4.3 0 0 1 2.6 1.5c.9 1.3.4 3-1.1 3.8a4.6 4.6 0 0 1-2.3.5 7.3 7.3 0 0 1-11.2.4 4.5 4.5 0 0 1-2.6-.4c-1.6-.8-2.1-2.6-1.2-3.9a4.4 4.4 0 0 1 2.7-1.6 6.7 6.7 0 0 1 4.4-4.1A5.6 5.6 0 0 1 11.9 2c.1-.3.4-.4.7-.4Z"/>`);

// The jester hood: one peak leaning over, and a point down each side of the face.
const kuromiIcon = characterMark(`<path d="M11.4 2.1c1.4-.6 3 .1 3.6 1.5.3.7.3 1.4 0 2a7 7 0 0 1 2.8 2.8l3.1 1.4c.5.2.5.9 0 1.1l-2.6 1.1a7.1 7.1 0 0 1-1 3.6 6.9 6.9 0 0 1-11.6 0 7.1 7.1 0 0 1-1-3.6L2.1 10.9c-.5-.2-.5-.9 0-1.1l3.1-1.4a7 7 0 0 1 3.6-3.1 2.7 2.7 0 0 1 2.6-3.2Z"/>`);

// Only the Sanrio themes swap the mark. NYC Ferry and Night keep the plain star: one is the board's
// own livery and the other is a working night shift, and neither is asking for a cartoon.
const THEME_MARKS = {
  "hello-kitty": kittyIcon,
  cinnamoroll: cinnamorollIcon,
  pompompurin: pompompurinIcon,
  kuromi: kuromiIcon
};

function favouriteMark() {
  return THEME_MARKS[activeTheme()] || starIcon;
}

function renderLandingList() {
  const landings = storage.json(landingsKey, []);
  if (!landings.length) return;
  const current = data?.meta?.landingNumber;
  const favourites = favouriteLandings();
  const mark = favouriteMark();
  // Starred landings float to the top, in the list's own order underneath. Someone who works two
  // docks should find both without scrolling; the rest of the system stays where it always was.
  const ordered = [
    ...landings.filter((landing) => favourites.has(landing.id)),
    ...landings.filter((landing) => !favourites.has(landing.id))
  ];
  const query = findViewElement("#landingSearch")?.value.trim().toLowerCase() || "";
  reconcileHTML(elements.landingList, ordered.filter(landing => landing.displayName.toLowerCase().includes(query)).map((landing) => {
    const starred = favourites.has(landing.id);
    const name = escapeHtml(landing.displayName);
    return `<li data-key="${landing.id}" class="landing-row${starred ? " is-favourite" : ""}">
    <button type="button" class="landing-star" data-favourite-id="${landing.id}" aria-pressed="${starred}" aria-label="${starred ? `Remove ${name} from favourites` : `Add ${name} to favourites`}" title="${starred ? "Remove from favourites" : "Add to favourites"}">${mark}</button>
    <button type="button" class="landing-option${landing.id === current ? " is-current" : ""}" data-landing-id="${landing.id}"${landing.id === current ? ' aria-current="true"' : ""}>
      <span class="landing-option-name">${name}</span>
    </button>
  </li>`;
  }).join(""));
}

async function loadLandings() {
  try {
    const response = await request("/api/landings", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    storage.setItem(landingsKey, JSON.stringify(payload.landings || []));
    if (Array.isArray(payload.operators) && payload.operators.length) {
      storage.setItem(operatorsKey, JSON.stringify(payload.operators));
    }
  } catch {
    // Keep whatever list was saved; the menu still works offline.
  }
  renderLandingList();
  renderFilterMenu();
}

// The nearest-landing shortcut.
//
// Someone opening this at a dock should not have to pick their landing out of a 26-item menu, so
// the button spends one tap on a location fix and then becomes a direct jump to whatever landing
// they are standing at. It only ever reads position on an explicit tap: no background watching, no
// permission prompt for anyone who never asks for it.

function savedNearest() {
  try {
    const saved = JSON.parse(storage.getItem(nearestKey) || "null");
    if (!saved || !Number.isInteger(saved.id)) return null;
    return Date.now() - Number(saved.at) > nearestMaxAgeMs ? null : saved;
  } catch {
    return null;
  }
}

// Great-circle metres. The landings sit a few km apart at most, so this is far more precision than
// ranking them needs — but Pier C and Brooklyn Navy Yard are only ~400 m apart, which is close
// enough that the cheap flat approximation is not obviously safe, and haversine costs nothing.
function distanceMetres(fromLat, fromLon, toLat, toLon) {
  const radians = Math.PI / 180;
  const halfLat = ((toLat - fromLat) * radians) / 2;
  const halfLon = ((toLon - fromLon) * radians) / 2;
  const a = Math.sin(halfLat) ** 2 + Math.cos(fromLat * radians) * Math.cos(toLat * radians) * Math.sin(halfLon) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Which of a landing's two names fits a button. Usually the short one ("Pier 11" over "Wall St /
// Pier 11"), but not always — landing 18 is "Rockaway" for display and "Rockaway + Bus Stop"
// internally — so take whichever is actually shorter rather than assuming.
function buttonLabel(landing) {
  return [landing.name, landing.displayName].filter(Boolean).sort((left, right) => left.length - right.length)[0] || `Landing ${landing.id}`;
}

function nearestLanding(latitude, longitude) {
  const landings = storage.json(landingsKey, []);
  let best = null;
  for (const landing of landings) {
    // A landing the build could not place is skipped rather than guessed at: missing from the
    // search is recoverable, wrong is not.
    if (!Number.isFinite(landing.latitude) || !Number.isFinite(landing.longitude)) continue;
    const metres = distanceMetres(latitude, longitude, landing.latitude, landing.longitude);
    if (!best || metres < best.metres) best = { id: landing.id, name: buttonLabel(landing), metres };
  }
  return best;
}

function distanceLabel(metres) {
  const miles = metres / 1609.344;
  return miles < 0.1 ? "under 0.1 mi" : `${miles.toFixed(1)} mi`;
}

function setNearest(state, label, description) {
  elements.nearestButton.dataset.state = state;
  elements.nearestButton.disabled = state === "locating";
  elements.nearestLabel.textContent = label;
  elements.nearestButton.setAttribute("aria-label", description);
  elements.nearestButton.title = description;
}

function renderNearest() {
  clearTimeout(nearestTimer);
  const saved = savedNearest();
  if (!saved) return setNearest("idle", "Nearest", "Find the nearest landing");
  // Standing at the landing already on screen, the shortcut has nowhere to send anyone, so it
  // becomes the way to take a fresh fix instead of a tap that does nothing.
  if (saved.id === data?.meta?.landingNumber) return setNearest("here", saved.name, `You are at ${saved.name} — tap to check again`);
  setNearest("ready", saved.name, `Nearest landing: ${saved.name}${saved.distance ? `, ${saved.distance} away` : ""}. Tap to switch.`);
}

// Failures say which failure it was and then get out of the way: a permission the user has to
// change in browser settings reads differently from a fix that just did not arrive.
function flashNearest(label, description) {
  setNearest("error", label, description);
  nearestTimer = setTimeout(renderNearest, 3200);
}

function locateNearest() {
  if (!navigator.geolocation) return flashNearest("No GPS", "This device cannot report its location.");
  clearTimeout(nearestTimer);
  setNearest("locating", "Locating…", "Finding the nearest landing");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const best = nearestLanding(position.coords.latitude, position.coords.longitude);
      // Only reachable from a landing list cached before landings carried positions. One online
      // start refreshes it, so this is a "not yet" rather than a real error.
      if (!best) return flashNearest("No fix", "No landing positions are available yet.");
      storage.setItem(nearestKey, JSON.stringify({ id: best.id, name: best.name, distance: distanceLabel(best.metres), at: Date.now() }));
      renderNearest();
    },
    (error) => {
      if (error.code === error.PERMISSION_DENIED) return flashNearest("Blocked", "Location access is blocked for this site.");
      flashNearest("No fix", "Your location could not be determined.");
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

// Wide screens dock the landing list; phones use a drawer.
const railMedia = window.matchMedia("(min-width:821px)");
const railDocked = () => railMedia.matches;

function setMenuOpen(open, moveFocus = true) {
  if (railDocked()) open = true;
  panel(elements.landingMenu, open, !railDocked());
  elements.menuButton.setAttribute("aria-expanded", String(open));
  root.classList.toggle("menu-open", open);
  if (!moveFocus) return;
  if (open) (elements.landingList.querySelector(".is-current") || elements.landingMenuClose)?.focus();
  else elements.menuButton.focus();
}

// Runs at startup and again whenever the device is rotated or the window resized across the
// boundary, because a layout that only settles on load is wrong the moment an iPad is turned.
function applyRail() {
  const docked = railDocked();
  root.classList.toggle("sidebar-docked", docked);
  elements.menuButton.hidden = docked;
  elements.landingMenuClose.hidden = docked;
  elements.landingMenuClose.textContent = "Done";
  setMenuOpen(docked, false);
}

async function selectLanding(landingNumber) {
  // Picking a landing dismisses a drawer, because a drawer is in the way of the answer. A docked
  // rail is not in the way of anything, so it stays where it is.
  const dismiss = () => { if (!railDocked()) setMenuOpen(false); };
  if (!Number.isInteger(landingNumber) || landingNumber === data?.meta?.landingNumber) return dismiss();
  storage.setItem(landingKey, String(landingNumber));
  dismiss();
  await load(landingNumber);
}

elements.nearestButton.addEventListener("click", () => {
  const saved = savedNearest();
  if (saved && saved.id !== data?.meta?.landingNumber) return void selectLanding(saved.id);
  locateNearest();
});



const sheets = [
  bindSheet(setTripOpen, { menu: elements.tripMenu, close: elements.tripMenuClose, scrim: elements.tripMenuScrim }),
  bindSheet(setMenuOpen, { menu: elements.landingMenu, trigger: elements.menuButton, close: elements.landingMenuClose, scrim: elements.landingMenuScrim, canClose: () => !railDocked() }),
  bindSheet(setFilterOpen, { menu: elements.filterMenu, trigger: elements.filterButton, close: elements.filterMenuClose, scrim: elements.filterMenuScrim }),
  bindSheet(setThemeOpen, { menu: elements.themeMenu, trigger: elements.themeButton, close: elements.themeMenuClose, scrim: elements.themeMenuScrim }),
  bindSheet(setAlertMenuOpen, { menu: elements.alertMenu, trigger: elements.serviceAlerts, close: elements.alertMenuClose, scrim: elements.alertMenuScrim }),
  bindSheet(setChangelogOpen, { menu: elements.changelogMenu, trigger: elements.changelogButton, close: elements.changelogMenuClose, scrim: elements.changelogMenuScrim })
];

findViewElement("#landingSearch")?.addEventListener("input", renderLandingList);
elements.landingList.addEventListener("click", (event) => {
  const star = event.target.closest("[data-favourite-id]");
  if (star) return setLandingFavourite(Number(star.dataset.favouriteId), star.getAttribute("aria-pressed") !== "true");
  const option = event.target.closest("[data-landing-id]");
  if (option) selectLanding(Number(option.dataset.landingId));
});
for (const button of elements.sortOptions) {
  button.addEventListener("click", () => selectSort(button.dataset.sort));
}
elements.clockToggle.addEventListener("click", toggleClockFormat);
elements.filterReset.addEventListener("click", showAllOperators);
elements.filterList.addEventListener("click", (event) => {
  const option = event.target.closest("[data-operator]");
  if (option) setOperatorHidden(option.dataset.operator, option.getAttribute("aria-checked") === "true");
});
// A row opens the trip it belongs to. Delegated because the board is rewritten every fifteen
// seconds and per-row listeners would be re-bound with it.
elements.departures.addEventListener("click", (event) => {
  const row = event.target.closest?.("[data-trip-id]");
  if (row) openTripView(row.dataset.tripId, row.dataset.stopId, Number(row.dataset.departureSeconds));
});
elements.departures.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest?.("[data-trip-id]");
  if (!row) return;
  // Space scrolls the departures list otherwise.
  event.preventDefault();
  openTripView(row.dataset.tripId, row.dataset.stopId, Number(row.dataset.departureSeconds));
});
// Tapping a pier is the same act as picking it from the drawer, so it is the same code path.
elements.tripStops.addEventListener("click", (event) => {
  const head = event.target.closest?.("[data-landing-id]");
  if (!head) return;
  setTripOpen(false);
  selectLanding(Number(head.dataset.landingId));
});
elements.themeList.addEventListener("click", (event) => {
  const option = event.target.closest("[data-theme]");
  if (option) selectTheme(option.dataset.theme);
});
elements.datePrev.addEventListener("click", () => stepDate(-1));
elements.dateNext.addEventListener("click", () => stepDate(1));
elements.dateCurrent.addEventListener("click", showToday);
function handleBoardKeys(event) {
  const openSheet = sheets.find(({ menu, canClose }) => !menu.hidden && canClose());
  if (event.key === "Escape" && openSheet) return openSheet.setOpen(false);
  // Arrow keys page through the schedule, which is how anyone reaches for a date stepper on a
  // desktop board. Only when the landing menu is closed and nothing is being typed into.
  // A docked rail does not swallow the arrow keys: it is part of the board, not a dialog over it.
  if (openSheet || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "ArrowLeft") stepDate(-1);
  else if (event.key === "ArrowRight") stepDate(1);
}
root.addEventListener("keydown", handleBoardKeys);
header?.addEventListener("keydown", handleBoardKeys);

railMedia.addEventListener("change", applyRail);
applyRail();
applyTheme();
renderThemeMenu();
renderSortToggle();
renderClockToggle();
renderNearest();
void loadChangelog();
void loadLandings();
const ready = load().catch(() => {
  elements.departures.innerHTML = `<div class="empty"><div><strong>Schedule unavailable</strong><span>The local schedule needs attention.</span></div></div>`;
});
poll(updateClock, 15_000);
poll(() => data ? loadRealtime() : load(requestedLanding), 15_000);
poll(loadServiceAlerts, 60_000);


// View lifecycle: no network response is awaited before retained content is shown.
return {
  ready,
  activate(url = new URL(location.href)) {
    if (header) { header.hidden = false; header.inert = false; }
    root.hidden = false;
    root.inert = false;
    const landing = Number(url.searchParams.get("landing"));
    if (landing > 0 && Number.isInteger(landing)) void selectLanding(landing);
    applyRail();
    updateClock();
    document.title = data ? `${data.meta.landing.displayName} Departures · Ferry Kitty` : "Ferry Kitty";
    lifecycle.activate();
    render();
  },
  deactivate() {
    lifecycle.deactivate();
    if (header) { header.hidden = true; header.inert = true; }
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
    root.hidden = true;
    clearTimeout(nearestTimer);
    tripView = null;
    tripRequest += 1;
    for (const sheet of sheets) {
      if (sheet.menu === elements.landingMenu && railDocked()) continue;
      if (!sheet.menu.hidden) { panel(sheet.menu, false); sheet.menu.hidden = true; }
    }
    if (!railDocked()) setMenuOpen(false, false);
    root.getAnimations?.({ subtree: true }).forEach(animation => animation.cancel());
    [...root.querySelectorAll('[aria-expanded="true"]'), ...(header?.querySelectorAll('[aria-expanded="true"]') || [])].forEach(node => {
      if (node !== elements.menuButton || !railDocked()) node.setAttribute("aria-expanded", "false");
    });
    root.hidden = true;
    root.inert = true;
  },
  dispose() {
    this.deactivate();
    lifecycle.dispose();
    railMedia.removeEventListener("change", applyRail);
    root.removeEventListener("keydown", handleBoardKeys);
    header?.removeEventListener("keydown", handleBoardKeys);
    MobileRuntime.releasePanels?.(root);
    root.replaceChildren();
    header?.replaceChildren();
  }
};
}
