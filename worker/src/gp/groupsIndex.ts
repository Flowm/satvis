// The groups index: what a refresh writes beside the groups, and what the API serves. No
// Cloudflare APIs: scripts/diskStore.mjs imports it through node type stripping.

import type { GroupResult } from "./evaluate.ts";
import type { GroupDefinition, GroupsConfig, GroupsIndex, GroupStatus } from "./types.ts";

export function coerceIndex(raw: unknown): GroupsIndex {
  if (raw && typeof raw === "object" && Array.isArray((raw as GroupsIndex).groups)) {
    return raw as GroupsIndex;
  }
  return { updated: "", groups: [] };
}

/**
 * Lays the config's tags and presets over a stored index. The API applies it too,
 * so a deploy that changes them takes effect before the next refresh.
 */
export function withConfig(index: GroupsIndex, config: GroupsConfig): GroupsIndex {
  const stored = new Map(index.groups.map((status) => [status.name, status]));
  const groups = config.groups.map((def): GroupStatus => {
    const { tags: _stale, ...status } = stored.get(def.name) ?? { name: def.name, updated: null, count: 0 };
    return def.tags === undefined ? status : { ...status, tags: def.tags };
  });
  const presets = Object.fromEntries((config.presets ?? []).map(({ name, ...preset }) => [name, preset]));
  return { ...index, groups, presets };
}

/**
 * A failed group keeps the previous `updated`/`count`, because its last-known-good
 * data still serves. The static generator shares this, so the two cannot diverge.
 */
export function buildStatuses(defs: GroupDefinition[], evaluated: Map<string, GroupResult | Error>, previousIndex: GroupsIndex, now: string): GroupStatus[] {
  const previousByName = new Map(previousIndex.groups.map((status) => [status.name, status]));
  return defs.map((def) => {
    const result = evaluated.get(def.name);
    if (result === undefined || result instanceof Error) {
      const message = result instanceof Error ? result.message : "not evaluated";
      const prev = previousByName.get(def.name);
      return { name: def.name, updated: prev?.updated ?? null, count: prev?.count ?? 0, lastError: message, lastErrorAt: now };
    }
    const status: GroupStatus = { name: def.name, updated: now, count: result.records.length };
    if (result.warnings.length > 0) {
      status.warnings = result.warnings;
    }
    return status;
  });
}
