import { JulianDate } from "@cesium/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { TimeRange } from "@/modules/util/timeDomain";

import type { ImageryContext } from "./CesiumLayerProviders";
import { showFramedImagery } from "./FramedImagery";

interface Layer {
  frame: number | undefined;
  ready: boolean;
}

const MINUTE = 60 * 1000;
const START = Date.parse("2026-10-03T00:00:00Z");
const RANGES: TimeRange[] = [{ start: START, end: START + 60 * MINUTE, step: 10 * MINUTE }];

/** A globe's layer stack and clock, and one imagery shown on it over a basemap; `ranges` null for a service that cannot be reached. */
function shown(ranges: TimeRange[] | null = RANGES) {
  const stack: Layer[] = [{ frame: undefined, ready: true }];
  const layers = {
    add: (layer: Layer, index = stack.length) => void stack.splice(index, 0, layer),
    remove: (layer: Layer) => stack.includes(layer) && stack.splice(stack.indexOf(layer), 1).length > 0,
    indexOf: (layer: Layer) => stack.indexOf(layer),
  };
  const ticks: (() => void)[] = [];
  const clock = {
    currentTime: JulianDate.fromDate(new Date(START + 15 * MINUTE)),
    onTick: {
      addEventListener: (listener: () => void) => {
        ticks.push(listener);
        return () => void ticks.splice(ticks.indexOf(listener), 1);
      },
    },
  };
  const lifetime = new AbortController();
  const globe = { loaded: false };
  const fetchRanges = vi.fn(() => Promise.resolve(ranges ?? undefined));
  const imagery = showFramedImagery<Layer>({ name: "GeoColor", refreshMs: 30 * MINUTE, fetchRanges, layer: (frame) => ({ frame, ready: true }) }, layers, () => 1, {
    clock,
    requestRender: () => {},
    tilesLoaded: () => globe.loaded,
    signal: lifetime.signal,
  } as unknown as ImageryContext);
  return {
    imagery,
    lifetime,
    globe,
    fetchRanges,
    /** The frames on the globe over the basemap, in z-order, as minutes into the list. */
    frames: () => stack.slice(1).map((layer) => (layer.frame === undefined ? "latest" : (layer.frame - START) / MINUTE)),
    setClock: (minutes: number) => {
      clock.currentTime = JulianDate.fromDate(new Date(START + minutes * MINUTE));
    },
    tick: (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        ticks.forEach((listener) => listener());
      }
    },
    listeners: () => ticks.length,
  };
}

describe("showFramedImagery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows the frame for the clock, and the next one over it until its tiles are there", async () => {
    const { frames, setClock, tick, globe, imagery } = shown();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toEqual([10]);

    setClock(25);
    tick();
    expect(frames()).toEqual([10, 20]);
    // Loaded as of a frame drawn before the new layer was added.
    globe.loaded = true;
    tick();
    expect(frames()).toEqual([10, 20]);
    globe.loaded = false;
    tick(5);
    expect(frames()).toEqual([10, 20]);

    globe.loaded = true;
    tick();
    expect(frames()).toEqual([20]);
    expect(imagery.top).toMatchObject({ frame: 20 * MINUTE + START });
  });

  test("finishes the frame it is loading before it starts a newer one", async () => {
    const { frames, setClock, tick, globe } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick();
    setClock(45);
    tick(5);
    expect(frames()).toEqual([10, 20]);

    globe.loaded = true;
    tick();
    expect(frames()).toEqual([20]);
    globe.loaded = false;
    tick();
    expect(frames()).toEqual([20, 40]);
  });

  test("holds the first and the last frame outside the list", async () => {
    const { frames, setClock, tick, globe } = shown();
    await vi.advanceTimersByTimeAsync(0);
    globe.loaded = true;
    setClock(-500);
    tick(4);
    expect(frames()).toEqual([0]);
    setClock(500);
    tick(4);
    expect(frames()).toEqual([60]);
  });

  test("asks for the list again once the clock is past its end, as often as the service lets it change", async () => {
    const { setClock, tick, fetchRanges } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(500);
    tick();
    expect(fetchRanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    tick(3);
    expect(fetchRanges).toHaveBeenCalledTimes(2);
  });

  test("shows the service's latest frame, not in time, when the list cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { frames, listeners } = shown(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toEqual(["latest"]);
    expect(listeners()).toBe(0);
    warn.mockRestore();
  });

  test("takes its layers off and stops listening once its lifetime ends", async () => {
    const { frames, setClock, tick, lifetime, listeners } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick();
    expect(frames()).toEqual([10, 20]);

    lifetime.abort();
    expect(frames()).toEqual([]);
    expect(listeners()).toBe(0);
  });

  test("shows nothing when its lifetime ends before its list arrives", async () => {
    const { frames, lifetime } = shown();
    lifetime.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toEqual([]);
  });
});
