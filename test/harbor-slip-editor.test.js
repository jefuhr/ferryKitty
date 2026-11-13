import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";
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

test("slip editor: boat proxy allows only the local tracker and returns a minimal positioned fleet", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slip-editor-boats-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const slipsPath = path.join(directory, "slips.csv");
  await writeFile(slipsPath, csv.replaceAll("Pier 11", "Wall St/Pier 11"));
  const requests = [];
  let status = 200, payload = { vessels: [
    { name: "Test Ferry", operatorName: "Test Operator", latitude: 40.7, longitude: -74, bearing: 90,
      speedKnots: 0.2, ageSeconds: 12, state: "docked", stale: false, landing: { name: "Pier 11" },
      slip: { name: "North" }, mmsi: 123456789, secret: "must not be forwarded" },
    { name: "Old Ferry", operatorName: "Other Operator", latitude: 40.71, longitude: -74.01,
      bearing: null, speedKnots: null, ageSeconds: 400, state: "underway", stale: true },
    { name: "No Fix", latitude: null, longitude: null },
    { name: "Invalid Fix", latitude: 100, longitude: -74 }
  ] };
  const tracker = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (payload === "hang") return;
    response.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "/redirected" } : {}) });
    response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  await new Promise((resolve) => tracker.listen(0, "127.0.0.1", resolve));
  t.after(() => tracker.listening ? new Promise((resolve) => tracker.close(resolve)) : undefined);
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}`;
  const { server, url } = await startEditor({ slipsPath, port: 0, trackerUrl });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${url}/api/boats`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true, boats: [
    { name: "Test Ferry", operatorName: "Test Operator", latitude: 40.7, longitude: -74, bearing: 90,
      speedKnots: 0.2, ageSeconds: 12, state: "docked", stale: false, mmsi: "123456789" },
    { name: "Old Ferry", operatorName: "Other Operator", latitude: 40.71, longitude: -74.01,
      bearing: null, speedKnots: null, ageSeconds: 400, state: "underway", stale: true, mmsi: null }
  ] });
  assert.deepEqual(requests, [{ method: "GET", url: "/api/harbor/vessels" }]);
  for (const badPayload of ["not JSON", { boats: [] }, { vessels: null }]) {
    payload = badPayload;
    const bad = await fetch(`${url}/api/boats`);
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { available: false, boats: [] });
  }
  payload = { vessels: [] };
  status = 503;
  assert.deepEqual(await (await fetch(`${url}/api/boats`)).json(), { available: false, boats: [] });
  // Refuse redirects rather than following a local tracker's instructions to another host.
  status = 302;
  const beforeRedirect = requests.length;
  assert.deepEqual(await (await fetch(`${url}/api/boats`)).json(), { available: false, boats: [] });
  assert.equal(requests.length, beforeRedirect + 1);
  status = 200;
  payload = { vessels: [] };
  const localhostEditor = await startEditor({ slipsPath, port: 0, trackerUrl: trackerUrl.replace("127.0.0.1", "localhost") });
  t.after(() => new Promise((resolve) => localhostEditor.server.close(resolve)));
  assert.deepEqual(await (await fetch(`${localhostEditor.url}/api/boats`)).json(), { available: true, boats: [] });
  payload = "hang";
  const timeoutStart = Date.now();
  const timedOut = await fetch(`${url}/api/boats`);
  assert.equal(timedOut.status, 200);
  assert.deepEqual(await timedOut.json(), { available: false, boats: [] });
  assert.ok(Date.now() - timeoutStart < 5000, "The tracker request is aborted after three seconds");
  await new Promise((resolve) => tracker.close(resolve));
  const unavailable = await fetch(`${url}/api/boats`);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), { available: false, boats: [] });
  assert.equal((await fetch(`${url}/api/survey`)).status, 200);
  const refused = spawnSync(process.execPath, ["scripts/harbor-slip-editor.mjs", "--tracker", "http://example.com"], { encoding: "utf8", timeout: 3000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /local.*http|http.*local/i);
  for (const trackerUrl of ["https://127.0.0.1:8090", "http://example.com", "http://192.168.1.1:8090", "file:///etc/hosts", "http://localhost.evil.example", "http://user:pass@localhost:8090"]) {
    await assert.rejects(startEditor({ slipsPath, port: 0, trackerUrl }), /local.*http|http.*local/i);
  }
});
