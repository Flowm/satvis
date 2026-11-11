#!/usr/bin/env node
// Downloads the upstream tables (SATCAT, GCAT's catalog, organisations and payloads, and
// CEOS's lists) from this machine and reports each to PUT /api/upstream/<name>, apart
// from the GP data (push-gp.mjs, ADR 0008). Each download is conditional on the Worker's
// stored ETag, read from /api/status, so an unchanged table costs a 304 and a report
// without a body; CEOS's is its snapshot version, asked for before its 21 downloads. Run
// daily: SATCAT changes once or twice a day, GCAT about weekly, CEOS a few times a year.
//
// Usage:
//   SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-catalog
//   SATVIS_API_URL=http://localhost:8787 SATVIS_TABLE_PAUSE_MS=0 SATVIS_REFRESH_TOKEN=... node scripts/push-catalog.mjs
//
// Exits non-zero when any table ends in an error, upstream's or the Worker's, so a
// scheduler reports it.

import { setTimeout as sleep } from "node:timers/promises";

import { reportHeaders } from "../src/gp/pushProtocol.ts";
import { fetchUpstream } from "../src/gp/upstream.ts";
import { UPSTREAMS } from "../src/gp/upstreams.ts";

const apiUrl = process.env.SATVIS_API_URL ?? "https://satvis.space";
const token = process.env.SATVIS_REFRESH_TOKEN;
/**
 * Between two tables. Workers Free allows 10 ms of CPU a request; a report of a new file
 * or a 304 takes 80 ms to 1.2 s of an undocumented allowance, and back to back they used
 * it up after about 2 s of CPU (`exceededCpu`, a 503). Local `wrangler dev` has no limit.
 */
const tablePauseMs = Number(process.env.SATVIS_TABLE_PAUSE_MS ?? 120_000);

function fail(message) {
  process.stderr.write(`push-catalog: ${message}\n`);
  process.exit(1);
}

/** Empty when the Worker is unreachable, which costs every table a full download. */
async function storedEtags() {
  try {
    const res = await fetch(`${apiUrl}/api/status`);
    if (!res.ok) {
      return {};
    }
    const { sources } = await res.json();
    return Object.fromEntries(UPSTREAMS.map(({ name }) => [name, sources?.[name]?.etag]));
  } catch {
    return {};
  }
}

/** One report per table: a body for a new file, else a header saying what happened. */
async function report(name, headers, body) {
  const res = await fetch(`${apiUrl}/api/upstream/${name}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  return { ok: res.ok, status: res.status, answer: await res.json().catch(() => ({})) };
}

/** Downloads one table and reports it; false when either step failed. */
async function pushTable(spec, etag) {
  const download = await fetchUpstream((url, init) => fetch(url, init), spec, etag);
  const sent = await report(spec.name, reportHeaders(download), download.body);
  let ok = true;
  if (download.body !== undefined) {
    const outcome = sent.ok ? `stored ${sent.answer.rows} rows` : `REFUSED (HTTP ${sent.status}: ${sent.answer.lastError ?? sent.answer.error})`;
    process.stdout.write(`push-catalog: ${spec.name} HTTP 200 — ${download.body.length} bytes in ${download.ms}ms, ${outcome}\n`);
  } else if (download.notModified) {
    process.stdout.write(`push-catalog: ${spec.name} not modified, HTTP ${download.status} (${download.ms}ms)\n`);
  } else {
    process.stdout.write(`push-catalog: ${spec.name} FAILED after ${download.ms}ms — ${download.error}; the Worker keeps its stored file\n`);
    ok = false;
  }
  if (!sent.ok) {
    process.stdout.write(`  report to ${apiUrl} answered HTTP ${sent.status}\n`);
    ok = false;
  }
  return ok;
}

async function main() {
  if (!token) {
    fail("SATVIS_REFRESH_TOKEN is not set (same value as the Worker's REFRESH_TOKEN secret)");
  }
  const etags = await storedEtags();
  let failed = false;
  for (const [index, spec] of UPSTREAMS.entries()) {
    if (index > 0) {
      // eslint-disable-next-line no-await-in-loop -- the pause is the point
      await sleep(tablePauseMs);
    }
    // eslint-disable-next-line no-await-in-loop -- one downloaded file in memory at a time; GCAT's is 19 MB
    failed = !(await pushTable(spec, etags[spec.name])) || failed;
  }
  if (failed) {
    fail("at least one table was not refreshed");
  }
}

await main();
