// The GP sources: where each lives, and their sequential download. No Cloudflare APIs:
// push-gp imports this file through node type stripping.

import { download, type FetchImpl } from "./download.ts";
import type { GroupDefinition, OmmRecord, SourceSpec } from "./types.ts";

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/";
/** CelesTrak asks clients to space out requests. */
const REQUEST_SPACING_MS = 250;
/**
 * Aborts a stalled source, so one hung upstream cannot push the sequential refresh
 * past the cron / 120 s /__scheduled limit. CelesTrak's largest groups need far less.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export function sourceKey(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `celestrak:${spec.celestrak}`;
  }
  if ("celestrakSup" in spec) {
    return `celestrakSup:${spec.celestrakSup}`;
  }
  return `url:${spec.url}`;
}

export function sourceUrl(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `${CELESTRAK_BASE}gp.php?GROUP=${encodeURIComponent(spec.celestrak)}&FORMAT=JSON`;
  }
  if ("celestrakSup" in spec) {
    return `${CELESTRAK_BASE}supplemental/sup-gp.php?FILE=${encodeURIComponent(spec.celestrakSup)}&FORMAT=JSON`;
  }
  return spec.url;
}

/** Deduped by sourceKey, so two groups naming one source fetch it once. */
export function collectSources(defs: GroupDefinition[]): SourceSpec[] {
  const seen = new Map<string, SourceSpec>();
  for (const def of defs) {
    for (const spec of def.sources ?? []) {
      const key = sourceKey(spec);
      if (!seen.has(key)) {
        seen.set(key, spec);
      }
    }
  }
  return [...seen.values()];
}

/** A failed source maps to an Error, so it breaks only the groups that use it. */
export type RecordsBySource = Map<string, OmmRecord[] | Error>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** CelesTrak serves HTML error pages with HTTP 200, so check the body shape too. */
function parseOmmArray(status: number, body: string): OmmRecord[] {
  if (status !== 200) {
    throw new Error(`HTTP ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`response is not JSON (starts with ${JSON.stringify(body.slice(0, 32))})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("response is not a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("response array is empty");
  }
  const first = parsed[0] as Record<string, unknown>;
  if (first === null || typeof first !== "object" || !("NORAD_CAT_ID" in first)) {
    throw new Error("first element is missing NORAD_CAT_ID");
  }
  return parsed as OmmRecord[];
}

/**
 * `records` on success, else `error`. `status` / `bytes` / `bodySample` are set when
 * the fetch got that far, which tells a bad body from a dead connection.
 */
export interface SourceFetch {
  key: string;
  url: string;
  ms: number;
  status?: number;
  bytes?: number;
  records?: OmmRecord[];
  error?: string;
  bodySample?: string;
}

/** Never throws. */
async function fetchSource(spec: SourceSpec, fetchImpl: FetchImpl): Promise<SourceFetch> {
  const key = sourceKey(spec);
  const url = sourceUrl(spec);
  const { ms, value, error } = await download(fetchImpl, url, { timeoutMs: REQUEST_TIMEOUT_MS }, async (res) => ({ status: res.status, body: await res.text() }));
  if (value === undefined) {
    // Never reached the origin: DNS, TLS or connection failure, or the abort timer (522-class stalls).
    return { key, url, ms, error };
  }
  const { status, body } = value;
  try {
    return { key, url, ms, status, bytes: body.length, records: parseOmmArray(status, body) };
  } catch (parseErr) {
    // The origin answered with something that is not OMM; the sample makes the logs diagnosable.
    return { key, url, ms, status, bytes: body.length, error: parseErr instanceof Error ? parseErr.message : String(parseErr), bodySample: body.slice(0, 120) };
  }
}

/** Never throws. It logs before each fetch, so the last line printed names a stalled source. */
export async function fetchSources(defs: GroupDefinition[], fetchImpl: FetchImpl): Promise<SourceFetch[]> {
  const specs = collectSources(defs);
  const results: SourceFetch[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (i > 0) {
      // Sequential on purpose, to spare CelesTrak; do not parallelize.
      // eslint-disable-next-line no-await-in-loop
      await delay(REQUEST_SPACING_MS);
    }
    const label = `[${i + 1}/${specs.length}]`;
    console.log(`gp fetch ${label} ${sourceKey(spec)}: GET ${sourceUrl(spec)}`);
    // eslint-disable-next-line no-await-in-loop -- sequential, rate-limited fetch (see above)
    const r = await fetchSource(spec, fetchImpl);
    if (r.records !== undefined) {
      console.log(`gp fetch ${label} ${r.key}: OK HTTP ${r.status}, ${r.records.length} records, ${r.bytes} bytes, ${r.ms}ms`);
    } else {
      const sample = r.bodySample ? ` body=${JSON.stringify(r.bodySample.replace(/\s+/g, " ").trim())}` : "";
      console.warn(`gp fetch ${label} ${r.key}: FAILED after ${r.ms}ms — ${r.error}${sample}`);
    }
    results.push(r);
  }
  return results;
}

export function toRecordsBySource(fetched: SourceFetch[]): RecordsBySource {
  const map: RecordsBySource = new Map();
  for (const r of fetched) {
    map.set(r.key, r.records ?? new Error(r.error ?? "fetch failed"));
  }
  return map;
}

/**
 * JSON-safe fetch diagnostics for the /api/refresh report. Failures such as 522s
 * reproduce only from the Worker's egress, so the caller must see what came back.
 */
export interface SourceProbe {
  key: string;
  url: string;
  ok: boolean;
  ms: number;
  status?: number;
  bytes?: number;
  records?: number;
  sample?: string;
  error?: string;
  bodySample?: string;
}

export function toProbe(r: SourceFetch): SourceProbe {
  return {
    key: r.key,
    url: r.url,
    ok: r.records !== undefined,
    ms: r.ms,
    status: r.status,
    bytes: r.bytes,
    records: r.records?.length,
    sample: r.records?.[0]?.OBJECT_NAME,
    error: r.error,
    bodySample: r.bodySample,
  };
}
