// A NASA GIBS layer frame by frame (FramedImagery.ts), drawn from its WMTS tiles.
//
// Web Mercator: GIBS's EPSG:4326 tile matrices are not powers of two (3×2 at level 1),
// so they cannot be a Cesium tiling scheme.

import { WebMapTileServiceImageryProvider, WebMercatorTilingScheme } from "@cesium/engine";

import type { TileFormat } from "@/config/instrumentImagery";
import { formatFrame, parseDomain, type TimeRange, withoutLatestFrame } from "@/modules/util/timeDomain";

import type { FrameList, FrameSource } from "./FramedImagery";

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

/** What a picture from GIBS is credited with. */
export const GIBS_CREDIT = "NASA Global Imagery Browse Services for EOSDIS";

export interface GibsOptions {
  layer: string;
  /** The layer's `GoogleMapsCompatible_LevelN` set; N is also the deepest level. */
  maximumLevel: number;
  format: TileFormat;
  /**
   * Daily layers name frames by date, the rest to the second. GIBS lists a day while
   * it is still imaging it, and serves what is missing as opaque black, so a daily
   * layer shows the newest finished day.
   */
  daily: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after it began a listed day may still be filling in: the day itself, and the
 * swaths that arrive hours behind. The last day of a layer that ended is older, and whole.
 */
const FILLING_MS = 2 * DAY_MS;

/** GIBS lets a domain be cached for 30 minutes, so asking sooner gets the same answer. */
const REFRESH_MS = 30 * 60 * 1000;

/** A frame list's window starts on the hour, so that other clocks ask for the same one. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * How far either side of the clock a layer with frames by the minute is listed. Its whole
 * list runs to a megabyte (GOES: 21,726 ranges, 4.7 s); a day either side to a few hundred bytes.
 */
const SPAN_MS = DAY_MS;

/**
 * The frames `range` of the layer's domain lists, `all` or `<start>--<end>`, maybe none, or
 * undefined when GIBS cannot be reached or answers with no domain.
 */
async function fetchDomain(options: GibsOptions, range: string, signal: AbortSignal): Promise<TimeRange[] | undefined> {
  try {
    const response = await fetch(`${GIBS}/1.0.0/${options.layer}/default/GoogleMapsCompatible_Level${options.maximumLevel}/all/${range}.xml`, { signal });
    const domain = response.ok ? /<Domain>([^<]*)<\/Domain>/.exec(await response.text())?.[1] : undefined;
    if (domain === undefined) {
      return undefined;
    }
    const listed = parseDomain(domain);
    const filling = options.daily && Date.now() - (listed.at(-1)?.end ?? 0) < FILLING_MS;
    return filling ? withoutLatestFrame(listed) : listed;
  } catch {
    return undefined;
  }
}

/** The days a daily layer lists, its newest maybe still filling in; undefined where GIBS does not answer. */
export function gibsDays(layer: string, signal: AbortSignal): Promise<TimeRange[] | undefined> {
  // Every daily true colour layer has a level-9 set, and its domain is the same in each.
  return fetchDomain({ layer, maximumLevel: 9, format: "jpeg", daily: false }, "all", signal);
}

/**
 * A layer's frames a day either side of `around`, or all of them: for a daily layer, whose
 * whole list is short, and for one with none that near, as one that ended. Not when GIBS
 * failed to answer: that would ask for the whole megabyte at every retry.
 */
async function fetchFrames(options: GibsOptions, around: number, signal: AbortSignal): Promise<FrameList | undefined> {
  if (!options.daily) {
    const hour = Math.floor(around / HOUR_MS) * HOUR_MS;
    const covers = { start: hour - SPAN_MS, end: hour + SPAN_MS };
    const name = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
    const ranges = await fetchDomain(options, `${name(covers.start)}--${name(covers.end)}`, signal);
    if (ranges === undefined || ranges.length > 0) {
      return ranges && { ranges, covers };
    }
  }
  const ranges = await fetchDomain(options, "all", signal);
  return ranges?.length ? { ranges } : undefined;
}

export function gibsFrames(options: GibsOptions): FrameSource<WebMapTileServiceImageryProvider> {
  return {
    name: options.layer,
    refreshMs: REFRESH_MS,
    fetchRanges: (signal, around) => fetchFrames(options, around, signal),
    show: (frame) =>
      new WebMapTileServiceImageryProvider({
        url: `${GIBS}/${options.layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${options.format}`,
        layer: options.layer,
        style: "default",
        tileMatrixSetID: `GoogleMapsCompatible_Level${options.maximumLevel}`,
        format: `image/${options.format}`,
        tilingScheme: new WebMercatorTilingScheme(),
        maximumLevel: options.maximumLevel,
        credit: GIBS_CREDIT,
        // Without the list: GIBS's own name for its latest frame, which for a daily layer
        // is the day still filling in, so yesterday's.
        dimensions: { Time: frame !== undefined || options.daily ? formatFrame(frame ?? Date.now() - DAY_MS, options.daily) : "default" },
      }),
  };
}

/**
 * How long a granule found without pixels is taken as without them: its provider may still
 * be taking it in, as a daily picture fills over its day, or EUMETView's swaths come hours on.
 */
export const RECHECK_MS = 10 * 60 * 1000;

/** Whether GIBS has a granule's pixels, by layer and start; a "no" is forgotten after RECHECK_MS, as GIBS may be taking the granule in. */
const granulePixels = new Map<string, Promise<boolean>>();

/**
 * Opaque pixels a granule's level-0 tile has at least where GIBS drew it. A 6-minute VIIRS
 * granule covered 294 to 770 of the tile's 65,536 on 2026-11-20; the one that crossed the
 * antimeridian at 23:30Z, 1, and GIBS's WMS drew nothing of it.
 */
const MIN_OPAQUE_PIXELS = 50;

/** The opaque pixels of a tile, or undefined where it cannot be decoded here. */
async function opaquePixels(tile: Blob): Promise<number | undefined> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return undefined;
  }
  const bitmap = await createImageBitmap(tile);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (context === null) {
    return undefined;
  }
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether GIBS has the pixels of a granule layer's frame at `start`: its one tile at level 0,
 * a 404 where GIBS left the granule out, as it does NOAA-20's daytime ones centred past 50° N
 * or 54° S, and nearly empty where it drew little of it. A frame it lacks would otherwise ask
 * for every tile in view and be refused each. False, and asked again later, where GIBS
 * cannot be reached.
 */
export function gibsHasGranule(options: Pick<GibsOptions, "layer" | "maximumLevel" | "format">, start: number): Promise<boolean> {
  const key = `${options.layer}/${start}`;
  let answer = granulePixels.get(key);
  if (answer === undefined) {
    const url = `${GIBS}/${options.layer}/default/${formatFrame(start, false)}/GoogleMapsCompatible_Level${options.maximumLevel}/0/0/0.${options.format}`;
    answer = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          return false;
        }
        const opaque = await opaquePixels(await response.blob()).catch(() => undefined);
        return opaque === undefined || opaque >= MIN_OPAQUE_PIXELS;
      })
      .then((has) => {
        if (!has) setTimeout(() => granulePixels.delete(key), RECHECK_MS);
        return has;
      })
      .catch(() => {
        granulePixels.delete(key);
        return false;
      });
    granulePixels.set(key, answer);
  }
  return answer;
}
