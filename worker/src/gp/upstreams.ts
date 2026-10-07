// The upstream tables, in one list: what push-catalog downloads, what
// POST /api/upstream/refresh fetches, and what PUT /api/upstream/<name> accepts.

import { GCAT_CATALOG, GCAT_ORGS, GCAT_PAYLOADS } from "./gcat.ts";
import { SATCAT } from "./satcat.ts";
import type { UpstreamName } from "./types.ts";
import type { UpstreamSpec } from "./upstream.ts";

/** Every upstream table, in the order they are fetched and listed. */
export const UPSTREAMS: readonly UpstreamSpec<unknown>[] = [SATCAT, GCAT_CATALOG, GCAT_ORGS, GCAT_PAYLOADS];

/** Undefined for a name no table has, which the API answers with 404. */
export function upstreamSpec(name: string): UpstreamSpec<unknown> | undefined {
  return UPSTREAMS.find((spec) => spec.name === (name as UpstreamName));
}
