// Failure modes: weak or sparse dwell evidence, shared and root-feed terminals,
// linked MMSIs, malformed FCC rows and missing MMSIs, unsafe name-only joins,
// missing provenance, duplicate ids, conflicting roster names, CLI side effects,
// read-only database access, absent databases, and unreferenced confirmations.
// Complete history must survive capped pages with tied timestamps; numeric facts
// must keep matching string references without changing their integer types.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidates, parseFccShips, propose } from "../lib/harbor-research.js";
import { runHarborResearch } from "../scripts/harbor-research.mjs";
import { openHarborDb } from "../lib/harbor-db.js";
import { createHarborStore } from "../lib/harbor-store.js";

const operators = [
  { id: "nycf", feedPrefix: "" },
  { id: "waterway", feedPrefix: "wtr:" },
  { id: "seastreak", feedPrefix: "sea:" }
];
const terminals = [
  { id: "west", stopIds: ["wtr:1"] },
  { id: "east", stopIds: ["sea:2"] },
  { id: "shared", stopIds: ["wtr:3", "sea:4"] },
  { id: "root", stopIds: ["9001"] }
];
const roster = { operators, vessels: [], byMmsi: new Map() };
const sighting = (mmsi, extra = {}) => ({ mmsi, name: "Test Ferry", callSign: "WTEST", shipType: 60, ...extra });
const dwellsAt = (mmsi, ids) => ids.map((terminalId) => ({ mmsi, terminalId }));
const candidate = (extra = {}) => ({ ...sighting("367000001"), operatorGuess: "waterway", share: 1, dwellCount: 4, terminals: [{ terminalId: "west", count: 4 }], ...extra });

test("candidates rank by dwellCount × share and enforce inclusive share/count thresholds", () => {
  const result = candidates({ roster, terminals,
    sightings: [sighting("367000001"), sighting("367000002"), sighting("367000003"), sighting("367000004"), sighting("367000005")],
    dwells: [
      ...dwellsAt("367000001", ["west", "west", "west", "east", "missing"]),
      ...dwellsAt("367000002", ["west", "west"]),
      ...dwellsAt("367000003", ["west", "west", "east", "east", "missing"]),
      ...dwellsAt("367000004", ["west", "west", "west", "west"])
    ]
  });
  assert.deepEqual(result.map((x) => x.mmsi), ["367000004", "367000001", "367000002", "367000003", "367000005"]);
  assert.equal(result[1].operatorGuess, "waterway");
  assert.equal(result[1].share, 0.6);
  assert.equal(result[1].dwellCount, 5);
  assert.equal(result[2].operatorGuess, null);
  assert.equal(result[2].share, 1);
  assert.equal(result[3].operatorGuess, null);
  assert.equal(result[3].share, 0.4);
  assert.equal(result[4].share, 0);
  assert.equal(result[4].operatorGuess, null);
});

test("shared terminals count toward each operator and empty prefix only uses root stops", () => {
  const result = candidates({ roster, terminals, sightings: [sighting("367000001"), sighting("367000002")],
    dwells: [...dwellsAt("367000001", ["shared", "shared", "east"]), ...dwellsAt("367000002", ["root", "root", "root"])] });
  const shared = result.find((x) => x.mmsi === "367000001");
  assert.equal(shared.operatorGuess, "seastreak");
  assert.equal(shared.share, 1);
  assert.deepEqual(shared.terminals, [{ terminalId: "shared", count: 2 }, { terminalId: "east", count: 1 }]);
  assert.equal(result.find((x) => x.mmsi === "367000002").operatorGuess, "nycf");
});

test("operators tied above the share threshold remain unresolved with sorted tie evidence", () => {
  const [result] = candidates({ roster, terminals, sightings: [sighting("367000001")],
    dwells: dwellsAt("367000001", ["shared", "shared", "shared"]) });
  assert.equal(result.share, 1);
  assert.equal(result.operatorGuess, null);
  assert.deepEqual(result.tiedOperators, ["seastreak", "waterway"]);
});

test("candidates exclude both learned links and committed MMSIs without mutating inputs", () => {
  const input = { terminals, roster: { ...roster, vessels: [{ mmsi: "367000002" }], byMmsi: new Map([["367000001", { vesselId: "known" }]]) },
    sightings: [sighting("367000001"), sighting("367000002"), sighting("367000003")], dwells: dwellsAt("367000003", ["west", "west", "west"]) };
  const before = structuredClone(input);
  assert.deepEqual(candidates(input).map((x) => x.mmsi), ["367000003"]);
  assert.deepEqual(input, before);
});

// Invented records in the observed l_ship.zip layout: SH has 27 fields, EN 30.
function fccRow(type, values) {
  const row = Array(type === "SH" ? 27 : 30).fill("");
  row[0] = type;
  for (const [key, value] of Object.entries(values)) row[key] = value;
  return row.join("|");
}

test("FCC parser joins EN licensees by system id regardless of row order and handles malformed lines", () => {
  const text = [
    fccRow("SH", { 1: "123", 4: "WTEST", 9: "TEST FERRY", 21: "367000001" }),
    "SH|broken", "SH|123||||||||||||||||||||not-an-mmsi",
    fccRow("EN", { 1: "123", 4: "WTEST", 5: "CL", 7: "Not the licensee" }),
    fccRow("EN", { 1: "123", 4: "WTEST", 5: "L", 7: "Invented Ferries LLC" }),
    fccRow("EN", { 1: "456", 5: "L", 7: "Other Ferries LLC" }),
    fccRow("SH", { 1: "456", 4: "WOTHER", 9: "OTHER FERRY" }),
    fccRow("SH", { 1: "789", 4: "WBAD", 9: "BAD FERRY", 21: "123" }),
    "unrelated|row"
  ].join("\r\n");
  assert.deepEqual(parseFccShips(text), [
    { callSign: "WTEST", name: "TEST FERRY", mmsi: "367000001", licensee: "Invented Ferries LLC" },
    { callSign: "WOTHER", name: "OTHER FERRY", mmsi: null, licensee: "Other Ferries LLC" }
  ]);
});

test("proposal references every sourced field and preserves AIS, FCC and confirmation evidence", () => {
  const confirmations = new Map([["367000001", { operatorId: "waterway", name: "Test Ferry One", class: "Catamaran", capacity: 123, builder: "Example Yard", year: 2020, confidence: 0.95,
    references: ["operatorId", "name", "class", "capacity", "builder", "year"].map((field) => ({ field, value: { operatorId: "waterway", name: "Test Ferry One", class: "Catamaran", capacity: 123, builder: "Example Yard", year: 2020 }[field], url: "https://example.invalid/fleet", note: "Invented confirmation", retrievedAt: "2026-11-01" })) }]]);
  const input = { candidates: [candidate()], roster, confirmations,
    fcc: [{ callSign: "WFCC", name: "TEST FERRY ONE", mmsi: "367000001", licensee: "Invented Ferries LLC" }] };
  const before = structuredClone(input);
  const { vessels, conflicts, skipped } = propose(input);
  assert.equal(vessels.length, 1);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(skipped, []);
  const vessel = vessels[0];
  assert.equal(vessel.id, "waterway:test-ferry-one");
  assert.equal(vessel.mmsi, "367000001");
  assert.equal(vessel.callSign, "WFCC");
  assert.deepEqual(vessel.aisNames, ["Test Ferry"]);
  assert.equal(vessel.active, true);
  assert.equal(vessel.number, null);
  for (const field of ["operatorId", "name", "mmsi", "callSign", "aisNames", "class", "capacity", "builder", "year"]) {
    assert.ok(vessel.references.some((r) => r.field === field && JSON.stringify(r.value) === JSON.stringify(vessel[field])), field);
  }
  const observation = vessel.references.find((r) => r.field === "mmsi" && r.url === null);
  assert.match(observation.note, /367000001.*Test Ferry.*4/);
  assert.equal(observation.retrievedAt, null);
  assert.ok(vessel.references.some((r) => r.note.includes("Invented Ferries LLC")));
  assert.equal(vessel.references.find((r) => r.field === "capacity").retrievedAt, "2026-11-01");
  assert.deepEqual(input, before);
});

test("FCC identity joins never use name alone or a call sign with a conflicting MMSI", () => {
  const fcc = [{ name: "Test Ferry", callSign: "WTEST", mmsi: "367000099", licensee: "Wrong Owner" }];
  const result = propose({ candidates: [candidate()], fcc, roster, confirmations: {} });
  assert.equal(result.vessels[0].name, "Test Ferry");
  assert.ok(result.vessels[0].references.every((r) => !r.note.includes("Wrong Owner")));
  const byCallSign = propose({ candidates: [candidate()], fcc: [{ ...fcc[0], mmsi: null, name: "Official Test Ferry" }], roster, confirmations: {} });
  assert.equal(byCallSign.vessels[0].name, "Official Test Ferry");
});

test("duplicate proposed ids move both candidates to conflicts", () => {
  const result = propose({ candidates: [candidate(), candidate({ mmsi: "367000002" })], roster, fcc: [], confirmations: {} });
  assert.deepEqual(result.vessels, []);
  assert.equal(result.conflicts.length, 2);
  assert.ok(result.conflicts.every((x) => x.kind === "duplicate-id"));
});

test("a roster name bound to a different MMSI conflicts after normalization", () => {
  const result = propose({ candidates: [candidate({ name: "TEST-FERRY" })],
    roster: { ...roster, vessels: [{ id: "existing", name: "Test Ferry", mmsi: "367000099" }] }, fcc: [], confirmations: {} });
  assert.deepEqual(result.vessels, []);
  assert.equal(result.conflicts[0].kind, "roster-name-mmsi");
});

test("missing operators or usable names are explicitly skipped and object confirmations can resolve them", () => {
  const result = propose({ candidates: [candidate({ operatorGuess: null }), candidate({ mmsi: "367000002", name: "@@@" })], roster, fcc: [], confirmations: {} });
  assert.equal(result.skipped.length, 2);
  assert.equal(result.vessels.length, 0);
  const confirmed = propose({ candidates: [candidate({ operatorGuess: null })], roster, fcc: [], confirmations: { "367000001": { operatorId: "waterway", references: [{ field: "operatorId", value: "waterway", url: "https://example.invalid/operator", note: "Invented source" }] } } });
  assert.equal(confirmed.vessels.length, 1);
});

test("unreferenced or mismatched confirmation fields are dropped, including name and operator", () => {
  const result = propose({ candidates: [candidate()], roster, fcc: [], confirmations: { "367000001": {
    operatorId: "seastreak", name: "Unverified Rename", capacity: 999, year: 2026,
    references: [{ field: "capacity", value: 123, url: "https://example.invalid/wrong-value" }]
  } } });
  assert.equal(result.vessels[0].operatorId, "waterway");
  assert.equal(result.vessels[0].name, "Test Ferry");
  assert.equal(result.vessels[0].capacity, undefined);
  assert.equal(result.vessels[0].year, undefined);
  assert.deepEqual(result.dropped.map((x) => x.field), ["operatorId", "name", "capacity", "year"]);
});

test("integer capacity and year retain matching trimmed string references", () => {
  const result = propose({ candidates: [candidate()], roster, fcc: [], confirmations: { "367000001": {
    capacity: 149, year: 2020, references: [
      { field: "capacity", value: " 149 ", url: "https://example.invalid/capacity" },
      { field: "year", value: "2020", url: "https://example.invalid/year" }
    ]
  } } });
  assert.equal(result.vessels[0].capacity, 149);
  assert.equal(result.vessels[0].year, 2020);
  assert.equal(Number.isInteger(result.vessels[0].capacity), true);
  assert.equal(Number.isInteger(result.vessels[0].year), true);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.vessels[0].references.find((reference) => reference.field === "capacity").value, " 149 ");
  assert.equal(result.vessels[0].references.find((reference) => reference.field === "year").value, "2020");
});

async function withDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "harbor-research-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rosterPath = join(root, "roster.json");
  await writeFile(rosterPath, JSON.stringify({ operators, vessels: [] }));
  const calls = [];
  const store = {
    listSightings: async (options) => { calls.push(["sightings", options]); return [sighting("367000001"), sighting("367000002")]; },
    listDwells: async (options) => { calls.push(["dwells", options]); return [...dwellsAt("367000001", ["west", "west", "west"]), ...dwellsAt("367000002", ["west", "west", "west"])]; },
    listTerminals: async () => terminals,
    listAisLinks: async (options) => { calls.push(["links", options]); return [{ mmsi: "367000002", vesselId: "existing" }]; }
  };
  return { root, rosterPath, store, calls };
}

async function historyDatabase(t) {
  const deps = await withDirectory(t);
  const databasePath = join(deps.root, "harbor.db");
  const db = openHarborDb({ databasePath });
  const store = createHarborStore(db);
  store.syncTerminals(terminals.map((terminal) => ({ ...terminal, name: terminal.id, latitude: 1, longitude: 2 })), []);
  return { ...deps, databasePath, db, store };
}

test("script reads all 2001 real-store dwells before guessing an operator across tied pages", async (t) => {
  const deps = await historyDatabase(t);
  try {
    deps.db.transaction(() => {
      deps.store.recordSighting({ ...sighting("367000001"), at: 300 });
      for (let i = 0; i < 2001; i++) {
        deps.store.recordDwell({ trackKey: `track:${i}`, mmsi: "367000001", terminalId: i < 1001 ? "west" : "east", since: i < 1001 ? 100 : 200, until: 300 });
      }
    });
  } finally {
    deps.db.close();
  }
  const prints = [];
  const result = await runHarborResearch({ root: deps.root, rosterPath: deps.rosterPath,
    args: ["--dry", "--db", deps.databasePath], stdout: (value) => prints.push(value) });
  assert.deepEqual(result.vessels, []);
  assert.equal(result.skipped[0].mmsi, "367000001");
  assert.match(prints.join(""), /operator \?\s+share 0\.50\s+dwells 2001/);
  assert.match(prints.join(""), /dry run, nothing written/);
});

test("script pages real-store sightings sharing a timestamp to discover a ferry beyond the first 1000", async (t) => {
  const deps = await historyDatabase(t);
  const mmsi = "367001000";
  try {
    deps.db.transaction(() => {
      for (let i = 0; i < 1001; i++) deps.store.recordSighting({ mmsi: String(367000000 + i), name: `Test Ferry ${i}`, at: 100 });
      for (let i = 0; i < 3; i++) deps.store.recordDwell({ trackKey: `track:${i}`, mmsi, terminalId: "west", since: 100, until: 200 });
    });
  } finally {
    deps.db.close();
  }
  const prints = [];
  const result = await runHarborResearch({ root: deps.root, rosterPath: deps.rosterPath,
    args: ["--dry", "--db", deps.databasePath], stdout: (value) => prints.push(value) });
  assert.equal(result.vessels.length, 1);
  assert.equal(result.vessels[0].mmsi, mmsi);
  assert.equal(result.skipped.length, 1000);
  assert.match(prints[0], /1001 unlinked vessels seen/);
});

test("script --dry reads a fake store, reports what it would propose, writes nothing and does not call confirm", async (t) => {
  const deps = await withDirectory(t);
  const outPath = join(deps.root, "proposed.json");
  await writeFile(outPath, "untouched");
  const prints = [];
  const result = await runHarborResearch({ ...deps, args: ["--dry", "--db", join(deps.root, "unused.sqlite"), "--out", outPath],
    confirm: () => assert.fail("dry run called confirm"), stdout: (value) => prints.push(value) });
  assert.equal(result.vessels.length, 1);
  // A dry run reports what it would propose and says that nothing was written.
  assert.match(prints.join(""), /1 would be proposed.*nothing written/);
  assert.equal(await readFile(outPath, "utf8"), "untouched");
  assert.deepEqual((await readdir(deps.root)).sort(), ["proposed.json", "roster.json"]);
});

test("script writes proposals only, stamps dates, loads FCC text and injects the optional confirmation", async (t) => {
  const deps = await withDirectory(t);
  const initial = await readFile(deps.rosterPath, "utf8");
  const outPath = join(deps.root, "proposed.json");
  const fccPath = join(deps.root, "fcc.dat");
  await writeFile(fccPath, fccRow("SH", { 1: "123", 4: "WTEST", 9: "TEST FERRY", 21: "367000001" }));
  const prints = [];
  let confirmed = 0;
  await runHarborResearch({ ...deps, args: ["--out", outPath, "--fcc", fccPath], now: () => Date.UTC(2026, 10, 12), stdout: (value) => prints.push(value),
    confirm: async (value) => { confirmed++; assert.equal(value.mmsi, "367000001"); assert.equal(value.evidence.dwellCount, 3); return { capacity: 999, references: [] }; } });
  const result = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(confirmed, 1);
  assert.equal(result.vessels.length, 1);
  assert.ok(result.vessels[0].references.every((r) => r.retrievedAt === "2026-11-12"));
  assert.match(prints.join(""), /1 vessel.*0 conflict.*0 skipped/i);
  assert.match(prints.join(""), /capacity.*dropped.*lack of a source/i);
  assert.equal(await readFile(deps.rosterPath, "utf8"), initial);
});

test("script uses the supplied state directory and opens the database read-only", async (t) => {
  const deps = await withDirectory(t);
  const databasePath = join(deps.root, "harbor.db");
  await writeFile(databasePath, "invented database");
  let closed = 0;
  const database = { close: () => closed++ };
  const result = await runHarborResearch({ root: deps.root, rosterPath: deps.rosterPath, stateDir: deps.root, args: ["--dry"],
    openDb: (options) => { assert.deepEqual(options, { databasePath, readOnly: true }); return database; },
    createStore: (value) => { assert.equal(value, database); return deps.store; }, stdout: () => {} });
  assert.equal(result.vessels.length, 1);
  assert.equal(closed, 1);
  assert.equal(await readFile(databasePath, "utf8"), "invented database");
});

test("missing database gives a dry diagnostic and never creates a file or opens the database", async (t) => {
  const deps = await withDirectory(t);
  const prints = [];
  const databasePath = join(deps.root, "absent.db");
  const input = { root: deps.root, rosterPath: deps.rosterPath, stdout: (value) => prints.push(value), openDb: () => assert.fail("opened missing database") };
  await runHarborResearch({ ...input, args: ["--dry", "--db", databasePath] });
  assert.match(prints.join(""), /no harbor database to read yet/i);
  await assert.rejects(runHarborResearch({ ...input, args: ["--db", databasePath] }), /no harbor database to read yet/i);
  assert.deepEqual(await readdir(deps.root), ["roster.json"]);
});

test("script rejects unknown/missing flags and roster output before opening or writing anything", async (t) => {
  const deps = await withDirectory(t);
  for (const args of [["--wat"], ["--db"], ["--out", deps.rosterPath]]) {
    await assert.rejects(runHarborResearch({ ...deps, args }), /argument|value|roster/i);
  }
});

test("script refuses output paths that overwrite database or FCC inputs", async (t) => {
  const deps = await withDirectory(t);
  const input = join(deps.root, "input.dat");
  await writeFile(input, "original input");
  await assert.rejects(runHarborResearch({ ...deps, args: ["--db", input, "--out", input] }), /overwrite/i);
  await assert.rejects(runHarborResearch({ ...deps, args: ["--fcc", input, "--out", input] }), /overwrite/i);
  assert.equal(await readFile(input, "utf8"), "original input");
});
