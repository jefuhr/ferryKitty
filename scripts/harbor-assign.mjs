#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHarborLlm, estimateCost } from "../lib/harbor-llm.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const USAGE = "Usage: node scripts/harbor-assign.mjs --date YYYYMMDD [--operator id] [--estimate | --submit | --collect batchId] [--db path]";

function parseArgs(args) {
  const options = { mode: "estimate" };
  let actions = 0;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--estimate", "--submit"].includes(flag)) { options.mode = flag.slice(2); actions++; continue; }
    if (!["--date", "--operator", "--collect", "--db"].includes(flag)) throw new Error(`Unknown argument ${flag}.\n${USAGE}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${USAGE}`);
    if (flag === "--collect") { options.mode = "collect"; options.batchId = value; actions++; }
    else options[flag.slice(2)] = value;
  }
  if (actions > 1) throw new Error(`Choose one of --estimate, --submit or --collect.\n${USAGE}`);
  const date = options.date;
  if (!/^\d{8}$/.test(date ?? "")) throw new Error(`A --date in YYYYMMDD form is required.\n${USAGE}`);
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) throw new Error("Invalid service date.");
  return options;
}

async function loadDependencies({ databasePath, mode }) {
  // Keep the integration imports lazy so importing this CLI (and checking missing credentials)
  // does not open SQLite or need the other phase 2 modules to have been installed yet.
  const [{ openHarborDb }, { createHarborStore }, { buildRuns }, { buildHarborSchedule }] = await Promise.all([
    import("../lib/harbor-db.js"), import("../lib/harbor-store.js"),
    import("../lib/harbor-runs.js"), import("../lib/harbor-schedule.js")
  ]);
  if (databasePath !== ":memory:") await mkdir(path.dirname(databasePath), { recursive: true });
  const database = openHarborDb({ databasePath });
  try {
    const store = createHarborStore(database);
    const schedule = mode === "collect" ? null : await buildHarborSchedule({ root: ROOT });
    return { store, schedule, buildRuns, close: () => database.close() };
  } catch (error) { database.close(); throw error; }
}

export async function runHarborAssign(args, {
  env = process.env, log = console.log, error = console.error,
  createClient = () => new Anthropic(), loadDependencies: load = loadDependencies,
  now = () => Date.now()
} = {}) {
  let dependencies;
  try {
    const options = parseArgs(args);
    if (options.mode !== "estimate" && !env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      throw new Error("Missing Anthropic credentials: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for --submit or --collect.");
    }
    const databasePath = options.db ?? env.HARBOR_DB_PATH ?? path.join(ROOT, "state", "harbor.sqlite");
    dependencies = await load({ databasePath, mode: options.mode });
    const { store, schedule, buildRuns } = dependencies;
    // No client is constructed in estimate mode, even when credentials happen to be present.
    const client = options.mode === "estimate" ? null : await createClient();
    const llm = createHarborLlm({ client, store, now });
    if (options.mode === "collect") {
      const result = await llm.collectDay(options.batchId);
      log(JSON.stringify(result));
      return 0;
    }
    const operators = (await store.listOperators()).filter((operator) => !options.operator || operator.id === options.operator);
    if (options.operator && !operators.length) throw new Error(`Unknown operator ${options.operator}.`);
    const requests = [];
    for (const operator of operators) {
      const runs = await buildRuns({ schedule, operatorId: operator.id, serviceDate: options.date });
      const observations = await store.listTripObservations({ operatorId: operator.id, serviceDate: options.date });
      const patterns = await store.listPatterns({ operatorId: operator.id });
      const vessels = await store.listVessels({ operatorId: operator.id });
      const observedTrips = new Set(observations.map((observation) => observation.tripId));
      const unmatched = runs.flatMap((run) => run.trips.filter((trip) => !observedTrips.has(trip.tripId)));
      const request = llm.dayRequest({ operator, serviceDate: options.date, runs, observations, unmatched, patterns, vessels });
      if (options.mode === "submit") await store.saveRuns(operator.id, options.date, runs);
      requests.push(request);
    }
    if (options.mode === "estimate") {
      const approximateInputTokens = requests.reduce((sum, request) => sum + JSON.stringify(request).length / 4, 0);
      const approximateCacheCreationTokens = requests.reduce((sum, request) => sum + JSON.stringify(request.system).length / 4, 0);
      const maxOutputTokens = requests.reduce((sum, request) => sum + request.max_tokens, 0);
      const model = requests[0]?.model ?? "claude-haiku-5-5";
      const costs = { model, inputTokens: approximateInputTokens - approximateCacheCreationTokens,
        cacheCreationTokens: approximateCacheCreationTokens, batch: true };
      const inputCost = estimateCost({ ...costs, outputTokens: 0 });
      const maximumCost = estimateCost({ ...costs, outputTokens: maxOutputTokens });
      log(`${requests.length} operator-day requests for ${options.date}`);
      log(`Approximate input tokens: ${approximateInputTokens.toFixed(0)} (request characters / 4; not a tokenizer count).`);
      log(`Estimated batch token cost: $${inputCost.toFixed(6)} input; $${maximumCost.toFixed(6)} including the maximum ${maxOutputTokens} output tokens (approximate, assuming cache creation, before cache-read savings).`);
      return 0;
    }
    if (!requests.length) throw new Error("No operator-day requests to submit. Seed the harbor database first.");
    log(JSON.stringify(await llm.submitDay(requests)));
    return 0;
  } catch (cause) {
    error(cause.message);
    return 1;
  } finally {
    await dependencies?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runHarborAssign(process.argv.slice(2));
}
