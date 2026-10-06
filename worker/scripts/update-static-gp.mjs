#!/usr/bin/env node
// Runs the Worker's refreshGroups (node >= 24 type stripping) against disk, writing
// the gitignored data/gp/<group>.json and data/gp/index.json (the gp:index shape).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coerceIndex } from "../src/gp/evaluate.ts";
import { refreshGroups } from "../src/gp/refresh.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const outDir = path.join(repoRoot, "data", "gp");
const satcatPath = path.join(workerDir, ".cache", "satcat.json");

/**
 * The SATCAT cache lives outside data/, because everything under data/ ships.
 * Deleting it costs one full 6.7 MB download.
 */
function diskGroupStore(dir, cachePath) {
  const indexPath = path.join(dir, "index.json");
  return {
    async readIndex() {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch {
        // Missing or corrupt: start from empty.
      }
      return coerceIndex(raw);
    },
    async writeGroup(name, records) {
      fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(records)}\n`);
    },
    async writeIndex(index) {
      fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    },
    async readSatcat() {
      try {
        return JSON.parse(fs.readFileSync(cachePath, "utf8"));
      } catch {
        // Missing or corrupt: this run downloads the catalog in full.
        return undefined;
      }
    },
    async writeSatcat(snapshot) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(snapshot)}\n`);
    },
  };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const defs = config.groups;

  fs.mkdirSync(outDir, { recursive: true });
  const report = await refreshGroups(config, diskGroupStore(outDir, satcatPath), (url, init) => fetch(url, init));

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

  const satcat = report.index.satcat;
  if (satcat) {
    process.stdout.write(
      satcat.lastError ? `  satcat: FAILED (${satcat.lastError}) — kept ${satcat.count} stored rows\n` : `  satcat: ${satcat.count} rows (fetched ${satcat.updated})\n`,
    );
  }

  process.stdout.write(`Wrote ${path.relative(repoRoot, outDir)}/ (${report.written}/${defs.length} groups)\n`);
}

await main();
