// Failure modes: catalog ids drifting, label and yard kinds being lost, private coordinates in
// warnings, duplicate survey points becoming separate slips, incorrect landing bounds, outlier
// fixes, nearby-slip ambiguity, weak distant matches, and heading filters rejecting unknowns.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSlipCsv, slipId, buildSlipIndex, assignSlip } from "../lib/harbor-slips.js";
import { distanceMetres, offsetPoint } from "../lib/harbor-geo.js";

const fixture = (name) => new URL(`./fixtures/harbor/${name}`, import.meta.url);
const { stops } = JSON.parse(readFileSync(fixture("stops.json"), "utf8"));
const csv = readFileSync(fixture("slips.csv"), "utf8");
const emptyAssignment = { slipId: null, confidence: 0, ambiguous: false, candidates: [] };

function fixtureIndex() {
  const slips = parseSlipCsv(csv, { stops });
  const partner = stops.find((stop) => stop.stopId === "tst:1");
  const landings = [
    { landingStopId: "9001", landingId: "1", name: "Test Cove" },
    { ...partner, landingStopId: partner.stopId, landingId: "partner" }
  ];
  return buildSlipIndex(slips, { stops, landings });
}

function isolatedIndex() {
  const slip = parseSlipCsv(csv, { stops }).find((item) => item.name === "North");
  return { slip, index: buildSlipIndex([slip], { stops }) };
}

test("slipId covers every label rule without case sensitivity", () => {
  const rows = [
    ["Slip 2", "SLIP_2", "2", "passenger"],
    ["SLIP_25", "SLIP_25", "25", "passenger"],
    ["slip 2", "SLIP_2", "2", "passenger"],
    ["Slip B1", "B1", "B1", "passenger"],
    ["North", "NORTH", "N", "passenger"],
    ["South", "SOUTH", "S", "passenger"],
    ["East", "NORTH", "E", "passenger"],
    ["West", "SOUTH", "W", "passenger"],
    ["DOCK #1", "DOCK_1", "1", "passenger"],
    ["Outer Dock #1", "OUTER_DOCK_1", "1", "passenger"],
    ["Dry Dock", "DRY_DOCK", "DD", "drydock"],
    ["Slip 27 Fuel Tanks", "SLIP_27", "27", "fuel"],
    ["Slip 31 Annex", "SLIP_31", "31", "yard"]
  ];
  for (const [label, token, platformCode, kind] of rows) {
    for (const variant of [label, label.toLowerCase(), label.toUpperCase()]) {
      assert.deepEqual(slipId("9001", variant), {
        id: `NYCF_9001_${token}`, token, platformCode, kind
      });
    }
  }
});

test("slipId supports fallback tokens and alias overrides scoped to the real stop id", () => {
  assert.equal(slipId("9001", "Outer...Berth / A").token, "OUTER_BERTH_A");
  assert.deepEqual(slipId("9001", "Slip 44 Mystery"), {
    id: "NYCF_9001_SLIP_44_MYSTERY", token: "SLIP_44_MYSTERY", platformCode: null, kind: "passenger"
  });
  const aliases = { "9001|North": "CUSTOM", "home-port|Slip 2": "YARD_TWO" };
  assert.deepEqual(slipId("9001", "North", { aliases }), {
    id: "NYCF_9001_CUSTOM", token: "CUSTOM", platformCode: "N", kind: "passenger"
  });
  assert.equal(slipId("9002", "North", { aliases }).token, "NORTH");
  assert.deepEqual(slipId("PIERC", "Slip 2", { aliases, landingStopId: "home-port", yard: true }), {
    id: "NYCF_PIERC_YARD_TWO", token: "YARD_TWO", platformCode: "2", kind: "yard"
  });
  assert.equal(slipId("PIERC", "Dry Dock", { yard: true }).kind, "drydock");
  assert.equal(slipId("PIERC", "Slip 27 Fuel Tanks", { yard: true }).kind, "fuel");
});

test("the captured catalog's six slip entries retain their exact ids and platform codes", () => {
  const catalog = JSON.parse(readFileSync(new URL("./fixtures/ferry-rt-slips.json", import.meta.url), "utf8"));
  const rows = catalog.slips.slips;
  const excluded = rows.filter((row) => !row.id.startsWith("NYCF_"));
  // The coordinator confirmed this entry describes the landing itself, rather than a slip.
  assert.deepEqual(excluded, [{ id: "87", name: "Pier 11", platformCode: null, landingStopId: "87" }]);
  assert.equal(rows.length - excluded.length, 6);
  for (const row of rows.filter((item) => item.id.startsWith("NYCF_"))) {
    const result = slipId(row.landingStopId, row.name);
    assert.equal(result.id, row.id);
    assert.equal(result.platformCode, row.platformCode);
  }
});

test("CSV parsing merges repeated labels and keeps yard slip kinds and ids", () => {
  const slips = parseSlipCsv(csv, { stops });
  assert.equal(slips.length, 12);
  const annex = slips.find((slip) => slip.name === "Slip 31 Annex");
  assert.equal(annex.points.length, 2);
  assert.equal(annex.id, "NYCF_PIERC_SLIP_31");
  const yard = slips.filter((slip) => slip.landingStopId === "home-port");
  assert.equal(yard.length, 4);
  assert.deepEqual(yard.map((slip) => slip.kind), ["drydock", "yard", "fuel", "yard"]);
  assert.ok(yard.every((slip) => slip.id.startsWith("NYCF_PIERC_")));
  assert.ok(slips.every((slip) => Object.keys(slip).sort().join() === "id,kind,landingStopId,name,platformCode,points"));
});

test("an unknown landing warns once without disclosing its coordinate", () => {
  const warnings = [];
  parseSlipCsv(csv, { stops, warn: (...args) => warnings.push(args) });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].length, 1);
  assert.match(warnings[0][0], /Nowhere Landing/);
  const row = csv.trim().split("\n").at(-1).split(",");
  for (const coordinate of row.slice(2)) assert.ok(!warnings[0][0].includes(coordinate));
});

test("CSV parsing tolerates CRLF, whitespace, trailing newlines and quoted fields", () => {
  const padded = csv.trim().split("\n").map((line) => line.split(",").map((field) => ` ${field} `).join(",")).join("\r\n") + "\r\n\r\n";
  assert.deepEqual(parseSlipCsv(padded, { stops }), parseSlipCsv(csv, { stops }));
  const stop = { ...stops[0], name: "Test, Cove" };
  const line = `landing,slip,latitude,longitude\n"Test, Cove","Slip 2",${stop.latitude},${stop.longitude}\n`;
  assert.equal(parseSlipCsv(line, { stops: [stop] })[0].name, "Slip 2");
});

test("CSV parsing passes yard identity and aliases through to slipId", () => {
  const slips = parseSlipCsv(csv, { stops, aliases: { "home-port|SLIP_25": "CUSTOM_25" } });
  assert.equal(slips.find((slip) => slip.name === "SLIP_25").id, "NYCF_PIERC_CUSTOM_25");
});

test("the index exposes ids, landing metadata, mean centres and no-slip bounds", () => {
  const index = fixtureIndex();
  assert.equal(index.byId.size, index.slips.length);
  for (const slip of index.slips) assert.equal(index.byId.get(slip.id), slip);
  const cove = index.landings.find((landing) => landing.landingStopId === "9001");
  assert.equal(cove.name, "Test Cove");
  assert.equal(cove.landingId, "1");
  assert.equal(cove.yard, false);
  const points = index.slips.filter((slip) => slip.landingStopId === "9001").flatMap((slip) => slip.points);
  assert.ok(Math.abs(cove.latitude - points.reduce((sum, point) => sum + point.latitude, 0) / points.length) < 1e-10);
  assert.ok(Math.abs(cove.longitude - points.reduce((sum, point) => sum + point.longitude, 0) / points.length) < 1e-10);
  assert.deepEqual(cove.slipIds, index.slips.filter((slip) => slip.landingStopId === "9001").map((slip) => slip.id));
  assert.equal(index.landings.find((landing) => landing.landingStopId === "home-port").yard, true);
  const partner = index.landings.find((landing) => landing.landingStopId === "tst:1");
  const stop = stops.find((item) => item.stopId === "tst:1");
  assert.equal(distanceMetres(partner, stop), 0);
  assert.equal(partner.radiusMetres, 120);
  assert.deepEqual(partner.slipIds, []);
  const nearest = index.nearestLanding(stop);
  assert.equal(nearest.landing, partner);
  assert.equal(nearest.distanceMetres, 0);
  assert.equal(buildSlipIndex([], { stops: [] }).nearestLanding(stop), null);
});

test("landing bounds use the farthest slip point plus 60 m, with a 120 m floor", () => {
  const { slip } = isolatedIndex();
  const extended = { ...slip, points: [slip.points[0], offsetPoint(slip.points[0], 90, 300)] };
  const landing = buildSlipIndex([extended], { stops }).landings[0];
  const expected = Math.max(...extended.points.map((point) => distanceMetres(landing, point))) + 60;
  assert.ok(Math.abs(landing.radiusMetres - expected) < 1e-8);
  assert.equal(buildSlipIndex([slip], { stops }).landings[0].radiusMetres, 120);
});

test("slipsNear measures to the nearest surveyed point and sorts by distance", () => {
  const index = fixtureIndex();
  const annex = index.slips.find((slip) => slip.name === "Slip 31 Annex");
  const matches = index.slipsNear(annex.points[1], 0.01);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].slip.id, annex.id);
  assert.equal(matches[0].distanceMetres, 0);
  const nearby = index.slipsNear(index.slips[0].points[0], 100);
  assert.ok(nearby.length >= 2);
  assert.ok(nearby.every((entry, position) => position === 0 || entry.distanceMetres >= nearby[position - 1].distanceMetres));
  assert.deepEqual(index.slipsNear(offsetPoint(annex.points[1], 90, 5000), 60), []);
});

test("an isolated slip's probability follows the Gaussian and falls with distance", () => {
  const { slip, index } = isolatedIndex();
  const distances = [0, 12, 30, 44, 50];
  const results = distances.map((metres) => assignSlip([offsetPoint(slip.points[0], 90, metres)], index, { landingStopId: slip.landingStopId }));
  assert.equal(results[0].slipId, slip.id);
  assert.ok(results[0].confidence >= 0.6);
  assert.equal(results.at(-1).slipId, null);
  for (let position = 0; position < results.length; position += 1) {
    const expectedWeight = Math.exp(-(distances[position] ** 2) / (2 * 12 ** 2));
    const expectedP = expectedWeight / (expectedWeight + Math.exp(-(45 ** 2) / (2 * 12 ** 2)));
    assert.ok(Math.abs(results[position].confidence - expectedP) < 1e-7);
    if (position) assert.ok(results[position].confidence < results[position - 1].confidence);
  }
});

test("the two close Test Cove slips are ambiguous at their midpoint", () => {
  const index = fixtureIndex();
  const first = index.slips.find((slip) => slip.id === "NYCF_9001_SLIP_1");
  const second = index.slips.find((slip) => slip.id === "NYCF_9001_SLIP_2");
  assert.ok(Math.abs(distanceMetres(first.points[0], second.points[0]) - 14) < 1);
  const midpoint = {
    latitude: (first.points[0].latitude + second.points[0].latitude) / 2,
    longitude: (first.points[0].longitude + second.points[0].longitude) / 2
  };
  const result = assignSlip([midpoint], index, { landingStopId: "9001" });
  assert.equal(result.ambiguous, true);
  assert.ok(result.confidence <= 0.6);
  assert.equal(result.slipId, null);
  assert.ok(result.candidates.every((candidate, position) => position === 0 || candidate.p <= result.candidates[position - 1].p));
});

test("close slips cap confidence without replacing the candidate's probability", () => {
  const slips = fixtureIndex().slips.filter((slip) => ["NYCF_9001_SLIP_1", "NYCF_9001_SLIP_2"].includes(slip.id));
  const index = buildSlipIndex(slips, { stops });
  const result = assignSlip(slips[0].points, index, { landingStopId: "9001" });
  assert.ok(result.candidates[0].p > 0.6);
  assert.equal(result.confidence, 0.6);
  assert.equal(result.ambiguous, true);
  assert.equal(result.slipId, slips[0].id);
  assert.ok(result.candidates.reduce((sum, candidate) => sum + candidate.p, 0) < 1);
});

test("assignment uses the last ten per-axis medians and ignores a wild outlier", () => {
  const { slip, index } = isolatedIndex();
  const point = slip.points[0];
  const options = { landingStopId: slip.landingStopId };
  const expected = assignSlip([point], index, options);
  const outlier = offsetPoint(point, 270, 10000);
  assert.deepEqual(assignSlip([...Array(9).fill(point), outlier], index, options), expected);
  assert.deepEqual(assignSlip([...Array(15).fill(outlier), ...Array(10).fill(point)], index, options), expected);
});

test("heading filtering drops only known headings more than 90 degrees away", () => {
  const { slip, index } = isolatedIndex();
  const options = { landingStopId: slip.landingStopId, headingDegrees: 10 };
  assert.deepEqual(assignSlip(slip.points, index, { ...options, slipHeadings: new Map([[slip.id, 101]]) }), emptyAssignment);
  for (const heading of [100, 350]) {
    assert.equal(assignSlip(slip.points, index, { ...options, slipHeadings: new Map([[slip.id, heading]]) }).slipId, slip.id);
  }
  assert.equal(assignSlip(slip.points, index, options).slipId, slip.id);
  assert.equal(assignSlip(slip.points, index, { ...options, headingDegrees: null, slipHeadings: new Map([[slip.id, 190]]) }).slipId, slip.id);
});

test("no points, no nearby slips, or a different landing give the exact empty assignment", () => {
  const { slip, index } = isolatedIndex();
  assert.deepEqual(assignSlip([], index, { landingStopId: slip.landingStopId }), emptyAssignment);
  assert.deepEqual(assignSlip([offsetPoint(slip.points[0], 90, 61)], index, { landingStopId: slip.landingStopId }), emptyAssignment);
  assert.deepEqual(assignSlip(slip.points, index, { landingStopId: "9001" }), emptyAssignment);
});
