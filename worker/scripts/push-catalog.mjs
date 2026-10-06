#!/usr/bin/env node
// Downloads the upstream tables (SATCAT, and GCAT's catalog, organisations and payloads)
// from this machine and reports each to PUT /api/upstream/<name>, apart from the GP data
// (push-gp.mjs, ADR 0008). Each download is conditional on the Worker's stored ETag, read
// from /api/status, so an unchanged table costs a 304 and a report without a body. Run
// daily: SATCAT changes once or twice a day, GCAT about weekly.
//
// Usage:
//   SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-catalog
//   SATVIS_API_URL=http://localhost:8080 SATVIS_REFRESH_TOKEN=... node scripts/push-catalog.mjs
//
// Exits non-zero when any table ends in an error, upstream's or the Worker's, so a
// scheduler reports it.

import { fetchUpstream } from "../src/gp/upstream.ts";
import { UPSTREAMS } from "../src/gp/upstreams.ts";

const apiUrl = process.env.SATVIS_API_URL ?? "https://satvis.space";
const token = process.env.SATVIS_REFRESH_TOKEN;

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

/** A header value must be ASCII on one line. */
function headerSafe(text) {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 400);
}

/** Downloads one table and reports it; false when either step failed. */
async function pushTable(spec, etag) {
  const download = await fetchUpstream((url, init) => fetch(url, init), spec, etag);
  let sent;
  let ok = true;
  if (download.body !== undefined) {
    const headers = { "Content-Type": "text/plain; charset=utf-8", ...(download.etag && { "X-Upstream-ETag": download.etag }) };
    sent = await report(spec.name, headers, download.body);
    const outcome = sent.ok ? `stored ${sent.answer.rows} rows` : `REFUSED (HTTP ${sent.status}: ${sent.answer.lastError ?? sent.answer.error})`;
    process.stdout.write(`push-catalog: ${spec.name} HTTP 200 — ${download.body.length} bytes in ${download.ms}ms, ${outcome}\n`);
  } else if (download.notModified) {
    sent = await report(spec.name, { "X-Upstream-Status": "304" });
    process.stdout.write(`push-catalog: ${spec.name} 304 not modified (${download.ms}ms)\n`);
  } else {
    sent = await report(spec.name, { "X-Upstream-Error": headerSafe(download.error ?? "fetch failed") });
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
  for (const spec of UPSTREAMS) {
    // eslint-disable-next-line no-await-in-loop -- one downloaded file in memory at a time; GCAT's is 19 MB
    failed = !(await pushTable(spec, etags[spec.name])) || failed;
  }
  if (failed) {
    fail("at least one table was not refreshed");
  }
}

await main();
