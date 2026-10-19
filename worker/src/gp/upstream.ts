// The tables the satellite table is built from (ADR 0006, 0008): SATCAT, and GCAT's
// catalog, organisations and payloads. Each is stored as the file upstream served,
// gzip-compressed, with its parsed rows and a status beside it. Two paths store them,
// PUT /api/upstream/<name> (push-catalog) and the Worker's own fetch; every GP update
// reads the rows. None is a group source: a missing table costs enrichment and fails no group.

import { download, type FetchImpl } from "./download.ts";
import { type GroupStore, upstreamStatuses } from "./store.ts";
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

/**
 * A parse that keeps fewer than this share of the stored rows is refused. The parsers
 * catch a cut row, not a file cut at a line break; neither table ever halves.
 */
const MIN_ROW_RATIO = 0.5;

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
  const headers = etag === undefined ? undefined : { "If-None-Match": etag };
  const { ms, value, error } = await download(fetchImpl, spec.url, { timeoutMs: spec.timeoutMs, headers }, async (res): Promise<Omit<UpstreamFetch, "ms">> => {
    if (res.status === 200) {
      return { status: 200, body: await res.text(), etag: res.headers?.get("ETag") ?? undefined };
    }
    return res.status === 304 ? { status: 304, notModified: true } : { status: res.status, error: `HTTP ${res.status}` };
  });
  return value === undefined ? { ms, error } : { ms, ...value };
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
  let parsed: T;
  let rows: number;
  try {
    parsed = spec.parse(body);
    rows = Object.keys(parsed as object).length;
    const stored = (await store.listUpstreams()).has(spec.name) ? (await store.readStatus(spec.name))?.rows : undefined;
    if (stored !== undefined && rows < stored * MIN_ROW_RATIO) {
      throw new Error(`${rows} rows, against ${stored} stored: cut off?`);
    }
  } catch (err) {
    const message = `refused: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`upstream ${spec.name}: ${message} (keeping the stored file)`);
    return { stored: false, status: await recordFailure(spec.name, store, message, now) };
  }
  const blob = new Blob([body]);
  await store.writeUpstream(spec.name, await gzip(blob));
  await store.writeUpstreamRows(spec.name, parsed);
  const status: UpstreamStatus = { updated: now, checked: now, etag, bytes: blob.size, rows };
  await store.writeStatus(spec.name, status);
  console.log(`upstream ${spec.name}: stored ${status.rows} rows, ${status.bytes} bytes`);
  return { stored: true, status };
}

/** The stored file, decompressed and parsed; undefined when none is stored. Throws when it no longer parses. */
async function parseStored<T>(spec: UpstreamSpec<T>, store: GroupStore): Promise<T | undefined> {
  const bytes = await store.readUpstream(spec.name);
  return bytes === undefined ? undefined : spec.parse(await gunzip(bytes));
}

/**
 * Upstream answered 304: it still serves the file stored here, so the check is
 * recorded and an earlier error is resolved. The rows are parsed from the stored file
 * again, so a parser change reaches them at the next check; a file the parser now
 * rejects keeps its old rows and records the error.
 */
export async function recordUnchanged<T>(spec: UpstreamSpec<T>, store: GroupStore, now: string): Promise<UpstreamStatus> {
  const { lastError: _resolved, lastErrorAt: _resolvedAt, ...previous } = (await store.readStatus(spec.name)) ?? {};
  let status: UpstreamStatus = { ...previous, checked: now };
  let parsed: T | undefined;
  try {
    parsed = await parseStored(spec, store);
  } catch (err) {
    const message = `stored file unreadable: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`upstream ${spec.name}: ${message} (keeping the stored rows)`);
    status = { ...status, lastError: message, lastErrorAt: now };
  }
  if (parsed !== undefined) {
    await store.writeUpstreamRows(spec.name, parsed);
  }
  await store.writeStatus(spec.name, status);
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

/** The stored file's ETag, for a conditional download; none without the file (store.ts, upstreamStatuses). */
export async function storedEtag(name: UpstreamName, store: GroupStore): Promise<string | undefined> {
  return (await upstreamStatuses(store))[name]?.etag;
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
    return recordUnchanged(spec, store, now);
  }
  console.warn(`upstream ${spec.name}: FAILED after ${result.ms}ms — ${result.error}`);
  return recordFailure(spec.name, store, result.error ?? "fetch failed", now);
}

/**
 * The stored rows, not the file: parsing all four files put a GP update over the
 * deployed Worker's 2 s CPU limit now and then (ADR 0008). A file stored before rows were
 * kept is parsed, and its rows are kept. Undefined when no file is stored or it no longer
 * parses: the GP update then enriches without this table.
 */
export async function loadUpstream<T>(spec: UpstreamSpec<T>, store: GroupStore): Promise<T | undefined> {
  const rows = await store.readUpstreamRows(spec.name);
  if (rows !== undefined) {
    return rows as T;
  }
  let parsed: T | undefined;
  try {
    parsed = await parseStored(spec, store);
  } catch (err) {
    console.warn(`gp refresh: stored ${spec.name} unreadable (${err instanceof Error ? err.message : String(err)}); enriching without it`);
    return undefined;
  }
  if (parsed === undefined) {
    console.warn(`gp refresh: no stored ${spec.name}; enriching without it`);
    return undefined;
  }
  await store.writeUpstreamRows(spec.name, parsed);
  return parsed;
}
