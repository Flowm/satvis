// The catalog sheet's state, at module scope so it survives the sheet's v-if remounts, and its
// actions on the globe, which go through setActivation like every activation writer.

import { storeToRefs } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";

import {
  type CatalogFilter,
  type CatalogRow,
  catalogRows,
  crossfilter,
  FACET_BY_KEY,
  FACETS,
  type FacetKey,
  type FilterChip,
  filterChips,
  leavesByParent,
  orbitLeafOf,
  type ShapeBox,
} from "../modules/catalogFacets";
import { hideFromActivation } from "../modules/satelliteActivation";
import type { SatelliteCatalog } from "../modules/SatelliteCatalog";
import { useSatStore } from "../stores/sat";
import { useSatelliteBrowser } from "./useSatelliteBrowser";

/** The most names one show writes to `sats=`, which every bookmark copies (ADR 0012). */
export const SHOW_CAP = 500;

/** The list's sort keys. */
export type SortKey = "name" | "satnum" | "orbit" | "country" | "launchDate" | "altitudeKm" | "inclinationDeg";

/** Picked values per facet. */
const pickedFacets = reactive(Object.fromEntries(FACETS.map((def) => [def.key, new Set<string>()])) as Record<FacetKey, Set<string>>);
/** Inclusive launch years, brushed on the histogram. */
const launchYears = ref<[number, number] | null>(null);
/** The box dragged on the orbit-shape plot. */
const shape = ref<ShapeBox | null>(null);
/** Name or NORAD id. */
const query = ref("");
/** Lists only what the globe shows. */
const activeOnly = ref(false);
/** The list's sort, by name at first. */
const sortKey = ref<SortKey>("name");
const sortDescending = ref(false);
/** The full-catalog load, while in flight. */
const loading = shallowRef<Promise<void> | undefined>();

/** The orbit facet's order, for sorting the list by orbit. */
const orbitRank = (row: CatalogRow): number => FACET_BY_KEY.orbit.order!.indexOf(orbitLeafOf(row.orbitClass, row.orbitKind));

/** A row's value for a sort key; undefined sorts last. */
function sortValue(row: CatalogRow, key: SortKey): string | number | undefined {
  return key === "orbit" ? orbitRank(row) : row[key];
}

/** The catalog sheet's filters, matches and globe actions. */
export function useCatalogFilters(catalog: SatelliteCatalog) {
  const satStore = useSatStore();
  const { catalogRevision, enabledTags, enabledSatellites, disabledSatellites } = storeToRefs(satStore);
  const browser = useSatelliteBrowser(catalog);

  /** Loads every group, search-only ones too; a failed group is retried on the next call. */
  function loadAll(): Promise<void> {
    if (loading.value === undefined) {
      const load = catalog.ensureAll().finally(() => {
        if (loading.value === load) {
          loading.value = undefined;
        }
      });
      loading.value = load;
    }
    return loading.value;
  }

  const rows = computed<CatalogRow[]>(() => {
    void catalogRevision.value;
    const searchOnly = new Set(catalog.groups.filter((group) => group.searchOnly).map((group) => group.tag));
    return catalogRows(catalog.entries, searchOnly, Date.now());
  });

  const filter = computed<CatalogFilter>(() => ({ facets: pickedFacets, launchYears: launchYears.value, shape: shape.value, query: query.value, activeOnly: activeOnly.value }));

  const result = computed(() => crossfilter(rows.value, filter.value, browser.activeSatNames.value));

  const matched = computed<CatalogRow[]>(() => {
    const key = sortKey.value;
    const direction = sortDescending.value ? -1 : 1;
    return result.value.matched.toSorted((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })) * direction;
    });
  });

  /** Each tree facet's leaves across the whole catalog, by parent. */
  const treeLeaves = computed(
    () => Object.fromEntries(FACETS.filter((def) => def.parentOf).map((def) => [def.key, leavesByParent(def, rows.value)])) as Partial<Record<FacetKey, Map<string, Set<string>>>>,
  );
  const chips = computed<FilterChip[]>(() => filterChips(filter.value, treeLeaves.value));

  function toggle(facet: FacetKey, value: string): void {
    const picked = pickedFacets[facet];
    if (picked.has(value)) {
      picked.delete(value);
    } else {
      picked.add(value);
    }
  }

  /** Picks all of `values`, or drops them when all are picked already. */
  function toggleAll(facet: FacetKey, values: readonly string[]): void {
    const picked = pickedFacets[facet];
    const all = values.every((value) => picked.has(value));
    for (const value of values) {
      if (all) {
        picked.delete(value);
      } else {
        picked.add(value);
      }
    }
  }

  /** A tree parent: every leaf it has across the catalog, not only those other filters leave visible. */
  function toggleParent(facet: FacetKey, parent: string): void {
    toggleAll(facet, [...(treeLeaves.value[facet]?.get(parent) ?? [])]);
  }

  function clearFacet(facet: FacetKey): void {
    pickedFacets[facet].clear();
  }

  function removeChip(chip: FilterChip): void {
    const { clears } = chip;
    if (clears === "launch") launchYears.value = null;
    else if (clears === "shape") shape.value = null;
    else if (clears === "query") query.value = "";
    else if (clears === "activeOnly") activeOnly.value = false;
    else clears.values.forEach((value) => pickedFacets[clears.facet].delete(value));
  }

  function clearFilters(): void {
    FACETS.forEach((def) => pickedFacets[def.key].clear());
    launchYears.value = null;
    shape.value = null;
    query.value = "";
    activeOnly.value = false;
  }

  /** A second click on the same key reverses the order. */
  function sortBy(key: SortKey): void {
    if (sortKey.value === key) {
      sortDescending.value = !sortDescending.value;
    } else {
      sortKey.value = key;
      sortDescending.value = false;
    }
  }

  /** Replaces what the globe shows with the first SHOW_CAP matches; returns how many. */
  function showOnly(matches: readonly CatalogRow[]): number {
    const names = matches.slice(0, SHOW_CAP).map((row) => row.name);
    satStore.setActivation({ enabledTags: [], enabledSatellites: names, disabledSatellites: [] });
    return names.length;
  }

  /** Adds the first SHOW_CAP matches the globe does not show yet; returns how many. */
  function add(matches: readonly CatalogRow[]): number {
    const names = matches
      .filter((row) => !browser.activeSatNames.value.has(row.name))
      .slice(0, SHOW_CAP)
      .map((row) => row.name);
    satStore.setActivation({ enabledSatellites: [...enabledSatellites.value, ...names] });
    return names.length;
  }

  function hide(matches: readonly CatalogRow[]): void {
    const lists = { enabledTags: enabledTags.value, enabledSatellites: enabledSatellites.value, disabledSatellites: disabledSatellites.value };
    satStore.setActivation(hideFromActivation(lists, new Set(matches.map((row) => row.name)), catalog));
  }

  return {
    pickedFacets,
    launchYears,
    shape,
    query,
    activeOnly,
    sortKey,
    sortDescending,
    /** The full catalog is loading. */
    isLoading: computed(() => loading.value !== undefined),
    loadAll,
    rows,
    /** Per-facet counts, launches per year, the plot's bright rows. */
    result,
    /** The matches, sorted. */
    matched,
    chips,
    /** What the globe shows, by name. */
    active: browser.activeSatNames,
    toggle,
    toggleAll,
    toggleParent,
    clearFacet,
    removeChip,
    clearFilters,
    sortBy,
    showOnly,
    add,
    hide,
    clearGlobe: browser.clearAll,
    toggleSat: browser.toggleSat,
    /** Never turns a satellite off: opening its info needs it built. */
    activateSat: browser.activateSat,
  };
}
