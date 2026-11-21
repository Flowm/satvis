import { JulianDate } from "@cesium/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Granule } from "@/modules/util/cmrGranules";

import { type GranuleSource, showGranuleImagery, TRAIL_MS } from "./GranuleImagery";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-20T10:00:00Z");

interface Layer {
  start: number;
}
interface Outline {
  start: number;
  missing: boolean;
}

/** A day granule `minutes` after START, six minutes long. */
function granule(minutes: number, day = true): Granule {
  const start = START + minutes * MINUTE;
  return { start, end: start + 6 * MINUTE, day, outline: [] };
}

/**
 * A layer stack over a basemap, the outlines drawn, and a clock; `granules` what CMR lists
 * for any window, `missing` the starts GIBS has no pixels for, null for a CMR that cannot be reached.
 */
function shown(granules: Granule[] | null, missing: number[] | "outlines only" = [], answerAfterMs: (minutes: number) => number = () => 0) {
  const stack: (Layer | "basemap")[] = ["basemap"];
  const layers = {
    add: (layer: Layer, index = stack.length) => void stack.splice(index, 0, layer),
    remove: (layer: Layer) => stack.includes(layer) && stack.splice(stack.indexOf(layer), 1).length > 0,
    indexOf: (layer: Layer) => stack.indexOf(layer),
  };
  const drawn = new Set<Outline>();
  const ticks: (() => void)[] = [];
  const clock = {
    currentTime: JulianDate.fromDate(new Date(START)),
    onTick: {
      addEventListener: (listener: () => void) => {
        ticks.push(listener);
        return () => void ticks.splice(ticks.indexOf(listener), 1);
      },
    },
  };
  const fetchGranules = vi.fn((_signal: AbortSignal, _start: number, _end: number) => Promise.resolve(granules ?? undefined));
  const source: GranuleSource<Layer, Outline> = {
    name: "TrueColor_Granule",
    fetchGranules,
    outline: ({ start }) => ({ start, missing: false }),
    ...(missing !== "outlines only" && {
      pixels: {
        has: ({ start }) => new Promise((resolve) => setTimeout(() => resolve(!missing.includes((start - START) / MINUTE)), answerAfterMs((start - START) / MINUTE))),
        layer: ({ start }) => ({ start }),
        markMissing: (outline) => {
          outline.missing = true;
        },
      },
    }),
  };
  const lifetime = new AbortController();
  const context = { clock, requestRender: () => {}, signal: lifetime.signal } as unknown as Parameters<typeof showGranuleImagery>[4];
  const imagery = showGranuleImagery(source, layers, { add: (outline) => drawn.add(outline), remove: (outline) => drawn.delete(outline) }, () => 1, context);
  const minutes = (start: number) => (start - START) / MINUTE;
  return {
    imagery,
    lifetime,
    fetchGranules,
    /** The granules' layers over the basemap, bottom first, as minutes after START. */
    layers: () => stack.slice(1).map((layer) => minutes((layer as Layer).start)),
    /** The outlines drawn, as minutes after START, a missing one marked. */
    outlines: () => [...drawn].map((outline) => `${minutes(outline.start)}${outline.missing ? "?" : ""}`).toSorted(),
    setClock: (minutesAfter: number) => {
      clock.currentTime = JulianDate.fromDate(new Date(START + minutesAfter * MINUTE));
      ticks.forEach((listener) => listener());
    },
    listeners: () => ticks.length,
  };
}

describe("showGranuleImagery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START + 30 * 24 * HOUR });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows each day granule once the clock passes its start, and drops it TRAIL_MS later", async () => {
    const { layers, outlines, setClock } = shown([granule(0), granule(6), granule(12), granule(18, false)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([0]);
    setClock(13);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([0, 6, 12]);
    // A night granule has no true colour pixels, and no outline.
    setClock(20);
    await vi.advanceTimersByTimeAsync(0);
    expect(outlines()).toEqual(["0", "12", "6"]);
    setClock(TRAIL_MS / MINUTE + 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([12]);
  });

  test("keeps the outline of a granule the provider has no pixels for, marked, and draws no layer for it", async () => {
    const { layers, outlines, setClock } = shown([granule(0), granule(6)], [6]);
    setClock(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([0]);
    expect(outlines()).toEqual(["0", "6?"]);
  });

  test("draws the outlines alone, unmarked, for a layer with no provider of pixels", async () => {
    const { layers, outlines, setClock, imagery } = shown([granule(0), granule(6)], "outlines only");
    setClock(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([]);
    expect(outlines()).toEqual(["0", "6"]);
    expect(imagery.top).toBeUndefined();
  });

  test("lays an older granule under a newer one whichever answers first", async () => {
    // Jumped to, all three are asked for at once, and the newest answers first.
    const { layers, setClock } = shown([granule(0), granule(6), granule(12)], [], (minutes) => 100 - 5 * minutes);
    await vi.advanceTimersByTimeAsync(0);
    setClock(13);
    await vi.advanceTimersByTimeAsync(75);
    expect(layers()).toEqual([6, 12]);
    await vi.advanceTimersByTimeAsync(25);
    expect(layers()).toEqual([0, 6, 12]);
  });

  test("lists the granules again when the clock leaves the hours listed, and not while it stays", async () => {
    const { fetchGranules, setClock } = shown([granule(0)]);
    await vi.advanceTimersByTimeAsync(0);
    setClock(30);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchGranules).toHaveBeenCalledTimes(1);
    setClock(3 * 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchGranules).toHaveBeenCalledTimes(2);
    const [, start, end] = fetchGranules.mock.calls[1]!;
    expect(start).toBeLessThanOrEqual(START + 3 * HOUR - TRAIL_MS);
    expect(end).toBeGreaterThan(START + 3 * HOUR);
  });

  test("asks a CMR that did not answer again a minute later, showing nothing meanwhile", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchGranules, layers, setClock } = shown(null);
    await vi.advanceTimersByTimeAsync(0);
    setClock(1);
    expect(fetchGranules).toHaveBeenCalledTimes(1);
    expect(layers()).toEqual([]);
    vi.advanceTimersByTime(60 * 1000);
    setClock(2);
    expect(fetchGranules).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("takes every layer and outline off, and stops following the clock, when its lifetime ends", async () => {
    const { layers, outlines, lifetime, listeners, setClock } = shown([granule(0), granule(6)]);
    setClock(7);
    await vi.advanceTimersByTimeAsync(0);
    lifetime.abort();
    expect(layers()).toEqual([]);
    expect(outlines()).toEqual([]);
    expect(listeners()).toBe(0);
  });

  test("is topped by its newest granule's layer", async () => {
    const { imagery, setClock } = shown([granule(0), granule(6)]);
    setClock(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(imagery.top).toEqual({ start: START + 6 * MINUTE });
  });
});
