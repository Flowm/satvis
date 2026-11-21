// A layer of one granule a frame, replayed behind the clock (ADR 0023): every granule
// sensed by day in the last TRAIL_MS before the simulation time is on the globe at once,
// its outline and, where a provider has them, its pixels, so the swath builds up behind
// the satellite as the clock runs and falls away behind it.
//
// Not FramedImagery.ts, which shows one frame: a granule is a few minutes of one swath,
// and a frame of it alone would show a strip that jumps ahead every few minutes.

import type { Clock } from "@cesium/core";
import { JulianDate } from "@cesium/core";

import type { Granule } from "@/modules/util/cmrGranules";

import type { FrameLayers, ImageryContext } from "./FramedImagery";

/** What a granule layer needs of its services. `Layer` draws a granule's pixels, `Outline` its outline. */
export interface GranuleSource<Layer, Outline> {
  /** Names the layer in the warning when its granules cannot be listed. */
  name: string;
  /** The granules sensed from `start` to `end` (epoch ms), or undefined when they cannot be listed. */
  fetchGranules: (signal: AbortSignal, start: number, end: number) => Promise<Granule[] | undefined>;
  /** Drawn at once. */
  outline: (granule: Granule) => Outline;
  /** The provider of the granules' pixels; absent for a layer of outlines alone. */
  pixels?: GranulePixels<Layer, Outline>;
}

/** A provider of granules' pixels, which may lack some. */
export interface GranulePixels<Layer, Outline> {
  /** Whether it has the granule's pixels. */
  has: (granule: Granule) => Promise<boolean>;
  layer: (granule: Granule) => Layer;
  /** Marks an outline drawn as one whose granule it has no pixels for. */
  markMissing: (outline: Outline) => void;
}

/** Where the outlines are drawn. */
export interface GranuleOutlines<Outline> {
  add(outline: Outline): void;
  remove(outline: Outline): void;
}

export interface GranuleImagery<Layer> {
  /** Its upper layer on the globe, while it has one. */
  readonly top: Layer | undefined;
}

/**
 * How long a granule stays behind the clock: about the daylit half of a 101-minute polar
 * orbit, so a whole pass over the day side is on the globe as the satellite leaves it.
 */
export const TRAIL_MS = 50 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** How far before and after the clock's hour the granules are listed at once: the trail, and the hour to come. */
const LIST_BEFORE_MS = 2 * HOUR_MS;
const LIST_AFTER_MS = 2 * HOUR_MS;

/** How soon a list that may still grow is asked again. */
const REFRESH_MS = 10 * 60 * 1000;

/** How long after it is sensed CMR may not list a granule yet: the near-real-time collection's lag, about three hours. */
const FILLING_MS = 4 * HOUR_MS;

/** How soon a list CMR did not answer is asked again. */
const RETRY_MS = 60 * 1000;

/** The day granules whose trail covers `time`, sorted by start. */
export function trailAt(granules: readonly Granule[], time: number): Granule[] {
  return granules.filter((granule) => granule.day && granule.start <= time && granule.start > time - TRAIL_MS);
}

/**
 * Shows `source`'s granules behind `clock`'s time until `signal` aborts. Their layers lie
 * from `position()` up, oldest at the bottom, so a newer granule's pixels lie over the
 * edge it shares with the one before.
 */
export function showGranuleImagery<Layer, Outline>(
  source: GranuleSource<Layer, Outline>,
  layers: FrameLayers<Layer>,
  outlines: GranuleOutlines<Outline>,
  position: () => number,
  { clock, requestRender, signal }: Pick<ImageryContext, "requestRender" | "signal"> & { clock: Pick<Clock, "currentTime" | "onTick"> },
): GranuleImagery<Layer> {
  interface Shown {
    granule: Granule;
    outline: Outline;
    layer?: Layer;
  }
  /** By start. */
  const shown = new Map<number, Shown>();
  let listing: { granules: Granule[]; start: number; end: number } | undefined;
  let asking = false;
  let lastAsk = Number.NEGATIVE_INFINITY;
  let failed = false;
  let warned = false;

  const list = async (time: number) => {
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    const start = hour - LIST_BEFORE_MS;
    const end = hour + LIST_AFTER_MS;
    asking = true;
    lastAsk = Date.now();
    const granules = await source.fetchGranules(signal, start, end).finally(() => (asking = false));
    if (signal.aborted) {
      return;
    }
    failed = granules === undefined;
    if (granules === undefined) {
      if (!warned) {
        console.warn(`[GranuleImagery] cannot list the granules of ${source.name}; asking again in a minute`);
        warned = true;
      }
      return;
    }
    listing = { granules, start, end };
    onTick();
  };

  /** Over the newest of its own layers older than `granule`, or at the bottom of them. */
  const indexFor = (granule: Granule): number => {
    let below: Layer | undefined;
    let belowStart = Number.NEGATIVE_INFINITY;
    for (const entry of shown.values()) {
      if (entry.layer !== undefined && entry.granule.start < granule.start && entry.granule.start > belowStart) {
        below = entry.layer;
        belowStart = entry.granule.start;
      }
    }
    return below === undefined ? position() : layers.indexOf(below) + 1;
  };

  const add = (granule: Granule) => {
    const entry: Shown = { granule, outline: source.outline(granule) };
    outlines.add(entry.outline);
    shown.set(granule.start, entry);
    const { pixels } = source;
    if (pixels === undefined) {
      return;
    }
    void pixels.has(granule).then((has) => {
      if (signal.aborted || shown.get(granule.start) !== entry) {
        return;
      }
      if (!has) {
        pixels.markMissing(entry.outline);
      } else {
        entry.layer = pixels.layer(granule);
        layers.add(entry.layer, indexFor(granule));
      }
      requestRender();
    });
  };

  const drop = (entry: Shown) => {
    outlines.remove(entry.outline);
    if (entry.layer !== undefined) {
      layers.remove(entry.layer);
    }
    shown.delete(entry.granule.start);
  };

  function onTick(): void {
    const time = JulianDate.toDate(clock.currentTime).getTime();
    const outside = listing === undefined || time - TRAIL_MS < listing.start || time > listing.end;
    // CMR lists a granule hours after it is sensed, so a list that reaches the last few hours grows.
    const filling = listing !== undefined && listing.end > Date.now() - FILLING_MS;
    const due = failed ? RETRY_MS : outside ? 0 : filling ? REFRESH_MS : Infinity;
    if (!asking && Date.now() - lastAsk >= due) {
      void list(time);
    }
    if (listing === undefined) {
      return;
    }
    const trail = trailAt(listing.granules, time);
    const wanted = new Set(trail.map((granule) => granule.start));
    let changed = false;
    for (const entry of shown.values()) {
      if (!wanted.has(entry.granule.start)) {
        drop(entry);
        changed = true;
      }
    }
    for (const granule of trail) {
      if (!shown.has(granule.start)) {
        add(granule);
        changed = true;
      }
    }
    if (changed) {
      requestRender();
    }
  }

  signal.addEventListener(
    "abort",
    () => {
      for (const entry of shown.values()) {
        drop(entry);
      }
      requestRender();
    },
    { once: true },
  );
  signal.addEventListener("abort", clock.onTick.addEventListener(onTick), { once: true });
  onTick();

  return {
    get top() {
      let top: Layer | undefined;
      let topStart = Number.NEGATIVE_INFINITY;
      for (const entry of shown.values()) {
        if (entry.layer !== undefined && entry.granule.start > topStart) {
          top = entry.layer;
          topStart = entry.granule.start;
        }
      }
      return top;
    },
  };
}
