// The Worker's wiring of the store-agnostic pipeline: the generated config, KV and the
// global fetch. Scripts wire the same functions to disk instead (scripts/update-static-gp.mjs).

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import { bundleFetch, type IngestSource } from "./pushProtocol.ts";
import { refreshGroups, type RefreshReport, refreshUpstreams } from "./refresh.ts";
import { kvGroupStore } from "./store.ts";
import type { GroupsConfig, UpstreamName, UpstreamStatus } from "./types.ts";

export const groupsConfig = generatedConfig as GroupsConfig;

export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

/** refreshUpstreams against KV and the real fetch: POST /api/upstream/refresh and the catalog cron. */
export async function refreshAllUpstreams(env: Env): Promise<Partial<Record<UpstreamName, UpstreamStatus>>> {
  return refreshUpstreams(kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

export async function ingestAll(env: Env, sources: IngestSource[]): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), bundleFetch(sources));
}
