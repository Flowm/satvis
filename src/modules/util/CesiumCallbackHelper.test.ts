import { JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

/**
 * A clock advanced by hand: `frame` moves real time by `ms` and simulation time by `ms × multiplier`.
 */
function fakeClock() {
  const listeners = new Set<() => void>();
  let realMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => realMs);
  const clock = {
    currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
    onTick: {
      addEventListener(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return {
    viewer: { clock } as unknown as Viewer,
    frame(ms: number, multiplier: number) {
      realMs += ms;
      clock.currentTime = JulianDate.addSeconds(clock.currentTime, (ms / 1000) * multiplier, new JulianDate());
      [...listeners].forEach((listener) => listener());
    },
  };
}

/** How many times the callback fired over `seconds` of 60 fps frames. */
function firesOver(seconds: number, multiplier: number, create: typeof CesiumCallbackHelper.createThrottledTimeCallback): number {
  const { viewer, frame } = fakeClock();
  let fired = 0;
  create(viewer, 1, () => (fired += 1));
  for (let i = 0; i < seconds * 60; i += 1) {
    frame(1000 / 60, multiplier);
  }
  return fired;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createThrottledTimeCallback", () => {
  test("fires once a second at 1×", () => {
    expect(firesOver(10, 1, CesiumCallbackHelper.createThrottledTimeCallback)).toBe(9);
  });

  test("fires once a real second at a fast clock, where the periodic time callback fires every frame", () => {
    expect(firesOver(10, 3600, CesiumCallbackHelper.createPeriodicTimeCallback)).toBe(600);
    expect(firesOver(10, 3600, CesiumCallbackHelper.createThrottledTimeCallback)).toBe(9);
  });

  test("does not fire while the clock is paused", () => {
    expect(firesOver(10, 0, CesiumCallbackHelper.createThrottledTimeCallback)).toBe(0);
  });

  test("fires a second after a jump while paused", () => {
    const { viewer, frame } = fakeClock();
    let fired = 0;
    CesiumCallbackHelper.createThrottledTimeCallback(viewer, 1, () => (fired += 1));
    frame(500, 0);
    viewer.clock.currentTime = JulianDate.addSeconds(viewer.clock.currentTime, 3600, new JulianDate());
    frame(16, 0);
    expect(fired).toBe(0);
    frame(500, 0);
    expect(fired).toBe(1);
  });
});
