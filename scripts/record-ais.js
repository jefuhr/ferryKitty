#!/usr/bin/env node
// Run by hand with AISSTREAM_API_KEY set. The capture is raw wire JSON, before
// normalization, so an unfamiliar message can be replayed without a live key.
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createAisStream } from "../lib/ais-stream.js";

function options(args) {
  let minutes = 10;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--minutes" && args[i + 1] !== undefined) minutes = Number(args[++i]);
    else if (args[i] === "--out" && args[i + 1]) out = args[++i];
    else throw new Error("Usage: node scripts/record-ais.js [--minutes <n>] [--out <path>]");
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60000 > 2147483647) {
    throw new Error("--minutes must be positive and fit within a single timer");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { duration: minutes * 60000, path: resolve(out ?? `state/ais-captures/${timestamp}.ndjson`) };
}

async function main() {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey?.trim()) {
    console.error("AISSTREAM_API_KEY is required to record AIS messages");
    process.exitCode = 1;
    return;
  }
  let config;
  try { config = options(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  let output;
  try { await mkdir(dirname(config.path), { recursive: true }); output = await open(config.path, "a"); }
  catch { console.error("Could not open AIS capture output"); process.exitCode = 1; return; }
  let count = 0, finished = false, timer, stream;
  let writes = Promise.resolve();
  let complete;
  const completion = new Promise((resolveDone) => { complete = resolveDone; });
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    stream?.stop();
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    complete();
  }
  class CaptureSocket extends globalThis.WebSocket {
    constructor(url) {
      super(url);
      this.binaryType = "arraybuffer";
      this.addEventListener("message", ({ data }) => {
        if (finished) return;
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        let line;
        try { line = JSON.stringify(JSON.parse(text)); }
        catch { line = JSON.stringify(text); }
        // Serialize file writes; a malformed frame remains a JSON string line so
        // captures still have exactly one valid NDJSON value per wire message.
        writes = writes.then(async () => { await output.writeFile(`${line}\n`); count += 1; }).catch(() => {
          console.error("Could not append AIS capture output"); process.exitCode = 1; finish();
        });
      });
    }
  }
  stream = createAisStream({ apiKey, WebSocketImpl: CaptureSocket });
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  timer = setTimeout(finish, config.duration);
  stream.start();
  await completion;
  await writes;
  try { await output.close(); }
  catch { console.error("Could not close AIS capture output"); process.exitCode = 1; }
  console.log(`Recorded ${count} AIS messages`);
}

// Transport and filesystem exceptions can contain credentials or private paths.
// The recorder reports fixed errors and never echoes environment values.
main().catch(() => { console.error("AIS recording failed"); process.exitCode = 1; });
