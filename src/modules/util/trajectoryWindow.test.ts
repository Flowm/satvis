import { describe, expect, test } from "vitest";

import { SAMPLES_PER_ORBIT, trajectoryWindow, WINDOW_ORBITS_BACK, WINDOW_ORBITS_FORWARD } from "./trajectoryWindow";

const ISS_PERIOD_MIN = 92.6;

describe("trajectoryWindow", () => {
  test("spans half an orbit back and one and a half forward", () => {
    const window = trajectoryWindow(ISS_PERIOD_MIN);
    const periodSeconds = ISS_PERIOD_MIN * 60;

    expect(window.offsetSeconds).toBeCloseTo(-periodSeconds * WINDOW_ORBITS_BACK, 6);
    expect(window.spanSeconds).toBeCloseTo(periodSeconds * (WINDOW_ORBITS_BACK + WINDOW_ORBITS_FORWARD), 6);
  });

  test("steps at the sampling rate and counts the closing boundary", () => {
    const window = trajectoryWindow(ISS_PERIOD_MIN);

    expect(window.stepSeconds).toBeCloseTo((ISS_PERIOD_MIN * 60) / SAMPLES_PER_ORBIT, 6);
    // 240 steps over two orbits, plus the closing boundary.
    expect(window.sampleCount).toBe(241);
  });

  test("scales with the period rather than assuming LEO", () => {
    const geo = trajectoryWindow(1436);

    expect(geo.sampleCount).toBe(241);
    expect(geo.stepSeconds).toBeCloseTo((1436 * 60) / SAMPLES_PER_ORBIT, 6);
  });

  test("an unusable period yields an empty window rather than NaN", () => {
    for (const period of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = trajectoryWindow(period);
      expect(window.sampleCount).toBe(0);
      expect(Number.isFinite(window.stepSeconds)).toBe(true);
      expect(Number.isFinite(window.offsetSeconds)).toBe(true);
      expect(Number.isFinite(window.spanSeconds)).toBe(true);
    }
  });
});
