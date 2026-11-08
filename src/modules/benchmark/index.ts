// The `window.bench` console handle, shared with the panel.

import { usePostHog } from "@/composables/usePostHog";
import { presetPath, resolvePreset } from "@/config/presets";
import type { CesiumController } from "@/modules/CesiumController";
import { foreignParams } from "@/modules/util/urlSync";
import { router } from "@/router";

import { buildPlan, estimateDurationMs, NAMED_SWEEPS, planScenes, type PlanSpec, type SceneStep, type SweepStep } from "./benchmarkPlan";
import { sceneRunProperties } from "./benchmarkReport";
import { BenchmarkRunner, DEFAULT_OPTIONS, FOOTPRINT_CAPTURE_MS, SCENE_OPTIONS, type BenchmarkOptions, type BenchmarkRun, type RunnerHooks } from "./benchmarkRunner";
import { SCENE_STEP_ESTIMATE_MS } from "./benchmarkStatus";
import { CesiumBenchmarkTarget, canMeasureFootprint, keptParams } from "./cesiumBenchmarkTarget";
import { logRun, toCsv, toJson, formatTable } from "./report";
import { sweepRunOf } from "./sweepResults";

export * from "./benchmarkPlan";
export * from "./benchmarkReport";
export * from "./benchmarkStatus";
export * from "./benchmarkRunner";
export * from "./cesiumBenchmarkTarget";
export * from "./sweepResults";
export * from "./frameSummary";
export * from "./report";

/** A named sweep's axes and options, each in place of the default. */
export type RunOverrides = Partial<PlanSpec> & Partial<BenchmarkOptions>;

/** What `bench.scenes` takes. */
export interface SceneRunOptions {
  /** Scene ids to run, without the drift repeat; all of them by default. */
  only?: readonly string[];
  /** The console's log by default. */
  hooks?: RunnerHooks;
}

/** The console's `window.bench`. */
export interface BenchmarkHandle {
  readonly target: CesiumBenchmarkTarget;
  /** Shared with the panel, which shows its runs. */
  readonly runner: BenchmarkRunner;
  /**
   * The route's benchmark scenes (ADR 0016), the report they make. Scenes served for another
   * route continue there, with `bench=run`, and this never resolves.
   */
  scenes(options?: SceneRunOptions): Promise<Record<string, unknown>>;
  /** The last scene run's report, as `scenes` resolved it. */
  readonly report: Record<string, unknown> | undefined;
  /** Sends the last scene run's report where usage is counted; false where it is not. */
  send(): boolean;
  /** Isolated component sets over the default counts. */
  run(overrides?: RunOverrides): Promise<BenchmarkRun<SweepStep>>;
  /** Components added one by one over the default counts. */
  cumulative(overrides?: RunOverrides): Promise<BenchmarkRun<SweepStep>>;
  /** A harness sanity check over three counts. */
  quick(overrides?: RunOverrides): Promise<BenchmarkRun<SweepStep>>;
  /** The propagation axis: one component set across four clock rates. */
  clock(overrides?: RunOverrides): Promise<BenchmarkRun<SweepStep>>;
  /** The run going, sweep or scenes. */
  cancel(): void;
  /** Returns the stop function. */
  watch(intervalMs?: number): () => void;
  /** The last sweep's tables, to the console. */
  log(): void;
  /** The last sweep's rows. */
  csv(): string;
  /** The last sweep's report, as both apps export it. */
  json(): string;
  /** The last sweep's table, for pasting into an issue. */
  text(): string;
}

/** Once installed. */
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

  async function start(defaults: PlanSpec, overrides: RunOverrides = {}): Promise<BenchmarkRun<SweepStep>> {
    const { satelliteCounts, componentSets, clockMultipliers, repeatFirstStep, warmupMs, sampleMs, ...extras } = overrides;
    const spec: PlanSpec = {
      satelliteCounts: satelliteCounts ?? defaults.satelliteCounts,
      componentSets: componentSets ?? defaults.componentSets,
      clockMultipliers: clockMultipliers ?? defaults.clockMultipliers,
      repeatFirstStep: repeatFirstStep ?? defaults.repeatFirstStep,
    };
    const options: BenchmarkOptions = { warmupMs: warmupMs ?? DEFAULT_OPTIONS.warmupMs, sampleMs: sampleMs ?? DEFAULT_OPTIONS.sampleMs, ...extras };
    if (options.captureFootprint && !canMeasureFootprint()) {
      console.warn(
        "[bench] captureFootprint was asked for but performance.measureUserAgentSpecificMemory is not available — the page is not cross-origin isolated. " +
          "Serve it with COOP: same-origin and COEP: credentialless. Carrying on without footprints.",
      );
    }
    const steps = buildPlan(spec);
    const seconds = Math.round(estimateDurationMs(steps, options.warmupMs + options.sampleMs, options.captureFootprint ? FOOTPRINT_CAPTURE_MS : 0) / 1000);
    console.log(`[bench] ${steps.length} steps, roughly ${Math.floor(seconds / 60)}m${seconds % 60}s. Leave the tab in the foreground — a background tab is throttled.`);
    const run = await runner.sweep(spec, options, hooks);
    logRun(sweepRunOf(run));
    return run;
  }

  let report: Record<string, unknown> | undefined;

  async function scenes({ only = [], hooks: sceneHooks = hooks }: SceneRunOptions = {}): Promise<Record<string, unknown>> {
    const preset = await resolvePreset(router.currentRoute.value.path);
    const served = preset.benchmarkScenes;
    const route = served[0]?.route;
    if (route === undefined) {
      throw new Error(`The ${preset.name} preset has no benchmark scenes`);
    }
    if (route !== presetPath(preset.name)) {
      // The url sync reads a route's preset defaults only at startup, so another route's
      // scenes run after a page load into it.
      const current = router.currentRoute.value.query;
      const query = { ...foreignParams(current), ...keptParams(current), bench: "run", ...(only.length > 0 && { benchscenes: only.join(",") }) };
      window.location.assign(router.resolve({ path: route, query }).href);
      return new Promise(() => {});
    }
    const unknown = only.filter((id) => !served.some((scene) => scene.id === id));
    if (unknown.length > 0) {
      console.warn(`[bench] no scene ${unknown.join(", ")}; served: ${served.map(({ id }) => id).join(", ")}`);
    }
    const steps = planScenes(served, only);
    if (steps.length === 0) {
      throw new Error(`No scene matches ${only.join(", ")}`);
    }
    console.log(`[bench] ${steps.length} scenes, roughly ${Math.round((steps.length * SCENE_STEP_ESTIMATE_MS) / 1000)} s. Keep the tab in the foreground.`);
    const run = await runner.start(steps, SCENE_OPTIONS, sceneHooks, { kind: "scenes", scenes: served });
    report = sceneRunProperties(run as BenchmarkRun<SceneStep>);
    console.log("[bench] report", JSON.stringify(report, null, 2));
    return report;
  }

  const requireRun = (): BenchmarkRun<SweepStep> => {
    const run = runner.run;
    if (!run) {
      throw new Error("No benchmark has been run yet");
    }
    if (run.kind !== "sweep") {
      throw new Error("The last run ran scenes: read `bench.report`");
    }
    return run as BenchmarkRun<SweepStep>;
  };

  handle = {
    target,
    runner,
    scenes,
    get report() {
      return report;
    },
    send() {
      const { posthog } = usePostHog();
      // Initialised only on satvis.space with a project key (usePostHog.ts).
      if (!report || report.benchmark_cancelled === true || !(posthog as { __loaded?: boolean }).__loaded) {
        return false;
      }
      posthog.capture("benchmark", report);
      return true;
    },
    run: (overrides) => start(NAMED_SWEEPS.run, overrides),
    cumulative: (overrides) => start(NAMED_SWEEPS.cumulative, overrides),
    quick: (overrides) => start(NAMED_SWEEPS.quick, overrides),
    clock: (overrides) => start(NAMED_SWEEPS.clock, overrides),
    cancel: () => runner.cancel(),
    watch(intervalMs = 2000) {
      target.meter.acquire("watch");
      const timer = setInterval(() => {
        const live = target.meter.stats;
        if (!live) {
          return;
        }
        const ms = (value: number | null): string => (value === null ? "  n/a" : value.toFixed(2).padStart(6));
        console.log(
          `[bench] ${(live.fps ?? 0).toFixed(1).padStart(5)} fps${live.paced ? " (paced)" : ""} · cpu ${ms(live.cpuMs)} ms · gpu ${ms(live.gpuMs)} ms ·`,
          `load ${live.loadPct === null ? `≥${(live.cpuBusyPct ?? 0).toFixed(0)}` : live.loadPct.toFixed(0)}% · ${String(live.satellites).padStart(5)} sats · heap ${live.memoryMb === null ? "n/a" : `${live.memoryMb.toFixed(0)} MB`}`,
        );
      }, intervalMs);
      return () => {
        clearInterval(timer);
        target.meter.release("watch");
      };
    },
    log: () => logRun(sweepRunOf(requireRun())),
    csv: () => toCsv(sweepRunOf(requireRun())),
    json: () => toJson(sweepRunOf(requireRun())),
    text: () => formatTable(sweepRunOf(requireRun())),
  };

  (window as unknown as { bench?: BenchmarkHandle }).bench = handle;
  console.log(
    "[bench] ready — `bench.scenes()`, then `bench.report`; sweeps `bench.quick()`, `bench.run()`, `bench.cumulative()`, `bench.clock()`; `bench.watch()`. See src/modules/benchmark/README.md.",
  );
  return handle;
}
