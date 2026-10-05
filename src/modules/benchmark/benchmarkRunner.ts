// The sweep loop over an injected target, free of Cesium, Vue and the DOM.

import { buildPlan, type BenchmarkStep, type PlanSpec } from "./benchmarkPlan";
import type { FrameSample } from "./frameSampler";

export interface SceneRequest {
  satelliteCount: number;
  components: readonly string[];
  clockMultiplier: number;
}

/**
 * What the app built, which can differ from the request: a name can match two
 * catalog entries, and a component exists only where it applies (no cone without
 * a swath, no model without a model url).
 */
export interface SceneApplied {
  satellitesRequested: number;
  satellitesVisible: number;
  componentsRequested: string[];
  componentsDrawn: string[];
  componentInstances: Record<string, number>;
  /** Read from the app, not the step: the app can refuse the clock. */
  clockMultiplier: number;
  entities: number;
  primitives: number;
  /** Teardown of the previous scene, so a build never starts from a diff. */
  clearMs: number;
  /** Wall time of the synchronous build, instantiation plus components. */
  buildMs: number;
}

export interface MeasureOptions {
  warmupMs: number;
  sampleMs: number;
  signal: AbortSignal;
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
  elapsedMs: number;
}

export interface BenchmarkTarget {
  environment(): Record<string, string | number>;
  /** Once per run, before the first step. */
  prepare(): Promise<void>;
  catalogSize(): number;
  apply(request: SceneRequest): Promise<SceneApplied>;
  measure(options: MeasureOptions): Promise<FrameSample>;
  /** Undefined where the browser cannot answer. Called after the sample window, with the scene still up. */
  measureFootprint(): Promise<FootprintSample | undefined>;
  restore(): Promise<void>;
}

export interface BenchmarkOptions {
  warmupMs: number;
  sampleMs: number;
  /** Off by default: each capture waits ~17 s, see `FootprintSample`. */
  captureFootprint?: boolean;
}

/** Measured over six calls: 14, 16, 19, 16, 18 and 19 s. A wait for GC, so it does not scale with the scene. */
export const FOOTPRINT_CAPTURE_MS = 17_000;

/**
 * The warmup must outlast the shader compiles and uploads after a build, and the
 * sample must span several trajectory refreshes, or the row swings.
 */
export const DEFAULT_OPTIONS: BenchmarkOptions = { warmupMs: 2000, sampleMs: 4000 };

export interface BenchmarkResult {
  step: BenchmarkStep;
  applied: SceneApplied;
  frames: FrameSample;
  footprint: FootprintSample | undefined;
}

export interface BenchmarkRun {
  startedAtIso: string;
  /** Lets the panel show a sweep started from the console. */
  spec: PlanSpec;
  environment: Record<string, string | number>;
  options: BenchmarkOptions;
  catalogSize: number;
  results: BenchmarkResult[];
  cancelled: boolean;
}

export interface RunnerHooks {
  onLog?(message: string): void;
  onProgress?(progress: { done: number; total: number; step: BenchmarkStep }): void;
  onResult?(result: BenchmarkResult, run: BenchmarkRun): void;
}

export class BenchmarkRunner {
  readonly #target: BenchmarkTarget;

  #abort: AbortController | undefined;

  #current: BenchmarkRun | undefined;

  constructor(target: BenchmarkTarget) {
    this.#target = target;
  }

  get running(): boolean {
    return this.#current !== undefined;
  }

  /** The run in progress, or the last one to finish. */
  get run(): BenchmarkRun | undefined {
    return this.#current ?? this.#last;
  }

  #last: BenchmarkRun | undefined;

  cancel(): void {
    this.#abort?.abort();
  }

  async start(spec: PlanSpec, options: BenchmarkOptions = DEFAULT_OPTIONS, hooks: RunnerHooks = {}): Promise<BenchmarkRun> {
    if (this.#current) {
      throw new Error("A benchmark is already running");
    }
    const abort = new AbortController();
    this.#abort = abort;

    await this.#target.prepare();
    const steps = buildPlan(spec);
    const run: BenchmarkRun = {
      startedAtIso: new Date().toISOString(),
      spec,
      environment: this.#target.environment(),
      options,
      catalogSize: this.#target.catalogSize(),
      results: [],
      cancelled: false,
    };
    this.#current = run;
    hooks.onLog?.(`${steps.length} steps over a catalog of ${run.catalogSize} satellites`);

    try {
      for (const step of steps) {
        if (abort.signal.aborted) {
          run.cancelled = true;
          break;
        }
        hooks.onProgress?.({ done: run.results.length, total: steps.length, step });
        // eslint-disable-next-line no-await-in-loop
        const applied = await this.#target.apply({ satelliteCount: step.satelliteCount, components: step.components, clockMultiplier: step.clockMultiplier });
        // eslint-disable-next-line no-await-in-loop
        const frames = await this.#target.measure({ ...options, signal: abort.signal });
        if (abort.signal.aborted) {
          // Drop the cut-short sample.
          run.cancelled = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const footprint = options.captureFootprint ? await this.#target.measureFootprint() : undefined;
        const result: BenchmarkResult = { step, applied, frames, footprint };
        run.results.push(result);
        hooks.onResult?.(result, run);
      }
    } finally {
      await this.#target.restore();
      this.#last = run;
      this.#current = undefined;
      this.#abort = undefined;
    }
    hooks.onLog?.(run.cancelled ? `cancelled after ${run.results.length} steps` : `finished ${run.results.length} steps`);
    return run;
  }
}
