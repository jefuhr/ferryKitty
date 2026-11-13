import { createHash } from "node:crypto";
import { parseSlipCsv } from "./harbor-slips.js";

export const HARBOR_BOUNDS = Object.freeze({ south: 40.35, north: 41.05, west: -74.4, east: -73.65 });

const revisionOf = (text) => createHash("sha256").update(text).digest("hex");
const quote = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

// Retain raw cells and record terminators so saving does not normalise untouched CSV.
function records(text) {
  const result = [];
  let start = 0, cellStart = 0, quoted = false, cells = [];
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    }
    if (!quoted && (char === "," || char === "\n" || char === "\r" || index === text.length)) {
      cells.push(text.slice(cellStart, index));
      cellStart = index + 1;
      if (char !== ",") {
        const end = index + (char === "\r" && text[index + 1] === "\n" ? 2 : char ? 1 : 0);
        if (index > start || end > start) result.push({ cells, raw: text.slice(start, end), eol: text.slice(index, end) });
        index = end - (end === text.length && !char ? 0 : 1);
        start = end;
        cellStart = end;
        cells = [];
      }
    }
  }
  if (quoted) throw new Error("The survey has an unterminated quoted field.");
  return result;
}

function decode(cell) {
  const value = cell.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.slice(1, -1).replaceAll('""', "").includes('"')) {
      throw new Error("The survey has malformed CSV quoting.");
    }
    return value.slice(1, -1).replaceAll('""', '"').trim();
  }
  if (value.includes('"')) throw new Error("The survey has malformed CSV quoting.");
  return value;
}

export function assertRevision(text, revision) {
  if (typeof revision !== "string" || revisionOf(text) !== revision) {
    const error = new Error("The survey changed on disk since it was loaded. Reload the page before saving; your edits have not been written.");
    error.statusCode = 409;
    throw error;
  }
}

export function validatePoints(points, { stops, existingIds = new Set() }) {
  if (!Array.isArray(points)) throw new Error("Points must be an array.");
  if (points.length > 20_000) throw new Error("The survey exceeds the 20,000 point limit.");
  const known = new Set([...stops.map((stop) => stop.name.trim()), "Pier C"]);
  const ids = new Set();
  for (const point of points) {
    if (!point || typeof point.id !== "string" || (!existingIds.has(point.id) && !/^new-[\w-]+$/.test(point.id))) {
      throw new Error("Every point must have a valid loaded or new point ID.");
    }
    if (ids.has(point.id)) throw new Error(`Duplicate point ID: ${point.id}`);
    ids.add(point.id);
    for (const field of ["landing", "slip"]) {
      if (typeof point[field] !== "string" || !point[field].trim() || point[field] !== point[field].trim() || point[field].length > 200 || /[\x00-\x1f\x7f]/.test(point[field])) {
        throw new Error(`Point ${point.id} needs a non-empty ${field} name without surrounding whitespace or control characters (maximum 200 characters).`);
      }
    }
    if (!known.has(point.landing)) throw new Error(`Unknown slip landing: ${point.landing}. Partner terminals are reference-only.`);
    const { latitude, longitude } = point;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < HARBOR_BOUNDS.south || latitude > HARBOR_BOUNDS.north || longitude < HARBOR_BOUNDS.west || longitude > HARBOR_BOUNDS.east) {
      throw new Error(`Point ${point.id} must have finite numeric coordinates inside New York Harbor (latitude ${HARBOR_BOUNDS.south}–${HARBOR_BOUNDS.north}, longitude ${HARBOR_BOUNDS.west}–${HARBOR_BOUNDS.east}).`);
    }
  }
  return points;
}

export function loadSurvey(text, { stops }) {
  const rows = records(text);
  const header = rows.shift();
  if (!header || header.cells.map(decode).join(",") !== "landing,slip,latitude,longitude") {
    throw new Error("Expected CSV header: landing,slip,latitude,longitude");
  }
  const points = [];
  for (const [index, row] of rows.entries()) {
    if (!row.raw.trim()) continue;
    if (row.cells.length !== 4) throw new Error(`Survey row ${index + 2} must have four fields.`);
    const [landing, slip, latitude, longitude] = row.cells.map(decode);
    const point = { id: `row-${index}`, landing, slip, latitude: latitude ? Number(latitude) : NaN, longitude: longitude ? Number(longitude) : NaN };
    row.point = { ...point };
    points.push(point);
  }
  validatePoints(points, { stops, existingIds: new Set(points.map((point) => point.id)) });
  const warnings = [];
  const loaded = parseSlipCsv(text, { stops, warn: (message) => warnings.push(message) });
  if (warnings.length || loaded.reduce((total, slip) => total + slip.points.length, 0) !== points.length) {
    throw new Error(`The tracker could not load the complete survey: ${warnings.join("; ")}`);
  }
  return { revision: revisionOf(text), points, header, rows, stops, newline: header.eol || "\n", text };
}

export function serializeSurvey(survey, points) {
  const existing = new Set(survey.rows.filter((row) => row.point).map((row) => row.point.id));
  validatePoints(points, { stops: survey.stops, existingIds: existing });
  const byId = new Map(points.map((point) => [point.id, point]));
  let text = survey.header.raw;
  for (const row of survey.rows) {
    if (!row.point) { text += row.raw; continue; }
    const point = byId.get(row.point.id);
    if (!point) continue;
    const fields = ["landing", "slip", "latitude", "longitude"];
    const cells = fields.map((field, index) => point[field] === row.point[field]
      ? row.cells[index] : index < 2 ? quote(point[field]) : point[field].toFixed(7));
    text += cells.join(",") + row.eol;
  }
  for (const point of points.filter((point) => !existing.has(point.id))) {
    if (text && !/[\r\n]$/.test(text)) text += survey.newline;
    text += [quote(point.landing), quote(point.slip), point.latitude.toFixed(7), point.longitude.toFixed(7)].join(",") + survey.newline;
  }
  // Run the exact tracker loader as a final guard, including quoted names and yard handling.
  const loaded = loadSurvey(text, { stops: survey.stops });
  if (loaded.points.length !== points.length) throw new Error("The saved survey would lose points.");
  return text;
}
