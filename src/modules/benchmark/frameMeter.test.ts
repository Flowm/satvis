import { describe, expect, test } from "vitest";

import { displayIntervalMs, gpuCapMs, gpuCappedPct } from "./frameMeter";

describe("displayIntervalMs", () => {
  test("reads the display from the single-refresh gaps", () => {
    expect(displayIntervalMs([33, 17, 16, 17, 33, 17, 16, 17])).toBeCloseTo(100 / 6, 9);
  });

  // A 60 Hz iPad while the page loads, where the median read 33 ms: a later reading stands instead.
  test("reads nothing where most gaps skip refreshes", () => {
    expect(displayIntervalMs([33, 50, 17, 33, 16, 33, 67, 17, 33])).toBeUndefined();
  });

  test("reads 120 Hz", () => {
    expect(displayIntervalMs(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 8 : 9)))).toBeCloseTo(8.5, 9);
  });

  // Safari on a busy iPad mini: catch-up frames between refreshes read 60 Hz as 143.
  test("needs half the gaps, so catch-up frames read nothing", () => {
    const gaps = [...Array.from({ length: 54 }, () => 16.7), 7, 7.5, 8, 7, 9, 7];
    expect(displayIntervalMs(gaps)).toBeCloseTo(16.7, 9);
  });

  // Safari's whole milliseconds split 16.7 into 16s and 17s; every fourth frame 4 ms late
  // leaves 20s and 13s, and a window from the shortest read 66 Hz. The 21s and 12s fall outside.
  test("reads 60 Hz from late frames in whole milliseconds", () => {
    const stamps = Array.from({ length: 61 }, (_, i) => Math.floor((i * 1000) / 60 + (i % 4 === 0 ? 4 : 0)));
    const gaps = stamps.slice(1).map((stamp, i) => stamp - (stamps[i] as number));
    expect(Math.abs(1000 / displayIntervalMs(gaps)! - 60)).toBeLessThan(2);
  });

  test("leaves out a stall's catch-up, and reads nothing from nothing", () => {
    expect(displayIntervalMs([0.5, 16.7, 16.7])).toBeCloseTo(16.7, 9);
    expect(displayIntervalMs([])).toBeUndefined();
  });
});

describe("gpuCapMs", () => {
  // ANGLE/Metal times a saturated GPU's queue too: 37 ms for 19 ms of work at 60 Hz.
  test("caps at the median interval only where the mean outruns it", () => {
    expect(gpuCapMs([30, 40, 37], [16.7, 16.6, 16.8])).toBe(16.7);
    expect(gpuCapMs([12, 14, 20], [16.7, 16.6, 16.8])).toBe(Number.POSITIVE_INFINITY);
    expect(gpuCapMs([28], [])).toBe(Number.POSITIVE_INFINITY);
  });

  test("counts the share capped, for the report", () => {
    expect(gpuCappedPct([30, 40, 37, 10], [16.7, 16.6, 16.8])).toBe(75);
    expect(gpuCappedPct([12, 14, 20], [16.7, 16.6, 16.8])).toBe(0);
    expect(gpuCappedPct([], [16.7])).toBeNull();
  });
});
