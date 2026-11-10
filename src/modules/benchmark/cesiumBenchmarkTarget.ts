// The Cesium-bound target: a scene step opens its link, a sweep step reconciles the satellite
// manager directly.

import { nextTick } from "vue";
import type { LocationQuery } from "vue-router";

import type { CesiumController } from "@/modules/CesiumController";
import { EMPTY_SCENE, type DesiredScene } from "@/modules/SatelliteManager";
import { desiredScene } from "@/modules/sceneSync";
import { withoutBenchmarkRun } from "@/modules/util/bookmarks";
import { foreignParams } from "@/modules/util/urlSync";
import { router } from "@/router";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

import { type BenchmarkStep, isSceneStep, type SceneStep, SWEEP_GROUND_STATION, type SweepStep } from "./benchmarkPlan";
import type { BenchmarkOptions, BenchmarkTarget, FootprintSample, MeasureOptions, SceneApplied, StepMeasurement } from "./benchmarkRunner";
import { type FrameMeter, frameMeterFor } from "./frameMeter";

declare global {
  /** `performance.measureUserAgentSpecificMemory()` is not in the dom lib (not Baseline). */
  interface MemoryMeasurement {
    /** Every scope's. */
    bytes: number;
    /** By scope and type. */
    breakdown: Array<{ bytes: number; types: string[]; attribution: Array<{ url: string; scope: string }> }>;
  }

  interface Performance {
    /** Chromium only, and only cross-origin isolated. */
    measureUserAgentSpecificMemory?: () => Promise<MemoryMeasurement>;
    /** Chrome only. Not bucketed: eight consecutive reads gave eight distinct values, with or without --enable-precise-memory-info. */
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }

  interface Navigator {
    /** Chromium only, in GB, rounded down to a power of two. */
    deviceMemory?: number;
  }
}

/** The figures' MB are MiB. */
const BYTES_PER_MB = 1024 * 1024;

/** Lets in-flight sample-window top-ups become collectable: one scene read 550 MB at +6 s, 544 MB at +16 s. */
const FOOTPRINT_QUIESCE_MS = 6000;

/** As the native app: the largest groups come from the worker on a first run. */
const LOAD_TIMEOUT_MS = 90_000;
/** Groups arrive one by one, so a scene is loaded once its count has held this long. */
const LOAD_STEADY_MS = 2000;
/** How often a loading scene's count is read. */
const LOAD_POLL_MS = 250;

/** Graphics settings a scene's link leaves as the user set them, as the native app keeps its pixel ratio. */
const KEPT_PARAMS = ["pixelratio", "framerate", "msaa", "fps"];

/** The graphics settings of `query` that every scene keeps (`KEPT_PARAMS`). */
export function keptParams(query: LocationQuery): LocationQuery {
  return Object.fromEntries(KEPT_PARAMS.flatMap((param) => (query[param] === undefined ? [] : [[param, query[param]]])));
}

/** Resolves early on abort; never rejects. */
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

/** Chrome's JS heap, garbage included; null elsewhere. */
const heapNowMb = (): number | null => {
  const bytes = performance.memory?.usedJSHeapSize;
  return bytes === undefined ? null : bytes / BYTES_PER_MB;
};

/** The web app as the runner drives it. */
export class CesiumBenchmarkTarget implements BenchmarkTarget {
  readonly #cc: CesiumController;

  /** Shared with the performance panel and `bench.watch()`. */
  readonly meter: FrameMeter;

  /** The run's, for its `tag`. */
  #options: BenchmarkOptions | undefined;

  /**
   * State before the first prepare(), held until restore() so a run that throws still
   * restores it: a sweep bypasses the store, a scene run navigates.
   */
  #saved: { requestRenderMode: boolean; shouldAnimate: boolean; multiplier: number; scene: DesiredScene; fullPath: string; swept: boolean } | undefined;

  constructor(cc: CesiumController) {
    this.#cc = cc;
    this.meter = frameMeterFor(cc.viewer, () => cc.sats.visibleSatellites.length);
  }

  /** Under the names both apps send. */
  environment(): Record<string, string | number | boolean> {
    const { canvas } = this.#cc.viewer.scene;
    const store = useCesiumStore();
    return {
      app_version: __BUILD_SHA__,
      app_build_date: __BUILD_DATE__,
      app_build_mode: import.meta.env.DEV ? "dev" : "production",
      app_pixel_ratio: store.pixelRatio,
      app_frame_rate: store.frameRate,
      // The web's alone: the native app has no order-independent translucency.
      app_oit: this.#cc.orderIndependentTranslucency,
      device_user_agent: navigator.userAgent,
      device_gpu: gpuName(),
      device_drawable_pixels: `${canvas.width}x${canvas.height}`,
      device_screen_scale: window.devicePixelRatio,
      device_processor_count: navigator.hardwareConcurrency,
      ...(navigator.deviceMemory !== undefined && { device_memory_gb: navigator.deviceMemory }),
      // A hidden tab presents no frames, which invalidates the run.
      device_visibility: document.visibilityState,
      device_cross_origin_isolated: window.crossOriginIsolated,
    };
  }

  /** Read as the run ends: the meter measures the display only once `prepare` installs it. */
  displayEnvironment(): Record<string, number> {
    return {
      app_frame_budget_ms: Number(this.meter.refreshMs(useCesiumStore().frameRate).toFixed(2)),
      device_max_fps: Math.round(1000 / this.meter.refreshMs("max")),
    };
  }

  /** A sweep also stops pacing, runs the clock and loads the whole catalog. */
  async prepare(options: BenchmarkOptions, steps: readonly BenchmarkStep[]): Promise<void> {
    this.#options = options;
    const { clock } = this.#cc.viewer;
    const cesiumStore = useCesiumStore();
    const swept = steps.some((step) => !isSceneStep(step));
    this.#saved ??= {
      requestRenderMode: cesiumStore.requestRenderMode,
      shouldAnimate: clock.shouldAnimate,
      multiplier: clock.multiplier,
      scene: desiredScene(useSatStore()),
      fullPath: router.currentRoute.value.fullPath,
      swept,
    };
    this.meter.acquire("benchmark");
    if (swept) {
      // A stopped clock skips position updates, which would measure idleness. Set through
      // the store so the Graphics panel's switch follows.
      cesiumStore.requestRenderMode = false;
      clock.shouldAnimate = true;
      // Otherwise the sweep measures group downloads.
      await this.#cc.sats.catalog.ensureAll();
    }
  }

  /** Distinct names, within `tag`. */
  catalogSize(): number {
    return this.#names().length;
  }

  /** A scene step opens its link; a sweep step builds its set. */
  apply(step: BenchmarkStep, signal: AbortSignal): Promise<SceneApplied> {
    return isSceneStep(step) ? this.#open(step, signal) : this.#build(step);
  }

  /** Waits until everything active is drawn and has held. */
  async #open(step: SceneStep, signal: AbortSignal): Promise<SceneApplied> {
    const { scene } = step;
    const current = router.currentRoute.value.query;
    // `bench=true`, never `run`: going back to this link must not start another run.
    const query = { ...foreignParams(current), ...keptParams(current), bench: "true", ...scene.query };
    if (scene.query.time === undefined) {
      // A paused or fast clock stays off `time` for its first minute; a scene without one is live.
      this.#cc.goLive();
    }
    // Paced: measured idle, as outside the benchmark.
    useCesiumStore().requestRenderMode = step.paced;
    const opened = performance.now();
    await router.replace({ path: scene.route, query });
    await nextTick();
    await Promise.race([this.#cc.sats.catalog.ensureTags(useSatStore().enabledTags), wait(LOAD_TIMEOUT_MS, signal)]);

    const sats = this.#cc.sats;
    let steadySince: number | undefined;
    let last = -1;
    let timedOut = false;
    while (!signal.aborted) {
      // eslint-disable-next-line no-await-in-loop
      await wait(LOAD_POLL_MS, signal);
      const now = performance.now();
      const drawn = sats.visibleSatellites.length;
      const complete = !sats.building && drawn === sats.activeSatellites.length && (!this.#cc.skyView.active || this.#cc.skyView.settled);
      // From when it is complete and its count holds, which a scene that completes without a
      // change of count, as the sky view does when its flight lands, starts as well.
      if (!complete || drawn !== last) {
        steadySince = complete ? now : undefined;
      } else {
        steadySince ??= now;
      }
      last = drawn;
      if (steadySince !== undefined && now - steadySince >= LOAD_STEADY_MS) {
        break;
      }
      if (now - opened > LOAD_TIMEOUT_MS) {
        timedOut = true;
        break;
      }
    }
    const loadedMs = performance.now() - opened - (timedOut ? 0 : LOAD_STEADY_MS);
    // No scene measures the info panel: a link opens none, and one opened since would cost its own frames.
    this.#cc.viewer.selectedEntity = undefined;
    return { ...this.#applied(), clearMs: 0, buildMs: Math.max(loadedMs, 0), timedOut };
  }

  /** From a cleared scene at ×1; the step's clock only once built. */
  async #build(step: SweepStep): Promise<SceneApplied> {
    const names = this.#names().slice(0, step.satelliteCount);
    const { clock } = this.#cc.viewer;

    // Real time during the build, or `buildMs` would carry propagation at ×1000.
    clock.multiplier = 1;

    // Clear first, or `buildMs` measures the diff from the previous scene.
    const clearStart = performance.now();
    this.#cc.sats.reconcile(this.#scene([], []));
    const clearMs = performance.now() - clearStart;
    await nextFrames(2);

    // Satellites are built to a per-frame budget (SatelliteManager.#build), so
    // reconcile returns early; `buildMs` waits for the complete scene.
    const buildStart = performance.now();
    this.#cc.sats.reconcile(this.#scene(names, step.components));
    await this.#cc.sats.buildSettled();
    const buildMs = performance.now() - buildStart;
    await nextFrames(2);

    // Only now, so the warmup absorbs the first refreshes at the new rate.
    clock.multiplier = step.clockMultiplier;
    return { ...this.#applied(), clearMs, buildMs };
  }

  /** What the app drew, once a step is built or loaded. */
  #applied(): Omit<SceneApplied, "clearMs" | "buildMs"> {
    const satellites = this.#cc.sats.visibleSatellites;
    const componentInstances: Record<string, number> = {};
    for (const satellite of satellites) {
      for (const component of satellite.componentNames) {
        componentInstances[component] = (componentInstances[component] ?? 0) + 1;
      }
    }
    return {
      satellitesVisible: satellites.length,
      componentsDrawn: this.#cc.sats.enabledComponents,
      componentInstances,
      clockMultiplier: this.#cc.viewer.clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
    };
  }

  /** The memory figure is Chrome's heap as the sample ends. */
  async measure(_step: BenchmarkStep, options: MeasureOptions): Promise<StepMeasurement> {
    await wait(options.warmupMs, options.signal);
    options.onRecording?.();
    this.meter.startRecording();
    await wait(options.sampleMs, options.signal);
    const metered = this.meter.stopRecording();
    const refreshMs = this.meter.refreshMs(useCesiumStore().frameRate);
    return { ...metered, refreshMs, memoryMb: heapNowMb() };
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
    // Stop the clock first, or the reading measures propagation churn. One scene
    // at 5,000 satellites with orbits, seconds apart:
    //
    //     clock running   1044 MB total (worker 557)   then 1295 MB (window 1106)
    //     clock stopped    550 MB total (worker  51)   then  544 MB (window  357)
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
      };
    } catch {
      // A refusal costs the row its footprint, not the sweep.
      return undefined;
    } finally {
      clock.shouldAnimate = wasAnimating;
    }
  }

  /** As the panel closes mid-run: the view put back is then without it. */
  dropPanel(): void {
    if (this.#saved) {
      const { path, query } = router.resolve(this.#saved.fullPath);
      const { bench: _bench, ...rest } = query;
      this.#saved.fullPath = router.resolve({ path, query: rest }).fullPath;
    }
  }

  /** Back to the view `prepare` saved: a sweep's scene, or a scene run's link. */
  async restore(): Promise<void> {
    const saved = this.#saved;
    this.meter.release("benchmark");
    if (!saved) {
      return;
    }
    this.#saved = undefined;
    const { clock } = this.#cc.viewer;
    if (saved.swept) {
      // The sweep bypassed the store, so sceneSync's watcher will not fire.
      this.#cc.sats.reconcile(desiredScene(useSatStore()));
    } else {
      // The user's view, the run's own `bench=run` or `send` and `benchscenes` gone.
      const { path, query } = router.resolve(saved.fullPath);
      const { benchscenes: _scenes, ...rest } = withoutBenchmarkRun(query);
      await router.replace({ path, query: rest });
      await nextTick();
    }
    useCesiumStore().requestRenderMode = saved.requestRenderMode;
    clock.shouldAnimate = saved.shouldAnimate;
    clock.multiplier = saved.multiplier;
    await nextFrames(1);
  }

  /** Sorted, so "the first 500" is stable across runs; deduplicated, as activation matches by name. */
  #names(): string[] {
    const tag = this.#options?.tag;
    const entries = tag ? this.#cc.sats.catalog.entriesWithTag(tag) : this.#cc.sats.catalog.entries;
    // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
    return [...new Set(entries.map((entry) => entry.name))].sort();
  }

  /** A sweep's scene, with a station where it draws links. */
  #scene(enabledSatellites: string[], components: readonly string[]): DesiredScene {
    // Links draw only to a station, and predict every pass of the satellites they show.
    const station = components.includes("Ground station link") ? [{ ...SWEEP_GROUND_STATION, name: "Benchmark" }] : [];
    return { ...EMPTY_SCENE, enabledSatellites, components: [...components], groundStations: station };
  }
}
