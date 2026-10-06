// Store-agnostic: the Worker runs it against KV, scripts/update-static-gp.mjs against disk.

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

export interface RefreshReport {
  index: GroupsIndex;
  sources: SourceProbe[];
  written: number;
  skipped: number;
  durationMs: number;
}

/** Curated rows override SATCAT field by field, so a row with only a swath keeps SATCAT's owner. */
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

/**
 * A 304 and a failure both fall back to the stored snapshot: a SATCAT outage costs
 * enrichment freshness and nothing else.
 */
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

  // Carry the previous `updated` forward, so it still says when the rows were fetched.
  console.warn(`gp refresh: satcat FAILED after ${result.ms}ms — ${result.error} (keeping ${count} stored rows)`);
  return {
    snapshot: stored,
    status: { updated: previous.satcat?.updated ?? stored?.updated ?? "", count, validator: stored?.validator, lastError: result.error, lastErrorAt: now },
  };
}

/** Failed groups get no write, so their last-known-good value stays in the store. */
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

  // Enrich after evaluateGroups, so every served record, includes and extras too, gets exactly one pass.
  const table = mergeSatelliteTables(satcat.snapshot, config.satellites ?? []);
  const matchedSatnums = new Set<string>();

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

  // A failed group contributes no records, so its satellites would look unmatched:
  // check only when every group evaluated.
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
  // The static snapshot is served straight from disk, so write the config's half too.
  const index = withConfig(refreshed, config);
  await store.writeIndex(index);
  const durationMs = Date.now() - startedMs;
  console.log(`gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed, ${satcat.status?.count ?? 0} satcat rows`);
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

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
  /**
   * The ETag the downloader saw, replayed as a header for the SATCAT fetch. GP sources leave it unset.
   */
  validator?: string;
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
      // E.g. an older push-gp against a newer Worker. A group keeps its last-known-good;
      // fetchSatcat catches it and keeps the stored snapshot.
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

export async function ingestAll(env: Env, sources: IngestSource[]): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), bundleFetch(sources));
}
