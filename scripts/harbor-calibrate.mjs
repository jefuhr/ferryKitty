#!/usr/bin/env node
// Replay capture files locally. The report projects assignments to ids and counts so neither
// human-readable nor JSON output accidentally includes the positions used in calibration.
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { normalizeAisMessage } from "../lib/ais-stream.js";
import { parseCsv } from "../lib/schedule-builder.js";
import { assignSlip, buildSlipIndex, parseSlipCsv, SLIP_MODEL } from "../lib/harbor-slips.js";
import { dwellSamples, sweep, reportGaps } from "../lib/harbor-calibrate.js";
import { THRESHOLDS } from "../lib/harbor-state.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: node scripts/harbor-calibrate.mjs [--capture <ndjson>...] [--slips <csv>] [--json]";

function options(args) {
  const captures = [];
  let slips = join(ROOT, "content/harbor-slips.csv"), json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--slips" && args[i + 1] && !args[i + 1].startsWith("--")) slips = resolve(args[++i]);
    else if (args[i] === "--capture") {
      const before = captures.length;
      while (args[i + 1] && !args[i + 1].startsWith("--")) captures.push(resolve(args[++i]));
      if (captures.length === before) throw new Error(USAGE);
    } else throw new Error(USAGE);
  }
  return { captures, slips, json };
}

async function loadCaptures(paths) {
  const records = [], capture = { files: paths.length, lines: 0, invalidLines: 0, ignored: 0, fixes: 0 };
  for (const path of paths) {
    const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      capture.lines += 1;
      let raw;
      try { raw = JSON.parse(line); }
      catch { capture.invalidLines += 1; continue; }
      const record = normalizeAisMessage(raw);
      if (record?.kind !== "fix" && record?.kind !== "static") { capture.ignored += 1; continue; }
      records.push(record);
      if (record.kind === "fix") capture.fixes += 1;
    }
  }
  records.sort((left, right) => (left.fix ?? left.static).at - (right.fix ?? right.static).at);
  return { records, capture };
}

const number = (value) => value === null ? "n/a" : value.toFixed(2);
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const mode = (model) => model.ambiguity.mode === "spacing" ? `spacing ${model.ambiguity.metres}m` : `margin ${model.ambiguity.p}`;

function printTable(report) {
  console.log(`captures: ${report.capture.files} files, ${report.capture.fixes} fixes, ${report.capture.invalidLines} invalid lines, ${report.capture.ignored} ignored records`);
  console.log(`calibration rests on ${report.dwells.length} dwells (observed stops, not verified slip labels)`);
  console.log("sigma  ambiguity       dwells  named  namedShare  ambiguous  flips  meanConfidence");
  for (const row of report.rows) {
    console.log(`${String(row.model.sigmaMetres).padEnd(5)}  ${mode(row.model).padEnd(14)}  ${String(row.dwells).padStart(6)}  ${String(row.named).padStart(5)}  ${percent(row.namedShare).padStart(10)}  ${String(row.ambiguous).padStart(9)}  ${String(row.flips).padStart(5)}  ${number(row.meanConfidence).padStart(14)}`);
  }
  console.log(`recommended: ${report.recommended ? JSON.stringify(report.recommended) : "none (every model had a slip flip)"}`);
  console.log(`live defaults unchanged: ${JSON.stringify(SLIP_MODEL)}`);
  if (report.recommended) {
    console.log("recommended assignments: landingStopId  slipId  confidence  ambiguous  fixes  spanSeconds");
    for (const dwell of report.dwells) {
      console.log(`${dwell.landingStopId}  ${dwell.slipId ?? "unknown"}  ${number(dwell.confidence)}  ${dwell.ambiguous}  ${dwell.fixes}  ${number((dwell.until - dwell.since) / 1000)}`);
    }
  }
  console.log("fix gaps (seconds): bucket  count  median  p75  p90  p95");
  for (const [bucket, values] of Object.entries(report.gaps)) {
    console.log(`${bucket}  ${values.count}  ${number(values.median)}  ${number(values.p75)}  ${number(values.p90)}  ${number(values.p95)}`);
  }
  console.log(`suggested moving-boat stale limit: ${report.suggestedMovingStaleSeconds === null ? "n/a (no moving gaps)" : `${report.suggestedMovingStaleSeconds}s (moving p90 rounded up to 30s)`}`);
  if (!report.dwells.length) console.log("no dwell evidence: the tie-break recommendation is not a calibrated default");
}

async function main() {
  const config = options(process.argv.slice(2));
  if (!config.captures.length) {
    const directory = join(ROOT, "state/ais-captures");
    const entries = await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    config.captures = entries.filter((name) => name.endsWith(".ndjson")).sort().map((name) => join(directory, name));
  }
  if (!config.captures.length) throw new Error("No captures found; supply --capture <ndjson>");
  const stops = parseCsv(await readFile(join(ROOT, "gtfs/stops.txt"), "utf8")).map((row) => ({
    stopId: row.stop_id, name: row.stop_name, latitude: Number(row.stop_lat), longitude: Number(row.stop_lon)
  }));
  const slips = parseSlipCsv(await readFile(config.slips, "utf8"), { stops, warn: (message) => console.error(message) });
  const slipIndex = buildSlipIndex(slips, { stops, landings: stops.map((stop) => ({ ...stop, landingStopId: stop.stopId })) });
  const { records, capture } = await loadCaptures(config.captures);
  const samples = dwellSamples({ records, slipIndex });
  const models = [4, 6, 8, 10, 12].flatMap((sigmaMetres) => [
    { ...SLIP_MODEL, sigmaMetres },
    ...[0.15, 0.2, 0.3].map((p) => ({ ...SLIP_MODEL, sigmaMetres, ambiguity: { mode: "margin", p } }))
  ]);
  const result = sweep({ samples, slipIndex, models });
  const gaps = reportGaps(records);
  const report = {
    capture, ...result, gaps,
    suggestedMovingStaleSeconds: gaps.moving.p90 === null ? null : Math.ceil(gaps.moving.p90 / 30) * 30,
    dwells: samples.map((sample) => {
      const assignment = result.recommended ? assignSlip(sample.points, slipIndex, {
        landingStopId: sample.landingStopId, model: result.recommended,
        storage: sample.until - sample.since >= THRESHOLDS.passengerLayupMs
      }) : null;
      return {
        landingStopId: sample.landingStopId, slipId: assignment?.slipId ?? null,
        confidence: assignment?.confidence ?? 0, ambiguous: assignment?.ambiguous ?? false,
        fixes: sample.points.length, since: sample.since, until: sample.until
      };
    })
  };
  if (config.json) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
}

main().catch((error) => {
  console.error(error.message === USAGE || error.message.startsWith("No captures found;") ? error.message : "Could not calibrate harbor captures; check input files");
  process.exitCode = 1;
});
