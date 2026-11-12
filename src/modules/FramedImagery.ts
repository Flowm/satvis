// Imagery that follows the simulation time as one layer a frame: the frame for the clock
// loads as a layer of its own, over the one before it, which stays until the new one's
// tiles are all there.
//
// Not Cesium's time-dynamic provider, whose reload empties the layer's tile cache: a
// globe tile made while the new frame loads, by a zoom, then has no parent tile to draw
// and shows what lies under the layer. Here such a tile draws the old frame's.
//
// A service is one FrameSource (GibsImagery.ts, EumetViewImagery.ts).

import { type Clock, JulianDate } from "@cesium/core";

import { snapToFrame, type TimeRange } from "@/modules/util/timeDomain";

/** What imagery that follows the simulation time needs from the viewer it is shown in. */
export interface ImageryContext {
  clock: Clock;
  requestRender: () => void;
  /** Whether the globe has every tile it wants, as of the last rendered frame. */
  tilesLoaded: () => boolean;
  /** Aborted to take the imagery off the globe. */
  signal: AbortSignal;
}

/** What this needs of Cesium's `ImageryLayerCollection`, so a test can stand in for it. */
export interface FrameLayers<Layer> {
  add(layer: Layer, index?: number): void;
  remove(layer: Layer): boolean;
  indexOf(layer: Layer): number;
}

/**
 * A layer of a service, frame by frame. `Shown` is what shows one frame: Cesium's
 * provider as the service's module makes it, the layer the controller wraps it in.
 */
export interface FrameSource<Shown> {
  /** Names the imagery in the warning when its frames cannot be read. */
  name: string;
  /** How often the service lets its list of frames change. */
  refreshMs: number;
  /** The imagery's frames, or undefined when the service cannot be reached or says nothing usable. */
  fetchRanges: (signal: AbortSignal) => Promise<TimeRange[] | undefined>;
  /** What shows `frame`, or the service's latest frame without one. Not called before `fetchRanges` settles. */
  show: (frame?: number) => Shown;
}

export interface FramedImagery<Layer> {
  /** Its upper layer on the globe, while it has one. */
  readonly top: Layer | undefined;
}

/** Ticks a new layer waits before the globe's word on its tiles counts: it speaks of the last frame drawn. */
const SETTLE_TICKS = 2;

/**
 * Shows `source` in `layers` until `signal` aborts. Its first layer goes to `position()`,
 * each later one over the one before it.
 *
 * A frame that is loading is never given up for a newer one, so a clock running faster
 * than the frames load still shows frames, skipping some, and a jump shows one frame on
 * the way.
 */
export function showFramedImagery<Layer extends { readonly ready: boolean }>(
  source: FrameSource<Layer>,
  layers: FrameLayers<Layer>,
  position: () => number,
  { clock, requestRender, tilesLoaded, signal }: ImageryContext,
): FramedImagery<Layer> {
  let ranges: TimeRange[] | undefined;
  let shown: { layer: Layer; frame: number | undefined } | undefined;
  let loading: { layer: Layer; frame: number; ticks: number } | undefined;
  let lastFetch = Date.now();

  const add = (frame?: number): Layer => {
    const layer = source.show(frame);
    layers.add(layer, shown ? layers.indexOf(shown.layer) + 1 : position());
    requestRender();
    return layer;
  };

  const onTick = () => {
    const time = JulianDate.toDate(clock.currentTime).getTime();
    if (time >= ranges!.at(-1)!.end && Date.now() - lastFetch >= source.refreshMs) {
      lastFetch = Date.now();
      void source.fetchRanges(signal).then((fresh) => {
        ranges = fresh ?? ranges;
      });
    }

    if (loading) {
      loading.ticks += 1;
      if (loading.ticks > SETTLE_TICKS && loading.layer.ready && tilesLoaded()) {
        layers.remove(shown!.layer);
        shown = loading;
        loading = undefined;
        requestRender();
      }
      return;
    }
    const frame = snapToFrame(ranges!, time)!;
    if (shown === undefined) {
      shown = { layer: add(frame), frame };
    } else if (frame !== shown.frame) {
      loading = { layer: add(frame), frame, ticks: 0 };
    }
  };

  signal.addEventListener(
    "abort",
    () => {
      for (const entry of [shown, loading]) {
        if (entry) {
          layers.remove(entry.layer);
        }
      }
      shown = undefined;
      loading = undefined;
      requestRender();
    },
    { once: true },
  );

  void source.fetchRanges(signal).then((fetched) => {
    if (signal.aborted) {
      return;
    }
    if (!fetched) {
      // The imagery stays usable, just not in time.
      console.warn(`[FramedImagery] no time domain for ${source.name}; showing its latest frame`);
      shown = { layer: add(), frame: undefined };
      return;
    }
    ranges = fetched;
    signal.addEventListener("abort", clock.onTick.addEventListener(onTick), { once: true });
    onTick();
  });

  return {
    get top() {
      return (loading ?? shown)?.layer;
    },
  };
}
