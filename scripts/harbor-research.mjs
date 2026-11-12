import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidates, parseFccShips, propose } from "../lib/harbor-research.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readHistory(list, cursorOf) {
  const limit = 1000;
  const rows = [];
  let before = null;
  // Store limits are capped per page. The composite cursor preserves every row
  // even when a timestamp is shared by observations on both sides of a page.
  while (true) {
    const page = await list({ limit, before });
    rows.push(...page);
    if (page.length < limit) return rows;
    before = cursorOf(page.at(-1));
  }
}

function options(args, root, stateDir) {
  const parsed = { databasePath: resolve(stateDir, "harbor.db"), outPath: resolve(root, "content/harbor-roster.proposed.json"), dry: false, fccPath: null };
  const flags = { "--db": "databasePath", "--out": "outPath", "--fcc": "fccPath" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--dry") parsed.dry = true;
    else if (flags[flag]) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for argument ${flag}`);
      parsed[flags[flag]] = resolve(value);
    } else throw new Error(`Unknown argument ${flag}`);
  }
  return parsed;
}

export async function runHarborResearch({ args = [], store, root = projectRoot,
  rosterPath = resolve(root, "content/harbor-roster.json"), now = () => Date.now(),
  stateDir = process.env.STATE_DIR || "state", openDb, createStore,
  confirm = null, stdout = (value) => process.stdout.write(value) } = {}) {
  const settings = options(args, root, stateDir);
  // Comparing real paths also protects the committed roster from a symlinked output.
  const canonical = async (path) => realpath(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(path);
  });
  const output = await canonical(settings.outPath);
  for (const input of [rosterPath, settings.databasePath, settings.fccPath].filter(Boolean)) {
    if (output === await canonical(input)) throw new Error("Output must not overwrite the roster, database or FCC input");
  }
  const roster = JSON.parse(await readFile(rosterPath, "utf8"));
  const fcc = settings.fccPath ? parseFccShips(await readFile(settings.fccPath, "utf8")) : [];
  let database;
  try {
    if (!store) {
      try {
        await stat(settings.databasePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const message = `No harbor database to read yet: ${settings.databasePath}`;
        if (!settings.dry) throw new Error(message);
        // Report an absent database without bootstrapping it.
        stdout(`${message}\n`);
        return { vessels: [], conflicts: [], skipped: [], dropped: [] };
      }
      // These modules are supplied by the database worker. Lazy imports keep
      // this entry point testable against a fake store before integration.
      const openHarborDb = openDb ?? (await import("../lib/harbor-db.js")).openHarborDb;
      const createHarborStore = createStore ?? (await import("../lib/harbor-store.js")).createHarborStore;
      database = openHarborDb({ databasePath: settings.databasePath, readOnly: true });
      store = createHarborStore(database);
    }
    const [sightings, dwells, terminals, links] = await Promise.all([
      readHistory((options) => store.listSightings(options), ({ lastSeen, mmsi }) => ({ lastSeen, mmsi })),
      readHistory((options) => store.listDwells(options), ({ since, id }) => ({ since, id })),
      store.listTerminals(), store.listAisLinks({})
    ]);
    roster.byMmsi = new Map(links.map((link) => [link.mmsi, link]));
    for (const vessel of roster.vessels) if (vessel.mmsi) roster.byMmsi.set(vessel.mmsi, { vesselId: vessel.id });
    const ranked = candidates({ sightings, dwells, terminals, roster });
    const confirmations = new Map();
    if (confirm && !settings.dry) {
      for (const candidate of ranked) {
        const result = await confirm({ mmsi: candidate.mmsi, name: candidate.name, callSign: candidate.callSign,
          operatorGuess: candidate.operatorGuess, evidence: { dwellCount: candidate.dwellCount, share: candidate.share,
            tiedOperators: candidate.tiedOperators ?? [],
            terminals: candidate.terminals, fcc: fcc.filter((record) => record.mmsi === candidate.mmsi) } });
        if (result) confirmations.set(candidate.mmsi, result);
      }
    }
    const proposal = propose({ candidates: ranked, fcc, confirmations, roster });
    if (settings.dry) {
      // A dry run shows what would be proposed and why, and touches nothing.
      stdout(`${ranked.length} unlinked vessels seen; ${proposal.vessels.length} would be proposed, ${proposal.conflicts.length} conflicts, ${proposal.skipped.length} skipped (dry run, nothing written)\n`);
      for (const candidate of ranked) {
        stdout(`  ${candidate.mmsi}  ${(candidate.name ?? "(no name)").padEnd(22)} operator ${candidate.operatorGuess ?? "?"}  share ${candidate.share.toFixed(2)}  dwells ${candidate.dwellCount}\n`);
      }
    } else {
      const retrievedAt = new Date(now()).toISOString().slice(0, 10);
      for (const vessel of [...proposal.vessels, ...proposal.conflicts.map((conflict) => conflict.vessel)]) {
        for (const reference of vessel.references) reference.retrievedAt ??= retrievedAt;
      }
      await writeFile(settings.outPath, `${JSON.stringify(proposal, null, 2)}\n`);
      stdout(`${proposal.vessels.length} vessel proposals, ${proposal.conflicts.length} conflicts, ${proposal.skipped.length} skipped → ${settings.outPath}\n`);
      for (const item of proposal.dropped) stdout(`${item.mmsi} ${item.field}: dropped for lack of a source\n`);
    }
    return proposal;
  } finally {
    database?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHarborResearch({ args: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`harbor research: ${error.message}\n`);
    process.exitCode = 1;
  });
}
