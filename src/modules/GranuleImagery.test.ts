import { JulianDate } from "@cesium/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Granule } from "@/modules/util/cmrGranules";

import { type GranuleSensing, type GranuleSource, SENSING_SLACK_MS, showGranuleImagery, TRAIL_MS } from "./GranuleImagery";

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
interface Sensing {
  start: number;
  passed: boolean;
}

/** A day granule `minutes` after START, six minutes long, with its first corner at `latitude`. */
function granule(minutes: number, day = true, latitude?: number): Granule {
  const start = START + minutes * MINUTE;
  return { start, end: start + 6 * MINUTE, day, outline: latitude === undefined ? [] : [{ latitude, longitude: 11 }] };
}

/**
 * A layer stack over a basemap, the outlines drawn, and a clock; `granules` what CMR lists
 * for any window, `missing` the starts GIBS has no pixels for, null for a CMR that cannot be reached.
 */
function shown(
  granules: Granule[] | null,
  missing: number[] | "outlines only" = [],
  answerAfterMs: (minutes: number) => number = () => 0,
  /** Whether the satellite followed has passed a granule at a time, both in minutes after START; no satellite where absent. */
  passedAt?: (granule: number, time: number) => boolean | undefined,
  /** Whether the provider has a layer a granule, as GIBS does, or its fills keep its pixels, as EUMETView's. */
  layerEach = true,
) {
  const fills = new Set<Sensing>();
  let tilesLoaded = true;
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
  const source: GranuleSource<Layer, Outline, Sensing> = {
    name: "TrueColor_Granule",
    fetchGranules,
    outline: ({ start }) => ({ start, missing: false }),
    ...(missing !== "outlines only" && {
      pixels: {
        has: ({ start }) => new Promise((resolve) => setTimeout(() => resolve(!missing.includes((start - START) / MINUTE)), answerAfterMs((start - START) / MINUTE))),
        ...(layerEach && { layer: ({ start }: Granule) => ({ layer: { start }, loaded: () => tilesLoaded }) }),
        markMissing: (outline) => {
          outline.missing = true;
        },
      },
    }),
    ...(passedAt !== undefined && {
      sensing: {
        passed: ({ start }, time) => passedAt((start - START) / MINUTE, (time - START) / MINUTE),
        show: ({ start }) => {
          const fill = { start, passed: false };
          fills.add(fill);
          return fill;
        },
        setPassed: (fill, passed) => {
          fill.passed = passed;
        },
        hide: (fill) => void fills.delete(fill),
      } satisfies GranuleSensing<Sensing>,
    }),
  };
  const lifetime = new AbortController();
  const context = { clock, requestRender: () => {}, signal: lifetime.signal } as unknown as Parameters<typeof showGranuleImagery<Layer, Outline, Sensing>>[4];
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
    /** The granules filling in, as minutes after START, a passed one marked. */
    fills: () => [...fills].map((fill) => `${minutes(fill.start)}${fill.passed ? "!" : ""}`).toSorted(),
    setTilesLoaded: (loaded: boolean) => {
      tilesLoaded = loaded;
    },
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

  test("shows each of the tiles of one scene, which share their start", async () => {
    const { layers, outlines, setClock } = shown([granule(0, true, 48), granule(0, true, 49), granule(0, true, 50)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([0, 0, 0]);
    expect(outlines()).toEqual(["0", "0", "0"]);
    setClock(TRAIL_MS / MINUTE + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(layers()).toEqual([]);
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

  describe("following the satellite", () => {
    // It passes a granule five minutes after its start, as today's elements may place it.
    const behind = (start: number, time: number) => time >= start + 5;

    test("fills the granule it is over, and gives it its outline and layer once past it", async () => {
      const { layers, outlines, fills, setClock } = shown([granule(0), granule(6)], [], undefined, behind);
      setClock(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(fills()).toEqual(["0"]);
      expect(outlines()).toEqual([]);
      expect(layers()).toEqual([]);
      setClock(6);
      await vi.advanceTimersByTimeAsync(0);
      expect(outlines()).toEqual(["0"]);
      expect(layers()).toEqual([0]);
      // The next one fills; the passed one's fill went with its layer's tiles.
      expect(fills()).toEqual(["6"]);
    });

    test("keeps a passed granule's fill until its layer has its tiles", async () => {
      const { fills, setClock, setTilesLoaded } = shown([granule(0)], [], undefined, behind);
      setClock(3);
      await vi.advanceTimersByTimeAsync(0);
      setTilesLoaded(false);
      setClock(6);
      await vi.advanceTimersByTimeAsync(0);
      expect(fills()).toEqual(["0"]);
      setTilesLoaded(true);
      setClock(6.1);
      expect(fills()).toEqual([]);
    });

    test("keeps the fill of a layer of outlines, passed, and drops a fill whose pixels the provider lacks", async () => {
      const outlinesOnly = shown([granule(0)], "outlines only", undefined, behind);
      outlinesOnly.setClock(6);
      await vi.advanceTimersByTimeAsync(0);
      expect(outlinesOnly.fills()).toEqual(["0!"]);
      expect(outlinesOnly.outlines()).toEqual(["0"]);
      const missing = shown([granule(0)], [0], undefined, behind);
      missing.setClock(6);
      await vi.advanceTimersByTimeAsync(0);
      expect(missing.fills()).toEqual([]);
      expect(missing.outlines()).toEqual(["0?"]);
    });

    test("keeps the fills of a provider without a layer a granule, and marks the outline of one it lacks", async () => {
      const { layers, outlines, fills, setClock } = shown([granule(0), granule(6)], [6], undefined, behind, false);
      setClock(12);
      await vi.advanceTimersByTimeAsync(0);
      expect(layers()).toEqual([]);
      expect(fills()).toEqual(["0!", "6!"]);
      expect(outlines()).toEqual(["0", "6?"]);
    });

    test("fills a granule again when the clock goes back over it", async () => {
      const { layers, outlines, fills, setClock } = shown([granule(0)], [], undefined, behind);
      setClock(6);
      await vi.advanceTimersByTimeAsync(0);
      setClock(2);
      expect(layers()).toEqual([]);
      expect(outlines()).toEqual([]);
      expect(fills()).toEqual(["0"]);
    });

    test("fills a granule the satellite drawn reaches before its start, and counts one long past as passed", async () => {
      const early = shown([granule(10)], [], undefined, () => false);
      early.setClock(10 - SENSING_SLACK_MS / MINUTE / 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(early.fills()).toEqual(["10"]);
      early.setClock(16 + SENSING_SLACK_MS / MINUTE + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(early.outlines()).toEqual(["10"]);
    });

    test("shows the granule whole at its start where the satellite is not drawn, and nothing before", async () => {
      const { outlines, fills, setClock } = shown([granule(0)], [], undefined, () => undefined);
      setClock(-1);
      await vi.advanceTimersByTimeAsync(0);
      expect(outlines()).toEqual([]);
      expect(fills()).toEqual([]);
      setClock(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(outlines()).toEqual(["0"]);
      expect(fills()).toEqual([]);
    });
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
