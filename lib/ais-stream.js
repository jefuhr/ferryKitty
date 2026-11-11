// Keep wire-specific fields and reconnect state here so harbor consumers only see
// normalized records. A new socket always supersedes every callback from the old one.
export const HARBOR_BOUNDING_BOXES = [[[40.38, -74.12], [41.22, -73.75]]];
const MESSAGE_TYPES = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];
const POSITION_TYPES = new Set(MESSAGE_TYPES.slice(0, 3));
const WATCHDOG_MS = 120000;
const STABLE_MS = 60000;
const ERROR_DELAY_MS = 300000;

function mmsiString(value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^\d{1,9}$/.test(text) ? text.padStart(9, "0") : null;
}
function numeric(value, min = 0, max = Infinity) {
  return Number.isFinite(value) && value >= min && value < max ? value : null;
}
function aisText(value) {
  return typeof value === "string" ? value.replace(/@/g, "").trim() || null : null;
}
function dimensions(value) {
  if (!value || typeof value !== "object") return null;
  const dims = { a: numeric(value.A), b: numeric(value.B), c: numeric(value.C), d: numeric(value.D) };
  return Object.values(dims).some((n) => n > 0) ? dims : null;
}
function measuredAt(value, receivedAt) {
  // aisstream's observed timestamp includes Go's nanoseconds and zone suffix.
  // Reduce the fraction to milliseconds before asking Date to parse the offset.
  const text = typeof value === "string" ? value.trim().replace(/(\.\d{3})\d+/, "$1").replace(/ UTC$/, "") : "";
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? parsed : receivedAt;
}

/** StaticDataReport returns a patch; the stream merges patches per MMSI. */
export function normalizeAisMessage(raw, receivedAt = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.error === "string" || typeof raw.Error === "string") {
    return { kind: "error", message: typeof raw.error === "string" ? raw.error : raw.Error };
  }
  const type = raw.MessageType;
  if (!MESSAGE_TYPES.includes(type)) return null;
  const body = raw.Message?.[type];
  if (!body || typeof body !== "object" || body.Valid === false) return null;
  const mmsi = mmsiString(body.UserID) ?? mmsiString(raw.MetaData?.MMSI);
  if (!mmsi) return null;
  const at = measuredAt(raw.MetaData?.time_utc, receivedAt);
  if (POSITION_TYPES.has(type)) {
    const latitude = Number.isFinite(body.Latitude) && Math.abs(body.Latitude) <= 90 ? body.Latitude : null;
    const longitude = Number.isFinite(body.Longitude) && Math.abs(body.Longitude) <= 180 ? body.Longitude : null;
    if (latitude === null || longitude === null) return null;
    const aisClass = type === "PositionReport" ? "A" : "B";
    return { kind: "fix", fix: {
      mmsi, latitude, longitude, sogKnots: numeric(body.Sog, 0, 102.3),
      cogDegrees: numeric(body.Cog, 0, 360), headingDegrees: numeric(body.TrueHeading, 0, 360),
      navStatus: aisClass === "A" ? numeric(body.NavigationalStatus, 0, 16) : null,
      at, source: "ais", aisClass
    } };
  }
  if (type === "ShipStaticData") {
    return { kind: "static", static: { mmsi, name: aisText(body.Name), callSign: aisText(body.CallSign),
      shipType: numeric(body.Type), imo: numeric(body.ImoNumber, 1), dims: dimensions(body.Dimension), aisClass: "A", at } };
  }
  // Valid flags identify the populated reports; PartNumber is only a fallback
  // for older messages without either flag, and may be a boolean or a number.
  const explicitValidity = Object.hasOwn(body.ReportA ?? {}, "Valid") || Object.hasOwn(body.ReportB ?? {}, "Valid");
  const includeA = body.ReportA && (body.ReportA.Valid === true || (!explicitValidity && [false, 0].includes(body.PartNumber)));
  const includeB = body.ReportB && (body.ReportB.Valid === true || (!explicitValidity && [true, 1].includes(body.PartNumber)));
  if (!includeA && !includeB) return null;
  const patch = { mmsi, aisClass: "B", at };
  if (includeA) patch.name = aisText(body.ReportA.Name);
  if (includeB) {
    patch.shipType = numeric(body.ReportB.ShipType);
    patch.callSign = aisText(body.ReportB.CallSign);
    patch.dims = dimensions(body.ReportB.Dimension);
  }
  return { kind: "static", static: patch };
}

export function createAisStream({
  url = "wss://stream.aisstream.io/v0/stream", apiKey, boundingBoxes = HARBOR_BOUNDING_BOXES,
  mmsiFilter = null, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
  onFix = () => {}, onStatic = () => {}, onStatus = () => {}
} = {}) {
  const enabled = typeof apiKey === "string" && apiKey.trim().length > 0;
  const snapshot = { state: enabled ? "stopped" : "disabled", connected: false, lastMessageAt: null,
    connectedAt: null, reconnects: 0, messages: 0, dropped: 0, lastError: null };
  const staticByMmsi = new Map();
  let running = false, socket = null, retryTimer = null, watchdogTimer = null, stableTimer = null;
  let failures = 0;
  const status = () => ({ ...snapshot });
  function transition(state) {
    const changed = snapshot.state !== state;
    snapshot.state = state;
    snapshot.connected = state === "open";
    if (changed) onStatus(status());
  }
  function cancelConnectionTimers() {
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    if (stableTimer !== null) clearTimer(stableTimer);
    watchdogTimer = stableTimer = null;
  }
  function closeQuietly(old) {
    // A transport exception may contain the subscription key or the URL. Neither
    // is useful to callers, so transport failures only have fixed public messages.
    try { old?.close(); } catch { /* Reconnection must still happen if close fails. */ }
  }
  function reconnect(delayOverride) {
    if (!running) return;
    cancelConnectionTimers();
    const old = socket;
    socket = null;
    closeQuietly(old);
    const base = Math.min(1000 * (2 ** Math.min(failures++, 6)), 60000);
    const delay = delayOverride ?? base * (0.8 + 0.4 * random());
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!running) return;
      snapshot.reconnects += 1;
      connect();
    }, delay);
    transition("waiting");
  }
  function armWatchdog(active) {
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    watchdogTimer = setTimer(() => {
      watchdogTimer = null;
      if (running && socket === active) {
        snapshot.lastError = "AIS stream timed out";
        reconnect();
      }
    }, WATCHDOG_MS);
  }
  function connect() {
    if (!running || socket !== null) return;
    transition("connecting");
    if (!running) return;
    let active;
    try {
      active = new WebSocketImpl(url);
      socket = active;
      active.binaryType = "arraybuffer";
    } catch {
      snapshot.lastError = "AIS connection failed";
      reconnect();
      return;
    }
    const current = () => running && socket === active;
    active.addEventListener("open", () => {
      if (!current()) return;
      try {
        const subscription = { APIKey: apiKey, BoundingBoxes: boundingBoxes, FilterMessageTypes: MESSAGE_TYPES };
        if (mmsiFilter !== null) subscription.FiltersShipMMSI = mmsiFilter;
        active.send(JSON.stringify(subscription));
      } catch {
        snapshot.lastError = "AIS subscription failed";
        reconnect();
        return;
      }
      snapshot.connectedAt = now();
      snapshot.lastError = null;
      stableTimer = setTimer(() => { stableTimer = null; if (current()) failures = 0; }, STABLE_MS);
      armWatchdog(active);
      transition("open");
    });
    active.addEventListener("message", (event) => {
      if (!current() || snapshot.state !== "open") return;
      snapshot.lastMessageAt = now();
      snapshot.messages += 1;
      armWatchdog(active);
      let raw;
      try {
        const data = event.data;
        const text = typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data);
        raw = JSON.parse(text);
      } catch {
        snapshot.dropped += 1;
        return;
      }
      const record = normalizeAisMessage(raw, snapshot.lastMessageAt);
      if (record?.kind === "error") {
        snapshot.lastError = record.message.split(apiKey).join("[redacted]");
        reconnect(ERROR_DELAY_MS);
      } else if (record?.kind === "fix") {
        onFix(record.fix);
      } else if (record?.kind === "static") {
        const patch = record.static;
        const previous = staticByMmsi.get(patch.mmsi) ?? { name: null, callSign: null, shipType: null, imo: null, dims: null };
        const merged = { ...previous };
        // An unavailable field is not evidence that a known value disappeared.
        for (const [key, value] of Object.entries(patch)) {
          if (value !== null || key === "aisClass" || key === "at") merged[key] = value;
        }
        staticByMmsi.set(patch.mmsi, merged);
        onStatic({ ...merged, dims: merged.dims ? { ...merged.dims } : null });
      }
    });
    active.addEventListener("error", () => {
      if (!current()) return;
      snapshot.lastError = "AIS connection failed";
      reconnect();
    });
    active.addEventListener("close", () => { if (current()) reconnect(); });
  }
  function start() {
    if (!enabled || running) return;
    running = true;
    connect();
  }
  function stop() {
    running = false;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    cancelConnectionTimers();
    const old = socket;
    socket = null;
    closeQuietly(old);
    transition(enabled ? "stopped" : "disabled");
  }
  return { start, stop, status };
}
