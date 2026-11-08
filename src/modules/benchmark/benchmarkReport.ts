// A scene run's report (ADR 0016): one flat set of properties for PostHog's insights. The
// native app's BenchmarkReport writes the same keys.

import type { BenchmarkScene } from "@/modules/util/gpSource";

import type { SceneStep } from "./benchmarkPlan";
import type { BenchmarkRun, StepMeasurement } from "./benchmarkRunner";
import { type FrameSummary, mean, summarize } from "./frameSummary";
import { driftPct } from "./report";

/** 7 and before: the native app alone, its scenes in its code. */
export const BENCHMARK_REPORT_VERSION = 8;

/** Where a memory figure comes from; the apps' do not compare. */
export type MemorySource = "phys_footprint" | "js_heap";

/** A measured scene step, as both apps report it. */
export interface SceneResult {
  /** `<id>_repeat` for the drift check. */
  id: string;
  /** Visible, as the app built them. */
  satellites: number;
  /** From opening the link to everything active drawn. */
  loadSeconds: number;
  /** The load wait gave up; measured anyway. */
  timedOut: boolean;
  /**
   * Paced, the frames more than two refreshes apart (`FrameRecording.idle`): the GPU's time
   * read at its lowered clock, over budget and load the CPU's alone.
   */
  idle: boolean;
  /** The recorded sample's. */
  summary: FrameSummary;
  /** Null where the platform does not say. */
  memoryMb: number | null;
  /** Null with `memoryMb`. */
  memorySource: MemorySource | null;
  /** This platform's own figures, sent as `x_<name>`; they compare with nothing on the other. */
  extras: Record<string, number | null>;
}

/** To `places` decimals, as the report sends them. */
const rounded = (value: number | null, places = 2): number | null => (value === null ? null : Number(value.toFixed(places)));

/** Under the names both apps send. */
export function sceneMetrics(result: SceneResult): Record<string, unknown> {
  const { summary } = result;
  return {
    satellites: result.satellites,
    load_s: rounded(result.loadSeconds, 1),
    timed_out: result.timedOut,
    idle: result.idle,
    frames: summary.frames,
    fps: rounded(summary.fps, 1),
    cpu_ms: rounded(summary.cpuMs),
    gpu_ms: rounded(summary.gpuMs),
    cpu_p95_ms: rounded(summary.cpuP95Ms),
    gpu_p95_ms: rounded(summary.gpuP95Ms),
    over_budget_pct: rounded(summary.overBudgetPct, 1),
    // Load's floor where the GPU's side is unknown, as in Safari; the GPU's alone adds nothing to load.
    cpu_busy_pct: rounded(summary.cpuBusyPct, 1),
    load_pct: rounded(summary.loadPct, 1),
    cpu_total_pct: rounded(summary.cpuTotalPct, 1),
    memory_mb: result.memoryMb === null ? null : Math.round(result.memoryMb),
    memory_source: result.memorySource,
    ...Object.fromEntries(Object.entries(result.extras).map(([name, value]) => [`x_${name}`, rounded(value)])),
  };
}

/** Only once all `planned` steps were measured. */
export function driftSteps(results: readonly SceneResult[], planned: number): [SceneResult, SceneResult] | undefined {
  const [first] = results;
  const repeated = results.at(-1);
  return results.length === planned && first && repeated?.id.endsWith("_repeat") ? [first, repeated] : undefined;
}

/** Percent of CPU time; a device that warmed up and slowed reads positive. */
export function drift(results: readonly SceneResult[], planned: number): number | null {
  const steps = driftSteps(results, planned);
  const first = steps?.[0].summary.cpuMs;
  const repeated = steps?.[1].summary.cpuMs;
  return first && repeated !== null && repeated !== undefined ? driftPct(first, repeated) : null;
}

/** What either app's run gives the report. */
export interface ReportInput {
  /** Sent as `benchmark_platform`. */
  platform: "web" | "ios";
  /** `app_` and `device_` properties: what the figures depend on beyond the app. */
  environment: Record<string, unknown>;
  /** As they were served; the report defines only those measured. */
  scenes: readonly BenchmarkScene[];
  /** In the order run, the repeat last. */
  results: readonly SceneResult[];
  /** The repeat included. */
  planned: number;
  /** Cut short: kept to read, never sent, as its drift check is missing. */
  cancelled: boolean;
}

/** `benchmark_` properties for the run, then `scene_<id>_<metric>` for each step measured. */
export function reportProperties({ platform, environment, scenes, results, planned, cancelled }: ReportInput): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...environment,
    benchmark_version: BENCHMARK_REPORT_VERSION,
    benchmark_platform: platform,
    benchmark_scenes: results.map(({ id }) => id),
    benchmark_definitions: scenes
      .filter(({ id }) => results.some((result) => result.id === id || result.id === `${id}_repeat`))
      .map(({ id, name, route, query, paced }) => ({ id, name, route, query, paced })),
    ...(cancelled && { benchmark_cancelled: true }),
  };
  const runDrift = drift(results, planned);
  if (runDrift !== null) {
    properties.benchmark_drift_pct = rounded(runDrift, 1);
  }
  for (const result of results) {
    for (const [metric, value] of Object.entries(sceneMetrics(result))) {
      properties[`scene_${result.id}_${metric}`] = value;
    }
  }
  return properties;
}

/** The web run's steps in the report's shape; its memory is the JS heap. */
export function sceneResults(run: BenchmarkRun<SceneStep>): SceneResult[] {
  return run.results.map((result) => ({
    id: result.step.id,
    satellites: result.applied.satellitesVisible,
    loadSeconds: result.applied.buildMs / 1000,
    timedOut: result.applied.timedOut ?? false,
    idle: result.recording.idle ?? false,
    summary: summarize(result.recording, result.refreshMs),
    memoryMb: result.memoryMb,
    memorySource: result.memoryMb === null ? null : "js_heap",
    extras: { ...cpuSplit(result), gpu_capped_pct: result.gpuCappedPct },
  }));
}

/** The frames' CPU time split into `clock.tick()`, propagation and entity updates, and the render. */
export function cpuSplit({ recording, tickMs }: StepMeasurement): { tick_ms: number | null; render_ms: number | null } {
  const tick = mean(tickMs);
  const cpu = mean(recording.cpu);
  return { tick_ms: tick, render_ms: cpu === null ? null : cpu - (tick ?? 0) };
}

/** The web scene run's report. */
export function sceneRunProperties(run: BenchmarkRun<SceneStep>): Record<string, unknown> {
  return reportProperties({ platform: "web", environment: run.environment, scenes: run.scenes ?? [], results: sceneResults(run), planned: run.planned, cancelled: run.cancelled });
}
