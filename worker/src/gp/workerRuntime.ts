// The Worker's wiring of the store-agnostic pipeline: the generated config and the global
// fetch. Scripts wire the same functions to disk instead (scripts/update-static-gp.mjs).

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import type { FetchImpl } from "./download.ts";
import { refreshGroups, type RefreshReport, refreshUpstreams } from "./refresh.ts";
import type { GroupStore } from "./store.ts";
import type { GroupsConfig, UpstreamName, UpstreamStatus } from "./types.ts";

export const groupsConfig = generatedConfig as GroupsConfig;

/** The Worker's own downloads. */
const workerFetch: FetchImpl = (url, init) => fetch(url, init);

/** The GP refresh; an ingest passes its bundle's replay (pushProtocol.ts, bundleFetch) as `fetchImpl`. */
export async function refreshAll(store: GroupStore, fetchImpl: FetchImpl = workerFetch): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, store, fetchImpl);
}

/** POST /api/upstream/refresh and the catalog cron. */
export async function refreshAllUpstreams(store: GroupStore): Promise<Partial<Record<UpstreamName, UpstreamStatus>>> {
  return refreshUpstreams(store, workerFetch);
}
