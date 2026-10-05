// The Cesium-bound target: scene requests become reconciles, the render loop becomes frame samples.

import type { JulianDate } from "@cesium/engine";

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import type { CesiumController } from "../CesiumController";
import type { DesiredScene } from "../SatelliteManager";
import type { BenchmarkTarget, FootprintSample, MeasureOptions, SceneApplied, SceneRequest } from "./benchmarkRunner";
import { FrameSampler, type FrameSample } from "./frameSampler";

declare global {
  /** `performance.measureUserAgentSpecificMemory()` is not in the dom lib (not Baseline). */
  interface MemoryMeasurement {
    bytes: number;
    breakdown: Array<{ bytes: number; types: string[]; attribution: Array<{ url: string; scope: string }> }>;
  }

  interface Performance {
    measureUserAgentSpecificMemory?: () => Promise<MemoryMeasurement>;
    // Chrome only. Not bucketed: eight consecutive reads gave eight distinct
    // values, with or without --enable-precise-memory-info. See FrameSample.heap.
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }
}

/** About 2 s at 60 fps. */
const LIVE_WINDOW_FRAMES = 120;

const BYTES_PER_MB = 1024 * 1024;

/** A result is usually a frame or two away; give up after ~1 s rather than leak. */
const GPU_QUERY_POLL_MS = 4;
const GPU_QUERY_MAX_POLLS = 250;

export interface LiveSnapshot {
  frames: FrameSample;
  satellitesVisible: number;
  componentsDrawn: string[];
  clockMultiplier: number;
  entities: number;
  primitives: number;
}

export interface TargetOptions {
  /** Unset means the whole loaded catalog. */
  tag?: string;
  /** Switches pass prediction on for every satellite: a large cost unrelated to drawing. */
  groundStation?: { lat: number; lon: number };
}

/**
 * Lets in-flight sample-window top-ups become collectable. One scene read 550 MB
 * at +6 s and 544 MB at +16 s, against 1044 and 1295 MB with the clock running.
 */
const FOOTPRINT_QUIESCE_MS = 6000;

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** A hidden tab suspends rAF, so the timeout keeps a backgrounded sweep from wedging. */
const nextFrames = (count: number, timeoutMs = 1000): Promise<void> =>
  new Promise((resolve) => {
    let remaining = count;
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        done();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

/** The sampler and epoch current when the query started. See `#endGpuQuery`. */
interface GpuTarget {
  sampler: FrameSampler;
  epoch: number;
}

/**
 * The API needs cross-origin isolation (`COOP: same-origin`, `COEP: credentialless`),
 * a property of how the page is served rather than of the browser.
 */
export const canMeasureFootprint = (): boolean => window.crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === "function";

/** On its own context, so Cesium's is not touched. */
function gpuName(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch {
    return "unknown";
  }
}

export class CesiumBenchmarkTarget implements BenchmarkTarget {
  readonly #cc: CesiumController;

  readonly #live = new FrameSampler(LIVE_WINDOW_FRAMES);

  #sweep: FrameSampler | undefined;

  #preUpdateAt = 0;

  /** The clock tick that preceded the frame being rendered. */
  #tickMs = 0;

  /** `EXT_disjoint_timer_query_webgl2`. */
  #timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | undefined;

  #gl: WebGL2RenderingContext | undefined;

  /** At most one in flight: one per frame would queue hundreds and force a flush on each. */
  #queryInFlight: { query: WebGLQuery; targets: GpuTarget[] } | undefined;

  options: TargetOptions = {};

  /** State before the first prepare(), held until restore() so a run that throws still restores it. */
  #saved: { requestRenderMode: boolean; shouldAnimate: boolean; multiplier: number; scene: DesiredScene } | undefined;

  constructor(cc: CesiumController) {
    this.#cc = cc;
    const { scene } = cc.viewer;
    // Cesium runs position updates in clock onTick, before preUpdate, so `cpu`
    // excludes them on purpose; see README.
    this.#initGpuTimer(scene);
    this.#instrumentClockTick();
    scene.preUpdate.addEventListener(() => {
      this.#preUpdateAt = performance.now();
      this.#beginGpuQuery();
    });
    scene.postRender.addEventListener(() => {
      const now = performance.now();
      const cpuMs = now - this.#preUpdateAt;
      this.#live.push(now, cpuMs, this.#tickMs);
      this.#sweep?.push(now, cpuMs, this.#tickMs);
      // After the timing marks, so the read does not inflate them.
      const bytes = performance.memory?.usedJSHeapSize;
      if (bytes !== undefined) {
        const mb = bytes / BYTES_PER_MB;
        this.#live.pushHeap(mb);
        this.#sweep?.pushHeap(mb);
      }
      this.#endGpuQuery();
    });
  }

  /** On ANGLE/Metal it returned several frame intervals per frame, so the report gates it. */
  #initGpuTimer(scene: object): void {
    try {
      // `context` is Cesium-internal, but it is the context the app draws with.
      const gl = (scene as { context?: { _gl?: WebGL2RenderingContext } }).context?._gl;
      const ext = gl?.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (gl && ext) {
        this.#gl = gl;
        this.#timerExt = ext;
      }
    } catch {
      // The GPU timer is optional.
    }
  }

  #beginGpuQuery(): void {
    const gl = this.#gl;
    const ext = this.#timerExt;
    if (!gl || !ext || this.#queryInFlight) {
      return;
    }
    try {
      const query = gl.createQuery();
      if (!query) {
        return;
      }
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const targets: GpuTarget[] = [{ sampler: this.#live, epoch: this.#live.epoch }];
      if (this.#sweep) {
        targets.push({ sampler: this.#sweep, epoch: this.#sweep.epoch });
      }
      this.#queryInFlight = { query, targets };
    } catch {
      this.#timerExt = undefined;
    }
  }

  #endGpuQuery(): void {
    const gl = this.#gl;
    const ext = this.#timerExt;
    const pending = this.#queryInFlight;
    if (!gl || !ext || !pending) {
      return;
    }
    const { query, targets } = pending;
    this.#queryInFlight = undefined;
    try {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
    } catch {
      gl.deleteQuery(query);
      this.#timerExt = undefined;
      return;
    }
    // Poll, and deliver only to the samplers and epochs the query started under.
    // Delivering to whatever was open on arrival leaked warmup frames and the
    // previous step: a 0-satellite step after a 5,000 one read 24 ms.
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      try {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          // A disjoint means the GPU was interrupted and the timing is invalid.
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
            for (const target of targets) {
              if (target.sampler.epoch === target.epoch) {
                target.sampler.pushGpu(ns / 1e6);
              }
            }
          }
          gl.deleteQuery(query);
          return;
        }
        if (attempts > GPU_QUERY_MAX_POLLS) {
          gl.deleteQuery(query);
          return;
        }
        setTimeout(poll, GPU_QUERY_POLL_MS);
      } catch {
        this.#timerExt = undefined;
      }
    };
    setTimeout(poll, GPU_QUERY_POLL_MS);
  }

  get gpuTimingAvailable(): boolean {
    return this.#timerExt !== undefined;
  }

  /** Sampled continuously, sweep or not. */
  live(): LiveSnapshot {
    return {
      frames: this.#live.snapshot(),
      satellitesVisible: this.#cc.sats.visibleSatellites.length,
      componentsDrawn: this.#cc.sats.enabledComponents,
      clockMultiplier: this.#cc.viewer.clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
    };
  }

  environment(): Record<string, string | number> {
    const { canvas } = this.#cc.viewer.scene;
    return {
      build: `${__BUILD_SHA__} ${__BUILD_DATE__}`,
      mode: import.meta.env.DEV ? "dev (unminified — numbers are pessimistic)" : "production build",
      userAgent: navigator.userAgent,
      gpu: gpuName(),
      canvas: `${canvas.width}x${canvas.height}`,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      // A hidden tab presents no frames, which invalidates the run.
      visibility: document.visibilityState,
      crossOriginIsolated: String(window.crossOriginIsolated),
    };
  }

  /**
   * Wraps `clock.tick` instead of adding an `onTick` listener: Cesium raises
   * listeners in registration order, and the ones that matter are registered
   * before this target exists, so a listener would miss them.
   */
  #instrumentClockTick(): void {
    const { clock } = this.#cc.viewer;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = clock.tick;
    if ((original as { __benchmarkWrapped?: boolean }).__benchmarkWrapped) {
      return;
    }
    const wrapped = (): JulianDate => {
      const started = performance.now();
      try {
        return original.call(clock);
      } finally {
        this.#tickMs = performance.now() - started;
      }
    };
    (wrapped as { __benchmarkWrapped?: boolean }).__benchmarkWrapped = true;
    clock.tick = wrapped;
  }

  async prepare(): Promise<void> {
    const { clock } = this.#cc.viewer;
    const cesiumStore = useCesiumStore();
    this.#saved ??= { requestRenderMode: cesiumStore.requestRenderMode, shouldAnimate: clock.shouldAnimate, multiplier: clock.multiplier, scene: this.#storeScene() };
    // requestRenderMode skips idle frames, and a stopped clock skips position
    // updates; either would measure idleness. Set through the store so the Render
    // menu's switch follows.
    cesiumStore.requestRenderMode = false;
    clock.shouldAnimate = true;
    // Otherwise the sweep measures group downloads.
    await this.#cc.sats.catalog.ensureAll();
  }

  catalogSize(): number {
    return this.#names().length;
  }

  async apply(request: SceneRequest): Promise<SceneApplied> {
    const names = this.#names().slice(0, request.satelliteCount);
    const { clock } = this.#cc.viewer;

    // Real time during the build, or `buildMs` would carry propagation at ×1000.
    clock.multiplier = 1;

    const clearStart = performance.now();
    this.#cc.sats.reconcile(this.#scene([], []));
    const clearMs = performance.now() - clearStart;
    await nextFrames(2);

    // Satellites are built to a per-frame budget (SatelliteManager.#build), so
    // reconcile returns early; `buildMs` waits for the complete scene.
    const buildStart = performance.now();
    this.#cc.sats.reconcile(this.#scene(names, request.components));
    await this.#cc.sats.buildSettled();
    const buildMs = performance.now() - buildStart;
    await nextFrames(2);

    // Only now, so the warmup absorbs the first refreshes at the new rate.
    clock.multiplier = request.clockMultiplier;

    const satellites = this.#cc.sats.visibleSatellites;
    const componentInstances: Record<string, number> = {};
    for (const satellite of satellites) {
      for (const component of satellite.componentNames) {
        componentInstances[component] = (componentInstances[component] ?? 0) + 1;
      }
    }
    return {
      satellitesRequested: request.satelliteCount,
      satellitesVisible: satellites.length,
      componentsRequested: [...request.components],
      componentsDrawn: this.#cc.sats.enabledComponents,
      componentInstances,
      clockMultiplier: clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
      clearMs,
      buildMs,
    };
  }

  async measure(options: MeasureOptions): Promise<FrameSample> {
    const sampler = new FrameSampler();
    this.#sweep = sampler;
    try {
      await wait(options.warmupMs, options.signal);
      // Drop the warmup's shader compiles and buffer uploads.
      sampler.reset();
      await wait(options.sampleMs, options.signal);
      return sampler.snapshot();
    } finally {
      this.#sweep = undefined;
    }
  }

  /**
   * `jsMb` is the `JavaScript`/`Window` entry, comparable with the heap figures;
   * the total adds DOM and workers (427 vs 297 MB at 5,000 satellites).
   */
  async measureFootprint(): Promise<FootprintSample | undefined> {
    const measure = performance.measureUserAgentSpecificMemory;
    if (!canMeasureFootprint() || !measure) {
      return undefined;
    }
    const startedAt = performance.now();
    // Stop the clock first, or the reading measures propagation churn. One scene
    // at 5,000 satellites with orbits, seconds apart:
    //
    //     clock running   1044 MB total (worker 557)   then 1295 MB (window 1106)
    //     clock stopped    550 MB total (worker  51)   then  544 MB (window  357)
    //
    // Safe only here, after the sample window has closed.
    const clock = this.#cc.viewer.clock;
    const wasAnimating = clock.shouldAnimate;
    clock.shouldAnimate = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, FOOTPRINT_QUIESCE_MS));
      const result = await measure.call(performance);
      const js = result.breakdown.find((entry) => entry.types.includes("JavaScript") && entry.attribution.some((item) => item.scope === "Window"));
      const workerBytes = result.breakdown.filter((entry) => entry.attribution.some((item) => (item.scope ?? "").includes("Worker"))).reduce((sum, entry) => sum + entry.bytes, 0);
      return {
        totalMb: result.bytes / BYTES_PER_MB,
        jsMb: (js?.bytes ?? result.bytes) / BYTES_PER_MB,
        workerMb: workerBytes / BYTES_PER_MB,
        elapsedMs: performance.now() - startedAt,
      };
    } catch {
      // A refusal costs the row its footprint, not the sweep.
      return undefined;
    } finally {
      clock.shouldAnimate = wasAnimating;
    }
  }

  async restore(): Promise<void> {
    const saved = this.#saved;
    if (!saved) {
      return;
    }
    const { clock } = this.#cc.viewer;
    useCesiumStore().requestRenderMode = saved.requestRenderMode;
    clock.shouldAnimate = saved.shouldAnimate;
    clock.multiplier = saved.multiplier;
    // The sweep bypassed the store, so sceneSync's watcher will not fire.
    this.#cc.sats.reconcile(this.#storeScene());
    this.#saved = undefined;
    await nextFrames(1);
  }

  /** Sorted, so "the first 500" is stable across runs; deduplicated because activation matches by name. */
  #names(): string[] {
    const entries = this.options.tag ? this.#cc.sats.catalog.entriesWithTag(this.options.tag) : this.#cc.sats.catalog.entries;
    // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
    return [...new Set(entries.map((entry) => entry.name))].sort();
  }

  #scene(enabledSatellites: string[], components: readonly string[]): DesiredScene {
    const station = this.options.groundStation;
    return {
      enabledTags: [],
      enabledSatellites,
      disabledSatellites: [],
      components: [...components],
      groundStations: station ? [{ lat: station.lat, lon: station.lon, name: "Benchmark" }] : [],
      overpassMode: "elevation",
      trackedSatellite: "",
    };
  }

  #storeScene(): DesiredScene {
    const store = useSatStore();
    return {
      enabledTags: [...store.enabledTags],
      enabledSatellites: [...store.enabledSatellites],
      disabledSatellites: [...store.disabledSatellites],
      components: [...store.enabledComponents],
      groundStations: store.groundStations.map((station) => ({ ...station })),
      overpassMode: store.overpassMode,
      trackedSatellite: store.trackedSatellite,
    };
  }
}
