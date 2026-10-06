#!/usr/bin/env node
// Runs the Worker's refreshUpstreams and refreshGroups (node >= 24 type stripping)
// against disk, writing the gitignored data/gp/<group>.json and data/gp/index.json
// (the gp:index shape).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coerceIndex } from "../src/gp/evaluate.ts";
import { refreshGroups, refreshUpstreams } from "../src/gp/refresh.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const outDir = path.join(repoRoot, "data", "gp");
const cacheDir = path.join(workerDir, ".cache");

/** Undefined for a missing or corrupt file: as if never written. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The real fetch, for both the tables and the GP sources. */
function fetchImpl(url, init) {
  return fetch(url, init);
}

/**
 * The upstream tables are kept outside data/, because everything under data/ ships:
 * `<name>.gz`, the file as downloaded, compressed, and `<name>.status.json`. Deleting
 * them costs a full download: 6.7 MB for SATCAT, 19 MB for GCAT's catalog.
 */
function diskGroupStore(dir, upstreamDir) {
  const indexPath = path.join(dir, "index.json");
  const statusPath = (name) => path.join(upstreamDir, `${name}.status.json`);
  return {
    async readIndex() {
      return coerceIndex(readJson(indexPath));
    },
    async writeGroup(name, records) {
      fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(records)}\n`);
    },
    async writeIndex(index) {
      fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    },
    async readUpstream(name) {
      const file = path.join(upstreamDir, `${name}.gz`);
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined;
    },
    async writeUpstream(name, bytes) {
      fs.mkdirSync(upstreamDir, { recursive: true });
      fs.writeFileSync(path.join(upstreamDir, `${name}.gz`), bytes);
    },
    async listUpstreams() {
      if (!fs.existsSync(upstreamDir)) {
        return new Set();
      }
      return new Set(
        fs
          .readdirSync(upstreamDir)
          .filter((file) => file.endsWith(".gz"))
          .map((file) => file.slice(0, -3)),
      );
    },
    async readStatus(name) {
      return readJson(statusPath(name));
    },
    async writeStatus(name, status) {
      fs.mkdirSync(upstreamDir, { recursive: true });
      fs.writeFileSync(statusPath(name), `${JSON.stringify(status)}\n`);
    },
    async listStatuses() {
      return {};
    },
  };
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
    process.stdout.write(
      status.lastError && status.lastErrorAt === status.checked
        ? `  ${name}: FAILED (${status.lastError}) — kept the stored file\n`
        : `  ${name}: ${status.rows} rows (stored ${status.updated})\n`,
    );
  }

  process.stdout.write(`Wrote ${path.relative(repoRoot, outDir)}/ (${report.written}/${defs.length} groups)\n`);
}

await main();
