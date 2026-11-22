// A EUMETView layer frame by frame (FramedImagery.ts), drawn by its WMS. The layer's own
// capabilities list its frames and its bounds, so the manifest carries neither.

import { Rectangle } from "@cesium/core";
import { WebMapServiceImageryProvider } from "@cesium/engine";

import { granuleFrame, type TileFormat } from "@/config/instrumentImagery";
import { type Granule, granuleExtent } from "@/modules/util/cmrGranules";
import { formatFrame, parseDomain, type TimeRange } from "@/modules/util/timeDomain";

import type { FrameSource } from "./FramedImagery";
import { opaquePixels } from "./GibsImagery";

const EUMETVIEW = "https://view.eumetsat.int/geoserver";

/** EUMETView lets a layer's capabilities be cached for 2 minutes; its fastest layer has a frame every 5. */
const REFRESH_MS = 5 * 60 * 1000;

/** Fewer requests than 256, and the service draws any size. */
const TILE_SIZE = 512;

/** A geographic tile of TILE_SIZE has the detail of a 256-pixel Web Mercator one two levels down. */
const LEVELS_ABOVE_WEB_MERCATOR = 2;

export interface EumetViewOptions {
  /** `workspace:name`. */
  layer: string;
  /** The deepest level worth asking for, in 256-pixel Web Mercator tiles, as the manifest gives it. */
  maximumLevel: number;
  format: TileFormat;
}

export interface EumetViewCapabilities {
  ranges: TimeRange[];
  /** West, south, east, north in degrees; undefined where the capabilities name no box. */
  bounds: [number, number, number, number] | undefined;
}

const BOUNDS = ["westBoundLongitude", "southBoundLatitude", "eastBoundLongitude", "northBoundLatitude"] as const;

/** What a layer's own WMS capabilities say of it. Of two bounding boxes the later is the layer's, the first its workspace's. */
export function parseCapabilities(xml: string): EumetViewCapabilities {
  const dimension = /<Dimension name="time"[^>]*>([^<]*)</.exec(xml)?.[1];
  const box = xml.slice(xml.lastIndexOf("<EX_GeographicBoundingBox>"));
  const [west, south, east, north] = BOUNDS.map((name) => Number(new RegExp(`<${name}>([^<]+)<`).exec(box)?.[1]));
  // Sentinel-3's box ends at 180.005° east.
  const bounds: EumetViewCapabilities["bounds"] = [Math.max(west!, -180), Math.max(south!, -90), Math.min(east!, 180), Math.min(north!, 90)];
  return { ranges: dimension ? parseDomain(dimension) : [], bounds: bounds.every(Number.isFinite) ? bounds : undefined };
}

export function eumetViewFrames(options: EumetViewOptions): FrameSource<WebMapServiceImageryProvider> {
  let bounds: EumetViewCapabilities["bounds"];
  return {
    name: options.layer,
    refreshMs: REFRESH_MS,
    fetchRanges: async (signal) => {
      try {
        const response = await fetch(`${EUMETVIEW}/${options.layer.replace(":", "/")}/ows?service=WMS&version=1.3.0&request=GetCapabilities`, { signal });
        if (!response.ok) {
          return undefined;
        }
        const capabilities = parseCapabilities(await response.text());
        bounds = capabilities.bounds ?? bounds;
        return capabilities.ranges.length > 0 ? { ranges: capabilities.ranges } : undefined;
      } catch {
        return undefined;
      }
    },
    show: (frame) =>
      new WebMapServiceImageryProvider({
        url: `${EUMETVIEW}/ows`,
        layers: options.layer,
        parameters: {
          transparent: "true",
          format: `image/${options.format}`,
          // Without a time the service draws its latest frame.
          ...(frame === undefined ? {} : { time: formatFrame(frame, false) }),
        },
        tileWidth: TILE_SIZE,
        tileHeight: TILE_SIZE,
        maximumLevel: Math.max(0, options.maximumLevel - LEVELS_ABOVE_WEB_MERCATOR),
        rectangle: bounds && Rectangle.fromDegrees(...bounds),
        enablePickFeatures: false,
        credit: "EUMETSAT",
      }),
  };
}

/** Whether EUMETView has a granule's pixels, by layer and start: a granule's answer does not change. */
const granulePixels = new Map<string, Promise<boolean>>();

/** Degrees either side of a granule's centre that are asked for: well inside a 3-minute OLCI granule, about 11° across. */
const PROBE_HALF_WIDTH = 1;

/** Pixels across the probe; half of them opaque is a granule there. */
const PROBE_SIZE = 16;

/**
 * Whether EUMETView has the pixels of a granule of `layer`, a swath an orbit: a small
 * picture around the granule's centre, clear where the swath lacks the granule, as
 * Sentinel-3A's lacked most of 2 of 10 on 2026-11-20. A box over the whole granule would
 * also catch its neighbours. False, and asked again later, where EUMETView cannot be reached.
 */
export function eumetViewHasGranule(layer: string, granule: Granule): Promise<boolean> {
  const key = `${layer}/${granule.start}`;
  let answer = granulePixels.get(key);
  if (answer === undefined) {
    const { west, south, east, north } = granuleExtent(granule);
    const longitude = (((((west + east) / 2 + 180) % 360) + 360) % 360) - 180;
    const latitude = (south + north) / 2;
    const bounds = { west: longitude - PROBE_HALF_WIDTH, south: latitude - PROBE_HALF_WIDTH, east: longitude + PROBE_HALF_WIDTH, north: latitude + PROBE_HALF_WIDTH };
    const query = new URLSearchParams({
      service: "WMS",
      request: "GetMap",
      version: "1.1.1",
      srs: "EPSG:4326",
      styles: "",
      layers: layer,
      width: String(PROBE_SIZE),
      height: String(PROBE_SIZE),
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(3)).join(","),
      format: "image/png",
      transparent: "true",
      time: granuleFrame("eumetview", granule.start),
    });
    answer = fetch(`${EUMETVIEW}/ows?${query}`)
      .then(async (response) => {
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
          return false;
        }
        const opaque = await opaquePixels(await response.blob()).catch(() => undefined);
        return opaque === undefined || opaque >= (PROBE_SIZE * PROBE_SIZE) / 2;
      })
      .catch(() => {
        granulePixels.delete(key);
        return false;
      });
    granulePixels.set(key, answer);
  }
  return answer;
}
