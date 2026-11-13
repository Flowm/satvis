// The catalog sheet's model (ADR 0012): rows, facets, a filter and crossfilter counts.
// Cesium-free and Vue-free, so node-env vitest exercises it.

import { gcatCategoryLabel, gcatClassLabel } from "@/config/gcatCodes";
import { readImageryList } from "@/config/instrumentImagery";
import { ORBIT_KINDS, type OrbitClass, orbitKindLabel } from "@/config/orbitClass";
import { SATCAT_LAUNCH_SITE, SATCAT_OPS_STATUS, satcatLabel } from "@/config/satcatCodes";
import { type SatelliteInstrument, satelliteModel } from "@/config/satelliteMetadata";
import { WAVEBANDS } from "@/config/wavebands";
import { formatFixed, formatInteger, formatNumber } from "@/modules/util/formats";
import { ascendingNodeDegOf, orbitShapeOf } from "@/modules/util/gp";
import { ltanHoursOf } from "@/modules/util/orbitFacts";

import { isCustom } from "./customSatellites";
import type { CatalogEntry } from "./SatelliteCatalog";

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

/** CEOS's waveband classes by wavelength, then the radar bands by frequency. */
export const BAND_ORDER: readonly string[] = WAVEBANDS.map((waveband) => waveband.band);

/** The data availability facet's values, in its order: what satvis has for a satellite. */
export const AVAILABILITY = {
  imagery: "Imagery",
  mapLayer: "Imagery as a map layer",
  /** Not every entry with a viewer link: every entry has one. */
  linkOnly: "Imagery as a viewer link only",
  instruments: "Instruments (CEOS)",
  model: "3D model",
} as const;

/** A row's imagery at its best, best first: what the list's imagery column marks and sorts by. */
export const IMAGERY_LEVELS = {
  layer: { rank: 0, mark: "strong", title: AVAILABILITY.mapLayer },
  link: { rank: 1, mark: "faint", title: AVAILABILITY.linkOnly },
} as const;
/** A key of IMAGERY_LEVELS: a layer the globe draws, or a link alone. */
export type ImageryLevel = keyof typeof IMAGERY_LEVELS;

/**
 * The instrument kind tree's parents, in its order, each with the CEOS kinds it takes; the
 * first match wins. CEOS has about 45 kinds, too many for one level.
 */
const KIND_FAMILIES: readonly [string, RegExp][] = [
  ["Optical imagers", /optical imager|Vis\/IR radiometer|spectro-radiometer|hyperspectral|narrow-band channel IR|multi-channel\/direction/i],
  ["Microwave radiometers", /MW radiometer/i],
  ["Radar", /radar|scatterometer/i],
  ["Lidar", /lidar/i],
  ["Spectrometers and sounders", /spectrometer|sounder|atmospheric chemistry/i],
  ["Lightning", /lightning/i],
  ["Sun and Earth radiation", /broad-band radiometer|solar irradiance/i],
  ["Space environment", /space environment|magnetometer|electric field/i],
  ["Positioning and gravity", /GNSS|radio-positioning|retroreflector|gradiometer|ranging|star tracker/i],
  ["Data and communications", /data collection|communications/i],
];
/** The family of a kind no other takes. */
const OTHER_FAMILY = "Other";
/** An instrument's kind where CEOS gives none, or its placeholders "TBD" and "Other". */
export const NO_INSTRUMENT_KIND = "Not stated";
/** Divides a kind leaf's family from its kind; no CEOS kind has one. */
const KIND_SEPARATOR = "|";

/** First match in KIND_FAMILIES, else OTHER_FAMILY. */
export function kindFamilyOf(kind: string): string {
  return KIND_FAMILIES.find(([, pattern]) => pattern.test(kind))?.[0] ?? OTHER_FAMILY;
}

/** Hours, the crossing chart's bin width. */
export const CROSSING_BIN_HOURS = 0.25;
/** Hours, where a daylit crossing's day starts; it ends 12 hours later. */
export const CROSSING_FROM_HOURS = 6;

/** The orbit tree's leaf for satellites whose class has no kind. */
export const NO_KIND = "Other";
/** The constellation of a satellite GCAT does not list yet. */
export const NO_PROGRAM = "Not in GCAT yet";

/** One satellite, its facets labelled. */
export interface CatalogRow {
  /** Unique among the rows: the satnum, or a custom satellite's catalog key. */
  key: string;
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
  elementSetAge: string;
  /** GCAT's programme, or NO_PROGRAM. */
  program: string;
  launchDate: string | undefined;
  launchYear: number | undefined;
  massKg: number | undefined;
  /** Km, semi-major axis less Earth's equatorial radius. */
  altitudeKm: number;
  /** Km above Earth's equatorial radius, likewise. */
  perigeeKm: number;
  /** Likewise. */
  apogeeKm: number;
  inclinationDeg: number;
  /** Days from the element set's epoch to when the rows were built. */
  ageDays: number;
  /** Sun-sync rows only: the daylit crossing. */
  crossing: EquatorCrossing | undefined;
  /** Its instruments' waveband classes; empty where CEOS lists none. */
  bands: string[];
  /** Its instruments' kinds, as the kind tree's leaves: "family|kind". */
  kinds: string[];
  /** AVAILABILITY values it has. */
  availability: string[];
  /** Its imagery at its best. */
  imagery: ImageryLevel | undefined;
}

/** Which way an orbit crosses the equator: southbound at its descending node, northbound at its ascending node. */
export type CrossingDirection = "southbound" | "northbound";

/** A sun-sync orbit's equator crossing at one node: its local time at the element set's epoch, and its direction. */
export interface EquatorCrossing {
  /** Hours of mean solar time. */
  hours: number;
  direction: CrossingDirection;
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
  | "availability"
  | "elementSetAge"
  | "constellation"
  | "band"
  | "kind";

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
  /** A row must have every picked value, not one of them; a pick's count is then what adding it leaves. */
  matchAll?: true;
  /** Bars on a square-root scale, where one value's count dwarfs another's. */
  sqrtBars?: true;
}

/** A bar's length for a value's count, in the facet's scale. */
export function barLength(def: FacetDef, count: number): number {
  return def.sqrtBars ? Math.sqrt(count) : count;
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
  {
    key: "kind",
    label: "Instrument kind",
    icon: "lucide:telescope",
    values: (row) => row.kinds,
    order: [...KIND_FAMILIES.map(([family]) => family), OTHER_FAMILY],
    parentOf: (leaf) => leaf.slice(0, leaf.indexOf(KIND_SEPARATOR)),
    leafLabel: (leaf) => leaf.slice(leaf.indexOf(KIND_SEPARATOR) + 1),
  },
  /** Imagery and a 3D model asks for satellites with both. 13,680 satellites have a model, 21 imagery. */
  {
    key: "availability",
    label: "Data availability",
    icon: "lucide:database",
    values: (row) => row.availability,
    order: Object.values(AVAILABILITY),
    matchAll: true,
    sqrtBars: true,
  },
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
  { key: "elementSetAge", label: "Element set age", icon: "lucide:clock", values: (row) => [row.elementSetAge], order: AGE_BUCKETS },
  /** Drawn by the bands chart, not as a tile. */
  { key: "band", label: "Band", icon: "lucide:audio-waveform", values: (row) => row.bands, order: BAND_ORDER },
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

// The node in radians and the epoch as a Julian date, as ltanHoursOf takes them.
/** Radians per degree. */
const DEGREES = Math.PI / 180;
/** Ms per day. */
const MS_PER_DAY = 86_400_000;
/** The Julian date of 1970-01-01. */
const UNIX_EPOCH_JULIAN_DATE = 2440587.5;

/** The node between 06:00 and 18:00, where the equator is in daylight in every season. */
export function daylitCrossingOf(ltanHours: number): EquatorCrossing {
  const daylit = ltanHours >= CROSSING_FROM_HOURS && ltanHours < CROSSING_FROM_HOURS + 12;
  return daylit ? { hours: ltanHours, direction: "northbound" } : { hours: (ltanHours + 12) % 24, direction: "southbound" };
}

/** Both of a sun-sync orbit's crossings: this one and, 12 hours off, the other node's. */
export function crossingsOf(crossing: EquatorCrossing): [EquatorCrossing, EquatorCrossing] {
  return [crossing, { hours: (crossing.hours + 12) % 24, direction: crossing.direction === "northbound" ? "southbound" : "northbound" }];
}

/** "550", "20.2k", "171k": km, short enough for a chart's axis. */
export function formatKm(km: number): string {
  if (km >= 100_000) return `${formatInteger(km / 1000)}k`;
  return km >= 1000 ? `${formatNumber(Math.round(km / 100) / 10)}k` : String(Math.round(km));
}

/** "22:30"; 24:00 for the end of the day. */
export function formatLocalTime(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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
function rowOf(key: string, entry: CatalogEntry, groups: string[], nowMs: number): CatalogRow {
  const m = entry.metadata;
  const { code, source } = entry.orbitKind;
  const { altitudeKm, perigeeKm, apogeeKm, inclinationDeg } = orbitShapeOf(entry.record);
  const ageDays = (nowMs - entry.epochMs) / MS_PER_DAY;
  const launchYear = m.launchDate === undefined ? undefined : Number(m.launchDate.slice(0, 4));
  // The tree's sun-sync, GCAT's inclination band, so the chart and the tree count the same satellites.
  const ltanHours = entry.orbitClass === "LEO" && code === "S" ? ltanHoursOf(ascendingNodeDegOf(entry.record) * DEGREES, entry.epochMs / MS_PER_DAY + UNIX_EPOCH_JULIAN_DATE) : NaN;
  return {
    key,
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
    elementSetAge: bucket(ageDays, AGE_BOUNDS_DAYS, AGE_BUCKETS),
    program: m.program ?? NO_PROGRAM,
    launchDate: m.launchDate,
    launchYear: Number.isFinite(launchYear) ? launchYear : undefined,
    massKg: m.massKg,
    altitudeKm,
    perigeeKm,
    apogeeKm,
    inclinationDeg,
    ageDays,
    // An unreadable epoch or node has no crossing, rather than one in no bin.
    crossing: Number.isFinite(ltanHours) ? daylitCrossingOf(ltanHours) : undefined,
    ...instrumentFacetsOf(m),
  };
}

/** The facets of what a satellite carries and what satvis has for it. */
function instrumentFacetsOf(m: CatalogEntry["metadata"]): Pick<CatalogRow, "bands" | "kinds" | "availability" | "imagery"> {
  const instruments = (Array.isArray(m.instruments) ? (m.instruments as unknown[]) : []).filter(
    (instrument): instrument is SatelliteInstrument => typeof instrument === "object" && instrument !== null,
  );
  const imagery = readImageryList(m.imagery);
  const bands = new Set<string>();
  const kinds = new Set<string>();
  for (const instrument of instruments) {
    const kind = typeof instrument.kind === "string" && instrument.kind !== "TBD" && instrument.kind !== "Other" ? instrument.kind : NO_INSTRUMENT_KIND;
    kinds.add(`${kindFamilyOf(kind)}${KIND_SEPARATOR}${kind}`);
    for (const band of Array.isArray(instrument.bands) ? instrument.bands : []) {
      bands.add(band);
    }
  }
  const level: ImageryLevel | undefined = imagery.length === 0 ? undefined : imagery.some((entry) => entry.drawn !== undefined) ? "layer" : "link";
  const availability: string[] = [];
  if (level !== undefined) availability.push(AVAILABILITY.imagery, level === "layer" ? AVAILABILITY.mapLayer : AVAILABILITY.linkOnly);
  if (instruments.length > 0) availability.push(AVAILABILITY.instruments);
  if (satelliteModel(m) !== undefined) availability.push(AVAILABILITY.model);
  return { bands: [...bands], kinds: [...kinds], availability, imagery: level };
}

/**
 * One row per satnum. A satellite a search-only group renames keeps a pickable group's name,
 * as the compact browser lists it. A custom satellite has a row of its own: its NORAD id may be a
 * catalog satellite's, under other elements.
 */
export function catalogRows(entries: readonly CatalogEntry[], searchOnlyTags: ReadonlySet<string>, nowMs: number): CatalogRow[] {
  const byRowKey = new Map<string, { entry: CatalogEntry; groups: string[] }>();
  for (const entry of entries) {
    const groups = entry.tags.filter((tag) => !searchOnlyTags.has(tag));
    const rowKey = isCustom(entry) ? entry.key : entry.satnum;
    const seen = byRowKey.get(rowKey);
    if (seen === undefined) {
      byRowKey.set(rowKey, { entry, groups: [...groups] });
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
  return [...byRowKey].map(([key, { entry, groups }]) => rowOf(key, entry, groups, nowMs));
}

/** A box on the orbit-shape plot. */
export interface ShapeBox {
  altitudeKm: [number, number];
  inclinationDeg: [number, number];
}

/** A box on the apogee-perigee plot. */
export interface ApsisBox {
  perigeeKm: [number, number];
  apogeeKm: [number, number];
}

/** Everything the catalog sheet filters by. */
export interface CatalogFilter {
  /** An empty or missing set filters nothing. */
  facets: Partial<Record<FacetKey, ReadonlySet<string>>>;
  /** Inclusive; a satellite without a launch date is out while set. */
  launchYears: [number, number] | null;
  shape: ShapeBox | null;
  /** The box on the apogee-perigee plot. */
  apsides: ApsisBox | null;
  /**
   * Hours either of a satellite's crossings falls in, from inclusive to exclusive; a satellite
   * without one is out while set. Null takes the daylit hours, so a direction alone picks the
   * daylit crossing's: every satellite crosses both ways in a day.
   */
  crossingHours: [number, number] | null;
  /** That crossing's direction. */
  crossingDirection: CrossingDirection | null;
  /** Name or satnum, case-insensitive. */
  query: string;
  /** Only what the globe shows. */
  activeOnly: boolean;
}

/** The dimensions a crossfilter counts apart. */
type Dimension = FacetKey | "launch" | "shape" | "apsides" | "crossing";

/** A crossfilter's matches and its charts' counts. */
export interface Crossfilter {
  matched: CatalogRow[];
  /** Per facet, value -> rows passing every filter but the facet's own; for a matchAll facet, every filter. */
  counts: Record<FacetKey, Map<string, number>>;
  /** Per tree facet, parent -> rows counted toward it, each once however many of its leaves it has. */
  parentCounts: Partial<Record<FacetKey, Map<string, number>>>;
  /** Launch year -> rows passing every filter but the launch years. */
  launches: Map<number, number>;
  /** Rows passing every filter but the shape box: the plot's bright points. */
  shapeRows: CatalogRow[];
  /** Rows passing every filter but the apsis box: that plot's bright points. */
  apsisRows: CatalogRow[];
  /** Per direction, crossing bin (from 00:00) -> rows passing every filter but the crossing, at both of a row's crossings. */
  crossings: Record<CrossingDirection, Map<number, number>>;
}

/** Outside an inclusive range. */
const outside = (value: number, [from, to]: [number, number]) => value < from || value > to;

/** Outside the box on either axis. */
function outsideShape(row: CatalogRow, box: ShapeBox): boolean {
  return outside(row.altitudeKm, box.altitudeKm) || outside(row.inclinationDeg, box.inclinationDeg);
}

/** Outside the box on either axis. */
function outsideApsides(row: CatalogRow, box: ApsisBox): boolean {
  return outside(row.perigeeKm, box.perigeeKm) || outside(row.apogeeKm, box.apogeeKm);
}

/** No crossing in the picked hours with the picked direction, or no crossing at all. */
function outsideCrossing(crossing: EquatorCrossing | undefined, filter: CatalogFilter): boolean {
  if (crossing === undefined) {
    return true;
  }
  const [from, to] = filter.crossingHours ?? [CROSSING_FROM_HOURS, CROSSING_FROM_HOURS + 12];
  return !crossingsOf(crossing).some(({ hours, direction }) => hours >= from && hours < to && (filter.crossingDirection === null || direction === filter.crossingDirection));
}

/**
 * One pass: a row failing no dimension counts everywhere, one failing exactly one counts
 * toward that dimension's chart, and one failing two counts nowhere. The query and "only on
 * the globe" have no chart, so they gate every count.
 */
export function crossfilter(rows: readonly CatalogRow[], filter: CatalogFilter, active: ReadonlySet<string>): Crossfilter {
  const counts = Object.fromEntries(FACETS.map((def) => [def.key, new Map<string, number>()])) as Record<FacetKey, Map<string, number>>;
  const parentCounts = Object.fromEntries(FACETS.filter((def) => def.parentOf).map((def) => [def.key, new Map<string, number>()])) as Crossfilter["parentCounts"];
  const launches = new Map<number, number>();
  const crossings: Crossfilter["crossings"] = { southbound: new Map(), northbound: new Map() };
  const matched: CatalogRow[] = [];
  const shapeRows: CatalogRow[] = [];
  const apsisRows: CatalogRow[] = [];
  const query = filter.query.trim().toUpperCase();
  const pickedFacets = FACETS.filter((def) => (filter.facets[def.key]?.size ?? 0) > 0);

  const countFacet = (def: FacetDef, row: CatalogRow) => {
    const map = counts[def.key];
    const values = def.values(row);
    for (const value of values) {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    const parents = parentCounts[def.key];
    if (parents) {
      for (const parent of new Set(values.map((value) => parentOf(def, value)))) {
        parents.set(parent, (parents.get(parent) ?? 0) + 1);
      }
    }
  };
  const countLaunch = (row: CatalogRow) => {
    if (row.launchYear !== undefined) {
      launches.set(row.launchYear, (launches.get(row.launchYear) ?? 0) + 1);
    }
  };

  const countCrossing = (row: CatalogRow) => {
    if (row.crossing === undefined) {
      return;
    }
    for (const { hours, direction } of crossingsOf(row.crossing)) {
      const map = crossings[direction];
      const bin = Math.floor(hours / CROSSING_BIN_HOURS);
      map.set(bin, (map.get(bin) ?? 0) + 1);
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
      const values = def.values(row);
      if (def.matchAll ? ![...picked].every((value) => values.includes(value)) : !values.some((value) => picked.has(value))) {
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
    if (failures < 2 && filter.apsides && outsideApsides(row, filter.apsides)) {
      failed = "apsides";
      failures += 1;
    }
    if (failures < 2 && (filter.crossingHours || filter.crossingDirection) && outsideCrossing(row.crossing, filter)) {
      failed = "crossing";
      failures += 1;
    }
    if (failures === 0) {
      matched.push(row);
      shapeRows.push(row);
      apsisRows.push(row);
      countLaunch(row);
      countCrossing(row);
      for (const def of FACETS) {
        countFacet(def, row);
      }
    } else if (failures === 1) {
      if (failed === "launch") {
        countLaunch(row);
      } else if (failed === "shape") {
        shapeRows.push(row);
      } else if (failed === "apsides") {
        apsisRows.push(row);
      } else if (failed === "crossing") {
        countCrossing(row);
      } else if (failed !== undefined && !FACET_BY_KEY[failed].matchAll) {
        countFacet(FACET_BY_KEY[failed], row);
      }
    }
  }
  return { matched, counts, parentCounts, launches, shapeRows, apsisRows, crossings };
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

/** A tree facet's items under their parents, each parent counted by `parentCounts`, else by its leaves' sum. */
export function facetBranches(def: FacetDef, items: readonly FacetItem[], parentCounts?: ReadonlyMap<string, number>): FacetBranch[] {
  const branches = new Map<string, FacetBranch>();
  for (const item of items) {
    const parent = parentOf(def, item.value);
    const branch = branches.get(parent) ?? { parent, count: 0, leaves: [] };
    branch.count += item.count;
    branch.leaves.push(item);
    branches.set(parent, branch);
  }
  for (const branch of branches.values()) {
    branch.count = parentCounts?.get(branch.parent) ?? branch.count;
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
  clears: { facet: FacetKey; values: string[] } | "launch" | "shape" | "apsides" | "crossing" | "query" | "activeOnly";
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
      value: `${formatKmRange(altitudeKm)}, ${formatFixed(inclinationDeg[0], 0)}–${formatFixed(Math.min(inclinationDeg[1], 180), 0)}°`,
      clears: "shape",
    });
  }
  if (filter.apsides) {
    const { perigeeKm, apogeeKm } = filter.apsides;
    chips.push({ id: "apsides", facet: "Apsides", value: `perigee ${formatKmRange(perigeeKm)}, apogee ${formatKmRange(apogeeKm)}`, clears: "apsides" });
  }
  if (filter.crossingHours || filter.crossingDirection) {
    const hours = filter.crossingHours && `${formatLocalTime(filter.crossingHours[0])}–${formatLocalTime(filter.crossingHours[1])}`;
    chips.push({ id: "crossing", facet: "Crossing", value: [hours, filter.crossingDirection].filter(Boolean).join(" "), clears: "crossing" });
  }
  if (filter.query.trim() !== "") {
    chips.push({ id: "query", facet: "Name", value: filter.query.trim(), clears: "query" });
  }
  if (filter.activeOnly) {
    chips.push({ id: "activeOnly", facet: "", value: "On the globe", clears: "activeOnly" });
  }
  return chips;
}

/** "300–600 km", or open-ended where a range reaches past its plot's axis ("over 2,000 km"), or "any" past both. */
export function formatOpenRange([from, to]: [number, number], format: (value: number) => string, unit: string): string {
  if (from === -Infinity && to === Infinity) return "any";
  if (to === Infinity) return `over ${format(from)}${unit}`;
  if (from === -Infinity) return `under ${format(to)}${unit}`;
  return `${format(from)}–${format(to)}${unit}`;
}

/** A chip's km range, in whole km with thousands separators. */
const formatKmRange = (range: [number, number]) => formatOpenRange(range, formatInteger, " km");
