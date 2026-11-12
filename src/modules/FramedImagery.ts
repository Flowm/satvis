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
  /**
   * What shows `frame`; without one, what to show while the frames cannot be listed:
   * the service's latest. Not called before `fetchRanges` settles.
   */
  show: (frame?: number) => Shown;
}

/** One frame on the globe. */
export interface Frame<Layer> {
  layer: Layer;
  /** Whether every tile it has asked for has arrived; false until it has asked for one. */
  loaded: () => boolean;
}

export interface FramedImagery<Layer> {
  /** Its upper layer on the globe, while it has one. */
  readonly top: Layer | undefined;
}

/** Drawn frames a new layer waits before the globe's word on its tiles counts: it speaks of the last frame drawn. */
const SETTLE_TICKS = 2;

/**
 * Drawn frames a loading layer has nothing in flight before it counts as whole. Cesium
 * asks for a few tiles at a time, so between two batches it has nothing for a frame.
 */
const IDLE_TICKS = 10;

/** A frame not whole by now is shown as far as it got, so a request that is never answered does not hold the imagery. */
const MAX_LOAD_MS = 20_000;

/** How soon a service that could not list its frames is asked again. */
const RETRY_MS = 60_000;

/**
 * Makes `provider` count its tile requests. Returns whether every one it has made has
 * been answered, well or not; false until it has made one.
 */
export function trackRequests<Args extends unknown[]>(provider: { requestImage: (...args: Args) => Promise<unknown> | undefined }): () => boolean {
  const request = provider.requestImage.bind(provider);
  let asked = false;
  let pending = 0;
  const answered = () => {
    pending -= 1;
  };
  provider.requestImage = (...args) => {
    const image = request(...args);
    // Undefined when Cesium holds the request back for a later frame.
    if (image) {
      asked = true;
      pending += 1;
      image.then(answered, answered);
    }
    return image;
  };
  return () => asked && pending === 0;
}

/**
 * Shows `source` in `layers` until `signal` aborts. Its first layer goes to `position()`,
 * each later one over the one before it.
 *
 * A frame that is loading is never given up for a newer one, so a clock running faster
 * than the frames load still shows frames, skipping some, and a jump shows one frame on
 * the way. It is given up when the clock returns to the frame that is shown.
 *
 * The new frame is whole when its own requests are answered, or sooner when the globe
 * has nothing left to load. The globe alone would not do: it waits for the terrain and
 * every other layer too, which never ends while the view keeps moving.
 */
export function showFramedImagery<Layer>(
  source: FrameSource<Frame<Layer>>,
  layers: FrameLayers<Layer>,
  position: () => number,
  { clock, requestRender, tilesLoaded, signal }: ImageryContext,
): FramedImagery<Layer> {
  type Shown = Frame<Layer> & { frame: number | undefined };
  let ranges: TimeRange[] | undefined;
  let shown: Shown | undefined;
  let loading: (Shown & { ticks: number; idle: number; since: number }) | undefined;
  let lastFetch = 0;

  const add = (frame?: number): Shown => {
    const made = source.show(frame);
    layers.add(made.layer, shown ? layers.indexOf(shown.layer) + 1 : position());
    requestRender();
    return { ...made, frame };
  };

  const list = async () => {
    lastFetch = Date.now();
    const listed = await source.fetchRanges(signal);
    ranges = listed ?? ranges;
    return listed;
  };

  const onTick = () => {
    const time = JulianDate.toDate(clock.currentTime).getTime();
    // A list that could not be read is asked for again; one that was, once the clock is past its end.
    const due = ranges === undefined ? RETRY_MS : time >= ranges.at(-1)!.end ? source.refreshMs : Infinity;
    if (Date.now() - lastFetch >= due) {
      void list();
    }
    if (ranges === undefined) {
      return;
    }
    const frame = snapToFrame(ranges, time)!;

    if (loading) {
      if (frame === shown!.frame) {
        layers.remove(loading.layer);
        loading = undefined;
        requestRender();
        return;
      }
      // In request render mode a tick need not draw a frame: this makes the counts below those of drawn frames.
      requestRender();
      loading.ticks += 1;
      loading.idle = loading.loaded() ? loading.idle + 1 : 0;
      const whole = loading.idle >= IDLE_TICKS || (loading.ticks > SETTLE_TICKS && tilesLoaded());
      if (whole || Date.now() - loading.since >= MAX_LOAD_MS) {
        layers.remove(shown!.layer);
        shown = loading;
        loading = undefined;
      }
      return;
    }
    if (shown === undefined) {
      shown = add(frame);
    } else if (frame !== shown.frame) {
      loading = { ...add(frame), ticks: 0, idle: 0, since: Date.now() };
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

  void list().then((listed) => {
    if (signal.aborted) {
      return;
    }
    if (!listed) {
      // The imagery stays usable, just not in time, until the service answers.
      console.warn(`[FramedImagery] no time domain for ${source.name}; showing its latest frame`);
      shown = add();
    }
    signal.addEventListener("abort", clock.onTick.addEventListener(onTick), { once: true });
    onTick();
  });

  return {
    get top() {
      return (loading ?? shown)?.layer;
    },
  };
}
