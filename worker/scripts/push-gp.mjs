#!/usr/bin/env node
// Downloads the GP sources from this machine with the Worker's own fetchSources (node >=
// 24 type stripping) and POSTs them to /api/ingest, for when CelesTrak firewalls
// Cloudflare's egress (HTTP 522 on every source). One run pulls ~7 MB: keep the cadence
// at 6 h or more, since CelesTrak asks for one download per update. The upstream tables
// travel separately, with push-catalog.mjs.
//
// Usage:
//   SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-gp
//   SATVIS_INGEST_URL=http://localhost:8080/api/ingest SATVIS_REFRESH_TOKEN=... node scripts/push-gp.mjs
//
// Exits non-zero when the POST fails or when the run wrote no group at all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toIngestBundle } from "../src/gp/pushProtocol.ts";
import { fetchSources } from "../src/gp/sources.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const ingestUrl = process.env.SATVIS_INGEST_URL ?? "https://satvis.space/api/ingest";
const token = process.env.SATVIS_REFRESH_TOKEN;

function fail(message) {
  process.stderr.write(`push-gp: ${message}\n`);
  process.exit(1);
}

async function main() {
  if (!token) {
    fail("SATVIS_REFRESH_TOKEN is not set (same value as the Worker's REFRESH_TOKEN secret)");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fetched = await fetchSources(config.groups, (url, init) => fetch(url, init));

  const bundle = toIngestBundle(fetched, new Date().toISOString());

  const ok = fetched.filter((source) => source.records !== undefined).length;
  const body = JSON.stringify(bundle);
  process.stdout.write(`push-gp: POST ${ingestUrl} — ${ok}/${fetched.length} sources downloaded, ${body.length} bytes\n`);

  let res;
  try {
    res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
  } catch (err) {
    fail(`POST failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    fail(`ingest returned HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const report = JSON.parse(text);
  for (const status of report.groups) {
    if (status.lastError) {
      process.stdout.write(`  ${status.name}: FAILED (${status.lastError}) — keeping last-known-good\n`);
    } else {
      process.stdout.write(`  ${status.name}: ${status.count} records\n`);
    }
    for (const warning of status.warnings ?? []) {
      process.stdout.write(`    WARNING: ${warning}\n`);
    }
  }
  process.stdout.write(`push-gp: ingested in ${report.durationMs}ms — ${report.written} groups written, ${report.skipped} skipped/failed\n`);

  // Partial failures stay green: those groups keep last-known-good and report lastError in /api/groups.json.
  if (report.written === 0) {
    fail("no group was written — every source failed");
  }
}

await main();
