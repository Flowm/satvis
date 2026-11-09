// A benchmark step's comparable core (ADR 0016). The native app's FrameRecording is held
// to it by a parity fixture, so change both together.

import { formatInteger } from "@/modules/util/formats";

/** Every frame over a stretch of time, in milliseconds. */
export interface FrameRecording {
  /** Between drawn frames. */
  intervals: number[];
  /** The main thread's work, the waits for the GPU or the display left out. */
  cpu: number[];
  /** Only the frames the GPU timed. */
  gpu: number[];
  /** The work of each paced call that drew nothing. */
  skippedCpu: number[];
  /** The recording's span, which the busy shares divide by. */
  durationMs?: number;
  /** The GPU's busy time, overlapping spans counted once where the platform tells them apart (`FrameMeter`). */
  gpuActiveMs?: number;
  /** Every thread's; on the web a floor, the frames' and workers' handling, as browsers report no process time. */
  totalCpuMs?: number;
  /**
   * Paced, at under half the display's rate: the GPU clocks down between frames, and timed
   * each 1.7 to 2 times slower than drawn every frame, so GPU time stays out of the budget
   * and load.
   */
  idle?: boolean;
}

/** Null where the recording cannot say; times in milliseconds, shares in percent. */
export interface FrameSummary {
  /** Frame intervals, one fewer than the frames drawn. */
  frames: number;
  /** Over the intervals; low by design when paced. */
  fps: number | null;
  /** Mean CPU time of a drawn frame. */
  cpuMs: number | null;
  /** Mean, over the frames the GPU timed. */
  gpuMs: number | null;
  /** Nearest-rank 95th percentile. */
  cpuP95Ms: number | null;
  /** Nearest-rank 95th percentile. */
  gpuP95Ms: number | null;
  /** The larger side's share of frames over budget; the CPU's alone when idle. */
  overBudgetPct: number | null;
  /** Of the duration, the paced calls that drew nothing included. */
  cpuBusyPct: number | null;
  /** Of the duration, at most 100. */
  gpuBusyPct: number | null;
  /** The busier side's busy share; the CPU's alone when idle. */
  loadPct: number | null;
  /** Of one core, every thread: propagation off the main thread too. */
  cpuTotalPct: number | null;
}

/** Nearest rank, over a copy so the caller's array keeps its order. */
export function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) {
    return null;
  }
  // eslint-disable-next-line unicorn/no-array-sort -- the spread is the copy
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * share) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))] as number;
}

/** 0 for none. */
export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
/** Null for none. */
export const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : sum(values) / values.length);

/** Each side's own share, as the web times the GPU on only some frames. */
export function overBudgetPct(cpu: readonly number[], gpu: readonly number[], budgetMs: number): number | null {
  const share = (values: readonly number[]): number => (values.length === 0 ? 0 : values.filter((value) => value > budgetMs).length / values.length);
  return cpu.length === 0 ? null : Math.max(share(cpu), share(gpu)) * 100;
}

/** `refreshMs` is each frame's budget: at 30 fps, a frame may take two refreshes. */
export function summarize(recording: FrameRecording, refreshMs: number): FrameSummary {
  const { intervals, cpu, gpu, skippedCpu, durationMs, gpuActiveMs, totalCpuMs, idle = false } = recording;
  const total = sum(intervals);
  const duration = durationMs !== undefined && durationMs > 0 ? durationMs : undefined;
  const cpuBusyPct = duration === undefined ? null : ((sum(cpu) + sum(skippedCpu)) / duration) * 100;
  const gpuBusyPct = gpu.length === 0 || gpuActiveMs === undefined || duration === undefined ? null : Math.min((gpuActiveMs / duration) * 100, 100);
  return {
    frames: intervals.length,
    fps: total > 0 ? (intervals.length / total) * 1000 : null,
    cpuMs: mean(cpu),
    gpuMs: mean(gpu),
    cpuP95Ms: percentile(cpu, 0.95),
    gpuP95Ms: percentile(gpu, 0.95),
    overBudgetPct: overBudgetPct(cpu, idle ? [] : gpu, refreshMs),
    cpuBusyPct,
    gpuBusyPct,
    loadPct: idle ? cpuBusyPct : cpuBusyPct === null || gpuBusyPct === null ? null : Math.max(cpuBusyPct, gpuBusyPct),
    cpuTotalPct: totalCpuMs === undefined || duration === undefined ? null : (totalCpuMs / duration) * 100,
  };
}

/** Load in whole percent, or at least the CPU's share where the GPU's is unknown, as in Safari; `unit` follows a figure, not the dash. */
export function formatLoad(loadPct: number | null, cpuBusyPct: number | null, unit = ""): string {
  if (loadPct !== null) {
    return `${formatInteger(loadPct)}${unit}`;
  }
  return cpuBusyPct === null ? "–" : `≥ ${formatInteger(cpuBusyPct)}${unit}`;
}
