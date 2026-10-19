// The push scripts' wire formats, both ends of each in one place: push-gp's ingest
// bundle (POST /api/ingest) and push-catalog's report of one table
// (PUT /api/upstream/<name>, ADR 0008). No Cloudflare APIs: the scripts import it through
// node type stripping.

import type { FetchImpl } from "./download.ts";
import type { SourceFetch } from "./sources.ts";
import type { UpstreamFetch } from "./upstream.ts";

/**
 * One source downloaded off-Worker. `body` is set on success and `error` on failure;
 * a 304 carries neither.
 */
export interface IngestSource {
  key: string;
  url: string;
  status?: number;
  body?: string;
  error?: string;
}

/**
 * Replays a downloaded bundle, so an ingest runs the Worker's own fetch path. `url` is only
 * a Map key: a posted bundle cannot make the Worker fetch anything.
 */
export function bundleFetch(sources: IngestSource[]): FetchImpl {
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  return async (url) => {
    const source = byUrl.get(url);
    if (source === undefined) {
      // E.g. an older push-gp against a newer Worker. The group keeps its last-known-good.
      throw new Error("source absent from the ingest bundle");
    }
    if (source.error !== undefined) {
      throw new Error(source.error);
    }
    return { status: source.status ?? 0, text: async () => source.body ?? "" };
  };
}

/** What push-gp posts. `fetchedAt` is informational; the Worker stamps its own time. */
export interface IngestBundle {
  fetchedAt: string;
  sources: IngestSource[];
}

/**
 * fetchSources keeps no raw body, so records travel re-serialized; the Worker
 * validates them again. A failure travels as its message and becomes the group's lastError.
 */
export function toIngestBundle(fetched: SourceFetch[], fetchedAt: string): IngestBundle {
  return {
    fetchedAt,
    sources: fetched.map((source) =>
      source.records === undefined
        ? { key: source.key, url: source.url, status: source.status, error: source.error ?? "fetch failed" }
        : { key: source.key, url: source.url, status: source.status, body: JSON.stringify(source.records) },
    ),
  };
}

/**
 * Returns the first problem as a string. Strict, because a malformed bundle would
 * otherwise read as an upstream outage.
 */
export function parseIngestBundle(raw: unknown): IngestSource[] | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const sources = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return "body.sources must be an array";
  }
  if (sources.length === 0) {
    return "body.sources is empty";
  }
  const parsed: IngestSource[] = [];
  for (let i = 0; i < sources.length; i++) {
    const entry = sources[i] as Record<string, unknown> | null;
    if (entry === null || typeof entry !== "object") {
      return `body.sources[${i}] must be an object`;
    }
    const { key, url, status, body, error } = entry;
    if (typeof key !== "string" || typeof url !== "string") {
      return `body.sources[${i}] needs string key and url`;
    }
    if (status !== undefined && typeof status !== "number") {
      return `body.sources[${i}].status must be a number`;
    }
    if (body !== undefined && typeof body !== "string") {
      return `body.sources[${i}].body must be a string`;
    }
    if (error !== undefined && typeof error !== "string") {
      return `body.sources[${i}].error must be a string`;
    }
    // A 304 carries neither: the stored value already is the payload.
    if (body === undefined && error === undefined && status !== 304) {
      return `body.sources[${i}] needs either body or error`;
    }
    parsed.push({ key, url, status, body, error });
  }
  return parsed;
}

/** A header value must be ASCII on one line. */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 400);
}

/**
 * The headers of one table's report: a new file travels as the body, with its ETag;
 * a 304 or a failure travels without one, as a header saying which.
 */
export function reportHeaders(download: UpstreamFetch): Record<string, string> {
  if (download.body !== undefined) {
    return { "Content-Type": "text/plain; charset=utf-8", ...(download.etag && { "X-Upstream-ETag": download.etag }) };
  }
  if (download.notModified) {
    return { "X-Upstream-Status": "304" };
  }
  return { "X-Upstream-Error": headerSafe(download.error ?? "fetch failed") };
}

/** A report as reportHeaders wrote it; `etag` goes with a new file, which is the body. */
export type TableReport = { error: string } | { notModified: true } | { etag?: string };

export function readReport(headers: Headers): TableReport {
  const error = headers.get("X-Upstream-Error");
  if (error !== null) {
    return { error };
  }
  if (headers.get("X-Upstream-Status") === "304") {
    return { notModified: true };
  }
  return { etag: headers.get("X-Upstream-ETag") ?? undefined };
}
