import { worldX, worldY } from "./map-projection.js";
import { createViewLifecycle } from "./view-lifecycle.js";

export function mountMap(root, { header = document.querySelector("#mapHeading"), navigate = url => location.assign(url), getGeometry = () => MobileRuntime.request("/api/map"), boardURL = "./", onRide = () => {} } = {}) {
const query = selector => root.querySelector(selector) || header?.querySelector(selector);
const lifecycle = createViewLifecycle();
const { poll } = lifecycle;
const { storage, request, reconcile, reveal } = MobileRuntime;
// The map page.
//
// Reads /api/map once for the harbor and /api/boats every fifteen seconds for what is on it, and
// draws both: an SVG of the route shapes, docks and fleet over bundled shorelines and roads.
//
// Fallback tiles are the only thing on this page that comes from anywhere but this server, and the only
// reason its Content-Security-Policy names a host other than 'self' — for images, and nothing else.
// Everything drawn over them is this server's own data, which is what makes the page degrade
// rather than break: with no signal the backdrop is missing and the harbor is still there.
//
// A themed vector overview, with street tiles as a fallback. Positions are reported fixes;
// the map never invents vessel movement between updates.
//
// Everything is written through textContent and createElementNS rather than innerHTML, strictly
// keeping the zero-innerHTML XSS contract.

const REFRESH_MS = 15_000;
const SVG = "http://www.w3.org/2000/svg";
const RADIANS = Math.PI / 180;
const METRES_PER_DEGREE = 111_320;
const DRAWING_WIDTH = 340;
const FIT_PADDING = 0.04;
const MAX_ZOOM = 16;
const LABEL_ZOOM = 2.2;
const STALE_FIX_SECONDS = 180;

const number = new Intl.NumberFormat("en-US");
const timeLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

const chart = query("#chart");
const mapMessage = query("#mapMessage");
const statusText = query("#mapStatusText");
const boatSearchInput = query("#boatSearch");
const routeFilterBar = query("#routeFilterBar");
const routeMenu = query("#mapRouteMenu");
const routeMenuButton = query("#mapMenuButton");
const routeClose = query("#mapRouteClose");
const routeScrim = query("#mapRouteScrim");
const routeMessage = query("#mapRouteMessage");
function setRouteMenuOpen(open, restoreFocus = true) {
  if (!routeMenu) return;
  MobileRuntime.panel(routeMenu, open, true, restoreFocus);
  routeMenuButton?.setAttribute("aria-expanded", String(open));
  if (open) (routeFilterBar.querySelector('[aria-pressed="true"]') || routeClose)?.focus();
  else if (restoreFocus) routeMenuButton?.focus({ preventScroll: true });
}
const openRouteMenu = () => setRouteMenuOpen(true);
const closeRouteMenu = () => setRouteMenuOpen(false);
const routeMenuKeys = event => {
  if (event.key === "Escape" && routeMenu && !routeMenu.hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeRouteMenu();
  }
};
routeMenuButton?.addEventListener("click", openRouteMenu);
routeClose?.addEventListener("click", closeRouteMenu);
routeScrim?.addEventListener("click", closeRouteMenu);
routeMenu?.addEventListener("keydown", routeMenuKeys);
const vesselCard = query("#vesselCard");
const dockCard = query("#dockCard");
const bridgeCard = query("#bridgeCard");
const seamarkCard = query("#seamarkCard");
const bottomSheet = query("#bottomSheet");
const sheetHandle = query("#sheetHandle");

const hasRaf = typeof requestAnimationFrame === "function";

let harbor = null;
let geometryFresh = false;
let boats = [];
let selectedId = null;
let rideFeedFresh = false;
let activeRouteFilter = null;
let searchQuery = "";
let projection = null;
let base = null;
let view = null;
let dockLayer = null;
let fleetLayer = null;
let tileLayer = null;
let chartBackdrop = null;
let tilesDrawnFor = "";
let fleetIsClose = false;
let detailKind = null;

// Geometry-owned caches are rebuilt with the SVG; fleet caches belong to retained nodes.
let features = [];
let streetLabels = [];
let dockLabels = [];
let fleetScalers = [];
let fleetDetails = [];
let viewport = { width: 360, height: 480 };
let renderedView = null;
let layerClose = null;
let fleetScale = null;
let forceStreetLayout = true;
let lastStreetLayout = -Infinity;
let wheelTimer = null;
const LABEL_INTERVAL = 100;
const CULL_MARGIN = 96;

function cacheFeature(nodes, points, scaler = null) {
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const [x, y] of points) {
    bounds.left = Math.min(bounds.left, x);
    bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.bottom = Math.max(bounds.bottom, y);
  }
  const feature = { nodes, bounds, scaler, visible: true, scale: null, padding: 0 };
  features.push(feature);
  return feature;
}

function cachePath(nodes, points) {
  return cacheFeature(nodes, points.map(point => projection.point(...point)));
}

function visibleArea(units, margin = 0) {
  const width = viewport.width * units;
  const height = viewport.height * units;
  return { left: view.x + (view.width - width) / 2 - margin * units,
    top: view.y + (view.height - height) / 2 - margin * units,
    right: view.x + (view.width + width) / 2 + margin * units,
    bottom: view.y + (view.height + height) / 2 + margin * units };
}

function updateFeatures(units, scale) {
  const area = visibleArea(units, CULL_MARGIN);
  for (const feature of features) {
    const b = feature.bounds;
    const pad = feature.padding * units;
    const visible = b.right + pad >= area.left && b.left - pad <= area.right &&
      b.bottom + pad >= area.top && b.top - pad <= area.bottom;
    // A label returning after an offscreen zoom gets its current scale before it is shown.
    if (visible && feature.scaler && feature.scale !== scale) {
      feature.scaler.setAttribute("transform", `scale(${scale})`);
      feature.scale = scale;
    }
    if (visible !== feature.visible) {
      for (const node of feature.nodes) node.style.display = visible ? "" : "none";
      feature.visible = visible;
    }
  }
}

function labelVisibility(entry, show, interactive = false) {
  if (entry.shown === show) return;
  entry.label.style.opacity = show ? "1" : "0";
  if (interactive) entry.label.style.pointerEvents = show ? "auto" : "none";
  entry.shown = show;
}

const previousFix = new Map();
const heading = new Map();
let wanted = new URLSearchParams(location.search).get("boat") || null;

// Camera animation state
let cameraAnimation = null;
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

// ---------------------------------------------------------------- the drawing

function makeProjection(bounds) {
  const left = worldX(bounds.minLongitude);
  const top = worldY(bounds.maxLatitude);
  const scale = DRAWING_WIDTH / (worldX(bounds.maxLongitude) - left);
  const padding = DRAWING_WIDTH * FIT_PADDING;
  return {
    scale,
    padding,
    left,
    top,
    width: DRAWING_WIDTH + padding * 2,
    height: (worldY(bounds.minLatitude) - top) * scale + padding * 2,
    point(latitude, longitude) {
      return [
        (worldX(longitude) - left) * scale + padding,
        (worldY(latitude) - top) * scale + padding
      ];
    },
    tile(x, y, span) {
      return [(x * span - left) * scale + padding, (y * span - top) * scale + padding, span * scale];
    }
  };
}

function pathData(points) {
  return points
    .map((point, index) => {
      const [x, y] = projection.point(point[0], point[1]);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// ---------------------------------------------------------------- the chart underneath

const TILE_LAYERS = [
  { name: "base", url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  { name: "seamark", url: (z, x, y) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png` }
];
const TILE_PIXELS = 256;
const MIN_TILE_ZOOM = 9;
const MAX_TILE_ZOOM = 16;
const MAX_TILES = 40;

function tileZoomFor() {
  const box = viewport;
  if (!box.width || !view) return MIN_TILE_ZOOM;
  const unitsPerPixel = Math.max(view.width / box.width, view.height / box.height);
  const worldPerPixel = unitsPerPixel / projection.scale;
  const zoom = Math.log2(1 / (worldPerPixel * TILE_PIXELS));
  return Math.max(MIN_TILE_ZOOM, Math.min(MAX_TILE_ZOOM, Math.round(zoom)));
}

function drawTiles() {
  if (!tileLayer || !view || !projection) return;
  if (harbor?.chart) return;
  const toWorldX = (x) => (x - projection.padding) / projection.scale + projection.left;
  const toWorldY = (y) => (y - projection.padding) / projection.scale + projection.top;
  const west = toWorldX(view.x);
  const east = toWorldX(view.x + view.width);
  const north = toWorldY(view.y);
  const south = toWorldY(view.y + view.height);

  let zoom = tileZoomFor();
  let count, span, fromX, toX, fromY, toY;
  for (;;) {
    count = 2 ** zoom;
    span = 1 / count;
    const first = (value) => Math.max(0, Math.floor(value * count) - 1);
    const last = (value) => Math.min(count - 1, Math.floor(value * count) + 1);
    [fromX, toX, fromY, toY] = [first(west), last(east), first(north), last(south)];
    if (zoom <= MIN_TILE_ZOOM) break;
    if ((toX - fromX + 1) * (toY - fromY + 1) <= MAX_TILES) break;
    zoom -= 1;
  }

  const signature = `${zoom}|${fromX}|${toX}|${fromY}|${toY}`;
  if (signature === tilesDrawnFor) return;
  tilesDrawnFor = signature;

  tileLayer.textContent = "";
  for (const layer of TILE_LAYERS) {
    const group = svgNode("g", { class: `tiles-${layer.name}` });
    for (let x = fromX; x <= toX; x += 1) {
      for (let y = fromY; y <= toY; y += 1) {
        const [left, top, size] = projection.tile(x, y, span);
        group.append(svgNode("image", {
          href: layer.url(zoom, x, y),
          x: left.toFixed(2),
          y: top.toFixed(2),
          width: (size + 0.5).toFixed(2),
          height: (size + 0.5).toFixed(2)
        }));
      }
    }
    tileLayer.append(group);
  }
}

function marker(className, latitude, longitude) {
  const [x, y] = projection.point(latitude, longitude);
  const outer = svgNode("g", { class: className, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})` });
  const inner = svgNode("g", { class: "scaler" });
  outer.append(inner);
  const feature = className === "boat" ? null : cacheFeature([outer], [[x, y]], inner);
  return { outer, inner, feature, x, y };
}

function drawChartBackdrop(chartData) {
  if (!chartData || !projection) return null;
  const backdrop = svgNode("g", { class: "chart-backdrop" });

  // 1. Water body
  const waterGroup = svgNode("g", { class: "chart-water" });
  const pad = projection.padding * 15;
  const waterRect = svgNode("rect", {
    class: "map-water",
    x: (-pad).toFixed(1),
    y: (-pad).toFixed(1),
    width: (projection.width + pad * 2).toFixed(1),
    height: (projection.height + pad * 2).toFixed(1)
  });
  waterGroup.append(waterRect);
  backdrop.append(waterGroup);

  // 2. Landmass polygons
  if (chartData.landmass) {
    const landGroup = svgNode("g", { class: "chart-land" });
    for (const land of chartData.landmass) {
      if (!land.points || land.points.length < 3) continue;
      const d = [land.points, ...(land.holes || [])].map((ring) => pathData(ring) + " Z").join(" ");
      const path = svgNode("path", {
        class: `map-landmass land-${land.id}`,
        d,
        "fill-rule": "evenodd",
        "vector-effect": "non-scaling-stroke"
      });
      path.dataset.landId = land.id;
      cachePath([path], land.points);
      landGroup.append(path);
    }
    backdrop.append(landGroup);
  }

  const parks = svgNode("g", { class: "chart-parks" });
  for (const park of chartData.parks || []) {
    const outline = svgNode("path", { class: "map-park", d: pathData(park.points) + " Z", "vector-effect": "non-scaling-stroke" });
    const title = svgNode("title");
    title.textContent = park.name;
    outline.append(title);
    cachePath([outline], park.points);
    parks.append(outline);
  }
  backdrop.append(parks);

  // 3. Navigation Channels / Fairways
  if (chartData.channels) {
    const channelGroup = svgNode("g", { class: "chart-channels" });
    for (const channel of chartData.channels) {
      if (!channel.points || channel.points.length < 2) continue;
      const d = pathData(channel.points);
      const path = svgNode("path", {
        class: "map-channel",
        d,
        "vector-effect": "non-scaling-stroke"
      });
      cachePath([path], channel.points);
      channelGroup.append(path);
    }
    backdrop.append(channelGroup);
  }

  // 4. Major Streets (arterials and expressways only, no side streets)
  if (chartData.streets) {
    const streetGroup = svgNode("g", { class: "chart-streets" });
    const streetLabelLayer = svgNode("g", { class: "chart-street-labels" });
    for (const street of chartData.streets) {
      if (!street.points || street.points.length < 2) continue;
      const d = pathData(street.points);
      const casing = svgNode("path", {
        class: `map-street-casing street-${street.type}`,
        d,
        "vector-effect": "non-scaling-stroke"
      });
      const line = svgNode("path", {
        class: `map-street street-${street.type}${street.priority ? " is-priority" : ""}`,
        d,
        "vector-effect": "non-scaling-stroke"
      });
      cachePath([casing, line], street.points);
      streetGroup.append(casing, line);
      const middle = Math.floor((street.points.length - 1) / 2);
      const [x1, y1] = projection.point(...street.points[middle]);
      const [x2, y2] = projection.point(...street.points[middle + 1]);
      const { outer, inner, feature } = marker("street-label-anchor", ...street.points[middle]);
      let angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const label = svgNode("text", { class: `street-label${street.priority ? " is-priority" : ""}`, transform: `rotate(${street.priority ? 0 : angle.toFixed(1)})`, y: -4, "text-anchor": "middle" });
      label.textContent = street.labelName || street.name;
      outer.dataset.latitude = street.points[middle][0];
      outer.dataset.longitude = street.points[middle][1];
      outer.dataset.highway = String(street.type === "highway");
      outer.dataset.priority = String(Boolean(street.priority));
      inner.append(label);
      streetLabelLayer.append(outer);
      const width = label.textContent.length * 5.5 + 8;
      feature.padding = width;
      streetLabels.push({ label, feature, x: x1, y: y1, width, name: label.textContent,
        priority: Boolean(street.priority), highway: street.type === "highway" });
    }
    backdrop.append(streetGroup, streetLabelLayer);
  }

  // 5. Bridges across waterways (with clearances)
  if (chartData.bridges) {
    const bridgeGroup = svgNode("g", { class: "chart-bridges" });
    for (const bridge of chartData.bridges) {
      if (!bridge.points || bridge.points.length < 2) continue;
      const [p1, p2] = bridge.points;
      const [x1, y1] = projection.point(p1[0], p1[1]);
      const [x2, y2] = projection.point(p2[0], p2[1]);
      const mx = ((x1 + x2) / 2).toFixed(1);
      const my = ((y1 + y2) / 2).toFixed(1);

      const group = svgNode("g", { class: "bridge-group" });
      group.dataset.bridgeId = bridge.id;
      group.dataset.clearanceFeet = bridge.clearanceFeet;
      group.dataset.name = bridge.name;
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", bridge.name);

      const casing = svgNode("line", {
        class: "bridge-casing",
        x1: x1.toFixed(1),
        y1: y1.toFixed(1),
        x2: x2.toFixed(1),
        y2: y2.toFixed(1),
        "vector-effect": "non-scaling-stroke"
      });
      const deck = svgNode("line", {
        class: "bridge-deck",
        x1: x1.toFixed(1),
        y1: y1.toFixed(1),
        x2: x2.toFixed(1),
        y2: y2.toFixed(1),
        "vector-effect": "non-scaling-stroke"
      });
      const anchor = svgNode("g", { transform: `translate(${mx},${my})` });
      const inner = svgNode("g", { class: "scaler" });
      const badge = svgNode("text", { class: "bridge-clearance-badge", x: 0, y: -3 });
      badge.textContent = bridge.name;
      inner.append(badge);
      anchor.append(inner);
      const hit = svgNode("line", { class: "bridge-hit", x1, y1, x2, y2, "vector-effect": "non-scaling-stroke" });
      group.append(hit, casing, deck, anchor);
      cacheFeature([group], [[x1, y1], [x2, y2]], inner).padding = bridge.name.length * 6;
      bridgeGroup.append(group);
    }
    backdrop.append(bridgeGroup);
  }

  // 6. Naval Markings (Seamarks: Lights & Buoys)
  if (chartData.seamarks) {
    const seamarkGroup = svgNode("g", { class: "chart-seamarks" });
    for (const seamark of chartData.seamarks) {
      const { outer, inner, feature } = marker(
        `seamark seamark-${seamark.type} seamark-${seamark.color}`,
        seamark.latitude,
        seamark.longitude
      );
      outer.dataset.seamarkId = seamark.id;
      outer.dataset.name = seamark.name;
      outer.setAttribute("tabindex", "0");
      outer.setAttribute("role", "button");
      outer.setAttribute("aria-label", seamark.name);
      inner.append(svgNode("circle", { class: "marker-hit", r: 10 }));

      if (seamark.type === "light") {
        const halo = svgNode("circle", { class: "seamark-halo", r: 6 });
        const core = svgNode("circle", { class: "seamark-light-core", r: 2.6 });
        const label = svgNode("text", { class: "seamark-label", x: 6, y: 0.5 });
        label.textContent = seamark.name.split(" ")[0];
        inner.append(halo, core, label);
      } else {
        const buoy = svgNode("polygon", {
          class: `seamark-buoy-icon seamark-buoy-${seamark.color}`,
          points: seamark.shape === "nun" ? "-2,2.5 0,-2.8 2,2.5" : "-2.2,2 2.2,2 2.2,-2 -2.2,-2"
        });
        const label = svgNode("text", { class: "seamark-label", x: 5, y: 0.5 });
        label.textContent = seamark.name.replace(/^.*\bBuoy\s+/, "");
        inner.append(buoy, label);
      }
      feature.padding = outer.textContent.length * 6 + 10;
      seamarkGroup.append(outer);
    }
    backdrop.append(seamarkGroup);
  }

  const places = [
    ["MANHATTAN", 40.770, -73.977, "borough"],
    ["BROOKLYN", 40.674, -73.970, "borough"],
    ["QUEENS", 40.756, -73.906, "borough"],
    ["THE BRONX", 40.825, -73.873, "borough"],
    ["STATEN ISLAND", 40.607, -74.109, "borough"],
    ["NEW JERSEY", 40.739, -74.060, "borough"],
    ["ROCKAWAY", 40.581, -73.814, "borough"],
    ["Upper Bay", 40.655, -74.032, "water"],
    ["Lower Bay", 40.555, -74.038, "water"],
    ["Hudson River", 40.761, -74.015, "water"],
    ["Central Park", 40.782, -73.965, "park"],
    ["East River", 40.779, -73.932, "water"],
    ["Governors Island", 40.689, -74.017, "island"]
  ];
  const labels = svgNode("g", { class: "place-labels" });
  for (const [name, lat, lon, kind] of places) {
    const { outer, inner, feature } = marker(`place-label place-${kind}`, lat, lon);
    feature.padding = name.length * 6;
    const label = svgNode("text", { "text-anchor": "middle" });
    label.textContent = name;
    inner.append(label);
    labels.append(outer);
  }
  backdrop.append(labels);
  return backdrop;
}

function drawHarbor() {
  cancelCameraAnimation();
  features = [];
  streetLabels = [];
  dockLabels = [];
  fleetScalers = [];
  fleetDetails = [];
  fleetScale = null;
  layerClose = null;
  forceStreetLayout = true;
  chart.textContent = "";
  projection = makeProjection(harbor.bounds);
  base = { x: 0, y: 0, width: projection.width, height: projection.height };
  view = { ...base };

  const title = svgNode("title", { id: "chartTitle" });
  title.textContent = "NYC Ferry landings and vessel positions, with harbor landmarks and marine reference details.";
  chart.append(title);

  tileLayer = svgNode("g", { class: "tiles" });
  tilesDrawnFor = "";
  chart.append(tileLayer);

  if (harbor.chart) {
    chartBackdrop = drawChartBackdrop(harbor.chart);
    if (chartBackdrop) chart.append(chartBackdrop);
  } else {
    chartBackdrop = null;
  }

  const casings = svgNode("g", { class: "casings" });
  const lines = svgNode("g", { class: "lines" });
  for (const route of harbor.routes) {
    for (const points of route.paths) {
      const d = pathData(points);
      const casing = svgNode("path", { class: "route-casing", d, "vector-effect": "non-scaling-stroke" });
      casings.append(casing);
      const line = svgNode("path", { class: "route-line", d, stroke: route.color, "vector-effect": "non-scaling-stroke" });
      line.dataset.route = route.id;
      cachePath([casing, line], points);
      lines.append(line);
    }
  }
  chart.append(casings, lines);

  dockLayer = svgNode("g", { class: "docks" });
  fleetLayer = svgNode("g", { class: "fleet" });
  for (const landing of harbor.landings) {
    const { outer, inner, feature, x, y } = marker("dock", landing.latitude, landing.longitude);
    outer.dataset.dockId = landing.id;
    outer.dataset.latitude = landing.latitude;
    outer.dataset.longitude = landing.longitude;
    outer.setAttribute("tabindex", "0");
    outer.setAttribute("role", "button");
    outer.setAttribute("aria-label", `Departures at ${landing.displayName || landing.name}`);
    inner.append(svgNode("circle", { class: "marker-hit", r: 10 }), svgNode("circle", { class: "dock-mark", r: 4 }));
    const label = svgNode("text", { class: "dock-label", x: 7, y: 3.5 });
    label.textContent = landing.displayName || landing.name;
    inner.append(label);
    feature.padding = label.textContent.length * 5.8 + 19;
    dockLabels.push({ node: outer, label, feature, x, y, target: false,
      latitude: landing.latitude, longitude: landing.longitude,
      width: label.textContent.length * 5.8 + 12,
      major: /Wall|34th|Rockaway|St. George|Bay Ridge|Astoria|90th/i.test(label.textContent) });
    dockLayer.append(outer);
  }
  chart.append(dockLayer, fleetLayer);

  renderRouteFilters();
  updateRouteLineStyles();
  drawFleet();
}

// ---------------------------------------------------------------- filters & legend

function renderRouteFilters() {
  if (!routeFilterBar || !harbor?.routes) return;
  if (routeMessage) routeMessage.hidden = true;
  routeFilterBar.textContent = "";

  const allPill = element("button", `route-filter-pill${!activeRouteFilter ? " is-active" : ""}`, "All routes");
  allPill.type = "button";
  allPill.setAttribute("aria-pressed", String(!activeRouteFilter));
  allPill.addEventListener("click", () => setRouteFilter(null));
  routeFilterBar.append(allPill);

  for (const route of harbor.routes) {
    const pill = element("button", `route-filter-pill${activeRouteFilter === route.id ? " is-active" : ""}`);
    pill.type = "button";
    pill.setAttribute("aria-pressed", String(activeRouteFilter === route.id));
    pill.title = route.name;
    const dot = element("span", "pill-dot");
    dot.style.background = route.color;
    pill.append(dot, element("span", "pill-code", route.shortName), element("span", "pill-name", route.name));
    pill.addEventListener("click", () => setRouteFilter(activeRouteFilter === route.id ? null : route.id));
    routeFilterBar.append(pill);
  }
}

function setRouteFilter(routeId) {
  activeRouteFilter = routeId;
  const rideAction = query("#routeRide");
  if (rideAction) rideAction.hidden = !routeId;
  const route = harbor.routes.find((item) => item.id === routeId);
  query("#mapScope").textContent = route?.name || "The whole harbor";
  query("#mapScopeDetail").textContent = route ? `${route.shortName} · Selected vessels highlighted` : "Landings & vessel positions";
  renderRouteFilters();
  updateRouteLineStyles();
  drawFleet();
  renderList();
  setRouteMenuOpen(false);
}

function updateRouteLineStyles() {
  for (const line of chart.querySelectorAll(".route-line")) {
    const match = !activeRouteFilter || line.dataset.route === activeRouteFilter;
    line.classList.toggle("is-dimmed", !match);
  }
}

function hullDigits(number) {
  return /^H-?\d+$/i.test(String(number || "")) ? String(number).replace(/^H-?/i, "") : null;
}

// ---------------------------------------------------------------- the fleet

function drawFleet() {
  if (!fleetLayer) return;
  const markers = [];
  const hull = fleetIsClose ? 10.5 : 6;
  const halo = fleetIsClose ? 16 : 11;
  const bow = fleetIsClose ? "M0,-17 L4.4,-9.8 L-4.4,-9.8 Z" : "M0,-12 L3.6,-5.6 L-3.6,-5.6 Z";

  for (const boat of boats) {
    const matchesFilter = !activeRouteFilter || boat.routeId === activeRouteFilter;
    const { outer, inner } = marker("boat", boat.latitude, boat.longitude);
    outer.dataset.boat = boat.id;
    outer.setAttribute("data-key", String(boat.id));
    outer.setAttribute("tabindex", "0");
    outer.setAttribute("role", "button");
    outer.setAttribute("aria-label", `${boat.name || boat.number || "Vessel"}: ${statusLine(boat)}`);
    inner.append(svgNode("circle", { class: "marker-hit", r: 12 }));
    if ((boat.ageSeconds ?? 0) > STALE_FIX_SECONDS) outer.classList.add("is-stale");
    if (!matchesFilter) outer.classList.add("is-dimmed");

    if (boat.status !== "stopped") {
      inner.append(svgNode("circle", { class: "boat-wake", r: hull, fill: boat.color || "#8fd3f4" }));
    }
    if (boat.id === selectedId) inner.append(svgNode("circle", { class: "boat-halo", r: halo }));
    const disc = svgNode("circle", { class: "boat-hull", r: hull });
    if (boat.color) disc.setAttribute("fill", boat.color);
    inner.append(disc);

    const bearing = boat.bearing ?? heading.get(boat.id);
    if (bearing != null) {
      inner.append(svgNode("path", { class: "boat-heading", d: bow, transform: `rotate(${bearing})` }));
    }
    const digits = hullDigits(boat.number);
    if (digits) {
      const number = svgNode("text", { class: "boat-number", "text-anchor": "middle", y: 3.2 });
      if (boat.color) number.setAttribute("fill", readableOn(boat.color));
      number.textContent = digits;
      number.style.display = fleetIsClose ? "" : "none";
      inner.append(number);
    }
    if (boat.id === selectedId) {
      const label = svgNode("text", { class: "boat-label", x: halo + 2, y: 4 });
      label.textContent = boat.name || boat.number || "Boat";
      inner.append(label);
    }
    markers.push(outer);
  }
  reconcile(fleetLayer, markers);
  // Reconciliation retains old nodes; references to the proposed markers are now stale.
  fleetScalers = [...fleetLayer.querySelectorAll(".scaler")];
  fleetDetails = [
    ["boat-hull", "r", 6, 10.5], ["boat-wake", "r", 6, 10.5],
    ["boat-halo", "r", 11, 16], ["boat-label", "x", 13, 18],
    ["boat-heading", "d", "M0,-12 L3.6,-5.6 L-3.6,-5.6 Z", "M0,-17 L4.4,-9.8 L-4.4,-9.8 Z"]
  ].map(([name, attribute, far, near]) => ({ nodes: [...fleetLayer.querySelectorAll(`.${name}`)], attribute, far, near }));
  fleetDetails.push({ nodes: [...fleetLayer.querySelectorAll(".boat-number")], attribute: null });
  fleetScale = null;
  markTargetDock();
  updateVesselCard();
  scheduleView();
}

function markTargetDock() {
  const target = boats.find((boat) => boat.id === selectedId)?.stop;
  for (const dock of dockLabels) {
    const distance = target?.latitude == null ? Infinity : metresBetween(target, dock);
    const next = distance < 300;
    if (dock.target !== next) {
      dock.node.classList.toggle("is-target", next);
      dock.target = next;
    }
  }
}

function metresBetween(from, to) {
  const easting = (to.longitude - from.longitude) * Math.cos(from.latitude * RADIANS);
  const northing = to.latitude - from.latitude;
  return Math.hypot(easting, northing) * METRES_PER_DEGREE;
}

// ---------------------------------------------------------------- pan, zoom & camera easing

let viewFramePending = false;
let cameraFrame = null;
function scheduleView() {
  if (!lifecycle.active) return;
  if (!hasRaf) return applyView();
  if (viewFramePending) return;
  viewFramePending = true;
  cameraFrame = requestAnimationFrame(renderCameraFrame);
}

function renderCameraFrame(now) {
  viewFramePending = false;
  if (cameraAnimation && !cameraAnimation(now)) {
    cameraAnimation = null;
    forceStreetLayout = true;
  }
  applyView(now);
  if (cameraAnimation) scheduleView();
}

function applyView(now = 0) {
  if (!view) return;
  const nextBox = `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.width.toFixed(1)} ${view.height.toFixed(1)}`;
  if (chart.getAttribute("viewBox") !== nextBox) chart.setAttribute("viewBox", nextBox);
  const [x, y, width, height] = nextBox.split(" ").map(Number);
  renderedView = { x, y, width, height };
  drawTiles();
  const units = Math.max(view.width / viewport.width, view.height / viewport.height);
  const scale = units.toFixed(3);
  updateFeatures(units, scale);
  if (fleetScale !== scale) {
    for (const scaler of fleetScalers) scaler.setAttribute("transform", `scale(${scale})`);
    fleetScale = scale;
  }
  const close = base.width / view.width >= LABEL_ZOOM;
  if (close !== layerClose) {
    dockLayer?.classList.toggle("is-close", close);
    chartBackdrop?.classList.toggle("is-close", close);
    layerClose = close;
  }
  if (close !== fleetIsClose) {
    fleetIsClose = close;
    for (const detail of fleetDetails) for (const node of detail.nodes) {
      if (detail.attribute) node.setAttribute(detail.attribute, close ? detail.near : detail.far);
      else node.style.display = close ? "" : "none";
    }
  }
  layoutDockLabels(units, close);
  const moving = pointers.size > 0 || cameraAnimation || wheelTimer !== null;
  if (forceStreetLayout || !moving || now - lastStreetLayout >= LABEL_INTERVAL) {
    layoutStreetLabels(units, close);
    lastStreetLayout = now;
    forceStreetLayout = false;
  }
}

// Keep names legible at every viewport size; crowded landing labels wait for more room.
function layoutDockLabels(units, close) {
  const occupied = [];
  const area = visibleArea(units);
  const docks = [...dockLabels].sort((a, b) => Number(b.target) - Number(a.target));
  for (const dock of docks) {
    const { label, x, y, target, major } = dock;
    const labelWidth = dock.width * units;
    const left = x + 7 * units + labelWidth > area.right;
    if (dock.left !== left) {
      label.setAttribute("x", left ? -7 : 7);
      label.setAttribute("text-anchor", left ? "end" : "start");
      dock.left = left;
    }
    const rect = { x: left ? x - 7 * units - labelWidth : x + 7 * units, y: y - 8 * units, w: labelWidth, h: 18 * units };
    const inside = x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
    const collides = occupied.some((r) => rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y);
    const show = inside && (target || ((major || close) && !collides));
    labelVisibility(dock, show, true);
    if (show) occupied.push(rect);
  }
}

function cacheViewport(box) {
  if (!box.width || !box.height) return;
  if (viewport.width === box.width && viewport.height === box.height) return;
  viewport = { width: box.width, height: box.height };
  forceStreetLayout = true;
  if (view) scheduleView();
}
cacheViewport(chart.getBoundingClientRect());
const resizeViewport = () => cacheViewport(chart.getBoundingClientRect());
const observer = typeof ResizeObserver === "function"
  ? new ResizeObserver(entries => { if (lifecycle.active) cacheViewport(entries[0].contentRect); }) : null;
if (observer) observer.observe(chart);
else globalThis.addEventListener?.("resize", resizeViewport);

function layoutStreetLabels(units, close) {
  const occupied = [];
  const named = new Set();
  const area = visibleArea(units);
  for (const entry of streetLabels) {
    if (!entry.feature.visible) { labelVisibility(entry, false); continue; }
    const { x, y, priority, name, highway } = entry;
    const width = entry.width * units;
    const height = (priority ? 14 : 28) * units;
    const rect = { x: x - width / 2, y: y - 13 * units, width, height };
    const inside = rect.x > area.left && rect.x + width < area.right && rect.y > area.top && rect.y + height < area.bottom;
    // Reject offscreen and duplicate labels before testing collisions.
    const eligible = inside && !named.has(name) && (close || highway || priority);
    const collides = eligible && occupied.some((r) => rect.x < r.x + r.width && rect.x + width > r.x && rect.y < r.y + r.height && rect.y + height > r.y);
    const show = eligible && !collides;
    labelVisibility(entry, show);
    if (show) { named.add(name); occupied.push(rect); }
  }
}

function clampView(next) {
  const width = Math.min(base.width, Math.max(base.width / MAX_ZOOM, next.width));
  const height = width * (base.height / base.width);
  return {
    x: Math.min(Math.max(next.x, 0), base.width - width),
    y: Math.min(Math.max(next.y, 0), base.height - height),
    width,
    height
  };
}

function setView(next) {
  if (!base) return;
  cancelCameraAnimation();
  view = clampView(next);
  scheduleView();
}

function cancelCameraAnimation() {
  if (cameraAnimation) {
    cameraAnimation = null;
    forceStreetLayout = true;
    scheduleView();
  }
}

function animateTo(target, duration = 320, { constrain = true } = {}) {
  if (!view || !base) return;
  const clamped = constrain ? clampView(target) : target;
  if (!hasRaf || reducedMotion?.matches) {
    cancelCameraAnimation();
    view = clamped;
    scheduleView();
    return;
  }
  cancelCameraAnimation();
  const start = { ...view };
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    // Smooth cubic ease out
    const ease = 1 - Math.pow(1 - progress, 3);
    view = {
      x: start.x + (clamped.x - start.x) * ease,
      y: start.y + (clamped.y - start.y) * ease,
      width: start.width + (clamped.width - start.width) * ease,
      height: start.height + (clamped.height - start.height) * ease
    };
    return progress < 1;
  }
  cameraAnimation = step;
  scheduleView();
}

function toDrawing(clientX, clientY) {
  const matrix = chart.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  if (!renderedView) return { x: point.x, y: point.y };
  const factor = view.width / renderedView.width;
  return { x: view.x + (point.x - renderedView.x) * factor,
    y: view.y + (point.y - renderedView.y) * factor };
}

function zoomBy(factor, clientX, clientY, { animate = false } = {}) {
  if (!view || !base) return;
  // Clamp the size before calculating the anchor offset. Clamping only in setView
  // lets repeated zooms at the limit keep moving the camera without changing scale.
  const width = Math.min(base.width, Math.max(base.width / MAX_ZOOM, view.width * factor));
  if (width === view.width) return;
  factor = width / view.width;
  const anchor = clientX == null ? null : toDrawing(clientX, clientY);
  const centre = anchor || { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  const next = {
    x: centre.x - (centre.x - view.x) * factor,
    y: centre.y - (centre.y - view.y) * factor,
    width
  };
  if (animate && hasRaf) animateTo(next, 280);
  else setView(next);
}

const pointers = new Map();
let grabbed = null;
let pinchDistance = 0;
let gestureView = null;
let gestureMatrix = null;
let gestureRenderedView = null;
let pinchAnchor = null;
let dragged = false;
let pointerHistory = [];

function pinchSpan() {
  const [first, second] = [...pointers.values()];
  return {
    distance: Math.hypot(first.x - second.x, first.y - second.y),
    clientX: (first.x + second.x) / 2,
    clientY: (first.y + second.y) / 2
  };
}

// All pointer samples in a gesture use one camera transform. The rendered SVG may
// lag the logical camera by a frame, so reading its CTM on every move feeds pan
// changes back into subsequent deltas and makes the camera jump.
function gesturePoint(x, y) {
  if (!gestureMatrix) return null;
  const point = new DOMPoint(x, y).matrixTransform(gestureMatrix);
  const factor = gestureView.width / gestureRenderedView.width;
  return { x: gestureView.x + (point.x - gestureRenderedView.x) * factor,
    y: gestureView.y + (point.y - gestureRenderedView.y) * factor };
}
function beginGesture() {
  // Capture once, accounting for a logical camera that is one frame ahead of the SVG.
  gestureView = { ...view };
  gestureRenderedView = { ...(renderedView || view) };
  gestureMatrix = chart.getScreenCTM()?.inverse() || null;
  pointerHistory = [];
  if (pointers.size === 1) {
    const first = [...pointers.values()][0];
    grabbed = gesturePoint(first.x, first.y);
    pinchDistance = 0;
  } else if (pointers.size === 2) {
    const span = pinchSpan();
    grabbed = null;
    pinchDistance = span.distance;
    pinchAnchor = gesturePoint(span.clientX, span.clientY);
  }
}

chart.addEventListener("pointerdown", (event) => {
  if (!view) return;
  cancelCameraAnimation();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY });
  pointerHistory = [{ x: event.clientX, y: event.clientY, time: Date.now() }];
  if (pointers.size === 1) {
    beginGesture();
    dragged = false;
    chart.classList.add("is-dragging");
  } else if (pointers.size === 2) {
    dragged = true;
    grabbed = null;
    beginGesture();
  }
});

chart.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId) || !view) return;
  const origin = pointers.get(event.pointerId);
  if (Math.hypot(event.clientX - origin.originX, event.clientY - origin.originY) > 4) {
    dragged = true;
    // Capture only a drag: capturing pointerdown retargets a landing's click to the SVG.
    chart.setPointerCapture(event.pointerId);
  }
  pointers.set(event.pointerId, { ...origin, x: event.clientX, y: event.clientY });
  if (!dragged && pointers.size === 1) return;

  const now = Date.now();
  pointerHistory.push({ x: event.clientX, y: event.clientY, time: now });
  if (pointerHistory.length > 5) pointerHistory.shift();

  if (pointers.size === 1 && grabbed) {
    const drawingPos = gesturePoint(event.clientX, event.clientY);
    if (drawingPos) setView({ x: gestureView.x - (drawingPos.x - grabbed.x), y: gestureView.y - (drawingPos.y - grabbed.y), width: gestureView.width });
  } else if (pointers.size === 2 && pinchDistance > 0) {
    const span = pinchSpan();
    if (span.distance > 0) {
      const point = gesturePoint(span.clientX, span.clientY);
      if (!point || !pinchAnchor) return;
      const width = Math.min(base.width, Math.max(base.width / MAX_ZOOM, gestureView.width * pinchDistance / span.distance));
      const factor = width / gestureView.width;
      setView({ x: pinchAnchor.x - (point.x - gestureView.x) * factor,
        y: pinchAnchor.y - (point.y - gestureView.y) * factor, width });
    }
  }
});

for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
  chart.addEventListener(name, (event) => {
    if (name === "lostpointercapture" && chart.hasPointerCapture?.(event.pointerId)) return;
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size === 1) beginGesture();
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      // Kinetic inertia glide if flicked
      if (name === "pointerup" && dragged && hasRaf && !reducedMotion?.matches && pointerHistory.length >= 2) {
        const last = pointerHistory.at(-1);
        const prev = pointerHistory[0];
        const dt = Math.max(1, last.time - prev.time);
        if (dt < 180 && Date.now() - last.time < 80) {
          const ctm = chart.getScreenCTM();
          if (ctm) {
            const inverse = ctm.inverse();
            const origin = new DOMPoint(0, 0).matrixTransform(inverse);
            const pixel = new DOMPoint(1, 0).matrixTransform(inverse);
            const scale = Math.hypot(pixel.x - origin.x, pixel.y - origin.y);
            let vx = ((last.x - prev.x) / dt) * scale;
            let vy = ((last.y - prev.y) / dt) * scale;
            if (Math.hypot(vx, vy) > 0.08) {
              let lastFrame = performance.now();
              const glide = (now) => {
                const elapsed = Math.min(32, Math.max(0, now - lastFrame));
                lastFrame = now;
                const decay = Math.pow(0.92, elapsed / 16.7);
                vx *= decay;
                vy *= decay;
                if (Math.hypot(vx, vy) > 0.005 && view && base) {
                  view = clampView({ x: view.x - vx * elapsed, y: view.y - vy * elapsed, width: view.width });
                  return true;
                }
                return false;
              };
              cameraAnimation = glide;
              scheduleView();
            }
          }
        }
      }
      grabbed = null;
      forceStreetLayout = true;
      scheduleView();
      chart.classList.remove("is-dragging");
    }
  });
}

chart.addEventListener("wheel", (event) => {
  if (!view || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  event.preventDefault();
  if (wheelTimer !== null) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelTimer = null;
    forceStreetLayout = true;
    scheduleView();
  }, LABEL_INTERVAL);
  // Wheel mice can report lines/pages; trackpads report small pixel deltas.
  // Bound individual jumps while preserving the gentler trackpad movement.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
  const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
  zoomBy(Math.exp(delta * 0.002), event.clientX, event.clientY);
}, { passive: false });

chart.addEventListener("keydown", (event) => {
  if (!view) return;
  if ((event.key === "Enter" || event.key === " ") && event.target !== chart) {
    event.preventDefault();
    event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return;
  }
  if (event.key === "Escape") { select(selectedId, { recentre: false }); return; }
  const step = view.width / 8;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[event.key]) {
    event.preventDefault();
    setView({ x: view.x + moves[event.key][0], y: view.y + moves[event.key][1], width: view.width });
  } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1 / 1.4); }
  else if (event.key === "-") { event.preventDefault(); zoomBy(1.4); }
});

chart.addEventListener("click", (event) => {
  if (dragged && event.detail !== 0) return;
  const pickedBoat = event.target.closest?.(".boat");
  if (pickedBoat) {
    hideDockCard();
    hideBridgeCard();
    hideSeamarkCard();
    select(pickedBoat.dataset.boat);
    return;
  }
  const pickedDock = event.target.closest?.(".dock");
  if (pickedDock) {
    hideBridgeCard();
    hideSeamarkCard();
    const dockId = Number(pickedDock.dataset.dockId);
    const dock = harbor?.landings?.find((l) => l.id === dockId);
    if (dock) showDockCard(dock);
    return;
  }
  const pickedBridge = event.target.closest?.(".bridge-group");
  if (pickedBridge) {
    hideDockCard();
    hideSeamarkCard();
    const bridgeId = pickedBridge.dataset.bridgeId;
    const bridge = harbor?.chart?.bridges?.find((b) => b.id === bridgeId);
    if (bridge) showBridgeCard(bridge);
    return;
  }
  const pickedSeamark = event.target.closest?.(".seamark");
  if (pickedSeamark) {
    hideDockCard();
    hideBridgeCard();
    const seamarkId = pickedSeamark.dataset.seamarkId;
    const seamark = harbor?.chart?.seamarks?.find((s) => s.id === seamarkId);
    if (seamark) showSeamarkCard(seamark);
    return;
  }
  hideDockCard();
  hideBridgeCard();
  hideSeamarkCard();
});

query("#zoomIn").addEventListener("click", () => zoomBy(1 / 1.4, null, null, { animate: true }));
query("#zoomOut").addEventListener("click", () => zoomBy(1.4, null, null, { animate: true }));
query("#zoomFit").addEventListener("click", () => {
  if (base) {
    if (hasRaf) animateTo({ ...base });
    else setView({ ...base });
  }
});

// ---------------------------------------------------------------- detail cards

function updateVesselCard() {
  if (!vesselCard) return;
  if (detailKind && detailKind !== "vessel") { reveal(vesselCard, false); return; }
  const boat = boats.find((b) => b.id === selectedId);
  if (!boat) {
    reveal(vesselCard, false);
    return;
  }
  reveal(vesselCard, true);

  const closeBtn = element("button", "card-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close vessel card");
  closeBtn.addEventListener("click", () => select(selectedId));

  const titleRow = element("div", "card-title-row");
  const chip = element("span", "card-route-chip", boat.route || "Ferry");
  if (boat.color) {
    chip.style.background = boat.color;
    chip.style.color = readableOn(boat.color);
  }
  const name = element("span", "card-vessel-name", boat.name || boat.number || "Ferry");
  if (boat.number && boat.name && boat.number !== boat.name) {
    name.append(element("span", "card-hull-number", ` (${boat.number})`));
  }
  titleRow.append(chip, name);

  const status = element("div", "card-status-line", boat.destination && !samePlace(boat.destination, boat.stop?.name)
    ? `${statusLine(boat)} · to ${boat.destination}`
    : statusLine(boat));

  const metaRow = element("div", "card-meta-row");
  const speed = element("span", "card-speed-badge", boat.speedKnots == null ? "Speed unavailable" : `${boat.speedKnots.toFixed(1)} kn`);
  const age = element("span", null, ageLabel(boat.ageSeconds));
  metaRow.append(speed, age);

  const actionBtn = element("a", "card-action-btn", "Open Departure Board");
  // Vehicle stop IDs are GTFS IDs; board links need the configured landing number.
  const landing = boat.stop?.latitude == null || !harbor ? null : harbor.landings
    .map((dock) => ({ dock, distance: metresBetween(dock, boat.stop) }))
    .filter((item) => item.distance < 300)
    .sort((a, b) => a.distance - b.distance)[0]?.dock;
  actionBtn.href = landing ? `${boardURL}?landing=${landing.id}` : boardURL;

  const rideButton = element("button", "card-action-btn ride-action", "Riding this boat?");
  rideButton.type = "button";
  rideButton.dataset.rideBoat = boat.id;
  reconcile(vesselCard, [closeBtn, titleRow, status, metaRow, rideButton, actionBtn]);
}

vesselCard?.addEventListener("click", event => {
  const button = event.target.closest?.("[data-ride-boat]");
  const boat = button && boats.find(item => item.id === button.dataset.rideBoat);
  if (boat) void onRide({ vesselId: boat.vesselId, name: boat.name || boat.number, number: boat.number, confirmed: rideFeedFresh && (boat.ageSeconds == null || boat.ageSeconds <= STALE_FIX_SECONDS), routeId: boat.routeId });
});
query("#routeRide")?.addEventListener("click", () => { setRouteMenuOpen(false); void onRide({ routeId: activeRouteFilter }); });

function showDockCard(dock) {
  if (!dockCard) return;
  detailKind = "dock";
  dockCard.textContent = "";
  dockCard.hidden = false;
  if (vesselCard) reveal(vesselCard, false);
  if (bridgeCard) reveal(bridgeCard, false);
  if (seamarkCard) reveal(seamarkCard, false);

  const title = element("h2", null, "Open departures?");
  title.id = "landingConfirmTitle";
  const description = element("p", null, `View the departure board for ${dock.displayName || dock.name}?`);
  description.id = "landingConfirmDescription";
  const actions = element("div", "landing-confirm-actions");
  const cancel = element("button", null, "Stay on map");
  cancel.type = "button";
  cancel.autofocus = true;
  cancel.addEventListener("click", hideDockCard);
  const open = element("button", "confirm-departures", "Open departures");
  open.type = "button";
  open.addEventListener("click", () => navigate(`${boardURL}?landing=${encodeURIComponent(dock.id)}`));
  actions.append(cancel, open);
  dockCard.append(title, description, actions);
  // Keep this in the same floating-card layer as vessel details. A non-modal dialog preserves
  // the map underneath and still gives keyboard users an Escape/cancel path.
  dockCard.show?.();
}

function hideDockCard() {
  if (!dockCard) return;
  dockCard.close?.();
  dockCard.hidden = true;
  dockCard.textContent = "";
  if (detailKind === "dock") detailKind = null;
}

if (dockCard) dockCard.addEventListener("cancel", (event) => {
  event.preventDefault();
  hideDockCard();
});
if (dockCard) dockCard.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideDockCard();
  }
});

function showBridgeCard(bridge) {
  if (!bridgeCard) return;
  detailKind = "bridge";
  bridgeCard.textContent = "";
  reveal(bridgeCard, true);
  if (vesselCard) reveal(vesselCard, false);
  if (dockCard) dockCard.hidden = true;
  if (seamarkCard) reveal(seamarkCard, false);

  const closeBtn = element("button", "card-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close bridge card");
  closeBtn.addEventListener("click", hideBridgeCard);

  const titleRow = element("div", "card-title-row");
  const name = element("span", "card-vessel-name", bridge.name);
  titleRow.append(name);

  const typeLine = element("div", "card-status-line", `${bridge.type} · ${bridge.waterway}`);

  const clearanceBox = element("div", "card-clearance-box");
  const heading = element("div", "card-clearance-label", "Vertical Navigational Clearance");
  const value = element("div", "card-clearance-val", `${bridge.clearanceFeet} ft (${bridge.clearanceMeters} m)`);
  const note = element("div", "card-clearance-note",
    `Reference only; verify current charts, tide and vessel air draft. ${bridge.clearanceNote || ""}`);
  clearanceBox.append(heading, value, note);

  bridgeCard.append(closeBtn, titleRow, typeLine, clearanceBox);
}

function hideBridgeCard() {
  if (!bridgeCard) return;
  reveal(bridgeCard, false);
  if (detailKind === "bridge") detailKind = null;
}

function showSeamarkCard(seamark) {
  if (!seamarkCard) return;
  detailKind = "seamark";
  seamarkCard.textContent = "";
  reveal(seamarkCard, true);
  if (vesselCard) reveal(vesselCard, false);
  if (dockCard) dockCard.hidden = true;
  if (bridgeCard) reveal(bridgeCard, false);

  const closeBtn = element("button", "card-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close seamark card");
  closeBtn.addEventListener("click", hideSeamarkCard);

  const titleRow = element("div", "card-title-row");
  const name = element("span", "card-vessel-name", seamark.name);
  titleRow.append(name);

  const status = element("div", "card-status-line",
    seamark.type === "light"
      ? `Light: ${seamark.characteristic || "Fixed"} · Nominal Range: ${seamark.rangeNm || "—"} NM`
      : `Buoy: ${seamark.subtype || seamark.shape || "Marker"} (${seamark.color})`);

  const desc = element("div", "card-seamark-desc", seamark.description || "Harbor navigational mark.");

  seamarkCard.append(closeBtn, titleRow, status, desc);
}

function hideSeamarkCard() {
  if (!seamarkCard) return;
  reveal(seamarkCard, false);
  if (detailKind === "seamark") detailKind = null;
}

// ---------------------------------------------------------------- bottom sheet & search

if (sheetHandle && bottomSheet) {
  if (wanted) {
    bottomSheet.dataset.state = "peek";
    sheetHandle.setAttribute("aria-expanded", "false");
    sheetHandle.setAttribute("aria-label", "Expand vessel list");
    query("#sheetToggleText").textContent = "Expand";
  }
  sheetHandle.addEventListener("click", () => {
    const next = bottomSheet.dataset.state === "peek" ? "half" : "peek";
    bottomSheet.dataset.state = next;
    sheetHandle.setAttribute("aria-expanded", String(next !== "peek"));
    sheetHandle.setAttribute("aria-label", next === "peek" ? "Expand vessel list" : "Collapse vessel list");
    query("#sheetToggleText").textContent = next === "peek" ? "Expand" : "Collapse";
  });
}

if (boatSearchInput) {
  boatSearchInput.addEventListener("input", (event) => {
    searchQuery = String(event.target.value || "").trim().toLowerCase();
    renderList();
  });
}

// ---------------------------------------------------------------- the list

function statusLine(boat) {
  const where = boat.stop?.name;
  if (!where) return boat.status === "stopped" ? "Alongside" : "Under way";
  if (boat.status === "stopped") return `Alongside at ${where}`;
  if (boat.status === "incoming") return `Arriving at ${where}`;
  return `Next stop ${where}`;
}

function samePlace(left, right) {
  const flatten = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(left) && flatten(left) === flatten(right);
}

function ageLabel(seconds) {
  if (seconds == null) return "";
  if (seconds < 45) return "just now";
  return `${Math.round(seconds / 60)} min ago`;
}

function recentreOn(boat) {
  if (!boat || !view || !base) return;
  const [x, y] = projection.point(boat.latitude, boat.longitude);
  const width = Math.min(view.width, base.width / 5);
  const height = width * (base.height / base.width);
  const box = chart.getBoundingClientRect();
  let offsetX = 0;
  let offsetY = 0;
  if (box.width && box.height && vesselCard && !vesselCard.hidden) {
    const card = vesselCard.getBoundingClientRect();
    if (card.top < box.bottom && card.bottom > box.top && card.left < box.right && card.right > box.left) {
      // Pick the larger clear area above or beside the card. SVG's default
      // xMidYMid meet scaling may letterbox the drawing, so use screen units.
      const top = 60;
      const above = { left: 32, top, right: box.width - 32, bottom: Math.max(top, card.top - box.top - 24) };
      const beside = { left: Math.min(box.width - 32, card.right - box.left + 24), top, right: box.width - 32, bottom: box.height - 32 };
      const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
      const clear = area(beside) > area(above) ? beside : above;
      const units = Math.max(width / box.width, height / box.height);
      offsetX = ((clear.left + clear.right) / 2 - box.width / 2) * units;
      offsetY = ((clear.top + clear.bottom) / 2 - box.height / 2) * units;
    }
  }
  // Allow the camera past the overview bounds to keep edge-of-harbor boats
  // clear of the card too. Manual pan/zoom still uses its normal limits.
  animateTo({ x: x - width / 2 - offsetX, y: y - height / 2 - offsetY, width, height }, 360, { constrain: false });
}

function select(id, { recentre = true } = {}) {
  wanted = null;
  selectedId = selectedId === id ? null : id;
  hideDockCard();
  hideBridgeCard();
  hideSeamarkCard();
  detailKind = "vessel";
  drawFleet();
  renderList();
  if (recentre) {
    const picked = boats.find((item) => item.id === selectedId);
    if (picked) {
      recentreOn(picked);
      if (bottomSheet && bottomSheet.dataset.state === "full") {
        bottomSheet.dataset.state = "half";
      }
    }
  }
}

function renderList() {
  const list = query("#boats");
  if (!list) return;
  const entries = [];

  const filtered = boats.filter((boat) => {
    if (activeRouteFilter && boat.routeId !== activeRouteFilter) return false;
    if (searchQuery) {
      const matchName = String(boat.name || "").toLowerCase().includes(searchQuery);
      const matchNum = String(boat.number || "").toLowerCase().includes(searchQuery);
      const matchDest = String(boat.destination || "").toLowerCase().includes(searchQuery);
      const matchStop = String(boat.stop?.name || "").toLowerCase().includes(searchQuery);
      return matchName || matchNum || matchDest || matchStop;
    }
    return true;
  });

  const countElem = query("#boatCount");
  query("#listCount").textContent = `${filtered.length} ${filtered.length === 1 ? "vessel" : "vessels"}${activeRouteFilter || searchQuery ? ` of ${boats.length}` : " reporting"}`;
  if (countElem) {
    countElem.textContent = boats.length
      ? `${number.format(boats.length)} ${boats.length === 1 ? "boat" : "boats"}`
      : "No positions";
  }

  if (!boats.length) {
    const empty = element("li", "empty");
    empty.append(element("strong", "empty-title", "No vessels reporting"),
      element("p", null, "No NYC Ferry vessel is reporting a position right now. Routes and landings are still available. Partner operators do not supply positions here."));
    reconcile(list, [empty]);
    return;
  }

  if (!filtered.length) {
    reconcile(list, [element("li", "empty", searchQuery ? `No boats match "${searchQuery}".` : "No vessels are reporting on this route right now.")]);
    return;
  }

  for (const boat of filtered) {
    const item = element("li");
    item.setAttribute("data-key", String(boat.id));
    const row = element("button", "boat-row");
    row.type = "button";
    row.setAttribute("aria-pressed", String(boat.id === selectedId));

    const chip = element("span", "route-chip", boat.route || "—");
    if (boat.color) {
      chip.style.background = boat.color;
      chip.style.color = readableOn(boat.color);
    }

    const name = element("span", "boat-name", boat.name || boat.number || "Unnamed vessel");
    if (boat.number && boat.name && boat.number !== boat.name) name.append(element("span", "boat-number", boat.number));

    const doing = element("span", "boat-doing", boat.destination && !samePlace(boat.destination, boat.stop?.name)
      ? `${statusLine(boat)} · to ${boat.destination}`
      : statusLine(boat));

    const figures = element("span", "boat-figures");
    figures.append(
      element("b", null, boat.speedKnots == null ? "—" : `${boat.speedKnots.toFixed(1)} kn`),
      element("span", null, ageLabel(boat.ageSeconds))
    );

    row.append(chip, name, doing, figures);
    row.addEventListener("click", () => select(boat.id));
    item.append(row);
    entries.push(item);
  }
  reconcile(list, entries);
}

function readableOn(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const part = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.45 ? "#3b2b33" : "#fff";
}

// ---------------------------------------------------------------- load & sync

function updateHeadings(next) {
  for (const boat of next) {
    const before = previousFix.get(boat.id);
    if (!before || metresBetween(before, boat) > 25) {
      if (before) {
        const easting = (boat.longitude - before.longitude) * Math.cos(boat.latitude * RADIANS);
        heading.set(boat.id, (Math.atan2(easting, boat.latitude - before.latitude) / RADIANS + 360) % 360);
      }
      previousFix.set(boat.id, { latitude: boat.latitude, longitude: boat.longitude });
    }
  }
  const afloat = new Set(next.map((boat) => boat.id));
  for (const id of [...previousFix.keys()]) if (!afloat.has(id)) { previousFix.delete(id); heading.delete(id); }
}

function message(text) {
  if (!mapMessage) return;
  mapMessage.textContent = text || "";
  mapMessage.hidden = !text;
}

function findWanted() {
  const flatten = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const asked = flatten(wanted);
  return boats.find((boat) => flatten(boat.name) === asked || flatten(boat.number) === asked) || null;
}

function followWanted() {
  if (!wanted) return null;
  if (!harbor || !base) return "";
  const found = findWanted();
  if (!found) return `${wanted} is not reporting a position right now.`;
  wanted = null;
  selectedId = found.id;
  drawFleet();
  recentreOn(found);
  return "";
}

// What the chip says and how it is dressed are decided together, so the word and the colour cannot
// drift apart the way an "Offline" label sitting on the stale styling did.
function setFeedStatus(label, state) {
  if (statusText) statusText.textContent = label;
  const chip = query("#mapStatus");
  if (chip) chip.dataset.state = state;
}
function applyPositions(payload, saved = false) {
  boats = payload.boats || [];
  rideFeedFresh = !saved && !payload.stale && Boolean(payload.available);
  updateHeadings(boats);
  if (selectedId && !boats.some(boat => boat.id === selectedId)) selectedId = null;
  const following = followWanted();
  drawFleet();
  renderList();
  const stale = saved || payload.stale;
  const at = payload.fetchedAt ? new Date(payload.fetchedAt) : null;
  if (stale) setFeedStatus("Saved", "stale");
  else if (!payload.available) setFeedStatus("No feed", "offline");
  else setFeedStatus("Live", "live");
  const note = query("#feedNote");
  if (note) note.textContent = `${at && Number.isFinite(+at) ? `Updated ${timeLabel.format(at)} · ` : ""}NYC Ferry positions · Refreshes every 15s`;
  message(stale ? `Saved positions${at && Number.isFinite(+at) ? `, at ${timeLabel.format(at)}` : ""} · refreshing when connected. These positions may be out of date.`
    : !payload.available ? "The vessel feed is not answering. Nothing here is current." : following);
}
// Only the small half of the harbor is kept locally. Bounds, routes and docks are 13 KB together;
// the chart backdrop is a megabyte of landmass and street geometry. Writing the whole thing on
// every load overruns Safari's 5 MB origin quota — which fails silently, so the cache never worked
// — and spends that quota against the saved schedules, which are the ones that matter offline.
// The backdrop still comes back offline: the service worker caches /api/map like every other API
// response, so it arrives a beat after the docks rather than not at all.
const GEOMETRY_KEY = "nyc-ferry-map-geometry";
function localHarbor({ bounds, routes, landings }) {
  return { bounds, routes, landings };
}
// Cheap enough to run on every refresh, unlike stringifying the chart to compare it with itself.
function harborFingerprint(value) {
  return `${JSON.stringify(localHarbor(value))}|${value.chart?.generatedAt || ""}`;
}
async function load() {
  // Both requests start together. Geometry failure does not suppress the vessel roster.
  const geometry = geometryFresh ? Promise.resolve() : getGeometry().then(async response => {
    if (!response.ok) throw new Error();
    const payload = await response.json();
    if (!payload.bounds || !Array.isArray(payload.landings) || !Array.isArray(payload.routes)) throw new Error();
    geometryFresh = true;
    const unchanged = harbor && harborFingerprint(harbor) === harborFingerprint(payload);
    const previousView = view && { ...view };
    harbor = payload;
    storage.setItem(GEOMETRY_KEY, JSON.stringify(localHarbor(payload)));
    if (!unchanged) {
      drawHarbor();
      if (previousView) { view = clampView(previousView); scheduleView(); }
    }
  });
  const positions = request("/api/boats", { cache: "no-store" }).then(async response => {
    const payload = await response.json();
    if (!Array.isArray(payload.boats)) throw new Error();
    storage.setItem("nyc-ferry-map-positions", JSON.stringify(payload));
    return payload;
  });
  const results = await Promise.allSettled([geometry, positions]);
  if (routeMessage && !harbor?.routes) routeMessage.textContent = "Routes unavailable. Reconnect to load the map.";
  if (results[1].status === "fulfilled") {
    applyPositions(results[1].value);
    return;
  }
  // "Saved" describes boats that are on screen. With none drawn there is nothing saved to describe.
  if (boats.length) setFeedStatus("Saved", "stale");
  else setFeedStatus("Offline", "offline");
  message("Could not reach the server. Any displayed positions may be out of date.");
}
const savedHarbor = storage.json(GEOMETRY_KEY);
if (savedHarbor?.bounds && Array.isArray(savedHarbor.landings) && Array.isArray(savedHarbor.routes)) {
  harbor = savedHarbor;
  drawHarbor();
}
const savedPositions = storage.json("nyc-ferry-map-positions");
if (Array.isArray(savedPositions?.boats)) applyPositions(savedPositions, true);
let usable;
const ready = new Promise(resolve => { usable = resolve; });
poll(async () => { try { await load(); } finally { usable(); } }, REFRESH_MS);

return {
  ready,
  activate(url = new URL(location.href)) {
    if (header) { header.hidden = false; header.inert = false; }
    root.hidden = false;
    root.inert = false;
    if (url.searchParams.has("boat")) wanted = url.searchParams.get("boat");
    document.title = "Ferry Kitty · Map";
    setFeedStatus(boats.length ? "Refreshing" : "Connecting", "loading");
    lifecycle.activate();
    resizeViewport();
    followWanted();
    scheduleView();
  },
  deactivate() {
    lifecycle.deactivate();
    root.hidden = true;
    setRouteMenuOpen(false, false);
    if (header) { header.hidden = true; header.inert = true; }
    root.hidden = true;
    cameraAnimation = null;
    if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
    cameraFrame = null;
    viewFramePending = false;
    clearTimeout(wheelTimer);
    wheelTimer = null;
    for (const id of pointers.keys()) {
      if (chart.hasPointerCapture?.(id)) chart.releasePointerCapture(id);
    }
    pointers.clear();
    pointerHistory = [];
    gestureView = null;
    gestureMatrix = null;
    gestureRenderedView = null;
    pinchAnchor = null;
    pinchDistance = 0;
    dragged = false;
    hideDockCard();
    hideBridgeCard();
    hideSeamarkCard();
    root.getAnimations?.({ subtree: true }).forEach(animation => animation.cancel());
    root.hidden = true;
    root.inert = true;
  },
  dispose() {
    this.deactivate();
    lifecycle.dispose();
    observer?.disconnect();
    globalThis.removeEventListener?.("resize", resizeViewport);
    routeMenuButton?.removeEventListener("click", openRouteMenu);
    routeClose?.removeEventListener("click", closeRouteMenu);
    routeScrim?.removeEventListener("click", closeRouteMenu);
    routeMenu?.removeEventListener("keydown", routeMenuKeys);
    MobileRuntime.releasePanels?.(root);
    root.replaceChildren();
    header?.replaceChildren();
  }
};
}
