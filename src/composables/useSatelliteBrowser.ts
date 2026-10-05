// State for the SatelliteBrowser panel, at module scope so it survives the panel's v-if remounts.
//
// The catalog (~13k entries) is not reactive: every computed touches `catalogRevision.value`
// and reads entries imperatively. Writes go only to the store, as whole arrays, because the
// url-sync plugin's $subscribe needs a new reference; sceneSync carries them to cc.sats.

import { storeToRefs } from "pinia";
import { computed, ref, shallowRef } from "vue";

import type { OrbitClass } from "../config/orbitClass";
import { isEnabledByTag } from "../modules/satelliteActivation";
import type { CatalogEntry, SatelliteCatalog } from "../modules/SatelliteCatalog";
import { useSatStore } from "../stores/sat";

export type BrowserRow =
  | {
      kind: "group";
      id: string;
      tag: string;
      count: number;
      activeCount: number;
      state: "all" | "some" | "none";
      expanded: boolean;
    }
  | {
      kind: "sat";
      id: string;
      name: string;
      satnum: string;
      checked: boolean;
      // Coloured like the satellite's point, so the list is the globe's legend.
      orbitClass: OrbitClass;
      // Search mode only.
      groupsLabel?: string;
    };

const SEARCH_DEBOUNCE_MS = 150;

const searchQuery = ref("");
const debouncedQuery = ref("");
// The full-catalog load a search starts, while in flight.
const searchLoad = shallowRef<Promise<void> | undefined>();
const searchLoading = computed(() => searchLoad.value !== undefined);
const expandedGroups = ref<Set<string>>(new Set());

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleDebounce(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debouncedQuery.value = searchQuery.value.trim();
    debounceTimer = undefined;
  }, SEARCH_DEBOUNCE_MS);
}

export function useSatelliteBrowser(catalog: SatelliteCatalog) {
  const satStore = useSatStore();
  const { catalogRevision, enabledSatellites, enabledTags, disabledSatellites } = storeToRefs(satStore);

  const allGroups = computed(() => {
    void catalogRevision.value;
    return catalog.groups;
  });

  const availableGroups = computed(() => allGroups.value.filter((group) => !group.searchOnly));

  const searchOnlyTags = computed(() => new Set(allGroups.value.filter((group) => group.searchOnly).map((group) => group.tag)));

  const isSearchOnly = (entry: CatalogEntry): boolean => entry.tags.length > 0 && entry.tags.every((tag) => searchOnlyTags.value.has(tag));

  // A group can rename a satellite a search-only group also carries, so the
  // catalog holds it twice under two names.
  const pickableSatnums = computed(() => {
    void catalogRevision.value;
    return new Set(catalog.entries.filter((entry) => !isSearchOnly(entry)).map((entry) => entry.satnum));
  });

  function setSearchQuery(value: string): void {
    searchQuery.value = value;
    // Search spans every group; a group that failed to load is retried here.
    if (value.trim() !== "" && searchLoad.value === undefined) {
      const load = catalog.ensureAll().finally(() => {
        if (searchLoad.value === load) {
          searchLoad.value = undefined;
        }
      });
      searchLoad.value = load;
    }
    scheduleDebounce();
  }

  function clearSearch(): void {
    searchQuery.value = "";
    debouncedQuery.value = "";
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  }

  const searchIndex = computed<{ entry: CatalogEntry; key: string }[]>(() => {
    void catalogRevision.value;
    return catalog.entries.map((entry) => ({
      entry,
      key: `${entry.nameUpper} ${entry.satnum}`,
    }));
  });

  const enabledTagSet = computed(() => new Set(enabledTags.value));
  const enabledSatSet = computed(() => new Set(enabledSatellites.value));
  const disabledSatSet = computed(() => new Set(disabledSatellites.value));

  // Individually selected plus tag members not opted out. Mirrors activeTargetEntries, minus tracking.
  const activeSatNames = computed<Set<string>>(() => {
    void catalogRevision.value;
    const disabled = disabledSatSet.value;
    const active = new Set(enabledSatellites.value);
    for (const tag of enabledTags.value) {
      for (const entry of catalog.entriesWithTag(tag)) {
        if (!disabled.has(entry.name)) {
          active.add(entry.name);
        }
      }
    }
    return active;
  });

  const activeSatCount = computed(() => activeSatNames.value.size);

  // `count` is the index estimate, so an unloaded group does not show 0. An enabled but
  // unloaded group shows as fully active until its entries arrive.
  const groupStats = computed<Map<string, { count: number; activeCount: number }>>(() => {
    void catalogRevision.value;
    const active = activeSatNames.value;
    const stats = new Map<string, { count: number; activeCount: number }>();
    for (const { tag, count } of availableGroups.value) {
      let activeCount = 0;
      for (const member of catalog.entriesWithTag(tag)) {
        if (active.has(member.name)) {
          activeCount += 1;
        }
      }
      if (enabledTagSet.value.has(tag) && !catalog.isTagLoaded(tag)) {
        activeCount = count;
      }
      stats.set(tag, { count, activeCount });
    }
    return stats;
  });

  // Count-based, so an enabled group with opted-out members shows "some".
  function groupState(count: number, activeCount: number): "all" | "some" | "none" {
    if (count > 0 && activeCount === count) {
      return "all";
    }
    return activeCount > 0 ? "some" : "none";
  }

  // Without a query: group rows, each expanded one followed by its members. With one:
  // matching groups, then deduplicated matching satellites with their group labels.
  const rows = computed<BrowserRow[]>(() => {
    void catalogRevision.value;
    const stats = groupStats.value;
    const active = activeSatNames.value;
    const groups = availableGroups.value.toSorted((a, b) => a.tag.localeCompare(b.tag));
    const query = debouncedQuery.value.toUpperCase();

    if (query === "") {
      const result: BrowserRow[] = [];
      for (const { tag } of groups) {
        const stat = stats.get(tag) ?? { count: 0, activeCount: 0 };
        const expanded = expandedGroups.value.has(tag);
        result.push({
          kind: "group",
          id: `g:${tag}`,
          tag,
          count: stat.count,
          activeCount: stat.activeCount,
          state: groupState(stat.count, stat.activeCount),
          expanded,
        });
        if (expanded) {
          const members = catalog.entriesWithTag(tag).toSorted((a, b) => a.name.localeCompare(b.name));
          for (const member of members) {
            result.push({
              kind: "sat",
              id: `s:${tag}:${member.name}`,
              name: member.name,
              satnum: member.satnum,
              checked: active.has(member.name),
              orbitClass: member.orbitClass,
            });
          }
        }
      }
      return result;
    }

    const result: BrowserRow[] = [];
    for (const { tag } of groups) {
      if (!tag.toUpperCase().includes(query)) {
        continue;
      }
      const stat = stats.get(tag) ?? { count: 0, activeCount: 0 };
      result.push({
        kind: "group",
        id: `g:${tag}`,
        tag,
        count: stat.count,
        activeCount: stat.activeCount,
        state: groupState(stat.count, stat.activeCount),
        expanded: false,
      });
    }
    const seen = new Set<string>();
    for (const { entry, key } of searchIndex.value) {
      if (!key.includes(query) || seen.has(entry.name) || (isSearchOnly(entry) && pickableSatnums.value.has(entry.satnum))) {
        continue;
      }
      seen.add(entry.name);
      result.push({
        kind: "sat",
        id: `s:${entry.name}`,
        name: entry.name,
        satnum: entry.satnum,
        checked: active.has(entry.name),
        orbitClass: entry.orbitClass,
        groupsLabel: groupsLabelOf(entry),
      });
    }
    return result;
  });

  function groupsLabelOf(entry: CatalogEntry): string | undefined {
    const tags = entry.tags.filter((tag) => !searchOnlyTags.value.has(tag));
    return tags.length > 0 ? tags.join(", ") : undefined;
  }

  // Drops exclusions no enabled group covers, so re-enabling a group starts full. Names
  // unknown to the catalog are kept: their group may not have loaded yet.
  function prunedExclusions(remainingTags: string[]): string[] {
    if (disabledSatellites.value.length === 0) {
      return [];
    }
    const tagSet = new Set(remainingTags);
    return disabledSatellites.value.filter((name) => {
      const entry = catalog.getByName(name);
      return entry === undefined || isEnabledByTag(entry, tagSet);
    });
  }

  // Prunes here, so the multiselect and the group rows cannot disagree.
  function setEnabledTags(next: string[]): void {
    satStore.setActivation({ enabledTags: next, disabledSatellites: prunedExclusions(next) });
  }

  // off -> all; some -> all (clears exclusions); all -> off. Never writes enabledSatellites,
  // so `sats=` cannot explode.
  function toggleGroup(tag: string): void {
    if (!enabledTagSet.value.has(tag)) {
      satStore.setActivation({ enabledTags: [...enabledTags.value, tag] });
      return;
    }
    const memberNames = new Set(catalog.entriesWithTag(tag).map((entry) => entry.name));
    const hasExcludedMember = disabledSatellites.value.some((name) => memberNames.has(name));
    if (hasExcludedMember) {
      satStore.setActivation({ disabledSatellites: disabledSatellites.value.filter((name) => !memberNames.has(name)) });
      return;
    }
    setEnabledTags(enabledTags.value.filter((t) => t !== tag));
  }

  // A satellite in an enabled group toggles `xsats=`; any other toggles `sats=`. The two stay disjoint.
  function toggleSat(name: string): void {
    const entry = catalog.getByName(name);
    if (entry && isEnabledByTag(entry, enabledTagSet.value)) {
      if (disabledSatSet.value.has(name)) {
        satStore.setActivation({ disabledSatellites: disabledSatellites.value.filter((s) => s !== name) });
      } else {
        // Drop a redundant individual enable, which would beat the exclusion.
        satStore.setActivation({
          disabledSatellites: [...disabledSatellites.value, name],
          enabledSatellites: enabledSatellites.value.filter((s) => s !== name),
        });
      }
      return;
    }
    if (enabledSatSet.value.has(name)) {
      satStore.setActivation({ enabledSatellites: enabledSatellites.value.filter((s) => s !== name) });
    } else {
      // An explicit enable overrides a stale exclusion.
      satStore.setActivation({
        enabledSatellites: [...enabledSatellites.value, name],
        disabledSatellites: disabledSatellites.value.filter((s) => s !== name),
      });
    }
  }

  // Never turns a satellite off: opening its info needs it built.
  function activateSat(name: string): void {
    if (!activeSatNames.value.has(name)) {
      toggleSat(name);
    }
  }

  function toggleExpand(tag: string): void {
    const next = new Set(expandedGroups.value);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
      void catalog.ensureTags([tag]);
    }
    expandedGroups.value = next;
  }

  function clearAll(): void {
    satStore.setActivation({ enabledTags: [], enabledSatellites: [], disabledSatellites: [] });
  }

  const hasActiveSelection = computed(() => enabledTags.value.length > 0 || enabledSatellites.value.length > 0);
  const groupCount = computed(() => enabledTags.value.length);
  const isLoading = computed(() => allGroups.value.length === 0);

  return {
    searchQuery,
    searchLoading,
    setSearchQuery,
    clearSearch,
    availableGroups,
    enabledTags,
    setEnabledTags,
    rows,
    activeSatCount,
    groupCount,
    hasActiveSelection,
    isLoading,
    toggleGroup,
    toggleSat,
    activateSat,
    toggleExpand,
    clearAll,
  };
}
