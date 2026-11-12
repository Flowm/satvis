// A NASA GIBS layer frame by frame (FramedImagery.ts), drawn from its WMTS tiles.
//
// Web Mercator: GIBS's EPSG:4326 tile matrices are not powers of two (3×2 at level 1),
// so they cannot be a Cesium tiling scheme.

import { WebMapTileServiceImageryProvider, WebMercatorTilingScheme } from "@cesium/engine";

import { formatFrame, parseDomain, type TimeRange, withoutLatestFrame } from "@/modules/util/timeDomain";

import type { FrameSource } from "./FramedImagery";

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

export interface GibsOptions {
  layer: string;
  /** The layer's `GoogleMapsCompatible_LevelN` set; N is also the deepest level. */
  maximumLevel: number;
  format: "png" | "jpeg";
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

/** The layer's frames, or undefined when GIBS cannot be reached or says nothing usable. */
async function fetchDomain(options: GibsOptions, signal: AbortSignal): Promise<TimeRange[] | undefined> {
  try {
    const response = await fetch(`${GIBS}/1.0.0/${options.layer}/default/GoogleMapsCompatible_Level${options.maximumLevel}/all/all.xml`, { signal });
    const domain = response.ok ? /<Domain>([^<]*)<\/Domain>/.exec(await response.text())?.[1] : undefined;
    const listed = domain ? parseDomain(domain) : [];
    const filling = options.daily && Date.now() - (listed.at(-1)?.end ?? 0) < FILLING_MS;
    const ranges = filling ? withoutLatestFrame(listed) : listed;
    return ranges.length > 0 ? ranges : undefined;
  } catch {
    return undefined;
  }
}

export function gibsFrames(options: GibsOptions): FrameSource<WebMapTileServiceImageryProvider> {
  return {
    name: options.layer,
    refreshMs: REFRESH_MS,
    fetchRanges: (signal) => fetchDomain(options, signal),
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
