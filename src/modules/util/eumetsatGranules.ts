// A layer's granules as EUMETSAT's Data Store lists them (ADR 0023): Sentinel-3's OLCI a day
// sooner than CMR (2 hours behind live against 26, measured 2026-11-22). Its OpenSearch
// answers any origin without a key.
//
// Cesium-free, so node-env vitest reads it.

import type { Granule, GranuleQuery, GroundPoint } from "./cmrGranules";
import { sunlit } from "./granuleDay";

const DATA_STORE = "https://api.eumetsat.int/data/search-products/1.0.0/os";

/** The Data Store's largest page. */
const PAGE_SIZE = 500;

/** Pages asked for at most: a day either side of the clock is 900 Sentinel-3A granules, near-real-time and archived. */
const MAX_PAGES = 5;

/**
 * Its near-real-time and archived copies of a granule start within microseconds; the
 * near-real-time ones go after about three weeks.
 */
const SAME_GRANULE_MS = 1000;

/** A Data Store collection's id: "EO:EUM:DAT:0409". */
export const DATA_STORE_COLLECTION_RE = /^EO:EUM:DAT:[A-Z0-9:_-]+$/;

/** One page of `query`'s granules, oldest first, or newest first for `newest`. */
export function dataStoreSearchUrl(query: GranuleQuery, page = 0): string {
  const params = new URLSearchParams({ format: "json", pi: query.collections[0]! });
  if (query.platform !== undefined) {
    params.set("sat", query.platform);
  }
  params.set("dtstart", new Date(query.start).toISOString());
  params.set("dtend", new Date(query.end).toISOString());
  if (query.point) {
    params.set("geo", `POINT(${query.point.longitude} ${query.point.latitude})`);
  }
  params.set("c", String(Math.min(query.newest ?? PAGE_SIZE, PAGE_SIZE)));
  params.set("si", String(page * PAGE_SIZE));
  params.set("sort", query.newest === undefined ? "start,time,1" : "start,time,0");
  return `${DATA_STORE}?${params}`;
}

type Ring = [number, number][];

const ON_MERIDIAN = 1e-6;

/**
 * One ring of the parts the Data Store splits a granule into at the antimeridian: the
 * western part a turn east, and the cut along 180° left out. Undefined where the parts
 * do not meet there, as a granule over a pole's cap.
 */
export function joinAtAntimeridian(parts: Ring[]): Ring | undefined {
  const chains: Ring[] = [];
  for (const part of parts) {
    const open = part.slice(0, -1).map(([lon, lat]): [number, number] => [lon < 0 ? lon + 360 : lon, lat]);
    const onCut = open.map(([lon]) => Math.abs(lon - 180) < ON_MERIDIAN);
    // The cut is the run of points on the meridian; the chain runs from its last point round to its first.
    const last = onCut.findIndex((on, i) => on && !onCut[(i + 1) % open.length]);
    if (last < 0 || onCut.every(Boolean)) {
      return undefined;
    }
    const chain: Ring = [];
    for (let i = 0, at = last; i < open.length; i++, at = (at + 1) % open.length) {
      chain.push(open[at]!);
      if (i > 0 && onCut[at]) break;
    }
    chains.push(chain);
  }
  const [first, second] = chains;
  if (first === undefined || second === undefined || chains.length !== 2) {
    return undefined;
  }
  // The second chain starts where the first ends, or runs the other way.
  const meets = (a: [number, number], b: [number, number]) => Math.abs(a[1] - b[1]) < 1e-3;
  const next = meets(first.at(-1)!, second[0]!) ? second : second.toReversed();
  if (!meets(first.at(-1)!, next[0]!)) {
    return undefined;
  }
  const ring = [...first, ...next.slice(1, -1)];
  return [...ring, ring[0]!];
}

/** A feature's outline as points, its parts joined; undefined for one without a polygon. */
function parseGeometry(geometry: unknown): GroundPoint[] | undefined {
  if (typeof geometry !== "object" || geometry === null) {
    return undefined;
  }
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  let ring: Ring | undefined;
  if (type === "Polygon" && Array.isArray(coordinates)) {
    ring = coordinates[0] as Ring;
  } else if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    const parts = (coordinates as Ring[][]).map((polygon) => polygon[0]!);
    ring = joinAtAntimeridian(parts) ?? parts.toSorted((a, b) => b.length - a.length)[0];
  }
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every((point) => Array.isArray(point) && point.every(Number.isFinite))) {
    return undefined;
  }
  return ring.map(([longitude, latitude]) => ({ latitude, longitude }));
}

/** One feature of the Data Store's answer, or undefined for one without times or a polygon. Whether by day is the sun's. */
export function parseDataStoreGranule(feature: unknown): Granule | undefined {
  if (typeof feature !== "object" || feature === null) {
    return undefined;
  }
  const { properties, geometry } = feature as { properties?: { date?: unknown }; geometry?: unknown };
  const [start, end] = typeof properties?.date === "string" ? properties.date.split("/").map(Date.parse) : [];
  const outline = parseGeometry(geometry);
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || outline === undefined) {
    return undefined;
  }
  return { start, end, day: sunlit(outline, start, end), outline };
}

/** One page's granules and how many the query has, or undefined for an error. */
async function fetchPage(query: GranuleQuery, page: number, signal: AbortSignal): Promise<{ granules: Granule[]; total: number } | undefined> {
  const response = await fetch(dataStoreSearchUrl(query, page), { signal });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { features?: unknown[]; totalResults?: number };
  return { granules: (body.features ?? []).flatMap((feature) => parseDataStoreGranule(feature) ?? []), total: body.totalResults ?? 0 };
}

/** The granules `query` asks for, one of each, sorted by start; undefined when the Data Store cannot be reached or answers with an error. */
export async function fetchDataStoreGranules(query: GranuleQuery, signal: AbortSignal): Promise<Granule[] | undefined> {
  try {
    const first = await fetchPage(query, 0, signal);
    if (first === undefined) {
      return undefined;
    }
    // The first page says how many there are; the rest are asked for at once.
    const pages = query.newest === undefined ? Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE)) : 1;
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(query, i + 1, signal)));
    if (rest.includes(undefined)) {
      return undefined;
    }
    const sorted = [first, ...rest].flatMap((page) => page!.granules).toSorted((a, b) => a.start - b.start);
    return sorted.filter((granule, i) => i === 0 || granule.start - sorted[i - 1]!.start >= SAME_GRANULE_MS);
  } catch {
    return undefined;
  }
}
