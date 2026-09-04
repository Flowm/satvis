// useSatelliteBrowser — module-scoped state + derived row model for the
// SatelliteBrowser panel. State lives at module scope (not inside the setup
// function) so search text, expansion and scroll position survive the panel
// being remounted (Satvis mounts the panel with a v-if, so opening/closing the
// catalog panel unmounts and remounts it; module scope keeps that transparent).
//
// The catalog itself is intentionally NOT reactive (it holds ~13k plain
// entries once the whole active catalog is in). Instead the store exposes `catalogRevision`, bumped whenever the
// catalog changes. Every computed here touches `catalogRevision.value` so it
// recomputes as groups arrive, while reading the actual entries imperatively
// from the catalog it is given.
//
// Writes only ever target the Pinia store, replacing the whole array (the
// url-sync plugin's $subscribe requires a new array reference to detect the
// change). sceneSync propagates store -> cc.sats — this composable never writes
// cc.sats directly.
//
// The catalog arrives as an argument rather than through the controller: it is
// the only thing here that is not the store, it is Cesium-free, and taking it
// directly is what keeps this file constructible without a viewer.

import { storeToRefs } from "pinia";
import { computed, ref } from "vue";

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
      // The colour here is the one the satellite's point is drawn in, so the
      // list reads as the legend for the globe.
      orbitClass: OrbitClass;
      // Only populated in search mode (tree-mode rows sit under their group).
      groupsLabel?: string;
    };

const SEARCH_DEBOUNCE_MS = 150;

const searchQuery = ref("");
const debouncedQuery = ref("");
// True while the full-catalog load a search triggers is still in flight, so
// the panel can say so instead of showing "No matches" for a name that is
// simply not here yet. The promise is kept so one load is not started twice.
const searchLoading = ref(false);
let searchLoad: Promise<void> | undefined;
// Collapsed by default: an empty set means every group is collapsed.
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

  // The groups the panel offers whole: a row in the tree, an entry in the
  // multiselect. Search-only groups are left out here but their satellites are
  // still in the search index, which is the whole point of them.
  const availableGroups = computed(() => allGroups.value.filter((group) => !group.searchOnly));

  const searchOnlyTags = computed(() => new Set(allGroups.value.filter((group) => group.searchOnly).map((group) => group.tag)));

  function setSearchQuery(value: string): void {
    searchQuery.value = value;
    // Search spans every group, so make sure the lazily-loaded ones arrive.
    // Memoized per group in the catalog, so once everything is in this settles
    // on the next microtask; a group that failed to load gets retried here.
    if (value.trim() !== "" && searchLoad === undefined) {
      searchLoading.value = true;
      const load = catalog.ensureAll().finally(() => {
        if (searchLoad === load) {
          searchLoad = undefined;
          searchLoading.value = false;
        }
      });
      searchLoad = load;
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

  // Precomputed search index: one entry per catalog satellite with a cheap,
  // uppercased match key (nameUpper already exists on the entry). Recomputed
  // only when the catalog revision bumps.
  const searchIndex = computed<{ entry: CatalogEntry; key: string }[]>(() => {
    void catalogRevision.value;
    return catalog.entries.map((entry) => ({
      entry,
      key: `${entry.nameUpper} ${entry.satnum}`,
    }));
  });

  // Sets of the current selection state, for fast membership tests.
  const enabledTagSet = computed(() => new Set(enabledTags.value));
  const enabledSatSet = computed(() => new Set(enabledSatellites.value));
  const disabledSatSet = computed(() => new Set(disabledSatellites.value));

  // Union of all active satellite names: individually selected, plus tag
  // members that are not opted out. Also drives group activeCount and the
  // summary bar. Mirrors activeTargetEntries (minus tracking).
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

  // Per-tag stats: total member count and how many are active (member of
  // activeSatNames — enabled via any tag or individually selected). The count
  // comes from availableGroups so a not-yet-loaded group shows its index
  // estimate instead of 0; an enabled-but-unloaded group is displayed as fully
  // active (optimistic — entries and exact counts follow when the load lands).
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

  // Purely count-based: an enabled group with opted-out members shows "some"
  // (indeterminate), so exclusions are visible at the group level.
  function groupState(count: number, activeCount: number): "all" | "some" | "none" {
    if (count > 0 && activeCount === count) {
      return "all";
    }
    return activeCount > 0 ? "some" : "none";
  }

  // The flat list the virtualizer renders. Two modes:
  //   Tree mode (no query): alphabetical group rows; expanded groups are
  //     followed by their member sat rows.
  //   Search mode: matching group rows first, then flat deduped sat rows whose
  //     match key contains the query, each annotated with its group labels.
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

    // Search mode.
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
      if (!key.includes(query) || seen.has(entry.name)) {
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

  // The groups a search hit belongs to, as the row shows them. A search-only
  // tag is left off: it names the catalog, not a group the user can pick.
  function groupsLabelOf(entry: CatalogEntry): string | undefined {
    const tags = entry.tags.filter((tag) => !searchOnlyTags.value.has(tag));
    return tags.length > 0 ? tags.join(", ") : undefined;
  }

  // Every action below writes a whole array to the store, never one element.

  // Exclusions no longer covered by any enabled group, dropped so re-enabling a
  // group later starts from the full group instead of resurrecting stale
  // opt-outs. Names unknown to the catalog are kept (they may belong to a
  // group that has not loaded yet — never destroy URL-hydrated state).
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

  // Replace the enabled groups wholesale. Pruning lives here rather than at the
  // call sites so the multiselect and the group rows cannot disagree.
  function setEnabledTags(next: string[]): void {
    satStore.setActivation({ enabledTags: next, disabledSatellites: prunedExclusions(next) });
  }

  // Toggle a whole group. Never touches enabledSatellites — the old "promote
  // full individual selection to a tag" behavior is deliberately dropped, and
  // group ops never bulk-write sats= so the URL can't explode.
  // Tri-state click cycle: off -> all on; "some" (opted-out members) -> all on
  // (clear the members' exclusions); all on -> off.
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

  // Toggle an individual satellite. A satellite covered by an enabled group
  // toggles via the exclusion list (xsats=), so unchecking it inside an active
  // group really disables it; anything else toggles the individual selection
  // (sats=). The two lists are kept disjoint per name.
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

  function toggleExpand(tag: string): void {
    const next = new Set(expandedGroups.value);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
      // Expanding lists the members, so load the group if it hasn't been yet.
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
    toggleExpand,
    clearAll,
  };
}
