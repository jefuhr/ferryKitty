import { createRideController } from "./ride-controller.js";
import { themeKey, THEMES } from "./preferences.js";

const prefix = "/ferryTimesMobile";
const base = location.pathname === prefix || location.pathname.startsWith(prefix + "/") ? prefix + "/" : "/";
const roots = { board: document.querySelector("#boardView"), map: document.querySelector("#mapView"), ride: document.querySelector("#rideView") };
const headings = { board: document.querySelector("#boardHeading"), map: document.querySelector("#mapHeading"), ride: document.querySelector("#rideHeading") };
const appHeader = document.querySelector(".app-header");
const measureHeader = () => document.documentElement.style.setProperty("--app-header-height", appHeader.getBoundingClientRect().height + "px");
// Safe-area changes resize the padding even when the header's content stays the
// same size. Observe the whole header so rotation cannot leave stale view bounds.
new ResizeObserver(measureHeader).observe(appHeader, { box: "border-box" });
const links = [...document.querySelectorAll(".app-header [data-view]")];
const controllers = new Map();
const mounting = new Map();
const modules = {};
let current = null;
let navigation = 0;
let geometryPromise = null;
const status = document.querySelector("#navigationStatus");
const ride = createRideController({ navigate, base });

function moduleFor(view) {
  if (!modules[view]) {
    modules[view] = (view === "board" ? import("../app.js?v=128") : view === "ride" ? import("./ride.js?v=128") : import("./map.js?v=128"))
      .catch(error => { delete modules[view]; throw error; });
  }
  return modules[view];
}
function geometry() {
  if (!geometryPromise) {
    geometryPromise = MobileRuntime.request("/api/map").then(async response => {
      if (!response.ok) throw new Error("Map geometry unavailable");
      const payload = await response.json();
      if (!payload.bounds || !Array.isArray(payload.landings) || !Array.isArray(payload.routes)) throw new Error("Invalid map geometry");
      return { ok: true, json: async () => payload };
    }).catch(error => { geometryPromise = null; throw error; });
  }
  return geometryPromise;
}
function setTheme(id) {
  const theme = THEMES.find(entry => entry.id === id) || THEMES[0];
  MobileRuntime.storage.setItem(themeKey, theme.id);
  document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.color);
}
setTheme(MobileRuntime.storage.getItem(themeKey));
MobileRuntime.syncViewport?.();
for (const link of links) link.href = base + (link.dataset.view === "map" ? "map" : "");

function viewFor(url) {
  if (url.origin !== location.origin) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const local = path.startsWith(prefix + "/") ? path.slice(prefix.length) : path === prefix ? "/" : path;
  if (["/", "/index.html"].includes(local)) return "board";
  if (["/map", "/map.html"].includes(local)) return "map";
  if (local === "/ride") return "ride";
  return null;
}
function mount(view) {
  if (controllers.has(view)) return Promise.resolve(controllers.get(view));
  if (!mounting.has(view)) {
    mounting.set(view, moduleFor(view).then(module => {
      // Geometry needs a real viewport on first draw, but mounting never waits for its feed.
      roots[view].hidden = false;
      const controller = view === "board"
        ? module.mountBoard(roots[view], { header: headings[view], setTheme, onRide: ride.choose })
        : view === "ride"
        ? module.mountRide(roots[view], { header: headings[view], ride, navigate, getGeometry: geometry, base })
        : module.mountMap(roots[view], { header: headings[view], navigate, getGeometry: geometry, boardURL: base, onRide: ride.choose });
      controllers.set(view, controller);
      roots[view].hidden = true;
      return controller;
    }).catch(error => {
      roots[view].hidden = true;
      mounting.delete(view);
      delete modules[view];
      throw error;
    }));
  }
  return mounting.get(view);
}
function show(view, controller, url, focus) {
  if (current && current !== view) controllers.get(current).deactivate();
  current = view;
  status.textContent = "";
  controller.activate(url);
  ride.viewChanged(view, url);
  measureHeader();
  for (const link of links) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (focus) (links.find(link => link.dataset.view === view) || document.querySelector("#rideMinimize")).focus({ preventScroll: true });
  document.documentElement.dataset.view = view;
}
async function navigate(destination, { historyMode = "push", focus = true } = {}) {
  let url = new URL(destination, location.href);
  let view = viewFor(url);
  if (view === "ride" && !ride.session) { url = new URL(base, location.origin); view = "board"; historyMode = "replace"; }
  if (!view) { location.assign(url.href); return; }
  const generation = ++navigation;
  try {
    // Already-mounted tabs take a synchronous path: no network or import promise in the hot path.
    let controller = controllers.get(view);
    if (!controller) {
      status.textContent = "Loading " + view + "…";
      controller = await mount(view);
    }
    if (generation !== navigation) return;
    if (historyMode === "push" && url.href !== location.href) history.pushState(null, "", url);
    if (historyMode === "replace") history.replaceState(null, "", url);
    show(view, controller, url, focus);
    void controller.ready.then(preload);
  } catch {
    if (generation === navigation) status.textContent = "Could not open this view. Please try again.";
  }
}
document.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a[href]");
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  const url = new URL(link.href);
  if (!viewFor(url) || url.hash) return;
  event.preventDefault();
  void navigate(url);
});
window.addEventListener("popstate", () => void navigate(location.href, { historyMode: "none" }));
window.addEventListener("storage", event => { if (event.key === themeKey) setTheme(event.newValue); });
let preloaded = false;
function preload() {
  if (preloaded || navigator.connection?.saveData) return;
  preloaded = true;
  const work = () => {
    void moduleFor(current === "board" ? "map" : "board").catch(() => {});
    void geometry().catch(() => {});
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(work, { timeout: 3000 });
  else window.setTimeout(work, 1000);
}
void navigate(ride.session ? base + "ride" : location.href, { historyMode: ride.session ? "replace" : "none", focus: false });

if ("serviceWorker" in navigator) {
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
  // The worker is fetched from the site root, so its scope covers the board wherever the board is
  // mounted — but the document it has to precache is wherever this page is, which is the root on a
  // local deployment and /ferryTimesMobile/ behind the deployment's proxy. Passing it along is the difference
  // between an offline shell and an install that fails on a 404.
  navigator.serviceWorker.register(`/sw.js?v=128&base=${encodeURIComponent(base)}`, { scope: "/", updateViaCache: "none" })
    .then((registration) => {
      registration.update();
      // A board added to a home screen is resumed, not reloaded. iOS keeps the page alive for days,
      // so the check above — which only ever runs on a load — never runs again, and an installed
      // board can sit on a shell several deploys old while a browser tab on the same phone is
      // current. Checking when it comes back to the front is what makes a relaunch mean something.
      // Throttled because resuming is something someone does dozens of times a shift, and the
      // answer cannot change faster than a deploy.
      let lastCheck = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastCheck < 60_000) return;
        lastCheck = Date.now();
        registration.update().catch(() => {});
      });
    })
    .catch(() => {});
}
