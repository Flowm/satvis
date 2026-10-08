#!/usr/bin/env node
// Runs the Worker's refreshUpstreams and refreshGroups (node >= 24 type stripping)
// against disk, writing the gitignored data/gp/<group>.json and data/gp/index.json
// (the gp:index shape).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshGroups, refreshUpstreams } from "../src/gp/refresh.ts";
import { diskGroupStore } from "./diskStore.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const outDir = path.join(repoRoot, "data", "gp");
const cacheDir = path.join(workerDir, ".cache");

/** The real fetch, for both the tables and the GP sources. */
function fetchImpl(url, init) {
  return fetch(url, init);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const defs = config.groups;

  fs.mkdirSync(outDir, { recursive: true });
  const store = diskGroupStore(outDir, cacheDir);
  // The tables first, so this refresh enriches from them.
  const statuses = await refreshUpstreams(store, fetchImpl);
  const report = await refreshGroups(config, store, fetchImpl);

  for (const s of report.index.groups) {
    if (s.lastError) {
      process.stdout.write(`  ${s.name}: FAILED (${s.lastError}) — keeping last-known-good\n`);
    } else {
      process.stdout.write(`  ${s.name}: ${s.count} records\n`);
    }
    for (const warning of s.warnings ?? []) {
      process.stdout.write(`    WARNING: ${warning}\n`);
    }
  }

  for (const [name, status] of Object.entries(statuses)) {
    process.stdout.write(status.lastError ? `  ${name}: FAILED (${status.lastError}) — kept the stored file\n` : `  ${name}: ${status.rows} rows (stored ${status.updated})\n`);
  }

  process.stdout.write(`Wrote ${path.relative(repoRoot, outDir)}/ (${report.written}/${defs.length} groups)\n`);
}

await main();
