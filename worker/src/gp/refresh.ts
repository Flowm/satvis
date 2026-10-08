// Store-agnostic: the Worker runs it against KV, scripts/update-static-gp.mjs against disk.

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import { buildStatuses, collectSources, evaluateGroups, fetchSources, type FetchImpl, type SourceProbe, toProbe, toRecordsBySource, withConfig } from "./evaluate.ts";
import { SatelliteTable } from "./satelliteTable.ts";
import { kvGroupStore, type GroupStore } from "./store.ts";
import type { GroupsConfig, GroupsIndex, UpstreamName, UpstreamStatus } from "./types.ts";
import { refreshUpstream } from "./upstream.ts";
import { UPSTREAMS } from "./upstreams.ts";

export const groupsConfig = generatedConfig as GroupsConfig;

export interface RefreshReport {
  index: GroupsIndex;
  sources: SourceProbe[];
  written: number;
  skipped: number;
  durationMs: number;
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

  // The stored tables, parsed anew, so a parser change applies on the next update (ADR 0008).
  const table = await SatelliteTable.load(store, config);

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
      // After evaluateGroups, so every served record, includes and extras too, gets exactly one pass.
      const records = table.enrich(result.records);
      written++;
      return store.writeGroup(def.name, records, { updated: now, count: records.length });
    }),
  );

  // A failed group contributes no records, so its satellites would look unmatched:
  // check only when every group evaluated.
  if (skipped > 0) {
    console.log(`gp refresh: skipping the satellite-table check — ${skipped} group(s) failed, so unmatched entries cannot be distinguished from unreachable ones`);
  } else {
    for (const entry of table.unmatched()) {
      console.warn(`gp refresh: satellite table entry ${entry.noradId}${entry.name ? ` (${entry.name})` : ""} matched no record in any group`);
    }
  }

  const refreshed: GroupsIndex = { updated: now, groups: statuses };
  // The static snapshot is served straight from disk, so write the config's half too.
  const index = withConfig(refreshed, config);
  await store.writeIndex(index);
  const durationMs = Date.now() - startedMs;
  console.log(
    `gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed, enriched from ${table.rows.satcat ?? 0} satcat and ${table.rows.gcat ?? 0} gcat rows`,
  );
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

/**
 * The Worker's own fetch of every upstream table, one after another, each conditional
 * on its stored file. The groups pick them up at the next GP update. A table whose
 * store write fails is reported with its error, and the next one is still fetched.
 */
export async function refreshUpstreams(store: GroupStore, fetchImpl: FetchImpl): Promise<Partial<Record<UpstreamName, UpstreamStatus>>> {
  const now = new Date().toISOString();
  const statuses: Partial<Record<UpstreamName, UpstreamStatus>> = {};
  for (const spec of UPSTREAMS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one file in memory at a time; GCAT's is 19 MB
      statuses[spec.name] = await refreshUpstream(spec, store, fetchImpl, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`upstream ${spec.name}: store failed — ${message}`);
      statuses[spec.name] = { lastError: `store failed: ${message}`, lastErrorAt: now };
    }
  }
  return statuses;
}

/** refreshUpstreams against KV and the real fetch: POST /api/upstream/refresh and the catalog cron. */
export async function refreshAllUpstreams(env: Env): Promise<Partial<Record<UpstreamName, UpstreamStatus>>> {
  return refreshUpstreams(kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
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

export async function ingestAll(env: Env, sources: IngestSource[]): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), bundleFetch(sources));
}
