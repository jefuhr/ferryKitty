// Failure modes: fleet/roster drift, missing lookup indexes, learned identities overriding
// committed identities or binding a vessel twice, inactive identities disappearing, substring
// matches, duplicate normalized names, AIS aliases being ignored, and name fallbacks allowing a
// second MMSI to claim a vessel with a committed or learned binding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRoster, loadRoster, rosterFromFleet, resolveIdentity } from "../lib/harbor-roster.js";

const rosterPath = new URL("./fixtures/harbor/roster.json", import.meta.url);
const fixtureRoster = JSON.parse(readFileSync(rosterPath, "utf8"));

test("rosterFromFleet preserves fleet ids, names and numbers with unbound active defaults", () => {
  const fleet = [{ id: "sample", name: "Sample Vessel", number: "H-999", extra: true }];
  assert.deepEqual(rosterFromFleet(fleet), [{
    id: "sample", operatorId: "nycf", name: "Sample Vessel", number: "H-999",
    mmsi: null, callSign: null, aisNames: [], active: true
  }]);
  assert.equal(fleet[0].extra, true);
  assert.deepEqual(rosterFromFleet([]), []);
});

test("the committed roster stays exactly in step with the NYC Ferry fleet", async () => {
  const { vessels: fleet } = JSON.parse(readFileSync(new URL("../content/vessels.json", import.meta.url), "utf8"));
  const committed = JSON.parse(readFileSync(new URL("../content/harbor-roster.json", import.meta.url), "utf8"));
  assert.equal(committed.version, 1);
  assert.deepEqual(committed.operators[0], { id: "nycf", name: "NYC Ferry", feedPrefix: "" });
  assert.deepEqual(committed.vessels.filter((vessel) => vessel.operatorId === "nycf"), rosterFromFleet(fleet));
  assert.equal(new Set(committed.vessels.map((vessel) => vessel.id)).size, committed.vessels.length);
  const loaded = await loadRoster({ rosterPath: new URL("../content/harbor-roster.json", import.meta.url) });
  assert.equal(loaded.byId.size, committed.vessels.length);
});

test("every other operator's vessel is namespaced, sourced, and its committed MMSI is unique and referenced", () => {
  const committed = JSON.parse(readFileSync(new URL("../content/harbor-roster.json", import.meta.url), "utf8"));
  const operators = new Map(committed.operators.map((operator) => [operator.id, operator]));
  assert.equal(new Set(committed.operators.map((operator) => operator.feedPrefix)).size, committed.operators.length);
  const mmsis = new Set();
  for (const vessel of committed.vessels) {
    assert.ok(operators.has(vessel.operatorId), `${vessel.id}: unknown operator`);
    if (vessel.operatorId === "nycf") continue;
    assert.ok(vessel.id.startsWith(`${vessel.operatorId}:`), `${vessel.id}: id is not namespaced`);
    assert.ok(vessel.references?.some((reference) => reference.field === "name" && reference.url), `${vessel.id}: no source for the vessel itself`);
    if (vessel.mmsi) {
      assert.match(vessel.mmsi, /^\d{9}$/);
      assert.ok(!mmsis.has(vessel.mmsi), `${vessel.id}: MMSI used twice`);
      mmsis.add(vessel.mmsi);
      assert.ok(vessel.references.some((reference) => reference.field === "mmsi" && reference.value === vessel.mmsi && reference.url), `${vessel.id}: MMSI has no source`);
    }
  }
});

test("loadRoster indexes committed identities while preserving inactive entries", async () => {
  const roster = await loadRoster({ rosterPath });
  assert.deepEqual(roster.operators, fixtureRoster.operators);
  assert.deepEqual(roster.vessels, fixtureRoster.vessels);
  assert.equal(roster.byId.size, 4);
  assert.equal(roster.byMmsi.size, 3);
  assert.equal(roster.byId.get("test-ferry-one").name, "Test Ferry One");
  assert.equal(roster.byId.get("test-ferry-one").learned, false);
  assert.deepEqual(roster.byMmsi.get("367000001"), { vesselId: "test-ferry-one", source: "roster", at: null });
  assert.deepEqual(resolveIdentity({ mmsi: "367000009" }, roster), { vesselId: "test-ferry-retired", source: "roster" });
  assert.equal(roster.byId.get("test-ferry-retired").active, false);
});

test("learned identities retain their source and cannot override committed or existing bindings", async () => {
  const learned = [
    { mmsi: "367000001", vesselId: "test-ferry-two", source: "proximity", at: 1 },
    { mmsi: "367000011", vesselId: "test-ferry-one", source: "proximity", at: 2 },
    { mmsi: "367000012", vesselId: "unknown", source: "proximity", at: 3 },
    { mmsi: "367000002", vesselId: "test-ferry-two", source: "proximity", at: 4 },
    { mmsi: "367000022", vesselId: "test-ferry-two", source: "proximity", at: 5 }
  ];
  const roster = await loadRoster({ rosterPath, learned });
  assert.equal(roster.byMmsi.size, 4);
  assert.deepEqual(roster.byMmsi.get("367000002"), { vesselId: "test-ferry-two", source: "proximity", at: 4 });
  assert.equal(roster.byId.get("test-ferry-two").mmsi, "367000002");
  assert.equal(roster.byId.get("test-ferry-two").learned, true);
  assert.deepEqual(resolveIdentity({ mmsi: "367000001", staticData: { name: "Test Ferry Two" } }, roster), { vesselId: "test-ferry-one", source: "roster" });
  assert.deepEqual(resolveIdentity({ mmsi: "367000002" }, roster), { vesselId: "test-ferry-two", source: "proximity" });
  for (const mmsi of ["367000011", "367000012", "367000022"]) assert.equal(roster.byMmsi.has(mmsi), false);
  assert.deepEqual(learned[3], { mmsi: "367000002", vesselId: "test-ferry-two", source: "proximity", at: 4 });
});

test("buildRoster is pure and refuses a second learned vessel for an occupied MMSI", () => {
  const data = structuredClone(fixtureRoster);
  data.vessels.push({ ...data.vessels[1], id: "another-unbound-vessel" });
  const before = structuredClone(data);
  const roster = buildRoster(data, [
    { mmsi: "367000002", vesselId: "test-ferry-two", source: "proximity", at: 10 },
    { mmsi: "367000002", vesselId: "another-unbound-vessel", source: "proximity", at: 11 }
  ]);
  assert.equal(roster.byId.get("another-unbound-vessel").mmsi, null);
  assert.equal(roster.byId.get("another-unbound-vessel").learned, false);
  assert.equal(roster.byMmsi.get("367000002").vesselId, "test-ferry-two");
  assert.deepEqual(data, before);
});

test("identity falls back to one exact normalized name or AIS alias", async () => {
  const roster = await loadRoster({ rosterPath });
  for (const name of ["  TÉST FERRY TWO@@ ", "TEST FERRY 2"]) {
    assert.deepEqual(resolveIdentity({ mmsi: "367099999", staticData: { name } }, roster), { vesselId: "test-ferry-two", source: "ais-name" });
  }
  assert.equal(resolveIdentity({ staticData: { name: "Test Ferry Retired" } }, roster), null);
  for (const name of ["Test Ferry", "Test Ferry Two Extended", "", null]) {
    assert.equal(resolveIdentity({ staticData: { name } }, roster), null);
  }
  assert.equal(resolveIdentity({}, roster), null);
});

test("name fallback cannot claim a vessel already bound to a different MMSI", () => {
  const roster = buildRoster(fixtureRoster);
  const vessel = roster.byId.get("test-ferry-one");
  assert.equal(resolveIdentity({ mmsi: "367099999", staticData: { name: vessel.name } }, roster), null);
  assert.deepEqual(resolveIdentity({ mmsi: vessel.mmsi, staticData: { name: vessel.name } }, roster), {
    vesselId: vessel.id, source: "roster"
  });
  assert.deepEqual(resolveIdentity({ mmsi: "367099999", staticData: { name: "Test Ferry Two" } }, roster), {
    vesselId: "test-ferry-two", source: "ais-name"
  });
});

test("name fallback checks learned MMSIs in byId rather than the committed vessel array", () => {
  const roster = buildRoster(fixtureRoster, [
    { mmsi: "367000002", vesselId: "test-ferry-two", source: "proximity", at: 10 }
  ]);
  assert.equal(roster.vessels.find((vessel) => vessel.id === "test-ferry-two").mmsi, null);
  for (const name of ["Test Ferry Two", "TEST FERRY 2"]) {
    assert.equal(resolveIdentity({ mmsi: "367099999", staticData: { name } }, roster), null);
  }
  assert.deepEqual(resolveIdentity({ mmsi: "367000002", staticData: { name: "Test Ferry Two" } }, roster), {
    vesselId: "test-ferry-two", source: "proximity"
  });
});

test("two normalized name matches are ambiguous, including aliases, but MMSI still wins", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harbor-roster-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customPath = path.join(directory, "roster.json");
  const data = structuredClone(fixtureRoster);
  data.vessels[0].mmsi = null;
  data.vessels[0].aisNames = ["Tést Ferry Two", "TEST FERRY 2"];
  data.vessels[1].aisNames.push("Test Ferry Two");
  await writeFile(customPath, JSON.stringify(data));
  const roster = await loadRoster({ rosterPath: customPath });
  assert.equal(resolveIdentity({ staticData: { name: "TEST FERRY TWO" } }, roster), null);
  assert.equal(resolveIdentity({ staticData: { name: "TEST FERRY 2" } }, roster), null);
  data.vessels[0].mmsi = "367000001";
  const bound = buildRoster(data);
  assert.deepEqual(resolveIdentity({ mmsi: "367000001", staticData: { name: "TEST FERRY TWO" } }, bound), { vesselId: "test-ferry-one", source: "roster" });
  assert.deepEqual(resolveIdentity({ mmsi: "367099999", staticData: { name: "TEST FERRY TWO" } }, bound), { vesselId: "test-ferry-two", source: "ais-name" });
});
