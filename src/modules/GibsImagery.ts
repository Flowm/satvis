// A NASA GIBS layer frame by frame (FramedImagery.ts), drawn from its WMTS tiles.
//
// Web Mercator: GIBS's EPSG:4326 tile matrices are not powers of two (3×2 at level 1),
// so they cannot be a Cesium tiling scheme.

import { WebMapTileServiceImageryProvider, WebMercatorTilingScheme } from "@cesium/engine";

import type { TileFormat } from "@/config/instrumentImagery";
import { formatFrame, parseDomain, type TimeRange, withoutLatestFrame } from "@/modules/util/timeDomain";

import type { FrameList, FrameSource } from "./FramedImagery";

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

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
        credit: "NASA Global Imagery Browse Services for EOSDIS",
        // Without the list: GIBS's own name for its latest frame, which for a daily layer
        // is the day still filling in, so yesterday's.
        dimensions: { Time: frame !== undefined || options.daily ? formatFrame(frame ?? Date.now() - DAY_MS, options.daily) : "default" },
      }),
  };
}
