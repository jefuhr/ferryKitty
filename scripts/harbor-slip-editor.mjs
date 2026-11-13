#!/usr/bin/env node
import http from "node:http";
import { readFile, writeFile, rename, unlink, stat, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../lib/schedule-builder.js";
import { assertRevision, loadSurvey, serializeSurvey } from "../lib/harbor-slip-editor.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATIC = new Map([
  ["/", ["tools/slip-editor/index.html", "text/html; charset=utf-8"]],
  ["/editor.js", ["tools/slip-editor/editor.js", "text/javascript; charset=utf-8"]],
  ["/editor.css", ["tools/slip-editor/editor.css", "text/css; charset=utf-8"]],
  ["/vendor/leaflet.js", ["node_modules/leaflet/dist/leaflet-src.esm.js", "text/javascript; charset=utf-8"]],
  ["/vendor/leaflet.css", ["node_modules/leaflet/dist/leaflet.css", "text/css; charset=utf-8"]]
]);

async function metadata() {
  const [csv, boardText, terminalText] = await Promise.all([
    readFile(path.join(ROOT, "gtfs/stops.txt"), "utf8"),
    readFile(path.join(ROOT, "config/landings.json"), "utf8"),
    readFile(path.join(ROOT, "config/harbor-terminals.json"), "utf8")
  ]);
  const stops = parseCsv(csv).map((row) => ({ stopId: row.stop_id, name: row.stop_name.trim(), latitude: Number(row.stop_lat), longitude: Number(row.stop_lon) }));
  const boards = Object.values(JSON.parse(boardText)).filter((landing) => !landing.unused);
  const landings = stops.filter((stop) => boards.some((landing) => landing.stopIds?.includes(stop.stopId))).map((stop) => ({ ...stop, editable: true,
    displayName: boards.find((landing) => landing.stopIds?.includes(stop.stopId))?.displayName ?? stop.name }));
  if (!landings.some((landing) => landing.name === "Pier C")) {
    const yard = boards.find((landing) => landing.name === "Pier C");
    if (!yard) throw new Error("Missing Pier C reference coordinates in config/landings.json.");
    landings.push({ ...yard, editable: true });
  }
  for (const board of boards.filter((landing) => !landing.stopIds?.length)) {
    landings.push({ ...board, editable: false });
  }
  const terminals = JSON.parse(terminalText).terminals.map((terminal) => ({ ...terminal, editable: false }));
  return { stops, landings, terminals };
}

export async function readDwells(dwellPath) {
  try { await access(dwellPath); }
  catch (error) {
    if (error.code === "ENOENT") return { available: false, points: [] };
    throw error;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dwellPath, { readOnly: true });
  try {
    const limit = 50_000;
    const rows = database.prepare(`SELECT terminal_id, slip_id, latitude, longitude, heading_degrees, since, until FROM dwells
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY since DESC LIMIT ?`).all(limit + 1);
    return { available: true, truncated: rows.length > limit,
      points: rows.slice(0, limit).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) };
  } finally { database.close(); }
}

function localTrackerUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report the same validation error for malformed URLs. */ }
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("The tracker must use a local HTTP URL on 127.0.0.1 or localhost, without credentials.");
  }
  return new URL("/api/harbor/vessels", url.origin);
}

async function readBoats(trackerUrl) {
  try {
    const response = await fetch(trackerUrl, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok) return { available: false, boats: [] };
    const data = await response.json();
    if (!Array.isArray(data?.vessels)) return { available: false, boats: [] };
    const numeric = (value) => Number.isFinite(value) ? value : null;
    const boats = data.vessels.filter((boat) => boat && Number.isFinite(boat.latitude) && Number.isFinite(boat.longitude)
      && Math.abs(boat.latitude) <= 90 && Math.abs(boat.longitude) <= 180).map((boat) => ({
      name: typeof boat.name === "string" ? boat.name : "Unnamed boat",
      operatorName: typeof boat.operatorName === "string" ? boat.operatorName : "Unknown operator",
      latitude: boat.latitude, longitude: boat.longitude, bearing: numeric(boat.bearing),
      speedKnots: numeric(boat.speedKnots), ageSeconds: numeric(boat.ageSeconds),
      state: typeof boat.state === "string" ? boat.state : "unknown", stale: boat.stale === true,
      mmsi: ["string", "number"].includes(typeof boat.mmsi) ? String(boat.mmsi) : null
    }));
    return { available: true, boats };
  } catch { return { available: false, boats: [] }; }
}

function publicSurvey(survey, meta) {
  const landings = [...meta.landings];
  for (const point of survey.points) {
    if (!landings.some((landing) => landing.name === point.landing)) {
      const stop = meta.stops.find((item) => item.name === point.landing);
      if (stop) landings.push({ ...stop, editable: true });
    }
  }
  return { revision: survey.revision, points: survey.points, landings, terminals: meta.terminals };
}

async function requestJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    const error = new Error("Save requests must use application/json.");
    error.statusCode = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4_000_000) {
      const error = new Error("The save request is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The save request must contain valid JSON."); }
}

export async function startEditor({ port = 8095, slipsPath = path.join(ROOT, "content/harbor-slips.csv"), dwellPath = path.join(ROOT, "state/harbor.db"), trackerUrl = "http://127.0.0.1:8090" } = {}) {
  const boatsUrl = localTrackerUrl(trackerUrl);
  const meta = await metadata();
  // Fail before listening if the input cannot safely round trip through the tracker.
  loadSurvey(await readFile(slipsPath, "utf8"), meta);
  let saving = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
        return json(403, { error: "This editor accepts requests from its own local page only." });
      }
      const pathname = new URL(request.url, origin).pathname;
      if (pathname === "/api/survey" && request.method === "GET") {
        return json(200, publicSurvey(loadSurvey(await readFile(slipsPath, "utf8"), meta), meta));
      }
      if (pathname === "/api/boats" && request.method === "GET") return json(200, await readBoats(boatsUrl));
      if (pathname === "/api/dwells" && request.method === "GET") {
        try { return json(200, await readDwells(dwellPath)); }
        catch (error) { return json(200, { available: false, points: [], message: `Dwell layer unavailable: ${error.message}` }); }
      }
      if (pathname === "/api/survey" && request.method === "POST") {
        const body = await requestJson(request);
        if (!body || typeof body !== "object") throw new Error("Expected a survey object.");
        const save = async () => {
          const current = await readFile(slipsPath, "utf8");
          assertRevision(current, body.revision);
          const survey = loadSurvey(current, meta);
          const text = serializeSurvey(survey, body.points);
          // A no-op save need not touch the inode or modification time.
          if (text === current) return publicSurvey(survey, meta);
          const temporary = `${slipsPath}.${randomUUID()}.tmp`;
          try {
            const info = await stat(slipsPath);
            await writeFile(temporary, text, { flag: "wx", mode: info.mode & 0o777 });
            assertRevision(await readFile(slipsPath, "utf8"), body.revision);
            await rename(temporary, slipsPath);
          } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
          return publicSurvey(loadSurvey(text, meta), meta);
        };
        const result = saving.then(save);
        saving = result.catch(() => {});
        return json(200, await result);
      }
      if (request.method === "GET" && STATIC.has(pathname)) {
        const [file, type] = STATIC.get(pathname);
        const content = await readFile(path.join(ROOT, file));
        response.writeHead(200, { "Content-Type": type });
        return response.end(content);
      }
      return json(404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) json(error.statusCode ?? 400, { error: error.message });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 1) {
      const flag = process.argv[index], value = process.argv[++index];
      if (flag === "--port" && /^\d+$/.test(value ?? "") && Number(value) <= 65535) options.port = Number(value);
      else if (flag === "--slips" && value) options.slipsPath = path.resolve(value);
      else if (flag === "--tracker" && value) options.trackerUrl = value;
      else throw new Error("Usage: npm run harbor:slips -- [--port 8095] [--slips path/to/slips.csv] [--tracker http://127.0.0.1:8090]");
    }
    const { url } = await startEditor(options);
    console.log(`Slip survey editor: ${url}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
