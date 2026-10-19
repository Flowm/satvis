// Which catalog entries should have a live SatelliteComponentCollection, and how the
// browser's toggles rewrite the three activation lists.
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

type ReadonlyActivationLists = Readonly<Record<keyof ActivationLists, readonly string[]>>;

/** The catalog, as the transitions below read it. */
interface CatalogLookup {
  entriesWithTag(tag: string): CatalogEntry[];
  getByName(name: string): CatalogEntry | undefined;
}

/**
 * The lists after hiding `hidden`: a group whose every member is hidden is dropped rather than
 * listed member by member in `xsats=`, and only what a remaining group still covers becomes an
 * exclusion.
 */
export function hideFromActivation(lists: ReadonlyActivationLists, hidden: ReadonlySet<string>, catalog: CatalogLookup): ActivationLists {
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

/**
 * Drops exclusions no remaining group covers, so re-enabling a group starts full. Names
 * unknown to the catalog are kept: their group may not have loaded yet.
 */
function prunedExclusions(disabledSatellites: readonly string[], remainingTags: readonly string[], catalog: CatalogLookup): string[] {
  if (disabledSatellites.length === 0) {
    return [];
  }
  const tagSet = new Set(remainingTags);
  return disabledSatellites.filter((name) => {
    const entry = catalog.getByName(name);
    return entry === undefined || isEnabledByTag(entry, tagSet);
  });
}

/**
 * The lists that change when tag `tag` is toggled (a group row in the browser): off -> all; some -> all (clears
 * exclusions); all -> off. Never touches enabledSatellites, so `sats=` cannot explode.
 */
export function toggledGroup(lists: ReadonlyActivationLists, tag: string, catalog: CatalogLookup): Partial<ActivationLists> {
  if (!lists.enabledTags.includes(tag)) {
    return { enabledTags: [...lists.enabledTags, tag] };
  }
  const memberNames = new Set(catalog.entriesWithTag(tag).map((entry) => entry.name));
  if (lists.disabledSatellites.some((name) => memberNames.has(name))) {
    return { disabledSatellites: lists.disabledSatellites.filter((name) => !memberNames.has(name)) };
  }
  const remaining = lists.enabledTags.filter((t) => t !== tag);
  return { enabledTags: remaining, disabledSatellites: prunedExclusions(lists.disabledSatellites, remaining, catalog) };
}

/**
 * The lists that change when satellite `name` is toggled. One in an enabled group toggles
 * `xsats=`; any other toggles `sats=`. The two stay disjoint.
 */
export function toggledSatellite(lists: ReadonlyActivationLists, name: string, catalog: CatalogLookup): Partial<ActivationLists> {
  const entry = catalog.getByName(name);
  if (entry && isEnabledByTag(entry, new Set(lists.enabledTags))) {
    if (lists.disabledSatellites.includes(name)) {
      return { disabledSatellites: lists.disabledSatellites.filter((s) => s !== name) };
    }
    // Drop a redundant individual enable, which would beat the exclusion.
    return { disabledSatellites: [...lists.disabledSatellites, name], enabledSatellites: lists.enabledSatellites.filter((s) => s !== name) };
  }
  if (lists.enabledSatellites.includes(name)) {
    return { enabledSatellites: lists.enabledSatellites.filter((s) => s !== name) };
  }
  // An explicit enable overrides a stale exclusion.
  return { enabledSatellites: [...lists.enabledSatellites, name], disabledSatellites: lists.disabledSatellites.filter((s) => s !== name) };
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
