import * as L from "/vendor/leaflet.js";

const $ = (id) => document.getElementById(id);
const map = L.map("map", { minZoom: 9, maxZoom: 24, zoomControl: true }).setView([40.707, -74.005], 12);
map.attributionControl.setPrefix(false);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxNativeZoom: 19, maxZoom: 24, minZoom: 9, keepBuffer: 1, referrerPolicy: "strict-origin-when-cross-origin",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>'
}).addTo(map);
L.control.scale({ imperial: false, maxWidth: 150 }).addTo(map);
const surveyLayer = L.layerGroup().addTo(map);
const referenceLayer = L.layerGroup().addTo(map);
const dwellLayer = L.layerGroup();
let points = [], landings = [], terminals = [], drafts = [], history = [];
let selected = { landing: null, slip: null, pointId: null };
let revision, baseline, saving = false, loaded = false;
let serverIds = new Map(), serverOrder = [];
const markers = new Map();
const signature = () => JSON.stringify({ points, drafts });
const dirty = () => loaded && signature() !== baseline;
const selectedPoint = () => points.find((point) => point.id === selected.pointId);
const inHarbor = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 40.35 && latitude <= 41.05 && longitude >= -74.4 && longitude <= -73.65;
const color = (name) => `hsl(${[...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0)} 65% 43%)`;
const message = (text, error = false) => { $("message").textContent = text; $("message").classList.toggle("error", error); };
function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, className) {
  const element = textElement("button", text, className);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}
function checkpoint() { history.push(structuredClone({ points, drafts, selected })); }
function change(action) {
  if (saving) return;
  checkpoint();
  action();
  render();
}
function select(landing, slip = null, pointId = null, centre = true) {
  if (saving) return;
  selected = { landing, slip, pointId };
  $("add-mode").checked = false;
  render();
  if (!centre) return;
  const group = points.filter((point) => point.landing === landing && (!slip || point.slip === slip));
  const point = selectedPoint();
  if (point) map.setView([point.latitude, point.longitude], Math.max(map.getZoom(), 21));
  else if (group.length) {
    map.fitBounds(L.latLngBounds(group.map((item) => [item.latitude, item.longitude])), { padding: [65, 65], maxZoom: 21 });
  } else {
    const reference = landings.find((item) => item.name === landing);
    if (reference) map.setView([reference.latitude, reference.longitude], 19);
  }
}
function slipsFor(landing) {
  return [...new Set([...points.filter((point) => point.landing === landing).map((point) => point.slip), ...drafts.filter((draft) => draft.landing === landing).map((draft) => draft.slip)])];
}
function renderList() {
  const query = $("filter").value.toLowerCase().trim();
  const list = document.createDocumentFragment();
  for (const landing of landings) {
    const slips = slipsFor(landing.name);
    const shown = slips.filter((slip) => `${landing.name} ${landing.displayName ?? ""} ${slip}`.toLowerCase().includes(query));
    if (query && !shown.length && !`${landing.name} ${landing.displayName ?? ""}`.toLowerCase().includes(query)) continue;
    const group = textElement("div", "", "landing");
    const title = button("", () => select(landing.name), "landing-title");
    title.classList.toggle("active", selected.landing === landing.name && !selected.slip);
    title.append(textElement("span", landing.displayName ?? landing.name), textElement("small", landing.editable ? `${slips.length} slips` : "reference"));
    group.append(title);
    for (const slip of shown) {
      const row = textElement("div", "", "slip");
      row.style.setProperty("--slip-color", color(landing.name));
      const groupPoints = points.filter((point) => point.landing === landing.name && point.slip === slip);
      const choose = button(`${slip} (${groupPoints.length})`, () => select(landing.name, slip, groupPoints[0]?.id ?? null));
      choose.classList.toggle("active", selected.landing === landing.name && selected.slip === slip);
      row.append(choose);
      for (const [index, point] of groupPoints.entries()) {
        const pointButton = button(String(index + 1), () => select(point.landing, point.slip, point.id), "point-button");
        pointButton.title = `${point.latitude.toFixed(7)}, ${point.longitude.toFixed(7)}`;
        pointButton.setAttribute("aria-label", `${landing.name} ${slip} point ${index + 1}`);
        pointButton.classList.toggle("active", selected.pointId === point.id);
        row.append(pointButton);
      }
      group.append(row);
    }
    list.append(group);
  }
  list.append(textElement("div", "Partner terminals · reference only", "reference-heading"));
  for (const terminal of terminals) {
    if (query && !terminal.name.toLowerCase().includes(query)) continue;
    list.append(button(terminal.name, () => {
      if (saving) return;
      selected = { landing: null, slip: null, pointId: null };
      $("add-mode").checked = false;
      render();
      map.setView([terminal.berth?.latitude ?? terminal.latitude, terminal.berth?.longitude ?? terminal.longitude], 19);
      message(`${terminal.name}: reference only. The current tracker CSV cannot represent partner-terminal slips.`);
    }, "landing-title"));
  }
  $("list").replaceChildren(list);
}
function renderControls() {
  const landing = landings.find((item) => item.name === selected.landing);
  const point = selectedPoint();
  $("selection").textContent = selected.landing ? `${selected.landing}${selected.slip ? ` · ${selected.slip}` : ""}` : "Choose a landing or point";
  $("new-slip-form").hidden = !landing?.editable;
  $("slip-controls").hidden = !selected.slip;
  $("point-form").hidden = !point;
  $("slip-name").value = selected.slip ?? "";
  $("map").classList.toggle("adding", $("add-mode").checked && Boolean(selected.slip));
  if (point) {
    $("latitude").value = point.latitude.toFixed(7);
    $("longitude").value = point.longitude.toFixed(7);
    const nearby = points.filter((other) => other.id !== point.id).map((other) => ({ point: other, distance: map.distance([point.latitude, point.longitude], [other.latitude, other.longitude]) })).sort((a, b) => a.distance - b.distance)[0];
    $("nearest").textContent = nearby ? `Nearest point: ${nearby.distance.toFixed(2)} m · ${nearby.point.landing} / ${nearby.point.slip}` : "No other survey points.";
  }
  $("undo").disabled = saving || !history.length;
  $("save").disabled = saving || !dirty();
  $("dirty").textContent = saving ? "Saving…" : dirty() ? "Unsaved changes" : "Saved";
  $("dirty").classList.toggle("unsaved", dirty());
  document.querySelector("aside").inert = saving;
  $("map").inert = saving;
  document.title = `${dirty() ? "* " : ""}Slip survey editor`;
}
function referenceMarker(reference, label, berth = false) {
  const position = berth ? reference.berth : reference;
  const marker = L.circleMarker([position.latitude, position.longitude], { radius: berth ? 5 : 6, weight: 2, color: "#596e7d", fillColor: "#edf3f6", fillOpacity: .7, dashArray: "3 2" }).addTo(referenceLayer);
  marker.bindTooltip(textElement("span", label), { permanent: true, direction: "right", offset: [8, 0] });
  marker.on("click", () => {
    if (reference.editable) select(reference.name);
    else message(`${label}: reference only.`);
  });
  if (berth && Number.isFinite(position.radiusMetres)) L.circle([position.latitude, position.longitude], { radius: position.radiusMetres, color: "#6b7d8e", weight: 1, fill: false, dashArray: "4 5", interactive: false }).addTo(referenceLayer);
}
function renderMap() {
  surveyLayer.clearLayers();
  referenceLayer.clearLayers();
  markers.clear();
  for (const point of points) {
    const dot = textElement("span", "", "survey-dot");
    dot.style.setProperty("--slip-color", color(point.landing));
    const marker = L.marker([point.latitude, point.longitude], {
      draggable: !saving, autoPan: true, bubblingMouseEvents: false,
      icon: L.divIcon({ html: dot, iconSize: [20, 20], iconAnchor: [10, 10], className: `survey-marker${point.id === selected.pointId ? " selected" : ""}` }),
      title: `${point.landing} / ${point.slip}`, alt: `${point.landing} / ${point.slip} survey point`, riseOnHover: true
    }).addTo(surveyLayer);
    const tooltip = textElement("span", point.slip);
    tooltip.title = point.landing;
    marker.bindTooltip(tooltip, { permanent: true, direction: "right", offset: [10, 0], className: point.id === selected.pointId ? "selected-label" : "" });
    marker.on("click", () => select(point.landing, point.slip, point.id, false));
    marker.on("dragstart", () => {
      selected = { landing: point.landing, slip: point.slip, pointId: point.id };
      $("add-mode").checked = false;
      renderList();
      renderControls();
    });
    marker.on("dragend", () => {
      const position = marker.getLatLng();
      if (!inHarbor(position.lat, position.lng)) { render(); message("Point must stay inside New York Harbor.", true); return; }
      change(() => { point.latitude = position.lat; point.longitude = position.lng; });
      message("Point moved. Save CSV to write the change.");
    });
    markers.set(point.id, marker);
  }
  for (const landing of landings) {
    if (!points.some((point) => point.landing === landing.name)) referenceMarker(landing, `${landing.displayName ?? landing.name} · ${landing.editable ? "no survey" : "reference"}`);
  }
  for (const terminal of terminals) {
    referenceMarker(terminal, `${terminal.name} · reference`);
    if (terminal.berth) referenceMarker(terminal, `${terminal.name} · berth`, true);
  }
}
function render() { renderList(); renderControls(); renderMap(); }

$("filter").addEventListener("input", renderList);
$("add-mode").addEventListener("change", renderControls);
$("new-slip-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const slip = $("new-slip").value.trim();
  if (!slip || !selected.landing || saving) return;
  if (slipsFor(selected.landing).includes(slip)) { message("That slip already exists. Select it to add another point.", true); return; }
  change(() => {
    drafts.push({ landing: selected.landing, slip });
    selected = { landing: selected.landing, slip, pointId: null };
    $("new-slip").value = "";
    $("add-mode").checked = true;
  });
  message(`Click the map to place the first point for ${slip}.`);
});
$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("slip-name").value.trim(), old = selected.slip;
  if (!name || name === old) return;
  if (slipsFor(selected.landing).includes(name)) { message("That slip name already exists at this landing. Choose a different name.", true); return; }
  change(() => {
    for (const point of points) if (point.landing === selected.landing && point.slip === old) point.slip = name;
    for (const draft of drafts) if (draft.landing === selected.landing && draft.slip === old) draft.slip = name;
    selected.slip = name;
  });
  message(`Renamed ${old} to ${name}.`);
});
$("delete-point").addEventListener("click", () => {
  if (!selectedPoint()) return;
  change(() => {
    points = points.filter((point) => point.id !== selected.pointId);
    selected.pointId = null;
    if (!points.some((point) => point.landing === selected.landing && point.slip === selected.slip)) selected.slip = null;
  });
  message("Point deleted. Undo restores it.");
});
$("delete-slip").addEventListener("click", () => {
  if (!selected.slip || saving) return;
  const count = points.filter((point) => point.landing === selected.landing && point.slip === selected.slip).length;
  if (!confirm(`Delete ${selected.slip} and all ${count} points at ${selected.landing}? You can undo this before or after saving.`)) return;
  change(() => {
    points = points.filter((point) => !(point.landing === selected.landing && point.slip === selected.slip));
    drafts = drafts.filter((draft) => !(draft.landing === selected.landing && draft.slip === selected.slip));
    selected.slip = null;
    selected.pointId = null;
  });
  message("Slip deleted. Undo restores it.");
});
$("point-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const point = selectedPoint();
  if (!point) return;
  const coordinate = (field) => $(field).value === point[field].toFixed(7) ? point[field] : Number($(field).value);
  const latitude = coordinate("latitude"), longitude = coordinate("longitude");
  if (!inHarbor(latitude, longitude)) { message("Enter valid coordinates inside New York Harbor.", true); return; }
  if (latitude === point.latitude && longitude === point.longitude) return;
  change(() => { point.latitude = latitude; point.longitude = longitude; });
  map.panTo([latitude, longitude]);
  message("Coordinates updated.");
});
map.on("click", (event) => {
  if (!loaded || saving || !$("add-mode").checked || !selected.slip) return;
  const { lat: latitude, lng: longitude } = event.latlng;
  if (!inHarbor(latitude, longitude)) { message("Point must stay inside New York Harbor.", true); return; }
  change(() => {
    const point = { id: `new-${crypto.randomUUID()}`, landing: selected.landing, slip: selected.slip, latitude, longitude };
    points.push(point);
    drafts = drafts.filter((draft) => draft.landing !== point.landing || draft.slip !== point.slip);
    selected.pointId = point.id;
  });
  message("Point added. Turn off map clicks when you are done placing points.");
});
map.on("mousemove", (event) => { $("pointer").textContent = `${event.latlng.lat.toFixed(7)}, ${event.latlng.lng.toFixed(7)}`; });
map.on("zoomend", () => { $("zoom").textContent = `z${map.getZoom()}${map.getZoom() > 19 ? " · overzoom" : ""}`; });
$("zoom").textContent = `z${map.getZoom()}`;
function undo() {
  if (!history.length || saving) return;
  ({ points, drafts, selected } = history.pop());
  $("add-mode").checked = false;
  render();
  message("Undid the last edit.");
}
$("undo").addEventListener("click", undo);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && !event.target.closest("input, textarea")) {
    event.preventDefault(); undo();
  }
});
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
$("save").addEventListener("click", async () => {
  if (saving || !dirty()) return;
  if (drafts.length) { message(`Place a point for ${drafts[0].slip}, or delete that empty slip before saving.`, true); return; }
  saving = true;
  render();
  try {
    // Keep stable session identities for Undo; the CSV loader numbers rows anew on every save.
    const byId = new Map(points.map((point) => [point.id, point]));
    const ordered = [...serverOrder.filter((id) => byId.has(id)), ...points.filter((point) => !serverIds.has(point.id)).map((point) => point.id)];
    const response = await fetch("/api/survey", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, points: points.map((point) => ({ ...point, id: serverIds.get(point.id) ?? (point.id.startsWith("new-") ? point.id : `new-${point.id}`) })) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Save failed (${response.status}).`);
    if (body.points.length !== ordered.length) throw new Error("Unexpected save response. Reload to check the file.");
    serverIds = new Map(ordered.map((id, index) => [id, body.points[index].id]));
    serverOrder = ordered;
    for (const [index, id] of ordered.entries()) Object.assign(byId.get(id), { latitude: body.points[index].latitude, longitude: body.points[index].longitude });
    revision = body.revision;
    baseline = signature();
    message(`Saved ${points.length} points.${history.length ? " Undo is still available." : ""}`);
  } catch (error) { message(error.message, true); }
  finally { saving = false; render(); }
});
$("dwells").addEventListener("change", () => {
  if ($("dwells").checked) dwellLayer.addTo(map);
  else dwellLayer.remove();
});
async function load() {
  try {
    const response = await fetch("/api/survey");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    ({ points, landings, terminals, revision } = data);
    landings.sort((a, b) => a.name.localeCompare(b.name));
    serverIds = new Map(points.map((point) => [point.id, point.id]));
    serverOrder = points.map((point) => point.id);
    loaded = true;
    baseline = signature();
    render();
    message(`${points.length} survey points. Choose a landing to zoom in; survey markers are draggable.`);
  } catch (error) { message(`Could not load survey: ${error.message}`, true); return; }
  try {
    const response = await fetch("/api/dwells");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not read dwell layer.");
    if (!data.available) {
      if (data.message) $("dwell-status").textContent = data.message;
      return;
    }
    $("dwell-control").hidden = false;
    $("dwell-status").textContent = `${data.points.length.toLocaleString()} dwell dots${data.truncated ? " (latest 50,000)" : ""}`;
    const renderer = L.canvas({ padding: .5 });
    for (const point of data.points) {
      const marker = L.circleMarker([point.latitude, point.longitude], { renderer, radius: 2, weight: 0, fillColor: "#f18224", fillOpacity: .6 }).addTo(dwellLayer);
      marker.bindTooltip(textElement("span", `${point.terminal_id ?? "Unknown terminal"} · ${point.slip_id ?? "unassigned"} · ${point.since ?? ""} – ${point.until ?? "ongoing"}${point.heading_degrees == null ? "" : ` · ${point.heading_degrees}°`}`));
    }
  } catch (error) { $("dwell-status").textContent = `Dwell layer unavailable: ${error.message}`; }
}
load();
