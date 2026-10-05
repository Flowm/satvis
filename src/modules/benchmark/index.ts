// The `window.bench` console handle, shared with the panel.

import type { CesiumController } from "../CesiumController";
import {
  CUMULATIVE_COMPONENT_SETS,
  DEFAULT_CLOCK_MULTIPLIERS,
  DEFAULT_SATELLITE_COUNTS,
  ISOLATED_COMPONENT_SETS,
  buildPlan,
  estimateDurationMs,
  formatComponents,
  type PlanSpec,
} from "./benchmarkPlan";
import { BenchmarkRunner, DEFAULT_OPTIONS, FOOTPRINT_CAPTURE_MS, type BenchmarkOptions, type BenchmarkRun, type RunnerHooks } from "./benchmarkRunner";
import { CesiumBenchmarkTarget, canMeasureFootprint, type TargetOptions } from "./cesiumBenchmarkTarget";
import { logRun, toCsv, toJson, formatTable } from "./report";

export * from "./benchmarkPlan";
export * from "./benchmarkRunner";
export * from "./cesiumBenchmarkTarget";
export * from "./framePump";
export * from "./frameSampler";
export * from "./report";

/** A harness sanity check, not a measurement. */
export const QUICK_SATELLITE_COUNTS: readonly number[] = [0, 100, 1000];

/** Orbit is rebuilt on every trajectory window refresh, so a faster clock shows most there. */
export const CLOCK_COMPONENT_SETS: readonly (readonly string[])[] = [["Point", "Orbit"]];

export type RunOverrides = Partial<PlanSpec> & Partial<BenchmarkOptions> & TargetOptions;

export interface BenchmarkHandle {
  readonly target: CesiumBenchmarkTarget;
  readonly runner: BenchmarkRunner;
  /** Isolated component sets over the default counts. */
  run(overrides?: RunOverrides): Promise<BenchmarkRun>;
  cumulative(overrides?: RunOverrides): Promise<BenchmarkRun>;
  quick(overrides?: RunOverrides): Promise<BenchmarkRun>;
  /** The propagation axis: one component set across four clock rates. */
  clock(overrides?: RunOverrides): Promise<BenchmarkRun>;
  cancel(): void;
  /** @returns the stop function. */
  watch(intervalMs?: number): () => void;
  readonly last: BenchmarkRun | undefined;
  log(): void;
  csv(): string;
  json(): string;
  text(): string;
  readonly presets: {
    counts: readonly number[];
    quickCounts: readonly number[];
    clockMultipliers: readonly number[];
    cumulative: readonly (readonly string[])[];
    isolated: readonly (readonly string[])[];
  };
}

let handle: BenchmarkHandle | undefined;

/** Idempotent. Only the panel loads this module, so `window.bench` exists once the panel opens. */
export function installBenchmark(cc: CesiumController): BenchmarkHandle {
  if (handle) {
    return handle;
  }
  const target = new CesiumBenchmarkTarget(cc);
  const runner = new BenchmarkRunner(target);

  const hooks: RunnerHooks = {
    onLog: (message) => console.log(`[bench] ${message}`),
    onProgress: ({ done, total, step }) => console.log(`[bench] ${done + 1}/${total} — ${step.label}`),
  };

  async function start(defaults: PlanSpec, overrides: RunOverrides = {}): Promise<BenchmarkRun> {
    const { satelliteCounts, componentSets, clockMultipliers, repeatFirstStep, warmupMs, sampleMs, captureFootprint, ...targetOptions } = overrides;
    target.options = targetOptions;
    const spec: PlanSpec = {
      satelliteCounts: satelliteCounts ?? defaults.satelliteCounts,
      componentSets: componentSets ?? defaults.componentSets,
      clockMultipliers: clockMultipliers ?? defaults.clockMultipliers,
      repeatFirstStep: repeatFirstStep ?? defaults.repeatFirstStep,
    };
    const options: BenchmarkOptions = { warmupMs: warmupMs ?? DEFAULT_OPTIONS.warmupMs, sampleMs: sampleMs ?? DEFAULT_OPTIONS.sampleMs, captureFootprint };
    if (captureFootprint && !canMeasureFootprint()) {
      console.warn(
        "[bench] captureFootprint was asked for but performance.measureUserAgentSpecificMemory is not available — the page is not cross-origin isolated. " +
          "Serve it with COOP: same-origin and COEP: credentialless. Carrying on without footprints.",
      );
    }
    const steps = buildPlan(spec);
    const seconds = Math.round(estimateDurationMs(steps, options.warmupMs + options.sampleMs, options.captureFootprint ? FOOTPRINT_CAPTURE_MS : 0) / 1000);
    console.log(`[bench] ${steps.length} steps, roughly ${Math.floor(seconds / 60)}m${seconds % 60}s. Leave the tab in the foreground — a background tab is throttled.`);
    const run = await runner.start(spec, options, hooks);
    logRun(run);
    return run;
  }

  const requireRun = (): BenchmarkRun => {
    const run = runner.run;
    if (!run) {
      throw new Error("No benchmark has been run yet");
    }
    return run;
  };

  handle = {
    target,
    runner,
    run: (overrides) => start({ satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: ISOLATED_COMPONENT_SETS }, overrides),
    cumulative: (overrides) => start({ satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: CUMULATIVE_COMPONENT_SETS }, overrides),
    quick: (overrides) => start({ satelliteCounts: QUICK_SATELLITE_COUNTS, componentSets: ISOLATED_COMPONENT_SETS }, overrides),
    clock: (overrides) => start({ satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: CLOCK_COMPONENT_SETS, clockMultipliers: DEFAULT_CLOCK_MULTIPLIERS }, overrides),
    cancel: () => runner.cancel(),
    watch(intervalMs = 2000) {
      const timer = setInterval(() => {
        const live = target.live();
        const { wall, cpu, heap } = live.frames;
        // The min-max gap is uncollected garbage; see FrameSample.heap.
        const heapText = heap === undefined ? "n/a" : `${heap.min.toFixed(0)}–${heap.max.toFixed(0)} MB`;
        console.log(
          `[bench] ${live.frames.fps.toFixed(1).padStart(5)} fps · frame ${(wall?.mean ?? 0).toFixed(2).padStart(6)} ms (p95 ${(wall?.p95 ?? 0).toFixed(2)}) · cpu ${(cpu?.mean ?? 0).toFixed(2).padStart(6)} ms ·`,
          `${String(live.satellitesVisible).padStart(5)} sats · ${formatComponents(live.componentsDrawn)} @ ×${live.clockMultiplier} · ${live.entities} entities · heap ${heapText}`,
        );
      }, intervalMs);
      return () => clearInterval(timer);
    },
    get last() {
      return runner.run;
    },
    log: () => logRun(requireRun()),
    csv: () => toCsv(requireRun()),
    json: () => toJson(requireRun()),
    text: () => formatTable(requireRun()),
    presets: {
      counts: DEFAULT_SATELLITE_COUNTS,
      quickCounts: QUICK_SATELLITE_COUNTS,
      clockMultipliers: DEFAULT_CLOCK_MULTIPLIERS,
      cumulative: CUMULATIVE_COMPONENT_SETS,
      isolated: ISOLATED_COMPONENT_SETS,
    },
  };

  (window as unknown as { bench?: BenchmarkHandle }).bench = handle;
  console.log("[bench] ready — `bench.quick()`, `bench.run()`, `bench.cumulative()`, `bench.clock()`, `bench.watch()`. See src/modules/benchmark/README.md.");
  return handle;
}

export const benchmarkHandle = (): BenchmarkHandle | undefined => handle;
