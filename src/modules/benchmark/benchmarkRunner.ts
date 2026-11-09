// The loop over an injected target, free of Cesium, Vue and the DOM (ADR 0016).

import type { BenchmarkScene } from "@/modules/util/gpSource";

import { buildPlan, type BenchmarkStep, type PlanSpec, type SweepStep } from "./benchmarkPlan";
import type { MeteredRecording } from "./frameMeter";

/** What the app built, which can differ from the request: a name can match two entries, and no cone without a swath. */
export interface SceneApplied {
  /** Drawn, which can differ from the count asked for. */
  satellitesVisible: number;
  /** The components the app has on. */
  componentsDrawn: string[];
  /** Visible satellites drawing each component, by name. */
  componentInstances: Record<string, number>;
  /** Read from the app, not the step: the app can refuse the clock. */
  clockMultiplier: number;
  /** Cesium's entities, once built. */
  entities: number;
  /** Cesium's top-level primitives, once built. */
  primitives: number;
  /** Teardown of the previous scene, so a build never starts from a diff. */
  clearMs: number;
  /** Wall time to a complete scene: the build, or for a link everything active drawn. */
  buildMs: number;
  /** A link still loading when the wait gave up, measured anyway. */
  timedOut?: boolean;
}

/** How long a step settles and records. */
export interface MeasureOptions {
  /** Settling, unrecorded: shader compiles and uploads after a build. */
  warmupMs: number;
  /** Recorded, after the warmup. */
  sampleMs: number;
  /** Cuts both short. */
  signal: AbortSignal;
  /** As the warmup ends. */
  onRecording?(): void;
}

/** Where the run going stands, updated in place. */
export interface RunProgress {
  /** Names the loading phase and the count. */
  kind: BenchmarkRun["kind"];
  /** The current step's, from 0. */
  index: number;
  /** Steps planned, the repeat included. */
  total: number;
  /** Loading covers the target's preparation too. */
  phase: "loading" | "settling" | "measuring";
  /** `performance.now()` as the step began. */
  stepStartedAt: number;
  /** The run's, for the panel's estimate of what is left. */
  options: BenchmarkOptions;
}

/** A step's recorded frames, its frame budget and its memory. */
export interface StepMeasurement extends MeteredRecording {
  /** The frame budget: a frame that takes longer is over budget. */
  refreshMs: number;
  /** Null where the browser does not say. */
  memoryMb: number | null;
}

/**
 * Absolute memory, garbage excluded, from `performance.measureUserAgentSpecificMemory()`:
 * Chromium only, needs cross-origin isolation, and resolves only at a GC (14-19 s).
 */
export interface FootprintSample {
  /** JavaScript, DOM and shared memory, across every scope. */
  totalMb: number;
  /** This window's JavaScript; within 0.2% of a forced collection. */
  jsMb: number;
  /** Worker scopes' JavaScript. Only `totalMb` includes it, so moving work into a worker raises the total. */
  workerMb: number;
}

/** What the runner drives: the Cesium app, or a fake in the tests. */
export interface BenchmarkTarget {
  /** `app_` and `device_` properties, read once prepared. */
  environment(): Record<string, string | number | boolean>;
  /** The environment's display figures, read as the run ends. */
  displayEnvironment(): Record<string, number>;
  /** Once per run, before the first step. */
  prepare(options: BenchmarkOptions, steps: readonly BenchmarkStep[]): Promise<void>;
  /** Satellites a sweep can draw. */
  catalogSize(): number;
  /** Resolves once the step's scene is complete. */
  apply(step: BenchmarkStep, signal: AbortSignal): Promise<SceneApplied>;
  /** Settles for `warmupMs`, then records for `sampleMs`. */
  measure(step: BenchmarkStep, options: MeasureOptions): Promise<StepMeasurement>;
  /** Called with the scene still up; undefined where the browser cannot answer. */
  measureFootprint(): Promise<FootprintSample | undefined>;
  /** Puts back what `prepare` changed, after a throw too. */
  restore(): Promise<void>;
}

/** How long each step settles and records. */
export interface BenchmarkOptions {
  /** Unrecorded. */
  warmupMs: number;
  /** Recorded. */
  sampleMs: number;
  /** Off by default: each capture waits ~17 s, see `FootprintSample`. */
  captureFootprint?: boolean;
  /** Unset means the whole loaded catalog. */
  tag?: string;
}

/** Measured over six calls: 14, 16, 19, 16, 18 and 19 s. A wait for GC, so it does not scale with the scene. */
export const FOOTPRINT_CAPTURE_MS = 17_000;

/** A sweep's: the warmup outlasts a build's shader compiles, the sample several trajectory refreshes. */
export const DEFAULT_OPTIONS: BenchmarkOptions = { warmupMs: 2000, sampleMs: 4000 };

/** A scene's, as the native app's: 3 s for tiles, models and shader caches to settle, 5 s measured. */
export const SCENE_OPTIONS: BenchmarkOptions = { warmupMs: 3000, sampleMs: 5000 };

/** A measured step. */
export interface BenchmarkResult<S extends BenchmarkStep = SweepStep> extends StepMeasurement {
  step: S;
  /** What the app built for the step. */
  applied: SceneApplied;
  /** Only with `captureFootprint`, where the browser answered. */
  footprint: FootprintSample | undefined;
}

/** What a run measures: the preset's benchmark scenes, or a sweep's steps. */
export type RunKind = "scenes" | "sweep";

/** One pass over a list of steps, filled in place as it goes. */
export interface BenchmarkRun<S extends BenchmarkStep = SweepStep> {
  kind: RunKind;
  /** Once the target is prepared. */
  startedAtIso: string;
  /** A sweep's, so the panel shows one started from the console. */
  spec?: PlanSpec;
  /** A scene run's, as they were served: the report carries them. */
  scenes?: readonly BenchmarkScene[];
  /** Every step planned, the repeat included: drift needs to know none was cut. */
  steps: readonly S[];
  /** `steps.length`. */
  planned: number;
  /** `app_` and `device_` properties; the display's join them as the run ends. */
  environment: Record<string, string | number | boolean>;
  options: BenchmarkOptions;
  /** Satellites a sweep could draw. */
  catalogSize: number;
  /** In the order measured; a cancelled run keeps those before the cut. */
  results: BenchmarkResult<S>[];
  /** Cut short, the cut step's sample dropped. */
  cancelled: boolean;
}

/** How the panel and the console follow a run. */
export interface RunnerHooks {
  /** A line for the console. */
  onLog?(message: string): void;
  /** Before each step. */
  onProgress?(progress: { done: number; total: number; step: BenchmarkStep }): void;
  /** After each measured step. */
  onResult?(result: BenchmarkResult<BenchmarkStep>, run: BenchmarkRun<BenchmarkStep>): void;
}

/** One run at a time, keeping the last. */
export class BenchmarkRunner {
  readonly #target: BenchmarkTarget;

  /** Set while a run goes. */
  #abort: AbortController | undefined;

  /** The run going. */
  #current: BenchmarkRun<BenchmarkStep> | undefined;

  /** The last run that ended, cancelled or not. */
  #last: BenchmarkRun<BenchmarkStep> | undefined;

  /** The run going's. */
  #progress: RunProgress | undefined;

  constructor(target: BenchmarkTarget) {
    this.#target = target;
  }

  /** From the call to `start`, so also while the target prepares. */
  get running(): boolean {
    return this.#abort !== undefined;
  }

  /** Undefined between runs. */
  get progress(): RunProgress | undefined {
    return this.#progress;
  }

  /** The run going, else the last. */
  get run(): BenchmarkRun<BenchmarkStep> | undefined {
    return this.#current ?? this.#last;
  }

  /** The current step's sample is dropped. */
  cancel(): void {
    this.#abort?.abort();
  }

  /** Plans `spec` and runs it. */
  sweep(spec: PlanSpec, options: BenchmarkOptions = DEFAULT_OPTIONS, hooks: RunnerHooks = {}): Promise<BenchmarkRun<SweepStep>> {
    return this.start(buildPlan(spec), options, hooks, { kind: "sweep", spec });
  }

  /** Throws while another run goes. */
  async start<S extends BenchmarkStep>(
    steps: readonly S[],
    options: BenchmarkOptions,
    hooks: RunnerHooks = {},
    describe: Pick<BenchmarkRun<S>, "kind" | "spec" | "scenes"> = { kind: "sweep" },
  ): Promise<BenchmarkRun<S>> {
    if (this.#abort) {
      throw new Error("A benchmark is already running");
    }
    const abort = new AbortController();
    this.#abort = abort;
    const progress: RunProgress = { kind: describe.kind, index: 0, total: steps.length, phase: "loading", stepStartedAt: performance.now(), options };
    this.#progress = progress;

    let run: BenchmarkRun<S> | undefined;
    try {
      await this.#target.prepare(options, steps);
      run = {
        ...describe,
        startedAtIso: new Date().toISOString(),
        steps,
        planned: steps.length,
        environment: this.#target.environment(),
        options,
        catalogSize: this.#target.catalogSize(),
        results: [],
        cancelled: false,
      };
      this.#current = run as BenchmarkRun<BenchmarkStep>;
      hooks.onLog?.(`${steps.length} steps over a catalog of ${run.catalogSize} satellites`);

      for (const step of steps) {
        if (abort.signal.aborted) {
          run.cancelled = true;
          break;
        }
        hooks.onProgress?.({ done: run.results.length, total: steps.length, step });
        Object.assign(progress, { index: run.results.length, phase: "loading", stepStartedAt: performance.now() });
        // eslint-disable-next-line no-await-in-loop
        const applied = await this.#target.apply(step, abort.signal);
        progress.phase = "settling";
        // eslint-disable-next-line no-await-in-loop
        const measurement = await this.#target.measure(step, {
          ...options,
          signal: abort.signal,
          onRecording: () => {
            progress.phase = "measuring";
          },
        });
        if (abort.signal.aborted) {
          // Drop the cut-short sample.
          run.cancelled = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const footprint = options.captureFootprint ? await this.#target.measureFootprint() : undefined;
        const result: BenchmarkResult<S> = { step, applied, ...measurement, footprint };
        run.results.push(result);
        hooks.onResult?.(result as BenchmarkResult<BenchmarkStep>, run as BenchmarkRun<BenchmarkStep>);
      }
      Object.assign(run.environment, this.#target.displayEnvironment());
    } finally {
      await this.#target.restore();
      this.#last = (run as BenchmarkRun<BenchmarkStep> | undefined) ?? this.#last;
      this.#current = undefined;
      this.#abort = undefined;
      this.#progress = undefined;
    }
    hooks.onLog?.(run.cancelled ? `cancelled after ${run.results.length} steps` : `finished ${run.results.length} steps`);
    return run;
  }
}
