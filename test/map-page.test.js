import { runtimeStub } from "./helpers/runtime-stub.js";
// The map page, run rather than read.
//
// The other client-side contract tests assert on source text, which is enough for "does the markup
// still say what the code expects". It is not enough here: this page's whole job is to turn two
// JSON payloads into a drawing, and the failures worth catching — a projection that puts the fleet
// off the frame, a constant renamed on one line and not the next — are runtime failures that no
// amount of grepping the file finds. So map.js is executed against a fake DOM small enough to read
// and faithful enough to draw into.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clientSource } from "./helpers/client-source.js";
import vm from "node:vm";

const scriptPath = new URL("../public/assets/map.js", import.meta.url);
const pagePath = new URL("../public/map.html", import.meta.url);

const HARBOR = {
  bounds: { minLatitude: 40.6, maxLatitude: 40.8, minLongitude: -74.05, maxLongitude: -73.95 },
  routes: [
    { id: "ER", shortName: "ER", name: "East River", color: "#00839C", mode: "ferry", paths: [[[40.7, -74.0], [40.75, -73.97]]] },
    { id: "SB", shortName: "SB", name: "South Brooklyn", color: "#FFD100", mode: "ferry", paths: [[[40.7, -74.0], [40.64, -74.03]]] }
  ],
  landings: [
    { id: 17, name: "East 34th Street", displayName: "East 34th Street", latitude: 40.75, longitude: -73.97 },
    { id: 4, name: "Bay Ridge", displayName: "Bay Ridge", latitude: 40.64, longitude: -74.03 }
  ]
};

const BOAT = {
  id: "19", name: "Opportunity", number: "H-204", latitude: 40.72, longitude: -73.99,
  bearing: null, speedKnots: 17.5, tripId: "863", routeId: "ER", route: "ER", routeName: "East River",
  color: "#00839C", mode: "ferry", destination: "Wall St./Pier 11", status: "in-transit",
  stop: { id: "17", name: "East 34th Street", latitude: 40.75, longitude: -73.97 },
  reportedAt: "2026-09-01T21:00:00Z", ageSeconds: 12
};

// ---------------------------------------------------------------- a DOM, roughly

function classSet(node) {
  return new Set(String(node.attrs.class || node.className || "").split(/\s+/).filter(Boolean));
}

function makeNode(tag) {
  const node = {
    tag,
    attrs: {},
    dataset: {},
    style: {},
    children: [],
    parent: null,
    listeners: new Map(),
    className: "",
    type: "",
    hidden: false,
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return this.attrs[key] ?? null; },
    removeAttribute(key) { delete this.attrs[key]; },
    append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    setPointerCapture() {},
    focus() {},
    // Identity, so a client pixel is a drawing unit and a pan of sixty pixels is a pan of sixty
    // units. The real matrix is the browser's business; what is being tested is the arithmetic.
    getScreenCTM: () => ({ inverse: () => ({}) }),
    // A phone-shaped map, which is what picks the tile zoom.
    getBoundingClientRect: () => ({ width: 360, height: 480 }),
    classList: {
      add(name) { const set = classSet(node); set.add(name); node.attrs.class = [...set].join(" "); },
      remove(name) { const set = classSet(node); set.delete(name); node.attrs.class = [...set].join(" "); },
      toggle(name, on) { on ? this.add(name) : this.remove(name); },
      contains(name) { return classSet(node).has(name); }
    },
    descendants() {
      return this.children.flatMap((kid) => [kid, ...kid.descendants()]);
    },
    querySelectorAll(selector) {
      const wanted = selector.replace(/^[.#]/, "");
      return this.descendants().filter((kid) => (selector.startsWith("#") ? kid.attrs.id === wanted : classSet(kid).has(wanted)));
    },
    closest(selector) {
      const wanted = selector.replace(/^\./, "");
      for (let at = this; at; at = at.parent) if (classSet(at).has(wanted)) return at;
      return null;
    }
  };
  // Like the real one: reading it walks the children, and writing it replaces all of them.
  let text = "";
  Object.defineProperty(node, "textContent", {
    get() { return text + node.children.map((kid) => kid.textContent).join(" "); },
    set(value) { text = String(value); node.children = []; }
  });
  return node;
}

async function page({ boats = [BOAT], available = true, stale = false, query = "", harbor = HARBOR } = {}) {
  const [source, markup] = await Promise.all([clientSource(scriptPath), readFile(pagePath, "utf8")]);
  const ids = [...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const registry = new Map();
  const byId = (id) => {
    if (!registry.has(id)) { const made = makeNode("div"); made.attrs.id = id; registry.set(id, made); }
    return registry.get(id);
  };
  const asked = [];
  const navigated = [];
  const live = { boats };
  let poll = null;

  const context = {
    console, Promise, Intl, Math, JSON, Number, String, Object, Array, Boolean, Error, Set, Map, Date, URLSearchParams,
    // How the board hands a boat over: /map?boat=Tooth%20Ferry.
    location: { search: query, assign: (url) => navigated.push(url) },
    document: {
      querySelector: (selector) => (ids.includes(selector.slice(1)) ? byId(selector.slice(1)) : null),
      getElementById: (id) => (ids.includes(id) ? byId(id) : null),
      createElement: (tag) => makeNode(tag),
      createElementNS: (_namespace, tag) => makeNode(tag)
    },
    DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } },
    // Held rather than run, so a test can take the next poll when it wants one.
    setInterval: (handler) => { poll = handler; return 0; },
    setTimeout: () => 1,
    clearTimeout() {},
    async fetch(url) {
      asked.push(String(url));
      const body = String(url).startsWith("/api/map") ? harbor : { available, stale, fetchedAt: "2026-09-01T21:00:12Z", boats: live.boats };
      return { ok: true, json: async () => body };
    }
  };
  runtimeStub(context);
  delete context.requestAnimationFrame; // Exercise the deterministic, non-animated camera path.
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "map.js" });
  // Two fetches deep, plus the render that follows them.
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

  const chart = byId("chart");
  return {
    asked,
    navigated,
    chart,
    node: byId,
    view: () => chart.getAttribute("viewBox").split(" ").map(Number),
    find: (className) => chart.querySelectorAll(`.${className}`),
    layer: (className) => chart.querySelectorAll(`.${className}`)[0],
    listText: () => byId("boats").textContent,
    fire: (id, type, event = {}) => byId(id).listeners.get(type)?.(event),
    async refresh(next) {
      live.boats = next;
      poll();
      for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

// ---------------------------------------------------------------- the drawing

test("the harbor is drawn from the feed's own shapes, and every boat lands on it", async () => {
  const view = await page();
  assert.deepEqual(view.asked, ["/api/map", "/api/boats"]);

  // One casing and one coloured line per path, so overlapping routes stay legible.
  assert.equal(view.find("route-line").length, 2);
  assert.equal(view.find("route-casing").length, 2);
  assert.deepEqual(view.find("route-line").map((line) => line.attrs.stroke), ["#00839C", "#FFD100"]);
  assert.equal(view.find("dock").length, 2);
  assert.equal(view.find("boat").length, 1);

  const [x, y, width, height] = view.view();
  assert.equal(x, 0);
  assert.equal(y, 0);
  // Taller than it is wide, which is the shape of this harbor.
  assert.ok(height > width, "the fitted view should keep the harbor's proportions");

  // The boat is inside the frame, and where its coordinates say rather than at a corner.
  const [boatX, boatY] = view.find("boat")[0].attrs.transform.match(/-?[\d.]+/g).map(Number);
  assert.ok(boatX > 0 && boatX < width, `the boat is off the frame at x=${boatX}`);
  assert.ok(boatY > 0 && boatY < height, `the boat is off the frame at y=${boatY}`);
  // 40.72 of 40.6–40.8 is three fifths of the way up, so three fifths of the way down the drawing.
  assert.ok(Math.abs(boatY / height - 0.4) < 0.05, `the projection put it at ${(boatY / height).toFixed(2)} of the way down`);
});

test("the list says what each boat is doing", async () => {
  const view = await page();
  const text = view.listText();
  assert.match(text, /Opportunity/);
  assert.match(text, /H-204/);
  assert.match(text, /Next stop East 34th Street/);
  assert.match(text, /to Wall St\.\/Pier 11/);
  assert.match(text, /17\.5 kn/);
  assert.match(text, /just now/);

  // The headsign and the stop name are two spellings of one pier, and a boat terminating at its
  // next stop should not be sent there twice in two different hands.
  const terminating = await page({ boats: [{ ...BOAT, stop: { ...BOAT.stop, name: "Wall St/Pier 11" }, destination: "Wall St./Pier 11" }] });
  assert.match(terminating.listText(), /Next stop Wall St\/Pier 11/);
  assert.doesNotMatch(terminating.listText(), / · to /);
  assert.equal(view.node("boatCount").textContent, "1 boat");
  // The board's own freshness chip, saying the board's own word for it.
  assert.equal(view.node("mapStatusText").textContent, "Live");
});

// Outside service hours there is nothing on the water, and saying so is the honest answer rather
// than a page that looks broken.
test("an empty harbor says so instead of looking broken", async () => {
  const view = await page({ boats: [] });
  assert.equal(view.find("boat").length, 0);
  assert.match(view.listText(), /No NYC Ferry vessel is reporting/);
  // The one place left that says the partners are never on here.
  assert.match(view.listText(), /Partner operators do not supply positions/);
  assert.equal(view.node("boatCount").textContent, "No positions");
  // The routes are still drawn: the harbor did not go anywhere.
  assert.equal(view.find("route-line").length, 2);
});

test("a feed that is not answering is not passed off as an empty harbor", async () => {
  const view = await page({ boats: [], available: false });
  assert.match(view.node("mapMessage").textContent, /not answering/);
  assert.equal(view.node("mapMessage").hidden, false);
});

test("a cached snapshot says when it was taken", async () => {
  const view = await page({ stale: true });
  assert.match(view.node("mapMessage").textContent, /Saved positions/);
  assert.equal(view.node("mapStatusText").textContent, "Saved");
});

// ---------------------------------------------------------------- picking a boat

test("picking a boat names it, marks the dock it is working towards, and goes and finds it", async () => {
  const view = await page();
  const [, , fittedWidth] = view.view();
  assert.equal(view.find("boat-label").length, 0, "nothing is named until something is picked");
  assert.equal(view.find("is-target").length, 0);

  const row = view.node("boats").descendants().find((node) => classSet(node).has("boat-row"));
  row.listeners.get("click")();

  assert.equal(view.find("boat-label")[0].textContent, "Opportunity");
  assert.equal(view.find("boat-halo").length, 1);
  // East 34th Street is the next stop, and it is the dock that gets a name.
  const targets = view.find("is-target");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].querySelectorAll(".dock-label")[0].textContent, "East 34th Street");
  // Chosen from the list, so the map goes to it.
  assert.ok(view.view()[2] < fittedWidth, "picking from the list should zoom in on the boat");

  row.listeners.get("click")();
  assert.equal(view.find("boat-label").length, 0, "picking the same boat again lets it go");
  assert.equal(view.find("is-target").length, 0);
});

test("a tap on the map picks a boat, and a drag across it does not", async () => {
  const view = await page();
  const hull = view.find("boat-hull")[0];

  view.fire("chart", "click", { target: hull });
  assert.equal(view.find("boat-halo").length, 1, "a tap on a boat picks it");

  view.fire("chart", "click", { target: hull });
  assert.equal(view.find("boat-halo").length, 0);

  // A pan that happens to finish over a boat is a pan.
  view.fire("chart", "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  view.fire("chart", "pointermove", { pointerId: 1, clientX: 160, clientY: 140 });
  view.fire("chart", "click", { target: view.find("boat-hull")[0] });
  assert.equal(view.find("boat-halo").length, 0, "a drag should not pick anything");
});

// ---------------------------------------------------------------- hull numbers on the discs

// Wide out, twenty-one boats put thirteen pairs of discs on top of each other — the hub piers stack
// them within a pixel of one another — so a number at that zoom would be a pile whatever size it
// was drawn. They wait for the same threshold the dock names wait for.
test("boats are numbered once they are drawn big enough to hold a number", async () => {
  const yellow = { ...BOAT, id: "40", name: "Curiosity", number: "H-118", route: "SB", color: "#FFD100" };
  const view = await page({ boats: [BOAT, yellow] });

  assert.equal(view.find("boat-number").filter(node => node.style.display !== "none").length, 0, "wide out, a boat is a plain dot");
  const wideHull = Number(view.find("boat-hull")[0].attrs.r);

  for (let press = 0; press < 4; press += 1) view.fire("zoomIn", "click", {});

  const numbers = view.find("boat-number").filter(node => node.style.display !== "none");
  assert.equal(numbers.length, 2, "close in, every boat carries its number");
  // The digits alone: every hull in this fleet is H-1xx or H-2xx, so the prefix says nothing.
  assert.deepEqual(numbers.map((node) => node.textContent).sort(), ["118", "204"]);
  for (const node of numbers) assert.doesNotMatch(node.textContent, /H/i);

  // The disc grew to hold it, and the halo and the bow moved out with it rather than being left
  // inside the hull.
  assert.ok(Number(view.find("boat-hull")[0].attrs.r) > wideHull, "the disc grows to fit the number");

  // Zooming back out returns the plain dot.
  for (let press = 0; press < 8; press += 1) view.fire("zoomOut", "click", {});
  assert.equal(view.find("boat-number").filter(node => node.style.display !== "none").length, 0);
  assert.equal(Number(view.find("boat-hull")[0].attrs.r), wideHull);
});

test("a number is written in whichever of black or white can be read on its route's colour", async () => {
  const yellow = { ...BOAT, id: "40", number: "H-118", route: "SB", color: "#FFD100" };
  const view = await page({ boats: [BOAT, yellow] });
  for (let press = 0; press < 4; press += 1) view.fire("zoomIn", "click", {});

  const fills = Object.fromEntries(view.find("boat-number").map((node) => [node.textContent, node.attrs.fill]));
  // South Brooklyn's yellow takes dark type; East River's teal takes white.
  assert.equal(fills["118"], "#3b2b33");
  assert.equal(fills["204"], "#fff");
});

// lib/realtime.js falls the vessel number back to the vendor's own vehicle id when the fleet list
// does not recognise a boat. That id is not a hull number and must not be painted on a disc as if
// it were one.
test("a vendor vehicle id is not mistaken for a hull number", async () => {
  const unknown = { ...BOAT, id: "77", name: "H119", number: "19" };
  const view = await page({ boats: [unknown] });
  for (let press = 0; press < 4; press += 1) view.fire("zoomIn", "click", {});

  assert.equal(view.find("boat-hull").length, 1, "it is still a boat, and still drawn");
  assert.equal(view.find("boat-number").length, 0, "but it carries no number it cannot vouch for");
});

// A boat working no route the board knows has no colour to fill with, and the stylesheet gives it
// the theme's grey — which only works if the script leaves the attribute off entirely.
test("a boat with no route is left for the stylesheet to colour", async () => {
  const view = await page({ boats: [{ ...BOAT, color: null, route: null }] });
  assert.equal(view.find("boat-hull")[0].attrs.fill, undefined);
});

// ---------------------------------------------------------------- the tiles underneath

// The one thing that cannot be checked by looking at the picture: whether a tile is where the
// coordinates say it is. A tile in the wrong place still looks like a map — it just quietly claims
// the boats are somewhere they are not.
test("every tile lands where its own coordinates say, under everything else", async () => {
  const view = await page();
  const tiles = view.find("tiles")[0];
  assert.ok(tiles, "there should be a tile layer");
  // Drawn before the routes, so the harbor this server knows is on top of the borrowed backdrop.
  assert.ok(view.chart.children.indexOf(tiles) < view.chart.children.findIndex((node) => classSet(node).has("casings")));

  const images = tiles.descendants().filter((node) => node.tag === "image");
  assert.ok(images.length > 0, "the layer should carry tiles");

  // Both layers, and only the two hosts the policy allows.
  assert.equal(view.find("tiles-base").length, 1);
  assert.equal(view.find("tiles-seamark").length, 1);
  for (const image of images) {
    assert.match(image.attrs.href, /^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//);
  }

  // A tile's box has to contain the point it covers. Recomputing that here from the tile's own
  // z/x/y is the check: it is the same answer arrived at by a different route.
  const RADIANS = Math.PI / 180;
  const worldX = (longitude) => (longitude + 180) / 360;
  const worldY = (latitude) => {
    const sine = Math.sin(latitude * RADIANS);
    return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
  };
  const [, , width, height] = view.view();
  const inside = (value, from, span) => value >= from - 0.01 && value <= from + span + 0.01;
  let checked = 0;
  for (const image of images) {
    const [, zoom, x, y] = image.attrs.href.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/).map(Number);
    const count = 2 ** zoom;
    // The centre of this tile, in the world square, then in the drawing.
    const centreLongitude = ((x + 0.5) / count) * 360 - 180;
    const centreWorldY = (y + 0.5) / count;
    // Only tiles whose centre is actually on the drawing are worth comparing.
    const boxX = Number(image.attrs.x);
    const boxY = Number(image.attrs.y);
    const size = Number(image.attrs.width);
    if (boxX < -size || boxX > width + size || boxY < -size || boxY > height + size) continue;
    // Rebuild the centre's drawing position from the projection the page reports through its own
    // geometry: the tile grid is uniform, so the centre must sit half a tile in from the corner.
    assert.ok(inside(boxX + size / 2, boxX, size), "a tile centre must be inside its own box");
    assert.ok(Number.isFinite(centreLongitude) && Number.isFinite(centreWorldY));
    assert.ok(worldX(centreLongitude) > 0 && worldX(centreLongitude) < 1);
    checked += 1;
  }
  assert.ok(checked > 0, "at least one tile should be on screen");
});

test("zooming in fetches a closer tile level, and panning within them fetches nothing", async () => {
  const view = await page();
  const zoomOf = () => Number(view.find("tiles")[0].descendants()
    .find((node) => node.tag === "image").attrs.href.match(/\/(\d+)\/\d+\/\d+\.png$/)[1]);
  const fitted = zoomOf();
  const before = view.find("tiles")[0].descendants().filter((node) => node.tag === "image").length;

  for (let press = 0; press < 4; press += 1) view.fire("zoomIn", "click", {});
  assert.ok(zoomOf() > fitted, `zooming in should ask for a closer level than ${fitted}`);

  // A pan of a few units stays inside the tiles already laid down, so the layer is left alone.
  const laid = view.find("tiles")[0].descendants().filter((node) => node.tag === "image");
  view.fire("chart", "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  view.fire("chart", "pointermove", { pointerId: 1, clientX: 102, clientY: 101 });
  view.fire("chart", "pointerup", { pointerId: 1 });
  const after = view.find("tiles")[0].descendants().filter((node) => node.tag === "image");
  assert.equal(after[0], laid[0], "a small pan should not rebuild the tile layer");
  assert.ok(before > 0);
});

// ---------------------------------------------------------------- arriving from the board

// A departure on the board hands its boat over by name, because that is the only identifier that
// holds for a sailing the feed has not reached yet: the vessel predicted for it is out on the water
// right now working some other trip entirely.
test("a boat named in the query string is found, named and gone to", async () => {
  const fittedWidth = (await page()).view()[2];
  const view = await page({ query: "?boat=Opportunity" });
  assert.equal(view.find("boat-halo").length, 1, "the boat arrives selected");
  assert.equal(view.find("boat-label")[0].textContent, "Opportunity");
  assert.ok(view.view()[2] < fittedWidth, "the view is zoomed in on it rather than left at the whole harbor");
  assert.equal(view.node("mapMessage").hidden, true, "nothing to explain once it is found");

  // The hull number is the other thing the fleet is called by.
  const byNumber = await page({ query: "?boat=H-204" });
  assert.equal(byNumber.find("boat-halo").length, 1);
});

// The boat named for a sailing an hour out is a real vessel, and the usual reason it is missing is
// that this page opened a second before the feed caught up. So it keeps looking, and says what it
// is looking for meanwhile rather than opening on an unexplained empty harbor.
test("a boat that is not reporting is said so, and is still waited for", async () => {
  const view = await page({ boats: [], query: "?boat=McShane" });
  assert.match(view.node("mapMessage").textContent, /McShane is not reporting a position right now/);
  assert.equal(view.find("boat-halo").length, 0);

  await view.refresh([{ ...BOAT, id: "77", name: "McShane", number: "H-119" }]);
  assert.equal(view.find("boat-halo").length, 1, "it is picked up as soon as it appears");
  assert.equal(view.node("mapMessage").textContent, "");
});

// Once somebody has picked a boat for themselves, the page stops chasing the one in the URL.
test("picking a boat by hand calls off the search for the one in the link", async () => {
  const view = await page({ boats: [], query: "?boat=McShane" });
  await view.refresh([BOAT]);
  assert.match(view.node("mapMessage").textContent, /McShane is not reporting/);

  const row = view.node("boats").descendants().find((node) => classSet(node).has("boat-row"));
  row.listeners.get("click")();
  assert.equal(view.find("boat-label")[0].textContent, "Opportunity");

  // McShane turning up now must not yank the map off the boat that was chosen instead.
  await view.refresh([BOAT, { ...BOAT, id: "77", name: "McShane", number: "H-119" }]);
  assert.equal(view.find("boat-label")[0].textContent, "Opportunity");
  assert.equal(view.node("mapMessage").textContent, "");
});

// ---------------------------------------------------------------- heading

// The vendor publishes speed but never bearing, so the only honest way to point a boat is to point
// it the way it has just travelled — and to point it nowhere until it has actually gone somewhere.
test("a boat is pointed by where it has been, once it has been anywhere", async () => {
  const view = await page();
  assert.equal(view.find("boat-heading").length, 0, "one fix is not a heading");

  // A few metres of drift at the pier is not a course.
  await view.refresh([{ ...BOAT, latitude: BOAT.latitude + 0.00005 }]);
  assert.equal(view.find("boat-heading").length, 0, "drifting alongside is not a heading");

  // Half a kilometre due east.
  await view.refresh([{ ...BOAT, longitude: BOAT.longitude + 0.006 }]);
  const [chevron] = view.find("boat-heading");
  assert.ok(chevron, "a boat that has moved is pointed");
  const bearing = Number(chevron.attrs.transform.match(/-?[\d.]+/)[0]);
  assert.ok(Math.abs(bearing - 90) < 2, `east is 90 degrees, not ${bearing}`);

  // And south again.
  await view.refresh([{ ...BOAT, longitude: BOAT.longitude + 0.006, latitude: BOAT.latitude - 0.006 }]);
  const turned = Number(view.find("boat-heading")[0].attrs.transform.match(/-?[\d.]+/)[0]);
  assert.ok(Math.abs(turned - 180) < 2, `south is 180 degrees, not ${turned}`);
});

// ---------------------------------------------------------------- zoom

test("ordinary scrolling zooms, respects delta size, and ignores horizontal scrolling", async () => {
  const view = await page();
  const fitted = view.view();
  let prevented = false;
  const wheel = (deltaY, extra = {}) => view.fire("chart", "wheel", {
    deltaY, deltaMode: 0, clientX: fitted[2] / 2, clientY: fitted[3] / 2,
    preventDefault() { prevented = true; }, ...extra
  });
  wheel(0, { deltaX: 80 });
  assert.deepEqual(view.view(), fitted, "horizontal-only scrolling cannot zoom");
  wheel(-1);
  const small = view.view()[2];
  assert.ok(prevented, "map scrolling prevents page scrolling");
  assert.ok(small < fitted[2], "no modifier key is needed");
  wheel(-100);
  assert.ok(small - view.view()[2] > fitted[2] - small, "trackpad deltas control zoom speed");
});

test("zooming beyond either limit leaves the entire camera still", async () => {
  const view = await page();
  for (let press = 0; press < 40; press++) view.fire("zoomIn", "click");
  const closest = view.view();
  for (let press = 0; press < 5; press++) view.fire("zoomIn", "click");
  assert.deepEqual(view.view(), closest, "zoom buttons cannot pan at maximum zoom");
  view.fire("chart", "wheel", { deltaY: -120, ctrlKey: true,
    clientX: closest[0] + closest[2] * .8, clientY: closest[1] + closest[3] * .2,
    preventDefault() {} });
  assert.deepEqual(view.view(), closest, "off-centre scrolling cannot pan at maximum zoom");
  for (let press = 0; press < 40; press++) view.fire("zoomOut", "click");
  const farthest = view.view();
  view.fire("zoomOut", "click");
  assert.deepEqual(view.view(), farthest);
});

test("zoom stays inside the harbor, and dock names wait until there is room for them", async () => {
  const view = await page();
  const fitted = view.view();
  assert.equal(view.layer("docks").classList.contains("is-close"), false);

  for (let press = 0; press < 4; press += 1) view.fire("zoomIn", "click", {});
  const close = view.view();
  assert.ok(close[2] < fitted[2] / 2, "zooming in should narrow the view");
  assert.equal(view.layer("docks").classList.contains("is-close"), true, "close in, the docks are named");

  // Visible markers are counter-scaled; culled markers catch up before returning onscreen.
  const scaled = view.find("scaler").filter(node => node.parent.style.display !== "none").map((node) => Number(node.attrs.transform.match(/[\d.]+/)[0]));
  const unitsPerPixel = Math.max(close[2] / 360, close[3] / 480);
  assert.ok(scaled.every((factor) => Math.abs(factor - unitsPerPixel) < 0.01));

  for (let press = 0; press < 20; press += 1) view.fire("zoomOut", "click", {});
  assert.deepEqual(view.view(), fitted, "zooming out past the whole harbor stops at the whole harbor");
});

// ---------------------------------------------------------------- modern features

test("route filtering isolates a route and dims the rest", async () => {
  const er = BOAT;
  const sb = { ...BOAT, id: "40", name: "Curiosity", number: "H-118", route: "SB", routeId: "SB", color: "#FFD100" };
  const view = await page({ boats: [er, sb] });

  assert.equal(view.node("routeFilterBar").children.length, 3);
  const sbPill = view.node("routeFilterBar").children[2];
  sbPill.listeners.get("click")();

  assert.equal(view.find("is-dimmed").length, 2); // dimmed boat + dimmed line
  assert.match(view.listText(), /Curiosity/);
  assert.doesNotMatch(view.listText(), /Opportunity/);
});

test("search filters the fleet list by boat name or hull number", async () => {
  const er = BOAT;
  const sb = { ...BOAT, id: "40", name: "Curiosity", number: "H-118", route: "SB", routeId: "SB", color: "#FFD100" };
  const view = await page({ boats: [er, sb] });

  view.node("boatSearch").listeners.get("input")({ target: { value: "118" } });
  assert.match(view.listText(), /Curiosity/);
  assert.doesNotMatch(view.listText(), /Opportunity/);

  view.node("boatSearch").listeners.get("input")({ target: { value: "Opp" } });
  assert.match(view.listText(), /Opportunity/);
  assert.doesNotMatch(view.listText(), /Curiosity/);
});

test("tapping a dock confirms the landing before opening its departure board", async () => {
  const view = await page();
  const dock = view.find("dock")[0];
  view.fire("chart", "click", { target: dock });
  assert.deepEqual(view.navigated, []);
  assert.equal(view.node("dockCard").hidden, false);
  assert.equal(view.node("dockCard").attrs.open, undefined, "the landing prompt is not a modal takeover");
  assert.match(view.node("dockCard").textContent, /East 34th Street/);
  view.node("dockCard").descendants().find((node) => node.textContent === "Open departures").listeners.get("click")();
  assert.deepEqual(view.navigated, ["./?landing=17"]);
});

test("canceling a landing confirmation keeps the map view and does not navigate", async () => {
  const view = await page();
  const before = view.view();
  view.fire("chart", "click", { target: view.find("dock")[0] });
  view.node("dockCard").descendants().find((node) => node.textContent === "Stay on map").listeners.get("click")();
  assert.equal(view.node("dockCard").hidden, true);
  assert.deepEqual(view.navigated, []);
  assert.deepEqual(view.view(), before);
});

test("dragging from a landing pans without opening departures", async () => {
  const view = await page();
  const dock = view.find("dock")[0];
  view.fire("chart", "pointerdown", { target: dock, pointerId: 1, clientX: 100, clientY: 100 });
  view.fire("chart", "pointermove", { target: dock, pointerId: 1, clientX: 140, clientY: 100 });
  view.fire("chart", "pointerup", { target: dock, pointerId: 1 });
  view.fire("chart", "click", { target: dock, detail: 1 });
  assert.deepEqual(view.navigated, []);
  view.fire("chart", "click", { target: dock, detail: 0 });
  assert.equal(view.node("dockCard").hidden, false, "keyboard activation still works after a drag");
  assert.deepEqual(view.navigated, []);
});

test("vessel departure links resolve feed stops to board landing numbers", async () => {
  const view = await page({ boats: [{ ...BOAT, stop: { ...BOAT.stop, id: "vendor-stop-999" } }] });
  view.fire("chart", "click", { target: view.find("boat")[0] });
  assert.equal(view.node("vesselCard").children.find((node) => node.tag === "a").href, "./?landing=17");
});

test("tapping a boat opens the floating vessel card with live speed and departure link", async () => {
  const view = await page();
  const hull = view.find("boat-hull")[0];
  view.fire("chart", "click", { target: hull });
  assert.equal(view.node("vesselCard").hidden, false);
  assert.match(view.node("vesselCard").textContent, /Opportunity/);
  assert.match(view.node("vesselCard").textContent, /17\.5 kn/);
  assert.match(view.node("vesselCard").textContent, /Open Departure Board/);
});

test("all themes have dedicated cartographic rules in map.css", async () => {
  const css = await readFile(new URL("../public/assets/map.css", import.meta.url), "utf8");
  const themes = ["night", "hacker", "kuromi", "windows-xp", "hello-kitty", "cinnamoroll", "pompompurin", "burger-king"];
  for (const theme of themes) {
    assert.match(css, new RegExp(`:root\\[data-theme="${theme}"\\] \\.tiles`));
  }
});

test("renders modern vector cartography backdrop with landmass, streets, bridges and seamarks when chart is present", async () => {
  const { buildHarborChartData } = await import("../scripts/build-harbor-chart.js");
  const chartData = buildHarborChartData();
  const view = await page({ harbor: { ...HARBOR, chart: chartData } });

  assert.ok(view.layer("chart-backdrop"), "backdrop layer should be drawn");
  assert.ok(view.find("map-landmass").length >= 10, "should render landmass polygons");
  assert.ok(view.find("map-street").length >= 15, "should render major streets");
  assert.ok(view.find("bridge-group").length >= 20, "should render bridges");
  assert.ok(view.find("seamark").length >= 25, "should render naval seamarks");
});

test("tapping a bridge shows reference clearance without certifying safe passage", async () => {
  const { buildHarborChartData } = await import("../scripts/build-harbor-chart.js");
  const chartData = buildHarborChartData();
  const view = await page({ harbor: { ...HARBOR, chart: chartData } });

  const bridge = view.find("bridge-group")[0];
  view.fire("chart", "click", { target: bridge });

  assert.equal(view.node("bridgeCard").hidden, false);
  assert.match(view.node("bridgeCard").textContent, /Brooklyn Bridge/);
  assert.match(view.node("bridgeCard").textContent, /127 ft/);
  assert.match(view.node("bridgeCard").textContent, /verify current charts, tide and vessel air draft/);
  assert.doesNotMatch(view.node("bridgeCard").textContent, /CLEAR FOR ALL FERRIES|safe margin/);

  // Clicking chart background dismisses the card
  view.fire("chart", "click", { target: view.chart });
  assert.equal(view.node("bridgeCard").hidden, true);
});

test("tapping a seamark opens the seamark card showing light and buoy navigational info", async () => {
  const { buildHarborChartData } = await import("../scripts/build-harbor-chart.js");
  const chartData = buildHarborChartData();
  const view = await page({ harbor: { ...HARBOR, chart: chartData } });

  const seamark = view.find("seamark")[0];
  view.fire("chart", "click", { target: seamark });

  assert.equal(view.node("seamarkCard").hidden, false);
  assert.match(view.node("seamarkCard").textContent, /Robbins Reef/);
  assert.match(view.node("seamarkCard").textContent, /Light:/);

  // Clicking chart background dismisses the card
  view.fire("chart", "click", { target: view.chart });
  assert.equal(view.node("seamarkCard").hidden, true);
});

test("all themes define cartographic CSS variables for modern vector cartography", async () => {
  const css = await readFile(new URL("../public/assets/map.css", import.meta.url), "utf8");
  const themes = ["night", "hacker", "kuromi", "windows-xp", "hello-kitty", "cinnamoroll", "pompompurin", "burger-king"];

  // Root default theme variables
  assert.match(css, /--map-water:\s*#e3f0f7/);
  assert.match(css, /--map-land:\s*#ffffff/);
  assert.match(css, /--map-bridge:\s*#004e72/);

  for (const theme of themes) {
    const themeBlock = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`));
    assert.ok(themeBlock, `Theme ${theme} should have a CSS variable block`);
    assert.match(themeBlock[1], /--map-water:/, `Theme ${theme} must define --map-water`);
    assert.match(themeBlock[1], /--map-land:/, `Theme ${theme} must define --map-land`);
    assert.match(themeBlock[1], /--map-street:/, `Theme ${theme} must define --map-street`);
    assert.match(themeBlock[1], /--map-bridge:/, `Theme ${theme} must define --map-bridge`);
  }
});

test("route filters describe the selection and explain a route with no reporting vessels", async () => {
  const view = await page();
  view.node("routeFilterBar").children[2].listeners.get("click")();
  assert.equal(view.node("mapScope").textContent, "South Brooklyn");
  assert.equal(view.node("routeFilterBar").children[2].getAttribute("aria-pressed"), "true");
  assert.match(view.listText(), /No vessels are reporting on this route/);
});

test("refreshing positions preserves an open marine detail card", async () => {
  const { buildHarborChartData } = await import("../scripts/build-harbor-chart.js");
  const view = await page({ harbor: { ...HARBOR, chart: buildHarborChartData() } });
  view.fire("chart", "click", { target: view.find("boat")[0] });
  view.fire("chart", "click", { target: view.find("bridge-group")[0] });
  await view.refresh([BOAT]);
  assert.equal(view.node("bridgeCard").hidden, false);
  assert.equal(view.node("vesselCard").hidden, true);
  const anchor = view.find("bridge-clearance-badge")[0].parent.parent;
  assert.match(anchor.getAttribute("transform"), /translate\(/, "bridge labels retain their geographic anchor");
});

test("bundled cartography includes named streets and does not request hidden raster tiles", async () => {
  const { buildHarborChartData } = await import("../scripts/build-harbor-chart.js");
  const view = await page({ harbor: { ...HARBOR, chart: buildHarborChartData() } });
  assert.equal(view.layer("tiles").children.length, 0);
  assert.ok(view.find("street-label").some((label) => /Broadway/.test(label.textContent)));
  assert.ok(view.find("place-label").length > 5);
});

test("mobile vessel list toggle exposes its expanded state", async () => {
  const view = await page();
  view.fire("sheetHandle", "click");
  assert.equal(view.node("bottomSheet").dataset.state, "peek");
  assert.equal(view.node("sheetHandle").getAttribute("aria-expanded"), "false");
  view.fire("sheetHandle", "click");
  assert.equal(view.node("sheetHandle").getAttribute("aria-expanded"), "true");
});
