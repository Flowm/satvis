import { describe, expect, test } from "vitest";

import { FrameCap } from "./frameCap";

/** The gaps between frames drawn over 10 s of refreshes, 0.1 ms early and late by turns, or floored to whole milliseconds as Safari's. */
function drawnGaps(intervalMs: number | undefined, hz: number, wholeMs = false): number[] {
  const cap = new FrameCap();
  cap.intervalMs = intervalMs;
  const drawn: number[] = [];
  for (let frame = 0; frame * (1000 / hz) <= 10_000; frame += 1) {
    const exact = (frame * 1000) / hz + (frame % 2 === 0 ? 0.1 : -0.1);
    const frameTime = wholeMs ? Math.floor(exact) : exact;
    if (cap.draws(frameTime)) {
      drawn.push(frameTime);
    }
  }
  return drawn.slice(1).map((time, i) => time - (drawn[i] as number));
}

/** Frames a second over `gaps`. */
const fps = (gaps: number[]): number => (gaps.length / gaps.reduce((sum, gap) => sum + gap, 0)) * 1000;

describe("FrameCap", () => {
  // Cesium's cap at 63 drew a frame in ten a refresh early on 120 Hz.
  test("draws a cap that divides the screen's rate on every nth refresh", () => {
    for (const [cap, hz, refreshes] of [
      [60, 60, 1],
      [60, 120, 2],
      [30, 60, 2],
      [30, 120, 4],
    ] as const) {
      for (const gap of drawnGaps(1000 / cap, hz)) {
        expect(gap).toBeCloseTo((refreshes * 1000) / hz, 0);
      }
      for (const gap of drawnGaps(1000 / cap, hz, true)) {
        expect(Math.abs(gap - (refreshes * 1000) / hz)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("draws any other cap at its rate on average", () => {
    for (const hz of [75, 90, 144]) {
      expect(fps(drawnGaps(1000 / 60, hz))).toBeCloseTo(60, 0);
      expect(fps(drawnGaps(1000 / 30, hz))).toBeCloseTo(30, 0);
    }
  });

  test("draws every refresh uncapped, or capped over the screen's rate", () => {
    expect(fps(drawnGaps(undefined, 120))).toBeCloseTo(120, 0);
    expect(fps(drawnGaps(1000 / 60, 50))).toBeCloseTo(50, 0);
  });

  test("starts over after a stall rather than catching up", () => {
    const cap = new FrameCap();
    cap.intervalMs = 1000 / 60;
    expect(cap.draws(0)).toBe(true);
    expect(cap.draws(500)).toBe(true);
    expect(cap.draws(508.3)).toBe(false);
    expect(cap.draws(516.7)).toBe(true);
  });
});
