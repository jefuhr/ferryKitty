import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { landingChoices, loadAllLandingData, operatorRoster, routeRoster, stopIdsForLanding } from "./lib/landing-data.js";
import { clampLimit, createConnectionIndex, tripConnections, vesselsByBoat } from "./lib/connections.js";
import { createCounterService } from "./lib/counters.js";
import { openStatsStore } from "./lib/stats-store.js";
import { describeBoats, loadHarborMap } from "./lib/fleet-map.js";
import { buildHarborSchedule } from "./lib/harbor-schedule.js";
import { encodeTripUpdates } from "./lib/harbor-api.js";
import { openHarborDb, seedRoster } from "./lib/harbor-db.js";
import { createHarborService } from "./lib/harbor-service.js";
import { createHarborStore } from "./lib/harbor-store.js";
import { harborLandings as joinHarborLandings, loadHarborTerminals } from "./lib/harbor-terminals.js";
import { createNyuRealtimeService } from "./lib/nyu-realtime.js";
import { createRealtimeService } from "./lib/realtime.js";
import { createRideService, resolveVessel } from "./lib/ride.js";
import { createRidePush, handleRidePush } from "./lib/ride-push.js";
import { PARTNER_FEEDS, parseCsv } from "./lib/schedule-builder.js";
import { createServiceAlertService } from "./lib/service-alerts.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
// Runtime state lives beside the code unless a caller says otherwise. A test that starts this
// server points it at a temporary directory so a run never rewrites the working copy's snapshots.
const STATE = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : path.join(ROOT, "state");
const DATA = path.join(PUBLIC, "data/display-data.json");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8090);
const DISPLAY_CONFIG = path.join(ROOT, "config/display.json");
const displayConfig = JSON.parse(await readFile(DISPLAY_CONFIG, "utf8"));

// This server answers for every landing, not just config/display.json's. See lib/landing-data.js
// for why the merged view matters as much as the per-landing map: without it the realtime feeds
// stay scoped to one landing and partner operators docking elsewhere never get fetched at all.
const LANDINGS_CONFIG = JSON.parse(await readFile(path.join(ROOT, "config/landings.json"), "utf8"));
const LANDING_CHOICES = landingChoices(LANDINGS_CONFIG);
const landingData = await loadAllLandingData({ root: ROOT, choices: LANDING_CHOICES });
const displayDataJson = new Map([...landingData.byLanding].map(([id, data]) => [id, precompressed(`${JSON.stringify(data)}\n`)]));
// The filter panel is per device and spans every landing, so it needs the whole roster rather
// than whatever the landing on screen happens to carry.
const OPERATORS = operatorRoster(landingData.byLanding);
const ROUTES = routeRoster(landingData.byLanding);
const realtimeStopsByLanding = new Map([...landingData.byLanding].map(([id, data]) => [id, stopIdsForLanding(data)]));
// The departure board also shows the pause at the far terminal. Keep just the two timing keys
// needed for each turn, alongside this landing's updates, rather than sending the whole feed.
const turnaroundLiveIDs = new Map((landingData.merged.departures || []).filter(row => row.liveTripId)
  .map(row => [String(row.tripId), String(row.liveTripId)]));
const turnaroundLiveID = tripId => landingData.merged.tripSchedules?.[tripId]?.liveTripId
  || turnaroundLiveIDs.get(String(tripId)) || tripId;
const turnaroundKeysByLanding = new Map([...landingData.byLanding].map(([id, data]) => {
  return [id, new Set(Object.entries(data.tripSchedules || {}).flatMap(([tripId, schedule]) => {
    const turn = schedule.turnaround;
    if (!turn) return [];
    return [schedule.liveTripId || turnaroundLiveID(tripId), turn.nextLiveTripId || turnaroundLiveID(turn.nextTripId),
      ...Object.values(schedule.liveTripIdsByDate || {}), ...Object.values(turn.nextLiveTripIdsByDate || {})]
      .filter(value => value != null).map(value => `${value}|${turn.stopId}`);
  }))];
}));
console.log(`Loaded ${landingData.byLanding.size} of ${LANDING_CHOICES.length} landings; realtime covers ${landingData.merged.meta.landing.stopIds.length} stops.`);

// The map page's static half: the route lines, the docks and the bounds that hold them, plus the
// trip index that turns "in transit to stop 4 of trip 863" into the name of a landing. Built once
// from the bundled feed, which is the same contract the landing data above has.
const harbor = await loadHarborMap({ root: ROOT, landings: landingData.available, byLanding: landingData.byLanding });
const harborMapJson = precompressed(`${JSON.stringify(harbor.map)}\n`);
console.log(`Charted ${harbor.map.routes.length} routes and ${harbor.map.landings.length} docks for the map.`);

const fleet = JSON.parse(await readFile(path.join(ROOT, "content/vessels.json"), "utf8")).vessels;
let harborService = null;
const rideService = await createRideService({ fleet, byLanding: landingData.byLanding, historyPath: path.join(STATE, "vessel-trip-history.json") });
const vesselIdentity = item => resolveVessel({ id: item.vesselNumber || item.number, label: item.boatName || item.name }, fleet)?.id || null;
const realtimeService = createRealtimeService({ loadDisplay: async () => landingData.merged, fleetPath: path.join(ROOT, "content/vessels.json"), cachePath: path.join(STATE, "realtime.json"), onRefresh: async (update) => {
  // Two listeners, neither of which may cost the other its turn: the ride history and the harbor
  // tracker both read the same refresh, and the tracker never throws.
  try { await rideService.observe(update); } finally { harborService?.observeOperatorFeed(update); }
} });
let ridePush = null, notificationFreshness = { stale: true };
try {
  ridePush = await createRidePush({ directory: STATE, subject: process.env.WEB_PUSH_SUBJECT || "https://juliet.nyc/ferryTimesMobile/",
    refresh: async () => { const current = await realtimeService.getCurrent(); notificationFreshness = { stale: current.stale, positionsStale: current.vehiclesStale }; return current.available && !current.stale; },
    describe: (id, at) => rideService.describe(id, at, notificationFreshness) });
} catch { console.error("Departure notifications unavailable: check the writable state directory and Web Push configuration."); }
const nyuRealtimeService = createNyuRealtimeService({ loadDisplay: async () => landingData.merged, cachePath: path.join(STATE, "nyu-realtime.json") });
const serviceAlertService = createServiceAlertService({ cachePath: path.join(STATE, "service-alerts.json") });
// Every stop on the board, indexed by the pier it belongs to, so the trip view can be told what
// leaves from the far end of a sailing. Built once from the landings already in memory and holding
// their departures by reference — see lib/connections.js.
const connectionIndex = createConnectionIndex(landingData.byLanding);
const statsStore = await openStatsStore({ databasePath: path.join(STATE, "stats.db") });
// The totals that existed before the history did. Folded into the hour they were last written and
// marked, so the lifetime numbers on the stats page survive the deploy that gave them a time axis.
const imported = await statsStore.importLegacyCounters(path.join(STATE, "counters.json"));
if (imported.imported) console.log(`Imported the previous counters, dating from ${imported.since}.`);
statsStore.markSince(new Date().toISOString());
const pruned = statsStore.prune();
if (pruned.removed) console.log(`Pruned ${pruned.removed} stats rows older than ${pruned.cutoff}.`);
const counters = createCounterService({ store: statsStore });
// The harbor tracker: every passenger ferry AIS can see, which landing and slip it is in, and which
// trip it is running. It needs one place per pier, so each board landing becomes one harbor landing
// named by its first stop id, and remembers every stop id any operator uses for that pier so a
// departure can be matched against whichever timetable the boat belongs to.
const landingTable = LANDINGS_CONFIG.landings || LANDINGS_CONFIG;
const boardLandings = landingData.available.flatMap((landing) => {
  const configured = landingTable[String(landing.id)] || {};
  const ids = [...(configured.stopIds || []).map(String),
    ...Object.values(PARTNER_FEEDS).flatMap((feed) => (configured[feed.stopIdsKey] || []).map((id) => `${feed.prefix}${id}`))];
  if (!ids.length || !Number.isFinite(landing.latitude) || !Number.isFinite(landing.longitude)) return [];
  return [{ landingStopId: ids[0], landingId: landing.id, name: landing.displayName || landing.name, latitude: landing.latitude, longitude: landing.longitude, stopIds: ids }];
});
// The board only knows the piers it shows departures for. Ferries that dock in the city also call
// at terminals across the river and down the bay; those come from a committed list of public stops.
const harborTerminals = await loadHarborTerminals(path.join(ROOT, "config/harbor-terminals.json")).catch((error) => {
  console.warn(`Harbor terminals unavailable: ${error.message}`);
  return [];
});
const { landings: harborLandings, stopIdsOfLanding: harborStopIds } = joinHarborLandings({ boardLandings, terminals: harborTerminals });
const harborRoster = JSON.parse(await readFile(path.join(ROOT, "content/harbor-roster.json"), "utf8"));
// The tracker's long memory. Like the tracker itself it is optional: if the database cannot be
// opened the tracker still runs, it just forgets what it saw.
let harborDb = null, harborStore = null;
try {
  harborDb = openHarborDb({ databasePath: path.join(STATE, "harbor.db") });
  seedRoster(harborDb, harborRoster);
  harborStore = createHarborStore(harborDb);
  await harborStore.importLegacy({ stateDir: STATE });
} catch (error) {
  console.warn(`Harbor database unavailable: ${error.message}`);
  harborDb?.close();
  harborDb = harborStore = null;
}
const harborStops = parseCsv(await readFile(path.join(ROOT, "gtfs/stops.txt"), "utf8"))
  .map((stop) => ({ stopId: stop.stop_id, name: stop.stop_name, latitude: Number(stop.stop_lat), longitude: Number(stop.stop_lon) }));
// The tracker is an addition to the board, so nothing about it may stop the board from starting.
// If it cannot be built, its three routes say so and every other route carries on.
const harborUnavailable = (reason) => ({
  start: async () => {}, stop: async () => {}, observeOperatorFeed: () => {},
  getCurrent: () => ({ available: false, stale: true, fetchedAt: null, error: reason, sources: {}, vessels: [] }),
  vesselDetail: () => null, operators: () => ({ operators: [] }), terminals: () => ({ terminals: [] }),
  slips: () => ({ slips: [] }),
  tripUpdates: () => encodeTripUpdates({ feed: null, now: Date.now() }),
  status: () => ({ ais: { state: "disabled" }, tracks: 0, slips: 0, landings: 0 })
});
harborService = await createHarborService({
  stateDir: STATE,
  roster: harborRoster, store: harborStore, terminals: harborTerminals,
  fleet, stops: harborStops, landings: harborLandings,
  stopIdsOfLanding: (id) => harborStopIds.get(id) || [id],
  // Without the berth survey the tracker reports landings and leaves slips blank.
  slipsCsvPath: process.env.HARBOR_SLIPS_CSV || path.join(ROOT, "content/harbor-slips.csv"),
  slipAliasesPath: path.join(ROOT, "secrets/slip-aliases.json"),
  schedule: await buildHarborSchedule({ root: ROOT, serviceTrips: harbor.serviceTrips }),
  routes: harbor.routes, serviceTrips: harbor.serviceTrips,
  apiKey: process.env.AISSTREAM_API_KEY || null,
  streamUrl: process.env.AISSTREAM_URL || undefined,
  replayPath: process.env.AIS_REPLAY_PATH || null,
  onEvent: (name) => { if (name === "ais-reconnect") counters.event(name); },
  warn: (message) => console.warn(message)
}).catch((error) => {
  console.error(`Harbor tracker unavailable: ${error.message}`);
  return harborUnavailable("The harbor tracker could not start.");
});
{
  const status = harborService.status();
  console.log(`Harbor tracker: ${status.landings} landings, ${status.slips} slips, ${status.tracks} remembered vessels, AIS ${status.ais.state}.`);
}
// The counters key landings by number, which is what an agent dials and not what anyone reading a
// stats page knows a dock by.
const LANDING_NAMES = Object.fromEntries(landingData.available.map((landing) => [landing.id, landing.displayName || landing.name]));
// The extensionless pages this server answers for, and the file each one is.
//
// Reachable as /stats at the site root and as /ferryTimesMobile/stats on juliet.nyc. Whether the proxy
// hands the prefix on or strips it is the proxy's business and not visible from here, so both
// arrivals are answered rather than guessed between — and both are counted as the one page they
// are, since counting them apart would file the proxied spelling in with the served files.
const PAGES = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/stats", "stats.html"], ["/map", "index.html"], ["/map.html", "index.html"], ["/ride", "index.html"]]);
const PROXY_PREFIX = "/ferryTimesMobile";
function pageFor(pathname) {
  // With or without the trailing slash a browser may add.
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  const canonical = trimmed === PROXY_PREFIX ? "/" : trimmed.startsWith(`${PROXY_PREFIX}/`) ? trimmed.slice(PROXY_PREFIX.length) : trimmed;
  return PAGES.has(canonical) ? { canonical, file: PAGES.get(canonical) } : null;
}
// Everything counted so far, including the current minute.
//
// The rollup runs on a timer, so anything counted since the last one is still only in memory. It is
// pushed down before reading rather than merged on top afterwards: a histogram cannot be usefully
// added to a percentile once the percentile has been taken, and one extra INSERT on a page nobody
// keeps open is cheaper than carrying two half-answers around and reconciling them.
function buildStats() {
  counters.flush();
  const landings = statsStore.totals("landing");
  return {
    since: statsStore.since(),
    generatedAt: new Date().toISOString(),
    routes: statsStore.totals("route"),
    statuses: statsStore.totals("status"),
    events: statsStore.totals("event"),
    landings,
    // Only the docks that have a count. Shipping all 30 names to render the four a board has
    // actually been opened on is most of this payload for none of its meaning.
    landingNames: Object.fromEntries(Object.keys(landings).map((id) => [id, LANDING_NAMES[id]]).filter(([, name]) => name)),
    series: {
      boards: statsStore.series("route", { hours: 48, keys: ["/api/display-data"] }),
      requests: statsStore.series("route", { hours: 48 })
    },
    feed: {
      ok: statsStore.series("event", { hours: 48, keys: ["realtime-ok"] }),
      stale: statsStore.series("event", { hours: 48, keys: ["realtime-stale"] }),
      unavailable: statsStore.series("event", { hours: 48, keys: ["realtime-unavailable"] })
    },
    harbor: {
      ok: statsStore.series("event", { hours: 48, keys: ["harbor-ok"] }),
      stale: statsStore.series("event", { hours: 48, keys: ["harbor-stale"] }),
      unavailable: statsStore.series("event", { hours: 48, keys: ["harbor-unavailable"] }),
      reconnects: statsStore.series("event", { hours: 48, keys: ["ais-reconnect"] })
    },
    latency: statsStore.latencies({ hours: 24 })
  };
}

const TYPES = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml", ".woff2":"font/woff2", ".webmanifest":"application/manifest+json; charset=utf-8" };

function headers(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  // The two tile hosts are the only exception to 'self' anywhere in this policy, and they are
  // allowed for images and nothing else: the map page draws OpenStreetMap under OpenSeaMap's
  // seamark overlay, which cannot be done from this origin. Everything that could execute —
  // script, style, fetch, fonts — stays where it was. A tile host that goes down, or a board with
  // no signal, costs the map its backdrop and nothing else: the routes, the docks and the boats
  // are all still drawn from this server's own data.
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org https://tiles.openseamap.org; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
}
// Nothing between this server and a phone compresses, and the map's chart alone is a megabyte of
// JSON on a cellular connection. Below roughly one packet there is nothing to win, so small
// answers go out as they always did rather than paying for a header and a deflate.
const COMPRESS_MIN_BYTES = 1400;
function acceptsGzip(request) {
  return /(^|,)\s*gzip\s*(;|,|$)/i.test(request?.headers?.["accept-encoding"] || "");
}
// The two large bodies never change between restarts, so they are deflated once at boot instead of
// on every request. Everything else is small enough that compressing it inline is cheaper than
// keeping a second copy of it in memory.
function precompressed(body) {
  return { raw: body, gzip: gzipSync(body) };
}
// `body` is either a string or a { raw, gzip } pair from precompressed(). The request is taken off
// the response rather than threaded through twenty call sites; Node has linked the two since 15.
function send(response, status, extraHeaders, body) {
  const raw = typeof body === "string" ? body : body.raw;
  const gzip = !acceptsGzip(response.req) ? null
    : typeof body === "string"
      ? (Buffer.byteLength(raw) >= COMPRESS_MIN_BYTES ? gzipSync(raw) : null)
      : body.gzip;
  const payload = gzip || Buffer.from(raw);
  headers(response);
  response.writeHead(status, {
    ...extraHeaders,
    "Content-Length": payload.length,
    // A shared cache keyed on the URL alone must not hand a deflated body to a client that asked
    // for plain text. /api/map is the one response here with a public max-age, and it is also the
    // one worth compressing most.
    "Vary": "Accept-Encoding",
    ...(gzip ? { "Content-Encoding": "gzip" } : {})
  });
  response.end(payload);
}
function json(response, status, body) { send(response, status, { "Content-Type": TYPES[".json"], "Cache-Control":"no-cache" }, `${JSON.stringify(body)}\n`); }
async function serve(response, file) {
  try { const info = await stat(file); if (!info.isFile()) throw new Error(); const extension = path.extname(file); const noCache = [".html", ".css", ".js"].includes(extension) || path.basename(file) === "sw.js"; headers(response); response.writeHead(200, { "Content-Type": TYPES[extension] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": noCache ? "no-cache, must-revalidate" : "public, max-age=3600" }); createReadStream(file).pipe(response); }
  catch { json(response, 404, { error: "Not found" }); }
}
async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (await handleRidePush(request, response, ridePush)) return;
  if (url.pathname === "/healthz" || url.pathname === "/api/health") return json(response, 200, { ok:true, service:"ferry-kitty", now:new Date().toISOString(), counters: buildStats() });
  // Public aggregate request statistics.
  if (url.pathname === "/api/stats") return json(response, 200, buildStats());
  // The change log, written by hand in content/changelog.json. Read off disk on every request
  // rather than at boot so an edit needs a deploy and not a restart, and served from /api/ so the
  // service worker treats it as data — network first, cached for offline — instead of caching it
  // for the life of a shell the way it caches everything under /assets/.
  if (url.pathname === "/api/changelog") {
    try {
      const parsed = JSON.parse(await readFile(path.join(ROOT, "content/changelog.json"), "utf8"));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return json(response, 200, { entries });
    } catch {
      // A change log nobody can read is not worth a 500 on a board that is otherwise fine.
      return json(response, 200, { entries: [] });
    }
  }
  if (url.pathname === "/api/landings") return json(response, 200, { landings: landingData.available, operators: OPERATORS, routes: ROUTES, configured: displayConfig.landingNumber });
  if (url.pathname === "/api/display-data") {
    const requested = url.searchParams.get("landingId");
    const landingNumber = requested === null ? Number(displayConfig.landingNumber) : Number(requested);
    if (requested !== null && !displayDataJson.has(landingNumber)) return json(response, 400, { error: "Unknown landing." });
    const built = displayDataJson.get(landingNumber);
    // Falling back to the file the build wrote keeps the default board available if its own landing was the one
    // that failed to build at startup — stale published times beat a blank board.
    try {
      const body = built ?? await readFile(DATA, "utf8");
      return send(response, 200, { "Content-Type":TYPES[".json"], "Cache-Control":"no-cache" }, body);
    } catch (error) { return json(response, 503, { error:"Display data unavailable", detail:error.message }); }
  }
  // NYU's live estimates ride along in the same payload: its updates are already namespaced with
  // the "nyu:" trip and stop ids the display was built with, so the client matches both operators
  // through one lookup. Either operator's feed failing leaves the other's usable, and one stale
  // source marks the whole payload stale — which only ever falls back to published times.
  if (url.pathname === "/api/vessels") return json(response, 200, { vessels: rideService.vessels() });
  if (url.pathname === "/api/ride") {
    const id = url.searchParams.get("vesselId");
    if (!id) return json(response, 400, { error: "A vesselId is required." });
    const current = await realtimeService.getCurrent();
    const ride = rideService.describe(id, Date.now(), { stale: current.stale, positionsStale: current.vehiclesStale });
    return ride ? json(response, 200, ride) : json(response, 404, { error: "Unknown vessel." });
  }
  if (url.pathname === "/api/realtime") {
    const [ferry, nyu] = await Promise.all([realtimeService.getCurrent(), nyuRealtimeService.getCurrent()]);
    // Upstream is polled once for the whole system, then narrowed per request. A client that names
    // its landing gets only its own stops, which keeps the payload the size it was before this
    // server covered all 25; omitting landingId returns everything, so an older cached client that
    // does not send it still works.
    const landingId = Number(url.searchParams.get("landingId"));
    const stops = realtimeStopsByLanding.get(landingId);
    const turnaroundKeys = turnaroundKeysByLanding.get(landingId);
    const updates = [...(ferry.updates || []), ...(nyu.updates || [])];
    // Where the boats are rides along in the same cached snapshot and is deliberately not forwarded
    // here. No board draws a map, and a coordinate pair per vessel on a payload every board polls
    // every fifteen seconds is weight for nobody. The map reads them from /api/boats, off this same
    // cache and without a second fetch upstream.
    const { positions, ...departureData } = ferry;
    const result = {
      ...departureData,
      vehicles: (departureData.vehicles || []).map(item => ({ ...item, vesselId: vesselIdentity(item) })),
      available: ferry.available || nyu.available,
      stale: Boolean(ferry.stale || nyu.stale),
      updates: stops ? updates.filter((update) => stops.has(String(update.stopId)) || turnaroundKeys?.has(`${update.tripId}|${update.stopId}`)) : updates,
      nyu: { available: nyu.available, stale: nyu.stale, fetchedAt: nyu.fetchedAt, error: nyu.error }
    };
    // The status code says a payload went out; these say what was in it. A board that answers 200
    // from a stale cache all afternoon looks perfectly healthy from the outside.
    // The healthy case is counted too. A timeline of failures alone cannot tell a quiet night
    // apart from a feed that stopped being asked.
    if (!result.available) counters.event("realtime-unavailable");
    else if (result.stale) counters.event("realtime-stale");
    else counters.event("realtime-ok");
    return json(response, result.available ? 200 : 503, result);
  }
  // The map's static half. It is derived from the bundled feed and so changes only on redeploy,
  // which is worth an hour of browser cache: it is by far the largest thing the map page fetches
  // and by far the least likely to have changed since the last time it was asked for.
  if (url.pathname === "/api/map") {
    return send(response, 200, { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=3600" }, harborMapJson);
  }
  // The map's live half, read off the same cached snapshot /api/realtime uses. Ages are measured
  // against the snapshot rather than against now, so a cache being served during an upstream outage
  // shows the harbor as it stood when it was last read instead of emptying out boat by boat.
  if (url.pathname === "/api/boats") {
    const current = await realtimeService.getCurrent();
    const asOf = current.fetchedAt ? Date.parse(current.fetchedAt) : Date.now();
    const boats = describeBoats(current.positions, { trips: harbor.trips, serviceTrips: harbor.serviceTrips, routes: harbor.routes, asOf });
    return json(response, current.available ? 200 : 503, {
      available: current.available,
      // The vessel-position feed is fetched alongside the trip updates and can fail on its own, so
      // a payload can be current for departures and stale for positions. This page only cares
      // about the second.
      stale: Boolean(current.stale || current.vehiclesStale),
      fetchedAt: current.fetchedAt,
      error: current.error,
      boats: boats.map(item => ({ ...item, vesselId: vesselIdentity(item) }))
    });
  }
  // Every passenger ferry the tracker knows, from AIS first and the operator's feed second. The
  // operator's feed is only read when somebody asks, exactly as /api/boats reads it, so this adds
  // no polling of its own; AIS arrives on its own connection whether anyone is asking or not.
  if (url.pathname === "/api/harbor/vessels") {
    await realtimeService.getCurrent().catch(() => null);
    const current = harborService.getCurrent({ includeUnrostered: url.searchParams.get("include") === "unrostered",
      operatorId: url.searchParams.get("operator") || null, state: url.searchParams.get("state") || null });
    counters.event(!current.available ? "harbor-unavailable" : current.stale ? "harbor-stale" : "harbor-ok");
    return json(response, current.available ? 200 : 503, current);
  }
  // One hull: who it is and how that is known, where it is, which run it is estimated to be on and
  // why, and where it has been. Documented as "/api/harbor/vessels/{id}".
  if (url.pathname.startsWith("/api/harbor/vessels/")) {
    let id = null;
    try { id = decodeURIComponent(url.pathname.slice("/api/harbor/vessels/".length)); } catch { /* A malformed id is an unknown id. */ }
    await realtimeService.getCurrent().catch(() => null);
    const detail = id ? harborService.vesselDetail(id) : null;
    return detail ? json(response, 200, detail) : json(response, 404, { error: "No such vessel." });
  }
  if (url.pathname === "/api/harbor/operators") return json(response, 200, harborService.operators());
  if (url.pathname === "/api/harbor/terminals") return json(response, 200, harborService.terminals());
  // The slip catalog and the slip-level trip updates, in the shapes the iOS app already reads.
  // Yard, fuel and dry-dock berths are listed only when asked for.
  if (url.pathname === "/api/slips") return json(response, 200, harborService.slips({ includeYard: url.searchParams.get("include") === "yard" }));
  if (url.pathname === "/gtfs-rt/tripupdate") {
    await realtimeService.getCurrent().catch(() => null);
    return send(response, 200, { "Content-Type": "application/x-protobuf", "Cache-Control": "no-store" },
      { raw: Buffer.from(harborService.tripUpdates()), gzip: null });
  }
  // What else leaves from the stops one trip calls at. The client cannot answer this from its own
  // payload — that is scoped to a single landing — so it asks here, naming only the trip.
  //
  // Deliberately no time parameter. The service worker caches every /api/ URL network-first and
  // nothing prunes that cache until a version bump, so a timestamp in the query string would grow
  // it without bound; one entry per trip ever tapped is finite and worth re-serving offline.
  if (url.pathname === "/api/connections") {
    const tripId = (url.searchParams.get("tripId") || "").trim();
    if (!tripId) return json(response, 400, { error: "tripId is required." });
    // Realtime is an enrichment here, never a precondition: a feed that is down should cost the
    // trip view its delays and vessel names, not the stop list it exists to show.
    let updates = new Map(), vehicles = new Map(), vessels = new Map(), stale = true;
    try {
      const [ferry, nyu] = await Promise.all([realtimeService.getCurrent(), nyuRealtimeService.getCurrent()]);
      // System-wide, before /api/realtime narrows them to one landing — which is exactly the data
      // this endpoint needs and the only place it exists.
      updates = new Map([...(ferry.updates || []), ...(nyu.updates || [])].map((item) => [`${item.tripId}|${item.stopId}`, item]));
      vehicles = new Map((ferry.vehicles || []).map((item) => [String(item.tripId), item]));
      vessels = vesselsByBoat(ferry.vehicles || []);
      stale = Boolean(ferry.stale || nyu.stale) || !(ferry.available || nyu.available);
    } catch { /* schedule-only, and the payload says so */ }
    const result = tripConnections({
      index: connectionIndex, tripId, limit: clampLimit(url.searchParams.get("limit")),
      updates, vehicles, vessels, stale
    });
    if (!result) return json(response, 404, { error: "Unknown trip." });
    return json(response, 200, result);
  }
  if (url.pathname === "/api/alerts") { const result = await serviceAlertService.getCurrent(); return json(response, result.available ? 200 : 503, result); }
  const page = pageFor(url.pathname);
  if (page) return serve(response, path.join(PUBLIC, page.file));
  let relative; try { relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")); } catch { return json(response, 400, { error:"Invalid path" }); }
  const file = path.resolve(PUBLIC, relative); if (!file.startsWith(`${PUBLIC}${path.sep}`)) return json(response, 403, { error:"Forbidden" });
  return serve(response, file);
}
// Counted once per request, from one place, after the response has gone out — so the count knows
// the status it ended with and nothing on the request path can be slowed or broken by counting it.
function count(request, response) {
  const startedAt = process.hrtime.bigint();
  response.on("finish", () => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    // Only the payload a board fetches when it opens or switches docks counts as viewing a landing.
    // Count board selections separately from background polling.
    const requested = url.searchParams.get("landingId");
    const landingId = requested === null ? Number(displayConfig.landingNumber) : Number(requested);
    counters.record({
      route: pageFor(url.pathname)?.canonical || url.pathname,
      landingId: url.pathname === "/api/display-data" && displayDataJson.has(landingId) ? landingId : undefined,
      status: response.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
    });
  });
}
const server = http.createServer((request, response) => {
  count(request, response);
  return handle(request, response).catch((error) => { console.error(error); if (!response.headersSent) json(response, 500, { error:"Internal server error" }); });
});
server.listen(PORT, HOST, () => {
  console.log(`Ferry Kitty ready at http://${HOST}:${PORT}`);
  counters.start();
  ridePush?.start();
  void harborService.start();
});
const shutdown = () => server.close(() => void Promise.all([counters.stop(), ridePush?.stop(), harborService.stop()]).finally(() => { statsStore.close(); harborDb?.close(); process.exit(0); }));
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
