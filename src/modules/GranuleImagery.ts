// Granules replayed behind the clock (ADR 0023): every day granule sensed in the TRAIL_MS
// before the simulation time shows its outline and, where the provider has them, its
// pixels, so the swath builds up behind the satellite and falls away behind it.
//
// Not FramedImagery.ts: a frame of one granule alone would show a strip that jumps ahead
// every few minutes.

import type { Clock } from "@cesium/core";
import { JulianDate } from "@cesium/core";

import type { Granule } from "@/modules/util/cmrGranules";

import type { Frame, FrameLayers, ImageryContext } from "./FramedImagery";

/**
 * What a granule layer needs of its services. `Layer` draws a granule's pixels, `Outline`
 * its outline, `Sensing` it filling in as it is sensed.
 */
export interface GranuleSource<Layer, Outline, Sensing = never> {
  /** Names the layer in the warning when its granules cannot be listed. */
  name: string;
  /** The granules sensed from `start` to `end` (epoch ms), or undefined when they cannot be listed. */
  fetchGranules: (signal: AbortSignal, start: number, end: number) => Promise<Granule[] | undefined>;
  /** Drawn at once. */
  outline: (granule: Granule) => Outline;
  /** The provider of the granules' pixels; absent for a layer of outlines alone. */
  pixels?: GranulePixels<Layer, Outline>;
  /** The satellite the granules are sensed by; absent where it cannot be followed. */
  sensing?: GranuleSensing<Sensing>;
}

/** A granule filling in behind the satellite's scan line, as the satellite drawn passes over it. */
export interface GranuleSensing<Sensing> {
  /** Whether the satellite drawn has passed all of the granule at `time` (epoch ms); undefined where it is not drawn then. */
  passed: (granule: Granule, time: number) => boolean | undefined;
  /** Drawn at once, filled behind the scan line. */
  show: (granule: Granule) => Sensing;
  /** Filled whole, as the satellite has passed it, or behind the scan line again. */
  setPassed: (sensing: Sensing, passed: boolean) => void;
  hide: (sensing: Sensing) => void;
}

/** A provider of granules' pixels, which may lack some. */
export interface GranulePixels<Layer, Outline> {
  /** Whether it has the granule's pixels. */
  has: (granule: Granule) => Promise<boolean>;
  /** A layer of the granule's pixels once passed; without one, its fill keeps its picture. */
  layer?: (granule: Granule) => Frame<Layer>;
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

/**
 * How far from a granule's times the satellite drawn may sense it: today's element set
 * places NOAA 20 up to 17 s off its granules of 30 days ago (ADR 0023). Past it, a granule
 * counts as passed, as its scan line, a plane through the Earth, turns back toward it.
 */
export const SENSING_SLACK_MS = 2 * 60 * 1000;

/** The day granules whose trail covers `time`, sorted by start, and with `early` those starting that soon. */
function trailAt(granules: readonly Granule[], time: number, early = 0): Granule[] {
  return granules.filter((granule) => granule.day && granule.start <= time + early && granule.start > time - TRAIL_MS);
}

/**
 * Shows `source`'s granules behind `clock`'s time until `signal` aborts. Their layers lie
 * from `position()` up, oldest at the bottom, so a newer granule's pixels lie over the
 * edge it shares with the one before.
 */
export function showGranuleImagery<Layer, Outline, Sensing = never>(
  source: GranuleSource<Layer, Outline, Sensing>,
  layers: FrameLayers<Layer>,
  outlines: GranuleOutlines<Outline>,
  position: () => number,
  { clock, requestRender, signal }: Pick<ImageryContext, "requestRender" | "signal"> & { clock: Pick<Clock, "currentTime" | "onTick"> },
): GranuleImagery<Layer> {
  interface Shown {
    granule: Granule;
    /** Drawn once the satellite has passed the granule. */
    outline?: Outline;
    layer?: Frame<Layer>;
    /** Whether the provider has its pixels, once it has said. */
    pixels?: boolean;
    sensing?: Sensing;
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
        below = entry.layer.layer;
        belowStart = entry.granule.start;
      }
    }
    return below === undefined ? position() : layers.indexOf(below) + 1;
  };

  /** Where the satellite is: past the granule, over it, or before it; without one to follow, past it once it has begun. */
  const stage = ({ granule }: Shown, time: number): "before" | "over" | "past" => {
    const past = source.sensing === undefined || time > granule.end + SENSING_SLACK_MS ? undefined : source.sensing.passed(granule, time);
    if (past === undefined) {
      return time >= granule.start ? "past" : "before";
    }
    return past ? "past" : "over";
  };

  /** Draws what the granule needs at `time`: passed, its outline and pixels; under the satellite, its fill alone. */
  const settle = (entry: Shown, time: number): boolean => {
    const { sensing, pixels } = source;
    const where = stage(entry, time);
    let changed = false;
    if (where !== "past") {
      if (entry.outline !== undefined) {
        outlines.remove(entry.outline);
        entry.outline = undefined;
        changed = true;
      }
      if (entry.layer !== undefined) {
        layers.remove(entry.layer.layer);
        entry.layer = undefined;
        changed = true;
      }
      if (sensing !== undefined && entry.sensing !== undefined && where === "before") {
        sensing.hide(entry.sensing);
        entry.sensing = undefined;
        changed = true;
      }
      if (sensing !== undefined && entry.sensing === undefined && where === "over") {
        entry.sensing = sensing.show(entry.granule);
        changed = true;
      }
      if (sensing !== undefined && entry.sensing !== undefined) {
        sensing.setPassed(entry.sensing, false);
      }
      return changed;
    }
    if (entry.outline === undefined) {
      entry.outline = source.outline(entry.granule);
      outlines.add(entry.outline);
      if (entry.pixels === false) {
        pixels?.markMissing(entry.outline);
      }
      changed = true;
    }
    if (pixels?.layer !== undefined && entry.pixels === true && entry.layer === undefined) {
      entry.layer = pixels.layer(entry.granule);
      layers.add(entry.layer.layer, indexFor(entry.granule));
      changed = true;
    }
    // Without a layer a granule, the fill is the swath behind the satellite, kept even after a jump past it.
    if (sensing !== undefined && pixels?.layer === undefined && entry.sensing === undefined) {
      entry.sensing = sensing.show(entry.granule);
      changed = true;
    }
    if (sensing !== undefined && entry.sensing !== undefined) {
      // A picture's fill goes once its own layer has its tiles, or has none.
      if (pixels?.layer === undefined) {
        sensing.setPassed(entry.sensing, true);
      } else if (entry.pixels === false || entry.layer?.loaded()) {
        sensing.hide(entry.sensing);
        entry.sensing = undefined;
        changed = true;
      }
    }
    return changed;
  };

  const add = (granule: Granule, time: number) => {
    const entry: Shown = { granule };
    shown.set(granule.start, entry);
    settle(entry, time);
    void source.pixels?.has(granule).then((has) => {
      if (signal.aborted || shown.get(granule.start) !== entry) {
        return;
      }
      entry.pixels = has;
      if (!has && entry.outline !== undefined) {
        source.pixels?.markMissing(entry.outline);
      }
      settle(entry, JulianDate.toDate(clock.currentTime).getTime());
      requestRender();
    });
  };

  const drop = (entry: Shown) => {
    if (entry.outline !== undefined) {
      outlines.remove(entry.outline);
    }
    if (entry.layer !== undefined) {
      layers.remove(entry.layer.layer);
    }
    if (entry.sensing !== undefined) {
      source.sensing?.hide(entry.sensing);
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
    const trail = trailAt(listing.granules, time, source.sensing === undefined ? 0 : SENSING_SLACK_MS);
    const wanted = new Set(trail.map((granule) => granule.start));
    let changed = false;
    for (const entry of shown.values()) {
      if (!wanted.has(entry.granule.start)) {
        drop(entry);
        changed = true;
      } else {
        changed = settle(entry, time) || changed;
      }
    }
    for (const granule of trail) {
      if (!shown.has(granule.start)) {
        add(granule, time);
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
          top = entry.layer.layer;
          topStart = entry.granule.start;
        }
      }
      return top;
    },
  };
}
