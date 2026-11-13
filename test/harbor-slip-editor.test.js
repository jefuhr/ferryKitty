import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { loadSurvey, serializeSurvey, assertRevision } from "../lib/harbor-slip-editor.js";
import { parseSlipCsv } from "../lib/harbor-slips.js";
import { startEditor, readDwells } from "../scripts/harbor-slip-editor.mjs";

const stops = [{ stopId: "87", name: "Pier 11", latitude: 40.7, longitude: -74 }];
const csv = 'landing,slip,latitude,longitude\r\nPier 11,North,40.7000000,-74.000\r\nPier 11,North,40.700100,-74.0001\r\nPier 11,"South, lower",40.6999,-74.00020\r\n';
const load = (text = csv) => loadSurvey(text, { stops });

test("slip editor: no edits preserve every byte, CRLF, quoting and coordinate text", () => {
  const survey = load();
  assert.equal(serializeSurvey(survey, structuredClone(survey.points)), csv);
  for (const source of [csv.trimEnd(), csv.replaceAll("\r\n", "\n"), csv + "\r\n"]) {
    const loaded = load(source);
    assert.equal(serializeSurvey(loaded, loaded.points), source);
  }
});

test("slip editor: moving one point changes only its coordinate cells and preserves existing row order", () => {
  const survey = load();
  const points = structuredClone(survey.points).reverse();
  points.find((point) => point.id === survey.points[1].id).latitude = 40.7002;
  assert.equal(serializeSurvey(survey, points), csv.replace("40.700100", "40.7002000"));
});

test("slip editor: editing the returned point array does not overwrite its original CSV baseline", () => {
  const survey = load();
  survey.points[0].latitude = 40.7003;
  assert.equal(serializeSurvey(survey, survey.points), csv.replace("40.7000000", "40.7003000"));
  survey.points.push({ id: "new-mutated", landing: "Pier C", slip: "Slip 3", latitude: 40.71, longitude: -74.02 });
  assert.equal(serializeSurvey(survey, survey.points), csv.replace("40.7000000", "40.7003000") + "Pier C,Slip 3,40.7100000,-74.0200000\r\n");
});

test("slip editor: add, rename and delete retain untouched rows and round trip through the tracker", () => {
  const survey = load();
  const points = survey.points.filter((point) => point.id !== survey.points[2].id)
    .map((point) => ({ ...point, slip: 'Berth "A", upper' }));
  points.push({ id: "new-1", landing: "Pier C", slip: "Slip 3", latitude: 40.71, longitude: -74.02 });
  const output = serializeSurvey(survey, points);
  assert.equal(output, 'landing,slip,latitude,longitude\r\nPier 11,"Berth ""A"", upper",40.7000000,-74.000\r\nPier 11,"Berth ""A"", upper",40.700100,-74.0001\r\nPier C,Slip 3,40.7100000,-74.0200000\r\n');
  const warnings = [];
  const slips = parseSlipCsv(output, { stops, warn: (message) => warnings.push(message) });
  assert.deepEqual(warnings, []);
  assert.equal(slips.length, 2);
  assert.equal(slips[0].points.length, 2);
});

test("slip editor: invalid coordinates, names, landings and point identities are refused", () => {
  const survey = load();
  for (const patch of [
    { latitude: NaN }, { latitude: Infinity }, { latitude: null }, { longitude: "-74" },
    { latitude: 0 }, { longitude: -180 }, { landing: "" }, { slip: " " },
    { landing: "Partner Pier" }, { slip: "North\nSouth" }, { id: "forged" }
  ]) {
    assert.throws(() => serializeSurvey(survey, [{ ...survey.points[0], ...patch }]), /.+/);
  }
  assert.throws(() => serializeSurvey(survey, [survey.points[0], survey.points[0]]), /duplicate/i);
  assert.throws(() => serializeSurvey(survey, null), /array/i);
  assert.throws(() => load(csv.replace("Pier 11,North", "Unknown,North")), /unknown/i);
});

test("slip editor: changing the survey on disk invalidates its loaded revision", () => {
  const survey = load();
  assert.doesNotThrow(() => assertRevision(csv, survey.revision));
  assert.throws(() => assertRevision(csv + "\n", survey.revision), /changed on disk/i);
});

test("slip editor: HTTP load, save, readback, conflict and local-origin protection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slip-editor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const slipsPath = path.join(directory, "slips.csv");
  const httpCsv = csv.replaceAll("Pier 11", "Wall St/Pier 11");
  await writeFile(slipsPath, httpCsv);
  const { server, url } = await startEditor({ slipsPath, port: 0, dwellPath: path.join(directory, "missing.db") });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const initial = await (await fetch(`${url}/api/survey`)).json();
  assert.equal(initial.points.length, 3);
  assert.equal(await readFile(slipsPath, "utf8"), httpCsv);
  assert.equal((await (await fetch(`${url}/api/dwells`)).json()).available, false);
  const post = (body, headers = {}) => fetch(`${url}/api/survey`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  const invalid = await post({ revision: initial.revision, points: [{ ...initial.points[0], latitude: 0 }] });
  assert.equal(invalid.status, 400);
  assert.equal(await readFile(slipsPath, "utf8"), httpCsv);
  const points = structuredClone(initial.points);
  points[0].longitude = -74.0003;
  const saved = await post({ revision: initial.revision, points });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(slipsPath, "utf8"), httpCsv.replace("-74.000\r", "-74.0003000\r"));
  assert.equal((await post({ revision: initial.revision, points })).status, 409);
  const fresh = await saved.json();
  await writeFile(slipsPath, httpCsv + "\r\n");
  const conflict = await post({ revision: fresh.revision, points: fresh.points });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /changed on disk/i);
  assert.equal(await readFile(slipsPath, "utf8"), httpCsv + "\r\n");
  assert.equal((await post({ revision: initial.revision, points }, { origin: "https://example.com" })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(`${url}/../package.json`)).status, 404);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /tile\.openstreetmap\.org/);
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  for (const resource of ["/editor.js", "/editor.css", "/vendor/leaflet.js", "/vendor/leaflet.css"]) {
    assert.equal((await fetch(`${url}${resource}`)).status, 200);
  }
});


test("slip editor: recorded dwell positions are read without changing the database", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(path.join(os.tmpdir(), "slip-editor-dwell-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "harbor.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE dwells (terminal_id TEXT, slip_id TEXT, latitude REAL, longitude REAL, heading_degrees REAL, since TEXT, until TEXT)");
  database.prepare("INSERT INTO dwells VALUES (?, ?, ?, ?, ?, ?, ?)").run("87", "NYCF_87_NORTH", 40.7, -74, 90, "2026-11-13T10:00:00Z", null);
  database.close();
  const before = await readFile(databasePath);
  const result = await readDwells(databasePath);
  assert.equal(result.available, true);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].heading_degrees, 90);
  assert.deepEqual(await readFile(databasePath), before);
});
