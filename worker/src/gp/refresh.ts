// Store-agnostic refresh: fetch every source, evaluate every group, and
// persist successful groups while preserving last-known-good on failure.
// The worker cron/API run it against KV (refreshAll); the static snapshot
// generator runs the same pipeline against disk (scripts/update-static-gp.mjs).

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import {
  buildStatuses,
  collectSources,
  indexSatellitesByNoradId,
  enrichRecords,
  evaluateGroups,
  fetchSources,
  type FetchImpl,
  type SatelliteFacts,
  type SourceProbe,
  toProbe,
  toRecordsBySource,
  withConfig,
} from "./evaluate.ts";
import { fetchSatcat } from "./satcat.ts";
import { kvGroupStore, type GroupStore } from "./store.ts";
import type { GroupsConfig, GroupsIndex, SatcatSnapshot, SatcatStatus, SatelliteEntry } from "./types.ts";

export const groupsConfig = generatedConfig as GroupsConfig;

// Result of one refresh run: the rebuilt index plus the per-source fetch
// diagnostics and write tallies, so a manual trigger (POST /api/refresh) can
// report exactly what happened. The cron ignores the return value.
export interface RefreshReport {
  index: GroupsIndex;
  sources: SourceProbe[];
  written: number;
  skipped: number;
  durationMs: number;
}

/**
 * Merge the two contributors to the satellite table into the one map enrichment
 * reads: the whole CelesTrak SATCAT, with the curated rows laid over it.
 *
 * Curated wins field by field, not row by row — a YAML row that supplies only a
 * swath keeps SATCAT's owner and launch date rather than erasing them. That is
 * the point of the curated table: it corrects and extends upstream, and the
 * things worth hand-writing (swath extents, sensor cones, models) are things
 * SATCAT does not carry at all.
 */
export function mergeSatelliteTables(satcat: SatcatSnapshot | undefined, entries: SatelliteEntry[]): Map<string, SatelliteFacts> {
  const merged = new Map<string, SatelliteFacts>();
  for (const [satnum, bag] of Object.entries(satcat?.rows ?? {})) {
    merged.set(satnum, { metadata: bag });
  }
  for (const [satnum, curated] of indexSatellitesByNoradId(entries)) {
    const upstream = merged.get(satnum);
    merged.set(satnum, { metadata: upstream === undefined ? curated.metadata : { ...upstream.metadata, ...curated.metadata } });
  }
  return merged;
}

// Resolve the SATCAT to enrich with, and the status to publish alongside it.
//
// A conditional fetch means the stored snapshot is the normal input: a 304 has
// no body, so "unchanged" and "we already have it" are the same state. A failure
// lands in the same place by design — SATCAT going down must cost enrichment
// freshness and nothing else, because the groups themselves are fetched,
// evaluated and stored entirely independently of it.
async function resolveSatcat(
  store: GroupStore,
  fetchImpl: FetchImpl,
  previous: GroupsIndex,
  now: string,
): Promise<{ snapshot: SatcatSnapshot | undefined; status: SatcatStatus | undefined }> {
  const stored = await store.readSatcat();
  const result = await fetchSatcat(fetchImpl, stored?.validator);

  if (result.rows !== undefined) {
    const snapshot: SatcatSnapshot = { validator: result.validator, updated: now, rows: result.rows };
    await store.writeSatcat(snapshot);
    const count = Object.keys(result.rows).length;
    console.log(`gp refresh: satcat HTTP 200 — ${count} rows, ${result.bytes} bytes, ${result.ms}ms`);
    return { snapshot, status: { updated: now, count, validator: result.validator } };
  }

  const count = stored === undefined ? 0 : Object.keys(stored.rows).length;
  if (result.notModified) {
    console.log(`gp refresh: satcat HTTP 304 — reusing ${count} stored rows (${result.ms}ms)`);
    return { snapshot: stored, status: { updated: stored?.updated ?? now, count, validator: stored?.validator } };
  }

  // Failed. Keep serving what we have, and carry the previous status forward so
  // `updated` keeps saying when the rows were actually fetched.
  console.warn(`gp refresh: satcat FAILED after ${result.ms}ms — ${result.error} (keeping ${count} stored rows)`);
  return {
    snapshot: stored,
    status: { updated: previous.satcat?.updated ?? stored?.updated ?? "", count, validator: stored?.validator, lastError: result.error, lastErrorAt: now },
  };
}

// Fetch upstream, evaluate, enrich, and write results to the store. Failed
// groups are skipped so their last-known-good value stays in the store; the
// rebuilt index (see buildStatuses) keeps their old `updated` and gains
// lastError/lastErrorAt.
export async function refreshGroups(config: GroupsConfig, store: GroupStore, fetchImpl: FetchImpl): Promise<RefreshReport> {
  const defs = config.groups;
  const startedMs = Date.now();
  const now = new Date().toISOString();
  console.log(`gp refresh: start — ${defs.length} groups, ${collectSources(defs).length} sources`);

  const fetched = await fetchSources(defs, fetchImpl);
  const evaluated = evaluateGroups(defs, toRecordsBySource(fetched));
  const previous = await store.readIndex();
  const statuses = buildStatuses(defs, evaluated, previous, now);
  const satcat = await resolveSatcat(store, fetchImpl, previous, now);

  // Enrichment runs here rather than inside evaluateGroups so it sits on the far
  // side of `include` and `extraRecords` — every record actually served gets
  // exactly one pass, including pseudo TLE extras.
  const table = mergeSatelliteTables(satcat.snapshot, config.satellites ?? []);
  const matchedSatnums = new Set<string>();

  // Persist successful groups in parallel (independent keys). Failed groups
  // get no write, so their last-known-good value stays intact.
  let written = 0;
  let skipped = 0;
  await Promise.all(
    defs.map((def) => {
      const result = evaluated.get(def.name);
      if (result === undefined || result instanceof Error) {
        skipped++;
        return undefined;
      }
      for (const warning of result.warnings) {
        console.warn(`gp refresh: ${def.name}: ${warning}`);
      }
      const enriched = enrichRecords(result.records, table);
      for (const satnum of enriched.matched) {
        matchedSatnums.add(satnum);
      }
      written++;
      return store.writeGroup(def.name, enriched.records, { updated: now, count: enriched.records.length });
    }),
  );

  // A table entry matching nothing in any group is a config-health signal (typo,
  // or a satellite quietly gone), not per-group status — so it is logged rather
  // than written into the index. Decayed entries are expected never to match.
  //
  // Only meaningful when every group evaluated: a failed group contributes no
  // records, so its satellites would look unmatched when the truth is only that we
  // could not reach the upstream. Reporting that as a config problem would cry wolf
  // on every transient CelesTrak failure, so the check is skipped instead.
  if (skipped > 0) {
    console.log(`gp refresh: skipping the satellite-table check — ${skipped} group(s) failed, so unmatched entries cannot be distinguished from unreachable ones`);
  } else {
    const unmatched = (config.satellites ?? []).filter((entry) => !entry.decayed && !matchedSatnums.has(String(entry.noradId)));
    for (const entry of unmatched) {
      console.warn(`gp refresh: satellite table entry ${entry.noradId}${entry.name ? ` (${entry.name})` : ""} matched no record in any group`);
    }
  }

  const refreshed: GroupsIndex = { updated: now, groups: statuses };
  if (satcat.status !== undefined) {
    refreshed.satcat = satcat.status;
  }
  // Written with the config's half too, because the static snapshot is read
  // straight from disk with nothing to lay it over.
  const index = withConfig(refreshed, config);
  await store.writeIndex(index);
  const durationMs = Date.now() - startedMs;
  console.log(`gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed, ${satcat.status?.count ?? 0} satcat rows`);
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

// Worker entrypoint: bundled config, KV store, global fetch.
export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

// One source downloaded off-Worker and replayed into the pipeline by
// bundleFetch. `body` carries the raw upstream payload on success; `error`
// carries the downloader's failure message instead. Exactly one is set.
export interface IngestSource {
  key: string;
  url: string;
  status?: number;
  body?: string;
  error?: string;
  // The ETag the downloader observed, replayed as a response header so the
  // SATCAT fetch can store it as its next conditional-request validator. Only
  // the SATCAT entry uses it; GP sources leave it unset.
  validator?: string;
}

// A FetchImpl serving an already-downloaded bundle instead of the network, so
// an ingest runs byte-for-byte the same evaluate/enrich/store path as the cron
// — including parseOmmArray's validation, which still rejects a bad payload and
// leaves that group's last-known-good intact.
//
// The `url` is only ever a Map key here; nothing is dereferenced, so a posted
// bundle cannot make the Worker fetch anything.
export function bundleFetch(sources: IngestSource[]): FetchImpl {
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  return async (url) => {
    const source = byUrl.get(url);
    if (source === undefined) {
      // Reached only for a source the downloader did not post — an older
      // push-gp against a newer Worker, say. Fatal for a group (it keeps its
      // last-known-good), survivable for SATCAT (fetchSatcat catches it and the
      // stored snapshot stands).
      throw new Error("source absent from the ingest bundle");
    }
    if (source.error !== undefined) {
      throw new Error(source.error);
    }
    const validator = source.validator;
    return {
      status: source.status ?? 0,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (validator ?? null) : null) },
      text: async () => source.body ?? "",
    };
  };
}

// Worker entrypoint for POST /api/ingest: same config and store as refreshAll,
// but the bytes come from the caller rather than from CelesTrak. Exists because
// CelesTrak firewalls Cloudflare's shared Worker egress (every source comes back
// HTTP 522), so the download has to happen from an IP we are not sharing with
// every other tenant — see worker/scripts/push-gp.mjs.
export async function ingestAll(env: Env, sources: IngestSource[]): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), bundleFetch(sources));
}
