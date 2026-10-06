// The tables the satellite table is built from (ADR 0006, 0008): SATCAT, and GCAT's
// catalog, organisations and payloads. Each is stored as the file upstream served,
// gzip-compressed, with a status beside it. Two paths store them, PUT /api/upstream/<name>
// (push-catalog) and the Worker's own fetch; every GP update reads and parses them anew.
// None is a group source: a missing table costs enrichment and fails no group.

import { type FetchImpl, USER_AGENT } from "./evaluate.ts";
import type { GroupStore } from "./store.ts";
import type { UpstreamName, UpstreamStatus } from "./types.ts";

/** One downloaded table: where it lives and how its file becomes rows. */
export interface UpstreamSpec<T> {
  /** Its KV keys, its entry in /api/status, and its path in PUT /api/upstream/<name>. */
  name: UpstreamName;
  /** Where upstream serves the whole table. */
  url: string;
  /** Throws on a body that is not this table, which then is not stored. */
  parse(body: string): T;
  /** For the download alone. */
  timeoutMs: number;
  /** After this long without a check, /api/status marks the table stale. */
  staleAfterMs: number;
}

/** Exactly one of `body`, `notModified` and `error` is set. */
export interface UpstreamFetch {
  /** Upstream's HTTP status; absent when the request itself failed. */
  status?: number;
  /** How long the download took. */
  ms: number;
  /** The file as served, on a 200. */
  body?: string;
  /** The ETag served with `body`, to send as If-None-Match next time. */
  etag?: string;
  /** Upstream answered 304: the stored file is current. */
  notModified?: boolean;
  /** Why the download failed. */
  error?: string;
}

/** Never throws. Conditional on `etag`, the stored file's, so an unchanged table costs a 304. */
export async function fetchUpstream(fetchImpl: FetchImpl, spec: UpstreamSpec<unknown>, etag?: string): Promise<UpstreamFetch> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${spec.timeoutMs}ms`)), spec.timeoutMs);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (etag !== undefined) {
    headers["If-None-Match"] = etag;
  }
  try {
    const res = await fetchImpl(spec.url, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    if (res.status === 304) {
      return { status: 304, ms, notModified: true };
    }
    if (res.status !== 200) {
      return { status: res.status, ms, error: `HTTP ${res.status}` };
    }
    return { status: 200, ms, body: await res.text(), etag: res.headers?.get("ETag") ?? undefined };
  } catch (err) {
    return { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** GCAT's catalog is 18.4 MiB against KV's 25 MiB value limit; gzip makes it 2.6 MiB. */
async function gzip(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** The stored file back as the text upstream served. */
async function gunzip(bytes: Uint8Array): Promise<string> {
  // A copy, typed as backed by an ArrayBuffer, which Blob needs.
  return new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/**
 * Parses `body` first, and stores it only if that succeeds: an error page or a cut-off
 * download never replaces a good file. A refused file is recorded as the status's error.
 */
export async function storeUpstream<T>(
  spec: UpstreamSpec<T>,
  store: GroupStore,
  body: string,
  etag: string | undefined,
  now: string,
): Promise<{ stored: boolean; status: UpstreamStatus }> {
  let rows: T;
  try {
    rows = spec.parse(body);
  } catch (err) {
    const message = `refused: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`upstream ${spec.name}: ${message} (keeping the stored file)`);
    return { stored: false, status: await recordFailure(spec.name, store, message, now) };
  }
  const blob = new Blob([body]);
  await store.writeUpstream(spec.name, await gzip(blob));
  const status: UpstreamStatus = { updated: now, checked: now, etag, bytes: blob.size, rows: Object.keys(rows as object).length };
  await store.writeStatus(spec.name, status);
  console.log(`upstream ${spec.name}: stored ${status.rows} rows, ${status.bytes} bytes`);
  return { stored: true, status };
}

/**
 * Upstream answered 304: it still serves the file stored here, so the check is
 * recorded and an earlier error is resolved.
 */
export async function recordUnchanged(name: UpstreamName, store: GroupStore, now: string): Promise<UpstreamStatus> {
  const { lastError: _resolved, lastErrorAt: _resolvedAt, ...previous } = (await store.readStatus(name)) ?? {};
  const status: UpstreamStatus = { ...previous, checked: now };
  await store.writeStatus(name, status);
  return status;
}

/**
 * The download failed or the file was refused; the stored file stands. `checked`
 * stays, so a table that keeps failing goes stale.
 */
export async function recordFailure(name: UpstreamName, store: GroupStore, error: string, now: string): Promise<UpstreamStatus> {
  const status: UpstreamStatus = { ...(await store.readStatus(name)), lastError: error, lastErrorAt: now };
  await store.writeStatus(name, status);
  return status;
}

/**
 * The stored file's ETag, if the file is there too: a status whose file is gone would
 * otherwise make every download conditional, upstream would answer 304, and the
 * table would never come back.
 */
export async function storedEtag(name: UpstreamName, store: GroupStore): Promise<string | undefined> {
  const [status, stored] = await Promise.all([store.readStatus(name), store.listUpstreams()]);
  return stored.has(name) ? status?.etag : undefined;
}

/**
 * The Worker's own fetch of one table, conditional on the stored file. A failed
 * download is recorded, not thrown; a failing store throws.
 */
export async function refreshUpstream<T>(spec: UpstreamSpec<T>, store: GroupStore, fetchImpl: FetchImpl, now: string): Promise<UpstreamStatus> {
  const result = await fetchUpstream(fetchImpl, spec, await storedEtag(spec.name, store));
  if (result.body !== undefined) {
    return (await storeUpstream(spec, store, result.body, result.etag, now)).status;
  }
  if (result.notModified) {
    console.log(`upstream ${spec.name}: HTTP 304 in ${result.ms}ms`);
    return recordUnchanged(spec.name, store, now);
  }
  console.warn(`upstream ${spec.name}: FAILED after ${result.ms}ms — ${result.error}`);
  return recordFailure(spec.name, store, result.error ?? "fetch failed", now);
}

/**
 * The stored file, parsed. Undefined when none is stored or it no longer parses, which
 * a parser change could cause: the GP update then enriches without this table.
 */
export async function loadUpstream<T>(spec: UpstreamSpec<T>, store: GroupStore): Promise<T | undefined> {
  const bytes = await store.readUpstream(spec.name);
  if (bytes === undefined) {
    console.warn(`gp refresh: no stored ${spec.name}; enriching without it`);
    return undefined;
  }
  try {
    return spec.parse(await gunzip(bytes));
  } catch (err) {
    console.warn(`gp refresh: stored ${spec.name} unreadable (${err instanceof Error ? err.message : String(err)}); enriching without it`);
    return undefined;
  }
}
