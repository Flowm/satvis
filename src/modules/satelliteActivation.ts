// Which catalog entries should have a live SatelliteComponentCollection.
// `disabledSatellites` beats only tag activation, never an explicit enable or
// tracking. Tracking keeps a satellite alive when its tag is disabled, so Cesium
// keeps no dangling trackedEntity. Must stay Cesium-free for node-env vitest.

import type { CatalogEntry } from "./SatelliteCatalog";

export interface ActivationState {
  entries: Iterable<CatalogEntry>;
  enabledTags: readonly string[];
  enabledSatellites: readonly string[];
  /** Names opted out of tag activation. */
  disabledSatellites?: readonly string[];
  trackedName?: string;
  pendingTrackedName?: string;
}

/** Shared with the SatelliteBrowser row model, so the UI and the manager cannot diverge. */
export function isEnabledByTag(entry: CatalogEntry, tagSet: ReadonlySet<string>): boolean {
  return entry.tags.some((tag) => tagSet.has(tag));
}

export function activeTargetEntries(state: ActivationState): Map<string, CatalogEntry> {
  const enabledTags = new Set(state.enabledTags);
  const enabledSatellites = new Set(state.enabledSatellites);
  const disabledSatellites = new Set(state.disabledSatellites ?? []);
  const target = new Map<string, CatalogEntry>();

  for (const entry of state.entries) {
    const enabledByTag = isEnabledByTag(entry, enabledTags) && !disabledSatellites.has(entry.name);
    const enabledByName = enabledSatellites.has(entry.name);
    const enabledByTrack = entry.name === state.trackedName || entry.name === state.pendingTrackedName;
    if (enabledByTag || enabledByName || enabledByTrack) {
      target.set(entry.key, entry);
    }
  }

  return target;
}

/** Tracked satellite first: a large build spreads over frames, and at 5,000 entries last waits seconds. */
export function buildOrder(entries: Iterable<[string, CatalogEntry]>, trackedName?: string): [string, CatalogEntry][] {
  const ordered = [...entries];
  if (!trackedName) {
    return ordered;
  }
  const index = ordered.findIndex(([, entry]) => entry.name === trackedName);
  if (index <= 0) {
    return ordered;
  }
  const [tracked] = ordered.splice(index, 1);
  return tracked ? [tracked, ...ordered] : ordered;
}
