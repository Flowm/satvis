// The catalog sheet's model (ADR 0012): rows, facets, a filter and crossfilter counts.
// Cesium-free and Vue-free, so node-env vitest exercises it.

import { gcatCategoryLabel, gcatClassLabel } from "../config/gcatCodes";
import { ORBIT_KINDS, type OrbitClass, orbitKindLabel } from "../config/orbitClass";
import { SATCAT_LAUNCH_SITE, SATCAT_OPS_STATUS, satcatLabel } from "../config/satcatCodes";
import type { CatalogEntry } from "./SatelliteCatalog";
import { orbitShapeOf } from "./util/gp";

/** A facet value for a field GCAT or SATCAT leaves empty. */
export const UNKNOWN = "Unknown";

/** Launch mass bands, smallest first. */
export const SIZE_CLASSES = ["Nano, under 10 kg", "Micro, 10–100 kg", "Small, 100–500 kg", "Medium, 500 kg–1 t", "Large, 1–5 t", "Very large, over 5 t"] as const;
/** Kg, the upper bound of each size class but the last. */
const SIZE_BOUNDS_KG = [10, 100, 500, 1000, 5000];

/** Element set ages, freshest first. */
export const AGE_BUCKETS = ["Under 1 day", "1–3 days", "3–7 days", "1–2 weeks", "2–4 weeks", "1–3 months", "Over 3 months"] as const;
/** Days, the upper bound of each age bucket but the last. */
const AGE_BOUNDS_DAYS = [1, 3, 7, 14, 28, 91];

/** The orbit tree's leaf for satellites whose class has no kind. */
export const NO_KIND = "Other";
/** The constellation of a satellite GCAT does not list yet. */
export const NO_PROGRAM = "Not in GCAT yet";

/** One satellite, its facets labelled. */
export interface CatalogRow {
  /** The catalog name, which activation is keyed by. */
  name: string;
  satnum: string;
  orbitClass: OrbitClass;
  /** GCAT's kind code, undefined where the class has none. */
  orbitKind: string | undefined;
  /** The kind came from the element set, not GCAT. */
  orbitKindComputed: boolean;
  /** Pickable groups only, search-only ones left out. */
  groups: string[];
  purposes: string[];
  ownerType: string;
  country: string;
  operator: string;
  manufacturer: string;
  bus: string;
  status: string;
  launchSite: string;
  size: string;
  model: string;
  elementSetAge: string;
  /** GCAT's programme, or NO_PROGRAM. */
  program: string;
  launchDate: string | undefined;
  launchYear: number | undefined;
  massKg: number | undefined;
  /** Km, semi-major axis less Earth's equatorial radius. */
  altitudeKm: number;
  inclinationDeg: number;
  /** Days from the element set's epoch to when the rows were built. */
  ageDays: number;
}

/** The orbit facet's value for a row: "LEO/S", or "GEO/" for a class without a kind. */
export const orbitLeafOf = (orbitClass: OrbitClass, kind: string | undefined): string => `${orbitClass}/${kind ?? ""}`;

/** The one parser of an orbit leaf. */
export function parseOrbitLeaf(leaf: string): { orbitClass: OrbitClass; kind: string | undefined } {
  const [orbitClass, kind] = leaf.split("/") as [OrbitClass, string | undefined];
  return { orbitClass, kind: kind === "" ? undefined : kind };
}

/** A facet, as the filter and the sheet name it. */
export type FacetKey =
  | "orbit"
  | "group"
  | "purpose"
  | "country"
  | "operator"
  | "ownerType"
  | "status"
  | "manufacturer"
  | "bus"
  | "size"
  | "launchSite"
  | "model"
  | "elementSetAge"
  | "constellation";

/** A facet: how to read it off a row, and how to order and fold its values. */
export interface FacetDef {
  key: FacetKey;
  label: string;
  /** A lucide icon name. */
  icon: string;
  /** Several for a satellite with several purposes or groups. */
  values: (row: CatalogRow) => readonly string[];
  /** Values in this order instead of by count, the rest last; a tree lists its parents here too. */
  order?: readonly string[];
  /** Makes the facet a tree: the parent a leaf folds under. */
  parentOf?: (value: string) => string;
  /** A leaf's display name, where its value is a key. */
  leafLabel?: (value: string) => string;
}

/** "Starlink 2MO S1" -> "Starlink", "Flock-4" -> "Flock". */
export function constellationOf(program: string): string {
  return program === NO_PROGRAM ? NO_PROGRAM : (program.split(/[\s-]/).find((part) => part !== "") ?? program);
}

/** By altitude. */
const ORBIT_CLASSES: readonly OrbitClass[] = ["LEO", "MEO", "GEO", "HEO"];

/** By altitude, each class followed by its kinds in GCAT's order and then its kindless leaf. */
const ORBIT_ORDER = ORBIT_CLASSES.flatMap((orbitClass) =>
  ([orbitClass] as string[]).concat(
    Object.keys(ORBIT_KINDS).filter((key) => key.startsWith(`${orbitClass}/`)),
    orbitLeafOf(orbitClass, undefined),
  ),
);

/** Every facet, the trees first. */
export const FACETS: readonly FacetDef[] = [
  {
    key: "orbit",
    label: "Orbit",
    icon: "lucide:orbit",
    values: (row) => [orbitLeafOf(row.orbitClass, row.orbitKind)],
    order: ORBIT_ORDER,
    parentOf: (leaf) => parseOrbitLeaf(leaf).orbitClass,
    leafLabel: (leaf) => {
      const { orbitClass, kind } = parseOrbitLeaf(leaf);
      return kind === undefined ? NO_KIND : orbitKindLabel(orbitClass, kind);
    },
  },
  { key: "constellation", label: "Constellation", icon: "lucide:sparkles", values: (row) => [row.program], parentOf: constellationOf },
  { key: "group", label: "Group", icon: "lucide:folder", values: (row) => row.groups },
  { key: "purpose", label: "Purpose", icon: "lucide:target", values: (row) => row.purposes },
  { key: "country", label: "Country", icon: "lucide:flag", values: (row) => [row.country] },
  { key: "operator", label: "Operator", icon: "lucide:building-2", values: (row) => [row.operator] },
  { key: "ownerType", label: "Owner type", icon: "lucide:users", values: (row) => [row.ownerType] },
  { key: "status", label: "Status", icon: "lucide:activity", values: (row) => [row.status] },
  { key: "manufacturer", label: "Manufacturer", icon: "lucide:factory", values: (row) => [row.manufacturer] },
  { key: "bus", label: "Bus", icon: "lucide:box", values: (row) => [row.bus] },
  { key: "size", label: "Size", icon: "lucide:weight", values: (row) => [row.size], order: [...SIZE_CLASSES, UNKNOWN] },
  { key: "launchSite", label: "Launch site", icon: "lucide:rocket", values: (row) => [row.launchSite] },
  { key: "model", label: "3D model", icon: "lucide:rotate-3d", values: (row) => [row.model] },
  { key: "elementSetAge", label: "Element set age", icon: "lucide:clock", values: (row) => [row.elementSetAge], order: AGE_BUCKETS },
];

/** Every facet, by key. */
export const FACET_BY_KEY: Readonly<Record<FacetKey, FacetDef>> = Object.fromEntries(FACETS.map((def) => [def.key, def])) as Record<FacetKey, FacetDef>;

/** A value's parent, itself for a flat facet. */
const parentOf = (def: FacetDef, value: string): string => (def.parentOf ? def.parentOf(value) : value);

/** A value's place in the facet's order; values it lacks go last. */
function orderRank(def: FacetDef, value: string): number {
  const i = def.order?.indexOf(value) ?? -1;
  return i === -1 ? (def.order?.length ?? 0) : i;
}

/** The bucket a value falls in, by the buckets' upper bounds; UNKNOWN for none. */
function bucket(value: number | undefined, bounds: readonly number[], buckets: readonly string[]): string {
  if (value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  const i = bounds.findIndex((bound) => value < bound);
  return buckets[i === -1 ? buckets.length - 1 : i] ?? UNKNOWN;
}

/** One entry's row, with the groups united across its duplicates. */
function rowOf(entry: CatalogEntry, groups: string[], nowMs: number): CatalogRow {
  const m = entry.metadata;
  const { code, source } = entry.orbitKind;
  const { altitudeKm, inclinationDeg } = orbitShapeOf(entry.record);
  const ageDays = (nowMs - entry.epochMs) / 86_400_000;
  const launchYear = m.launchDate === undefined ? undefined : Number(m.launchDate.slice(0, 4));
  return {
    name: entry.name,
    satnum: entry.satnum,
    orbitClass: entry.orbitClass,
    orbitKind: code,
    orbitKindComputed: source === "computed",
    groups,
    purposes: m.category === undefined ? [UNKNOWN] : gcatCategoryLabel(m.category).split(" / "),
    ownerType: m.class === undefined ? UNKNOWN : gcatClassLabel(m.class),
    country: m.country ?? UNKNOWN,
    operator: m.operator ?? UNKNOWN,
    manufacturer: m.manufacturer ?? UNKNOWN,
    bus: m.bus ?? UNKNOWN,
    status: m.opsStatus === undefined ? UNKNOWN : satcatLabel(SATCAT_OPS_STATUS, m.opsStatus),
    launchSite: m.launchSite === undefined ? UNKNOWN : satcatLabel(SATCAT_LAUNCH_SITE, m.launchSite),
    size: bucket(m.massKg, SIZE_BOUNDS_KG, SIZE_CLASSES),
    model: m.modelFile === undefined ? "Point only" : "Has a 3D model",
    elementSetAge: bucket(ageDays, AGE_BOUNDS_DAYS, AGE_BUCKETS),
    program: m.program ?? NO_PROGRAM,
    launchDate: m.launchDate,
    launchYear: Number.isFinite(launchYear) ? launchYear : undefined,
    massKg: m.massKg,
    altitudeKm,
    inclinationDeg,
    ageDays,
  };
}

/**
 * One row per satnum. A satellite a search-only group renames keeps a pickable group's name,
 * as the compact browser lists it.
 */
export function catalogRows(entries: readonly CatalogEntry[], searchOnlyTags: ReadonlySet<string>, nowMs: number): CatalogRow[] {
  const bySatnum = new Map<string, { entry: CatalogEntry; groups: string[] }>();
  for (const entry of entries) {
    const groups = entry.tags.filter((tag) => !searchOnlyTags.has(tag));
    const seen = bySatnum.get(entry.satnum);
    if (seen === undefined) {
      bySatnum.set(entry.satnum, { entry, groups: [...groups] });
      continue;
    }
    if (seen.groups.length === 0 && groups.length > 0) {
      seen.entry = entry;
    }
    for (const group of groups) {
      if (!seen.groups.includes(group)) {
        seen.groups.push(group);
      }
    }
  }
  return [...bySatnum.values()].map(({ entry, groups }) => rowOf(entry, groups, nowMs));
}

/** A box on the orbit-shape plot. */
export interface ShapeBox {
  altitudeKm: [number, number];
  inclinationDeg: [number, number];
}

/** Everything the catalog sheet filters by. */
export interface CatalogFilter {
  /** An empty or missing set filters nothing. */
  facets: Partial<Record<FacetKey, ReadonlySet<string>>>;
  /** Inclusive; a satellite without a launch date is out while set. */
  launchYears: [number, number] | null;
  shape: ShapeBox | null;
  /** Name or satnum, case-insensitive. */
  query: string;
  /** Only what the globe shows. */
  activeOnly: boolean;
}

/** The dimensions a crossfilter counts apart. */
type Dimension = FacetKey | "launch" | "shape";

/** A crossfilter's matches and its charts' counts. */
export interface Crossfilter {
  matched: CatalogRow[];
  /** Per facet, value -> rows passing every filter but the facet's own. */
  counts: Record<FacetKey, Map<string, number>>;
  /** Launch year -> rows passing every filter but the launch years. */
  launches: Map<number, number>;
  /** Rows passing every filter but the shape box: the plot's bright points. */
  shapeRows: CatalogRow[];
}

/** Outside the box on either axis. */
function outsideShape(row: CatalogRow, box: ShapeBox): boolean {
  return row.altitudeKm < box.altitudeKm[0] || row.altitudeKm > box.altitudeKm[1] || row.inclinationDeg < box.inclinationDeg[0] || row.inclinationDeg > box.inclinationDeg[1];
}

/**
 * One pass: a row failing no dimension counts everywhere, one failing exactly one counts
 * toward that dimension's chart, and one failing two counts nowhere. The query and "only on
 * the globe" have no chart, so they gate every count.
 */
export function crossfilter(rows: readonly CatalogRow[], filter: CatalogFilter, active: ReadonlySet<string>): Crossfilter {
  const counts = Object.fromEntries(FACETS.map((def) => [def.key, new Map<string, number>()])) as Record<FacetKey, Map<string, number>>;
  const launches = new Map<number, number>();
  const matched: CatalogRow[] = [];
  const shapeRows: CatalogRow[] = [];
  const query = filter.query.trim().toUpperCase();
  const pickedFacets = FACETS.filter((def) => (filter.facets[def.key]?.size ?? 0) > 0);

  const countFacet = (def: FacetDef, row: CatalogRow) => {
    const map = counts[def.key];
    for (const value of def.values(row)) {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
  };
  const countLaunch = (row: CatalogRow) => {
    if (row.launchYear !== undefined) {
      launches.set(row.launchYear, (launches.get(row.launchYear) ?? 0) + 1);
    }
  };

  for (const row of rows) {
    if (query !== "" && !row.name.toUpperCase().includes(query) && !row.satnum.includes(query)) {
      continue;
    }
    if (filter.activeOnly && !active.has(row.name)) {
      continue;
    }
    let failed: Dimension | undefined;
    let failures = 0;
    for (const def of pickedFacets) {
      const picked = filter.facets[def.key]!;
      if (!def.values(row).some((value) => picked.has(value))) {
        failed = def.key;
        failures += 1;
        if (failures > 1) {
          break;
        }
      }
    }
    if (failures < 2 && filter.launchYears) {
      const [from, to] = filter.launchYears;
      if (row.launchYear === undefined || row.launchYear < from || row.launchYear > to) {
        failed = "launch";
        failures += 1;
      }
    }
    if (failures < 2 && filter.shape && outsideShape(row, filter.shape)) {
      failed = "shape";
      failures += 1;
    }
    if (failures === 0) {
      matched.push(row);
      shapeRows.push(row);
      countLaunch(row);
      for (const def of FACETS) {
        countFacet(def, row);
      }
    } else if (failures === 1) {
      if (failed === "launch") {
        countLaunch(row);
      } else if (failed === "shape") {
        shapeRows.push(row);
      } else if (failed !== undefined) {
        countFacet(FACET_BY_KEY[failed], row);
      }
    }
  }
  return { matched, counts, launches, shapeRows };
}

/** A facet value and its count. */
export interface FacetItem {
  value: string;
  count: number;
}

/** A facet's values with their counts, a picked value kept at 0 so it can be unpicked. */
export function facetItems(def: FacetDef, counts: Map<string, number>, picked: ReadonlySet<string> | undefined): FacetItem[] {
  const items = new Map(counts);
  for (const value of picked ?? []) {
    if (!items.has(value)) {
      items.set(value, 0);
    }
  }
  const list = [...items].map(([value, count]) => ({ value, count }));
  return list.toSorted((a, b) => orderRank(def, a.value) - orderRank(def, b.value) || b.count - a.count || a.value.localeCompare(b.value));
}

/** A tree facet's parent, its count and its leaves. */
export interface FacetBranch {
  parent: string;
  count: number;
  leaves: FacetItem[];
}

/** A tree facet's items under their parents. */
export function facetBranches(def: FacetDef, items: readonly FacetItem[]): FacetBranch[] {
  const branches = new Map<string, FacetBranch>();
  for (const item of items) {
    const parent = parentOf(def, item.value);
    const branch = branches.get(parent) ?? { parent, count: 0, leaves: [] };
    branch.count += item.count;
    branch.leaves.push(item);
    branches.set(parent, branch);
  }
  return [...branches.values()].toSorted((a, b) => orderRank(def, a.parent) - orderRank(def, b.parent) || b.count - a.count || a.parent.localeCompare(b.parent));
}

/** Every leaf of a tree facet across all rows, by parent: what picking a parent picks. */
export function leavesByParent(def: FacetDef, rows: readonly CatalogRow[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const value of def.values(row)) {
      const parent = parentOf(def, value);
      const leaves = result.get(parent) ?? new Set<string>();
      leaves.add(value);
      result.set(parent, leaves);
    }
  }
  return result;
}

/** The picked items first, then the rest up to `top` in all, so a pick never hides behind "+n more". */
export function pickedFirst<T>(items: readonly T[], isPicked: (item: T) => boolean, top: number): T[] {
  const picked = items.filter(isPicked);
  return [...picked, ...items.filter((item) => !isPicked(item)).slice(0, Math.max(0, top - picked.length))];
}

/** A removable chip naming one filter. */
export interface FilterChip {
  /** Unique among the chips. */
  id: string;
  /** What is filtered: "Orbit", "Launched". */
  facet: string;
  /** By what: "Sun-sync", "LEO", "2019–2024". */
  value: string;
  /** The facet values, or the filter, removing the chip clears. */
  clears: { facet: FacetKey; values: string[] } | "launch" | "shape" | "query" | "activeOnly";
}

/** One chip per picked value, a tree's fully picked parent as one chip, then the other filters. */
export function filterChips(filter: CatalogFilter, leaves: Partial<Record<FacetKey, Map<string, Set<string>>>>): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const def of FACETS) {
    const picked = filter.facets[def.key];
    if (!picked || picked.size === 0) {
      continue;
    }
    const remaining = new Set(picked);
    for (const [parent, values] of leaves[def.key] ?? []) {
      if (def.parentOf && values.size > 1 && [...values].every((value) => picked.has(value))) {
        chips.push({ id: `${def.key}:${parent}`, facet: def.label, value: parent, clears: { facet: def.key, values: [...values] } });
        values.forEach((value) => remaining.delete(value));
      }
    }
    for (const value of remaining) {
      const label = def.leafLabel ? `${parentOf(def, value)} ${def.leafLabel(value)}` : value;
      chips.push({ id: `${def.key}:${value}`, facet: def.label, value: label, clears: { facet: def.key, values: [value] } });
    }
  }
  if (filter.launchYears) {
    chips.push({ id: "launch", facet: "Launched", value: `${filter.launchYears[0]}–${filter.launchYears[1]}`, clears: "launch" });
  }
  if (filter.shape) {
    const { altitudeKm, inclinationDeg } = filter.shape;
    chips.push({
      id: "shape",
      facet: "Shape",
      value: `${Math.round(altitudeKm[0])}–${Math.round(altitudeKm[1])} km, ${inclinationDeg[0].toFixed(0)}–${inclinationDeg[1].toFixed(0)}°`,
      clears: "shape",
    });
  }
  if (filter.query.trim() !== "") {
    chips.push({ id: "query", facet: "Name", value: filter.query.trim(), clears: "query" });
  }
  if (filter.activeOnly) {
    chips.push({ id: "activeOnly", facet: "", value: "On the globe", clears: "activeOnly" });
  }
  return chips;
}
