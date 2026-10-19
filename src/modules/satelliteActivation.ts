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

/** The three activation lists, as the store's setActivation takes them. */
export interface ActivationLists {
  enabledTags: string[];
  enabledSatellites: string[];
  disabledSatellites: string[];
}

/**
 * The lists after hiding `hidden`: a group whose every member is hidden is dropped rather than
 * listed member by member in `xsats=`, and only what a remaining group still covers becomes an
 * exclusion.
 */
export function hideFromActivation(
  lists: Readonly<Record<keyof ActivationLists, readonly string[]>>,
  hidden: ReadonlySet<string>,
  catalog: { entriesWithTag(tag: string): CatalogEntry[]; getByName(name: string): CatalogEntry | undefined },
): ActivationLists {
  const enabledTags = lists.enabledTags.filter((tag) => !catalog.entriesWithTag(tag).every((entry) => hidden.has(entry.name)));
  const tagSet = new Set(enabledTags);
  const stillCovered = [...hidden].filter((name) => {
    const entry = catalog.getByName(name);
    return entry !== undefined && isEnabledByTag(entry, tagSet);
  });
  return {
    enabledTags,
    enabledSatellites: lists.enabledSatellites.filter((name) => !hidden.has(name)),
    disabledSatellites: enabledTags.length === 0 ? [] : [...lists.disabledSatellites.filter((name) => !hidden.has(name)), ...stillCovered],
  };
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
