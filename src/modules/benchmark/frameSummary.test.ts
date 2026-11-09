import { describe, expect, test } from "vitest";

import { type FrameRecording, overBudgetPct, percentile, summarize } from "./frameSummary";

const recording = (fields: Partial<FrameRecording>): FrameRecording => ({ intervals: [], cpu: [], gpu: [], skippedCpu: [], ...fields });
const HZ60 = 1000 / 60;

describe("summarize", () => {
  // Ninety frames on the 60 Hz pace and ten that missed it twice over.
  test("summarises an uneven recording", () => {
    const summary = summarize(recording({ intervals: [...Array.from({ length: 90 }, () => 16.7), ...Array.from({ length: 10 }, () => 50.1)], cpu: [1, 3], gpu: [8, 10] }), HZ60);
    expect(summary.frames).toBe(100);
    expect(summary.fps).toBeCloseTo(100 / 2.004, 6);
    expect([summary.cpuMs, summary.gpuMs, summary.cpuP95Ms, summary.gpuP95Ms, summary.overBudgetPct]).toEqual([2, 9, 3, 10, 0]);
  });

  // The web times the GPU on some frames only, so each side's share counts on its own.
  test("counts the larger side's share of frames over budget", () => {
    expect(overBudgetPct([4, 20, 4, 4], [], HZ60)).toBe(25);
    expect(overBudgetPct([4, 4], [20, 4, 4, 4, 4], HZ60)).toBe(20);
    // At 30 fps a frame may take two refreshes.
    expect(overBudgetPct([20, 20], [20], 1000 / 30)).toBe(0);
    expect(overBudgetPct([], [20], HZ60)).toBeNull();
  });

  test("counts every thread's CPU time against the recording, in percent of one core", () => {
    expect(summarize(recording({ cpu: [4, 4], durationMs: 200, totalCpuMs: 50 }), HZ60).cpuTotalPct).toBe(25);
    expect(summarize(recording({ cpu: [4, 4], durationMs: 200 }), HZ60).cpuTotalPct).toBeNull();
  });

  test("reads nothing from no frames", () => {
    expect(summarize(recording({}), HZ60)).toEqual({
      frames: 0,
      fps: null,
      cpuMs: null,
      gpuMs: null,
      cpuP95Ms: null,
      gpuP95Ms: null,
      overBudgetPct: null,
      cpuBusyPct: null,
      gpuBusyPct: null,
      loadPct: null,
      cpuTotalPct: null,
    });
  });

  // The CPU's busy time counts the calls that drew nothing; load is the busier side's.
  test("measures the load of the busier side, only when both sides are known", () => {
    const summary = summarize(recording({ intervals: [100, 100], cpu: [30, 30, 20], gpu: [5, 5, 5], skippedCpu: [10, 10], durationMs: 500, gpuActiveMs: 15 }), HZ60);
    expect(summary.cpuBusyPct).toBeCloseTo(20, 9);
    expect(summary.gpuBusyPct).toBeCloseTo(3, 9);
    expect(summary.loadPct).toBe(summary.cpuBusyPct);
    // Safari's GPU reads nothing, which leaves load unknown rather than the CPU's.
    const cpuOnly = summarize(recording({ cpu: [10], durationMs: 100 }), HZ60);
    expect([cpuOnly.cpuBusyPct, cpuOnly.gpuBusyPct, cpuOnly.loadPct]).toEqual([10, null, null]);
  });

  // Idle, the GPU runs at a lowered clock: its times are kept but count against nothing.
  test("leaves an idle recording's GPU time out of the budget and load", () => {
    const idle = { intervals: [250, 300], cpu: [3, 3, 3], gpu: [28, 29, 27], durationMs: 600, gpuActiveMs: 84 };
    const busy = summarize(recording(idle), HZ60);
    const summary = summarize(recording({ ...idle, idle: true }), HZ60);
    expect(busy.overBudgetPct).toBe(100);
    expect(busy.loadPct).toBeCloseTo(14, 9);
    expect([summary.gpuMs, summary.overBudgetPct, summary.loadPct]).toEqual([28, 0, 1.5]);
    expect(summary.gpuBusyPct).toBeCloseTo(14, 9);
  });
});

test("percentile takes the nearest rank", () => {
  expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
  expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
  expect(percentile([4, 1, 3, 2], 0)).toBe(1);
  expect(percentile([], 0.5)).toBeNull();
});
