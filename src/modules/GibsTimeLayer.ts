// A NASA GIBS layer showing the frame for the simulation time. Cesium reloads the
// tiles when the clock enters another interval of `times`. GOES-East alone has
// ~370,000 frames, so `times` covers only a window around the clock.
//
// Web Mercator: GIBS's EPSG:4326 tile matrices are not powers of two (3×2 at level 1),
// so they cannot be a Cesium tiling scheme.

import { Clock, Iso8601, JulianDate, TimeInterval, TimeIntervalCollection, WebMapTileServiceImageryProvider, WebMercatorTilingScheme } from "@cesium/engine";

import type { ImageryContext } from "./CesiumLayerProviders";
import { formatFrame, frameWindow, parseDomain, type TimeRange } from "./util/timeDomain";

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

export interface GibsTimeLayerOptions {
  layer: string;
  /** The layer's `GoogleMapsCompatible_LevelN` set; N is also the deepest level. */
  maximumLevel: number;
  format: "png" | "jpeg";
  /** Daily layers name frames by date, the rest to the second. */
  daily: boolean;
}

/** Steps either side of the clock: a day at 10 minutes, two months daily. */
const WINDOW_SLOTS = 72;

/** GIBS lets a domain be cached for 30 minutes, so asking sooner gets the same answer. */
const REFRESH_MS = 30 * 60 * 1000;

const stepMs = (daily: boolean) => (daily ? 24 * 60 : 10) * 60 * 1000;

/** The layer's frames, or undefined when GIBS cannot be reached or says nothing usable. */
async function fetchDomain(options: GibsTimeLayerOptions, signal: AbortSignal): Promise<TimeRange[] | undefined> {
  try {
    const response = await fetch(`${GIBS}/1.0.0/${options.layer}/default/GoogleMapsCompatible_Level${options.maximumLevel}/all/all.xml`, { signal });
    const domain = response.ok ? /<Domain>([^<]*)<\/Domain>/.exec(await response.text())?.[1] : undefined;
    const ranges = domain ? parseDomain(domain) : [];
    return ranges.length > 0 ? ranges : undefined;
  } catch {
    return undefined;
  }
}

/** The window around `center` as Cesium intervals, the first and last open-ended. */
function frameIntervals(ranges: readonly TimeRange[], center: number, daily: boolean): TimeIntervalCollection {
  const steps = frameWindow(ranges, center, stepMs(daily), WINDOW_SLOTS);
  return new TimeIntervalCollection(
    steps.map(
      (step, index) =>
        new TimeInterval({
          start: index === 0 ? Iso8601.MINIMUM_VALUE : JulianDate.fromDate(new Date(step.start)),
          stop: index === steps.length - 1 ? Iso8601.MAXIMUM_VALUE : JulianDate.fromDate(new Date(steps[index + 1]!.start)),
          isStopIncluded: false,
          data: { Time: formatFrame(step.frame, daily) },
        }),
    ),
  );
}

function provider(options: GibsTimeLayerOptions, time: Pick<WebMapTileServiceImageryProvider.ConstructorOptions, "clock" | "times" | "dimensions">) {
  return new WebMapTileServiceImageryProvider({
    url: `${GIBS}/${options.layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${options.format}`,
    layer: options.layer,
    style: "default",
    tileMatrixSetID: `GoogleMapsCompatible_Level${options.maximumLevel}`,
    format: `image/${options.format}`,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: options.maximumLevel,
    credit: "NASA Global Imagery Browse Services for EOSDIS",
    ...time,
  });
}

export async function createGibsTimeLayer(options: GibsTimeLayerOptions, { clock, requestRender, signal }: ImageryContext): Promise<WebMapTileServiceImageryProvider> {
  let ranges = await fetchDomain(options, signal);
  if (!ranges) {
    // GIBS's own name for its latest frame: the layer stays usable, just not in time.
    console.warn(`[GibsTimeLayer] no time domain for ${options.layer}; showing its latest frame`);
    return provider(options, { dimensions: { Time: "default" } });
  }

  const now = () => JulianDate.toDate(clock.currentTime).getTime();
  // Cesium never unsubscribes from the clock it is given, so it gets one of its own,
  // kept in step by the one listener below, which does come off.
  const cesiumClock = new Clock({ currentTime: clock.currentTime });
  const layer = provider(options, { clock: cesiumClock, times: frameIntervals(ranges, now(), options.daily) });

  // Rebuilt halfway to either end, so Cesium can always preload the next frames.
  const margin = (WINDOW_SLOTS / 2) * stepMs(options.daily);
  let center = now();
  let lastFetch = Date.now();

  const rebuild = (time: number) => {
    center = time;
    layer.times = frameIntervals(ranges!, time, options.daily);
    requestRender();
  };

  const onTick = () => {
    cesiumClock.currentTime = clock.currentTime;
    cesiumClock.multiplier = clock.multiplier;
    cesiumClock.shouldAnimate = clock.shouldAnimate;
    cesiumClock.canAnimate = clock.canAnimate;
    cesiumClock.onTick.raiseEvent(cesiumClock);

    const time = now();
    const first = ranges![0]!.start;
    const last = ranges!.at(-1)!.end;
    if (time >= last && Date.now() - lastFetch >= REFRESH_MS) {
      lastFetch = Date.now();
      void fetchDomain(options, signal).then((fresh) => {
        if (fresh && fresh.at(-1)!.end !== ranges!.at(-1)!.end) {
          ranges = fresh;
          rebuild(now());
        }
      });
    }
    // Outside the data the open-ended interval already shows the right frame.
    const settled = (time >= last && center >= last) || (time < first && center < first);
    if (Math.abs(time - center) > margin && !settled) {
      rebuild(time);
    }
  };

  if (!signal.aborted) {
    const removeTick = clock.onTick.addEventListener(onTick);
    signal.addEventListener("abort", removeTick, { once: true });
  }
  return layer;
}
