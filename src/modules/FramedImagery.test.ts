import { JulianDate } from "@cesium/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { TimeRange } from "@/modules/util/timeDomain";

import { type ImageryContext, showFramedImagery, trackRequests } from "./FramedImagery";

interface Layer {
  frame: number | undefined;
}

const MINUTE = 60 * 1000;
const START = Date.parse("2026-10-03T00:00:00Z");
const RANGES: TimeRange[] = [{ start: START, end: START + 60 * MINUTE, step: 10 * MINUTE }];

/**
 * A globe's layer stack and clock, and one imagery shown on it over a basemap. `globe.loaded`
 * is the globe's word on all its tiles, `requests.answered` each frame's on its own;
 * `ranges` null for a service that cannot be reached.
 */
function shown(ranges: TimeRange[] | null = RANGES) {
  const stack: Layer[] = [{ frame: undefined }];
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
  const requests = { answered: false };
  const fetchRanges = vi.fn(() => Promise.resolve(ranges ?? undefined));
  const source = { name: "GeoColor", refreshMs: 30 * MINUTE, fetchRanges, show: (frame?: number) => ({ layer: { frame }, loaded: () => requests.answered }) };
  const imagery = showFramedImagery<Layer>(source, layers, () => 1, {
    clock,
    requestRender: () => {},
    tilesLoaded: () => globe.loaded,
    signal: lifetime.signal,
  } as unknown as ImageryContext);
  return {
    imagery,
    lifetime,
    globe,
    requests,
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

  test("asks for the list again once the clock is past its end, as often as the service lets it change, and shows a newer frame", async () => {
    const { frames, setClock, tick, globe, fetchRanges } = shown();
    await vi.advanceTimersByTimeAsync(0);
    globe.loaded = true;
    setClock(500);
    tick(4);
    expect(frames()).toEqual([60]);
    expect(fetchRanges).toHaveBeenCalledTimes(1);

    fetchRanges.mockResolvedValueOnce([{ ...RANGES[0]!, end: START + 70 * MINUTE }]);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    tick();
    expect(fetchRanges).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    tick(4);
    expect(frames()).toEqual([70]);
  });

  test("shows the new frame once its own requests are answered, though the globe is still loading", async () => {
    const { frames, setClock, tick, requests } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick(30);
    expect(frames()).toEqual([10, 20]);

    // Between two batches of requests a layer has nothing in flight for a frame.
    requests.answered = true;
    tick(5);
    requests.answered = false;
    tick();
    requests.answered = true;
    tick(9);
    expect(frames()).toEqual([10, 20]);
    tick();
    expect(frames()).toEqual([20]);
  });

  test("shows a frame as far as it got when a request is never answered", async () => {
    const { frames, setClock, tick } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick();
    await vi.advanceTimersByTimeAsync(19_000);
    tick();
    expect(frames()).toEqual([10, 20]);
    await vi.advanceTimersByTimeAsync(1000);
    tick();
    expect(frames()).toEqual([20]);
  });

  test("gives up a loading frame when the clock returns to the one that is shown", async () => {
    const { frames, setClock, tick, globe, imagery } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick();
    expect(frames()).toEqual([10, 20]);

    setClock(15);
    globe.loaded = true;
    tick(4);
    expect(frames()).toEqual([10]);
    expect(imagery.top).toMatchObject({ frame: 10 * MINUTE + START });
  });

  test("shows the service's latest frame while the list cannot be read, and follows the clock once it can", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { frames, tick, globe, fetchRanges, listeners } = shown(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toEqual(["latest"]);
    expect(listeners()).toBe(1);

    await vi.advanceTimersByTimeAsync(59_000);
    tick();
    expect(fetchRanges).toHaveBeenCalledTimes(1);
    fetchRanges.mockResolvedValueOnce(RANGES);
    await vi.advanceTimersByTimeAsync(1000);
    tick();
    expect(fetchRanges).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    globe.loaded = true;
    tick(4);
    expect(frames()).toEqual([10]);
    warn.mockRestore();
  });

  test("takes its layers off and stops listening once its lifetime ends", async () => {
    const { frames, setClock, tick, lifetime, listeners, imagery } = shown();
    await vi.advanceTimersByTimeAsync(0);
    setClock(25);
    tick();
    expect(frames()).toEqual([10, 20]);

    lifetime.abort();
    expect(frames()).toEqual([]);
    expect(listeners()).toBe(0);
    // Nothing is placed over a layer that has left the globe.
    expect(imagery.top).toBeUndefined();
  });

  test("shows nothing when its lifetime ends before its list arrives", async () => {
    const { frames, lifetime } = shown();
    lifetime.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toEqual([]);
  });
});

describe("trackRequests", () => {
  /** A provider whose requests the test answers; `held` for one Cesium holds back. */
  function provider() {
    const answers: { resolve: () => void; reject: () => void }[] = [];
    const tiles = {
      held: false,
      requestImage: (_x: number, _y: number) =>
        tiles.held
          ? undefined
          : new Promise<void>((resolve, reject) => {
              answers.push({ resolve, reject: () => reject(new Error("404")) });
            }),
    };
    return { tiles, answers };
  }

  test("is loaded once every request it has made is answered, well or not", async () => {
    const { tiles, answers } = provider();
    const loaded = trackRequests(tiles);
    expect(loaded()).toBe(false);

    void tiles.requestImage(0, 0);
    tiles.requestImage(1, 0)?.catch(() => {});
    expect(loaded()).toBe(false);
    answers[0]!.resolve();
    await Promise.resolve();
    expect(loaded()).toBe(false);
    answers[1]!.reject();
    await vi.waitFor(() => expect(loaded()).toBe(true));

    void tiles.requestImage(2, 0);
    expect(loaded()).toBe(false);
  });

  test("does not count a request Cesium holds back", () => {
    const { tiles } = provider();
    const loaded = trackRequests(tiles);
    tiles.held = true;
    expect(tiles.requestImage(0, 0)).toBeUndefined();
    expect(loaded()).toBe(false);
  });
});
