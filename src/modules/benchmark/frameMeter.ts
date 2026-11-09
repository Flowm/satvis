// What every frame costs (ADR 0016): CPU time around Cesium's whole frame (`CesiumWidget.render`:
// the clock tick, then `Scene.render`), GPU time from the timer query where the driver has one.

import type { Viewer } from "@cesium/widgets";

import { type FrameRate } from "@/config/rendering";
import { workerTimeMs } from "@/modules/util/workerTime";

import { type FrameRecording, type FrameSummary, mean, percentile, sum, summarize } from "./frameSummary";

/** As the native app's panel. */
const PUBLISH_MS = 500;
/** How far back `frames` reaches: the frame-time graph's width. */
export const GRAPH_WINDOW_MS = 5000;
/** How often a GPU timer query is asked for its answer. */
const GPU_QUERY_POLL_MS = 4;
/** About a second; an answer later than that is dropped. */
const GPU_QUERY_MAX_POLLS = 250;
/** The figures' MB are MiB. */
const BYTES_PER_MB = 1024 * 1024;
/**
 * The share of gaps the display's interval must hold (`displayIntervalMs`). Safari's late frames
 * leave catch-up gaps of 5 to 14 ms: over the iPad mini's own gaps a fifth read 60 Hz as up to 89,
 * half 59.6 to 60.2 or nothing.
 */
const DISPLAY_SHARE = 0.5;
/** How far the gaps of a single refresh spread, as a ratio. */
const DISPLAY_CLUSTER = 1.25;
/**
 * The ratio either side of the cluster's median that is averaged: centred, as Safari's whole
 * milliseconds split 16.7 into 16s and 17s, and a window from the shortest read 66 Hz.
 */
const DISPLAY_WINDOW = 1.2;
/**
 * The display is measured again this often while shown, the shortest reading standing: Safari on
 * an iPad mini building a scene draws 18 to 24 ms apart, unaligned to the refresh, for 20 s and
 * more, and readings at 5 s and 20 s alone read its 60 Hz as 48 to 55.
 */
const DISPLAY_REMEASURE_MS = 10_000;

/** A drawn frame, as the graph plots it. */
export interface MeteredFrame {
  /** `performance.now()` as its work ended. */
  at: number;
  /** Cesium's whole frame, the clock tick included. */
  cpuMs: number;
  /** Arrives a few milliseconds after the frame, when the driver answers. */
  gpuMs?: number;
  /**
   * Paced, more than two display intervals after the frame before: its GPU time is at the
   * lowered clock (`FrameRecording.idle`), so the graph keeps it out of the budget.
   */
  idle: boolean;
}

/** Over at least the last half second, to a drawn frame. */
export interface LiveFrameStats extends FrameSummary {
  /** Chrome's JS heap, garbage included; null elsewhere. */
  memoryMb: number | null;
  /** Visible. */
  satellites: number;
  /** Frames drawn only on change, so fps is low by design and load is the cost. */
  paced: boolean;
  /** The share of GPU times capped at the frame interval (`gpuCapMs`), in percent; null with none timed. */
  gpuCappedPct: number | null;
  /** GPU time left out of load (`FrameRecording.idle`). */
  idle: boolean;
}

/** A step's frames, as the meter recorded them. */
export interface MeteredRecording {
  /** GPU times capped at `gpuCapMs`. */
  recording: FrameRecording;
  /** `clock.tick()` of each drawn frame: propagation and entity updates. */
  tickMs: number[];
  /**
   * The heap twice a second, where Chrome reports it. It counts uncollected garbage: two
   * passes over one scene read 86 and 462 MB, and the zero-satellite step 59 to 436 MB
   * against a live set of 39.5 MB. Differences down one sweep's column cancel to about 1%.
   */
  heapMb: number[];
  /**
   * The share of GPU times capped at the median interval (`gpuCapMs`), in percent: above 0 the
   * GPU was saturated, and its time reads the interval, short of the work. Null with none timed.
   */
  gpuCappedPct: number | null;
}

/** One stretch's frames: the window being published, or a step's recording. */
interface Recorder {
  /** `performance.now()` at the start. */
  started: number;
  /** `workerTimeMs()` at the start. */
  workerMs: number;
  /** `performance.now()` as the last drawn frame ended. */
  lastDrawn: number | undefined;
  /** Between drawn frames. */
  intervals: number[];
  /** Of each drawn frame. */
  cpu: number[];
  /** `clock.tick()` of each drawn frame. */
  tick: number[];
  /** As the driver answers, uncapped. */
  gpu: number[];
  /** Of each call that drew nothing. */
  skippedCpu: number[];
  /** Sampled as each window is published. */
  heap: number[];
}

/** Starting at `now`. */
const newRecorder = (now: number): Recorder => ({
  started: now,
  workerMs: workerTimeMs(),
  lastDrawn: undefined,
  intervals: [],
  cpu: [],
  tick: [],
  gpu: [],
  skippedCpu: [],
  heap: [],
});

/** Chrome's JS heap, garbage included; undefined elsewhere. */
const heapMb = (): number | undefined => {
  const bytes = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return bytes === undefined ? undefined : bytes / BYTES_PER_MB;
};

/**
 * The most GPU time a frame can have cost: where the mean outruns the median frame interval,
 * the GPU is saturated, and ANGLE/Metal's timer counts each frame's wait in the queue too
 * (37 ms for 19 ms of work). Keeping pace, a frame cost at most an interval.
 */
export function gpuCapMs(gpu: readonly number[], intervals: readonly number[]): number {
  const median = percentile(intervals, 0.5);
  return median !== null && (mean(gpu) ?? 0) > median ? median : Number.POSITIVE_INFINITY;
}

/** The share of `gpu` that `gpuCapMs` caps, in percent; null with no GPU time. */
export function gpuCappedPct(gpu: readonly number[], intervals: readonly number[]): number | null {
  const cap = gpuCapMs(gpu, intervals);
  return gpu.length === 0 ? null : (gpu.filter((ms) => ms > cap).length / gpu.length) * 100;
}

/**
 * The display's refresh interval from the gaps between animation frames: the shortest gaps,
 * `DISPLAY_CLUSTER` apart, that hold `DISPLAY_SHARE` of them, averaged within `DISPLAY_WINDOW` of
 * their median. Not the median of all: a page still loading skips refreshes, and that read 25 to
 * 28 ms on a 60 Hz iPad. Gaps under 3 ms, a stall's catch-up, are left out.
 */
export function displayIntervalMs(gaps: readonly number[]): number | undefined {
  // eslint-disable-next-line unicorn/no-array-sort -- the filter is the copy
  const real = gaps.filter((gap) => gap >= 3).sort((a, b) => a - b);
  const needed = Math.max(2, real.length * DISPLAY_SHARE);
  for (const shortest of real) {
    const cluster = real.filter((gap) => gap >= shortest && gap <= shortest * DISPLAY_CLUSTER);
    const middle = percentile(cluster, 0.5);
    if (cluster.length >= needed && middle !== null) {
      return mean(real.filter((gap) => gap >= middle / DISPLAY_WINDOW && gap <= middle * DISPLAY_WINDOW)) ?? undefined;
    }
  }
  return undefined;
}

/** Measures only while acquired, so a visitor with neither panel open pays nothing. */
export class FrameMeter {
  readonly #viewer: Viewer;
  /** The visible satellites' count. */
  readonly #satellites: () => number;
  /** Measuring while any remain. */
  readonly #users = new Set<string>();
  /** Set while installed. */
  #uninstall: (() => void) | undefined;

  /** Set by `postRender`, which Cesium raises only for a frame it drew. */
  #drew = false;
  /** The current frame's `clock.tick()`. */
  #tickMs = 0;
  /** The drawn frames of the last `GRAPH_WINDOW_MS`. */
  #frames: MeteredFrame[] = [];
  /** The half second being summed for `stats`. */
  #window: Recorder;
  /** The last window's summary. */
  #published: LiveFrameStats | undefined;
  /** A step's, while one records. */
  #recorder: Recorder | undefined;
  /** From the gaps between animation frames. */
  #displayMs: number | undefined;
  /** A measurement of the display in flight. */
  #measuringDisplay = false;
  /** Cesium's context, where it has the timer extension. */
  #gl: WebGL2RenderingContext | undefined;
  /** The timer extension; dropped once a query throws. */
  #timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | undefined;
  /** At most one in flight: one per frame would queue hundreds and force a flush on each. */
  #query: { query: WebGLQuery } | undefined;

  constructor(viewer: Viewer, satellites: () => number) {
    this.#viewer = viewer;
    this.#satellites = satellites;
    this.#window = newRecorder(performance.now());
  }

  /** Undefined while no one has acquired the meter. */
  get stats(): LiveFrameStats | undefined {
    return this.#users.size > 0 ? this.#published : undefined;
  }

  /** The last `GRAPH_WINDOW_MS`, oldest first. */
  get frames(): readonly MeteredFrame[] {
    return this.#frames;
  }

  /** The frame budget: what `rate` asks for, never shorter than the display's, as the native app's. */
  refreshMs(rate: FrameRate): number {
    const display = this.#displayMs ?? 1000 / 60;
    return rate === "max" ? display : Math.max(1000 / Number(rate), display);
  }

  /** The first user installs the meter. */
  acquire(user: string): void {
    this.#users.add(user);
    if (!this.#uninstall) {
      this.#install();
    }
  }

  /** The last user uninstalls it, dropping its frames. */
  release(user: string): void {
    this.#users.delete(user);
    if (this.#users.size === 0 && this.#uninstall) {
      this.#uninstall();
      this.#uninstall = undefined;
      this.#published = undefined;
      this.#frames = [];
    }
  }

  /** Holds the meter until `stopRecording`. */
  startRecording(): void {
    this.acquire("recording");
    this.#recorder = newRecorder(performance.now());
  }

  /** An empty recording where none was started. */
  stopRecording(): MeteredRecording {
    const recorder = this.#recorder ?? newRecorder(performance.now());
    this.#recorder = undefined;
    this.release("recording");
    return {
      recording: this.#recordingOf(recorder, performance.now()),
      tickMs: recorder.tick,
      heapMb: recorder.heap,
      gpuCappedPct: gpuCappedPct(recorder.gpu, recorder.intervals),
    };
  }

  /** GPU times capped at `gpuCapMs`. */
  #recordingOf(recorder: Recorder, now: number): FrameRecording {
    const cap = gpuCapMs(recorder.gpu, recorder.intervals);
    const gpu = recorder.gpu.map((ms) => Math.min(ms, cap));
    return {
      intervals: recorder.intervals,
      cpu: recorder.cpu,
      gpu,
      skippedCpu: recorder.skippedCpu,
      durationMs: now - recorder.started,
      idle: this.#idle(recorder.intervals),
      totalCpuMs: sum(recorder.cpu) + sum(recorder.skippedCpu) + workerTimeMs() - recorder.workerMs,
      // The timer gives a span's length, not where it lies, so overlap cannot be joined as on
      // iOS, and it times one frame in flight at a time: the mean over every frame drawn.
      ...(gpu.length > 0 && { gpuActiveMs: (mean(gpu) ?? 0) * recorder.cpu.length }),
    };
  }

  /** Wraps the widget's render and the clock's tick, and measures the display. */
  #install(): void {
    const { cesiumWidget: widget, scene, clock } = this.#viewer;
    this.#initGpuTimer();
    this.#measureDisplay();
    const remeasure = setInterval(() => this.#measureDisplay(), DISPLAY_REMEASURE_MS);
    this.#window = newRecorder(performance.now());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- called on the widget below
    const render = widget.render;
    const metered = function (this: FrameMeter): void {
      this.#drew = false;
      this.#tickMs = 0;
      const started = performance.now();
      render.call(widget);
      this.#frame(started, performance.now());
    }.bind(this);
    widget.render = metered;

    // A listener would miss the ones registered with the viewer before this one.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called on the clock below
    const tick = clock.tick;
    clock.tick = () => {
      const started = performance.now();
      try {
        return tick.call(clock);
      } finally {
        this.#tickMs = performance.now() - started;
      }
    };

    // Not preUpdate: Cesium raises it on every call, before it decides whether to draw, and a
    // query begun on a call that draws nothing would time the idle gap to the next drawn frame.
    const removePreRender = scene.preRender.addEventListener(() => this.#beginGpuQuery());
    const removePostRender = scene.postRender.addEventListener(() => {
      this.#drew = true;
    });

    this.#uninstall = () => {
      clearInterval(remeasure);
      // Only where no one wrapped them since; another wrapper keeps calling these.
      if (widget.render === metered) {
        widget.render = render;
      }
      clock.tick = tick;
      removePreRender();
      removePostRender();
      // A query begun on a frame that threw before drawing is still open.
      if (this.#query && this.#gl && this.#timer) {
        try {
          this.#gl.endQuery(this.#timer.TIME_ELAPSED_EXT);
        } catch {
          // Already ended with its context.
        }
        this.#gl.deleteQuery(this.#query.query);
      }
      this.#query = undefined;
    };
  }

  /** Every call to the widget's render, drawn or not. */
  #frame(started: number, ended: number): void {
    const cpuMs = ended - started;
    const recorders = this.#recorder ? [this.#window, this.#recorder] : [this.#window];
    if (!this.#drew) {
      for (const recorder of recorders) {
        recorder.skippedCpu.push(cpuMs);
      }
      // Published only as a frame is drawn, as the native app does: paced, a half second can
      // pass without one, and would read 0 fps with no frame cost.
      return;
    }
    const previous = this.#frames.at(-1)?.at;
    // Frames drawn faster than the display measured: it was measured while refreshes were skipped.
    if (previous !== undefined && this.#displayMs !== undefined && ended - previous < this.#displayMs * 0.75) {
      this.#measureDisplay();
    }
    const idle = this.#paced() && (previous === undefined || ended - previous > 2 * (this.#displayMs ?? 1000 / 60));
    const frame: MeteredFrame = { at: ended, cpuMs, idle };
    for (const recorder of recorders) {
      if (recorder.lastDrawn !== undefined) {
        recorder.intervals.push(ended - recorder.lastDrawn);
      }
      recorder.lastDrawn = ended;
      recorder.cpu.push(cpuMs);
      recorder.tick.push(this.#tickMs);
    }
    this.#frames.push(frame);
    while (this.#frames.length > 0 && (this.#frames[0] as MeteredFrame).at < ended - GRAPH_WINDOW_MS) {
      this.#frames.shift();
    }
    this.#endGpuQuery(frame, this.#recorder);
    this.#publishIfDue(ended);
  }

  /** Every `PUBLISH_MS`, sampling the heap for a recording. */
  #publishIfDue(now: number): void {
    const window = this.#window;
    const elapsed = now - window.started;
    if (elapsed < PUBLISH_MS) {
      return;
    }
    const heap = heapMb();
    if (this.#recorder && heap !== undefined) {
      this.#recorder.heap.push(heap);
    }
    const recording = this.#recordingOf(window, now);
    this.#published = {
      // No budget: the header shows no share over it.
      ...summarize(recording, Number.POSITIVE_INFINITY),
      memoryMb: heap ?? null,
      satellites: this.#satellites(),
      paced: this.#paced(),
      idle: recording.idle ?? false,
      gpuCappedPct: gpuCappedPct(window.gpu, window.intervals),
    };
    this.#window = { ...newRecorder(now), lastDrawn: window.lastDrawn };
  }

  /** As createViewer.ts draws every frame while tracking, and the native app counts it unpaced. */
  #paced(): boolean {
    const { scene, trackedEntity } = this.#viewer;
    return scene.requestRenderMode && !trackedEntity;
  }

  /** Paced at under half the display's rate: dragging the globe, paced still, draws every frame. */
  #idle(intervals: readonly number[]): boolean {
    return this.#paced() && (mean(intervals) ?? Number.POSITIVE_INFINITY) > 2 * (this.#displayMs ?? 1000 / 60);
  }

  /** Over 60 animation frames, keeping the shortest so far: a display at 120 Hz reads 8.3 ms. */
  #measureDisplay(): void {
    if (this.#measuringDisplay) {
      return;
    }
    this.#measuringDisplay = true;
    const stamps: number[] = [];
    const step = (now: number): void => {
      stamps.push(now);
      if (stamps.length < 61) {
        requestAnimationFrame(step);
        return;
      }
      this.#measuringDisplay = false;
      const measured = displayIntervalMs(stamps.slice(1).map((stamp, i) => stamp - (stamps[i] as number)));
      if (measured !== undefined) {
        this.#displayMs = Math.min(measured, this.#displayMs ?? Number.POSITIVE_INFINITY);
      }
    };
    requestAnimationFrame(step);
  }

  /** Leaves the timer unset where the driver has none. */
  #initGpuTimer(): void {
    try {
      // `context` is Cesium-internal, but it is the context the app draws with.
      const gl = (this.#viewer.scene as unknown as { context?: { _gl?: WebGL2RenderingContext } }).context?._gl;
      const timer = gl?.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null | undefined;
      if (gl && timer) {
        this.#gl = gl;
        this.#timer = timer;
      }
    } catch {
      // The GPU timer is optional: Safari has none.
    }
  }

  /** On `preRender`, which Cesium raises only for a call that draws. */
  #beginGpuQuery(): void {
    const gl = this.#gl;
    const timer = this.#timer;
    if (!gl || !timer || this.#query) {
      return;
    }
    try {
      const query = gl.createQuery();
      if (query) {
        gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        this.#query = { query };
      }
    } catch {
      this.#timer = undefined;
    }
  }

  /**
   * The answer goes to the frame's own recording, as whatever was recording on arrival leaked
   * the previous step's, and to the window open on arrival: a paced window's frames are often
   * answered after it was published.
   */
  #endGpuQuery(frame: MeteredFrame, recording: Recorder | undefined): void {
    const gl = this.#gl;
    const timer = this.#timer;
    const pending = this.#query;
    if (!gl || !timer || !pending) {
      return;
    }
    this.#query = undefined;
    const { query } = pending;
    try {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
    } catch {
      gl.deleteQuery(query);
      this.#timer = undefined;
      return;
    }
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      try {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          // A disjoint means the GPU was interrupted and the timing is invalid.
          if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
            const ms = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
            frame.gpuMs = ms;
            this.#window.gpu.push(ms);
            recording?.gpu.push(ms);
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
        this.#timer = undefined;
      }
    };
    setTimeout(poll, GPU_QUERY_POLL_MS);
  }
}

/** One per viewer. */
const meters = new WeakMap<Viewer, FrameMeter>();

/** Shared by the performance panel and the benchmark. */
export function frameMeterFor(viewer: Viewer, satellites: () => number): FrameMeter {
  let meter = meters.get(viewer);
  if (!meter) {
    meter = new FrameMeter(viewer, satellites);
    meters.set(viewer, meter);
  }
  return meter;
}
