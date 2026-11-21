// A layer's granules as NASA's Common Metadata Repository lists them (ADR 0023): when each
// was sensed and the ground it covers. GIBS draws a granule's pixels but cannot say which
// granules cover a place: its DescribeDomains ignores the bounding box.
//
// Cesium-free, so node-env vitest reads it.

const CMR = "https://cmr.earthdata.nasa.gov/search/granules.json";

/** CMR asks every client to name itself, and throttles one that does not first. */
const CLIENT_ID = "satvis";

/** CMR's largest page. A 6-minute collection has 240 granules a day. */
const PAGE_SIZE = 2000;

/** A point on the ground, in degrees. */
export interface GroundPoint {
  latitude: number;
  longitude: number;
}

/** One granule: a few minutes of one instrument's swath. */
export interface Granule {
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** Sensed at least partly by day; a true colour picture has nothing of a night granule. */
  day: boolean;
  /** The ground it covers, a closed ring: CMR's outer polygon, its last point the first. */
  outline: GroundPoint[];
}

/**
 * A granule's extent in degrees, its longitudes unwrapped from its first corner's, so one
 * across the antimeridian has an `east` past 180 or a `west` before -180.
 */
export function granuleExtent(granule: Granule): { west: number; south: number; east: number; north: number } {
  const first = granule.outline[0]?.longitude ?? 0;
  const longitudes = granule.outline.map(({ longitude }) => longitude + 360 * Math.round((first - longitude) / 360));
  const latitudes = granule.outline.map(({ latitude }) => latitude);
  return { west: Math.min(...longitudes), south: Math.min(...latitudes), east: Math.max(...longitudes), north: Math.max(...latitudes) };
}

/** The granules from `start` to `end` (epoch ms), or only those covering `point`. */
export interface GranuleQuery {
  collections: readonly string[];
  start: number;
  end: number;
  point?: GroundPoint;
}

/** `"lat lon lat lon …"`, CMR's ring, to points; undefined for one that does not read. */
function parseRing(ring: unknown): GroundPoint[] | undefined {
  if (typeof ring !== "string") {
    return undefined;
  }
  const numbers = ring.trim().split(/\s+/).map(Number);
  if (numbers.length < 8 || numbers.length % 2 !== 0 || numbers.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const points: GroundPoint[] = [];
  for (let i = 0; i < numbers.length; i += 2) {
    points.push({ latitude: numbers[i]!, longitude: numbers[i + 1]! });
  }
  return points;
}

/** One entry of CMR's JSON feed, or undefined for one without times or a polygon. */
export function parseGranule(entry: unknown): Granule | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { time_start, time_end, day_night_flag, polygons } = entry as Record<string, unknown>;
  const start = typeof time_start === "string" ? Date.parse(time_start) : Number.NaN;
  const end = typeof time_end === "string" ? Date.parse(time_end) : Number.NaN;
  const outline = Array.isArray(polygons) && Array.isArray(polygons[0]) ? parseRing(polygons[0][0]) : undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || outline === undefined) {
    return undefined;
  }
  return { start, end, day: day_night_flag !== "NIGHT", outline };
}

/** CMR's address for `query`, sorted by start. */
export function granuleSearchUrl(query: GranuleQuery): string {
  const params = new URLSearchParams();
  for (const collection of query.collections) {
    params.append("short_name", collection);
  }
  params.set("temporal", `${new Date(query.start).toISOString()},${new Date(query.end).toISOString()}`);
  if (query.point) {
    params.set("point", `${query.point.longitude},${query.point.latitude}`);
  }
  params.set("page_size", String(PAGE_SIZE));
  params.set("sort_key", "start_date");
  return `${CMR}?${params}`;
}

/**
 * Sorted by start, one per start: a granule the near-real-time and the standard
 * collections both list is one, the first collection's.
 */
export function uniqueGranules(granules: readonly Granule[]): Granule[] {
  const byStart = new Map<number, Granule>();
  for (const granule of granules) {
    if (!byStart.has(granule.start)) {
      byStart.set(granule.start, granule);
    }
  }
  return [...byStart.values()].toSorted((a, b) => a.start - b.start);
}

/**
 * The granules `query` asks for, or undefined when CMR cannot be reached or answers
 * with an error. The collections are asked in order, so a near-real-time collection listed
 * first wins where both have a granule.
 */
export async function fetchGranules(query: GranuleQuery, signal: AbortSignal): Promise<Granule[] | undefined> {
  try {
    const response = await fetch(granuleSearchUrl(query), { signal, headers: { "Client-Id": CLIENT_ID } });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { feed?: { entry?: unknown[] } };
    const entries = body.feed?.entry ?? [];
    const rank = new Map(query.collections.map((name, index) => [name, index]));
    // CMR sorts by start alone, so where both collections have a granule either may come first.
    const ranked = entries.flatMap((entry) => {
      const granule = parseGranule(entry);
      const collection = (entry as { producer_granule_id?: unknown }).producer_granule_id;
      const name = typeof collection === "string" ? collection.split(".")[0]! : "";
      return granule ? [{ granule, rank: rank.get(name) ?? query.collections.length }] : [];
    });
    return uniqueGranules(ranked.toSorted((a, b) => a.rank - b.rank).map(({ granule }) => granule));
  } catch {
    return undefined;
  }
}

/** Consecutive granules: one overpass of the satellite. */
export interface Overpass {
  start: number;
  end: number;
  granules: Granule[];
}

/** Granules that follow one another without a gap, as one overpass each. `granules` sorted by start. */
export function groupOverpasses(granules: readonly Granule[]): Overpass[] {
  const overpasses: Overpass[] = [];
  for (const granule of granules) {
    const last = overpasses.at(-1);
    if (last !== undefined && granule.start <= last.end) {
      last.end = Math.max(last.end, granule.end);
      last.granules.push(granule);
    } else {
      overpasses.push({ start: granule.start, end: granule.end, granules: [granule] });
    }
  }
  return overpasses;
}
