// Frame timing collection, free of Cesium and the DOM: the caller pushes timestamps in.

/** Below 30 fps a frame is felt rather than merely measured. */
export const JANK_MS = 1000 / 30;

export interface SeriesStats {
  count: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Percentiles over a copy, so the caller's array keeps its arrival order. */
export function seriesStats(values: readonly number[]): SeriesStats | undefined {
  if (values.length === 0) {
    return undefined;
  }
  // The spread is the copy the rule asks for; toSorted is past the ES2022 lib.
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] as number;
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    mean: sum / values.length,
    min: sorted[0] as number,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] as number,
  };
}

export interface FrameSample {
  frames: number;
  elapsedMs: number;
  fps: number;
  /** Time between consecutive presented frames; this is where a vsync ceiling shows. */
  wall: SeriesStats | undefined;
  /**
   * Cesium's preUpdate to postRender. Cesium runs the clock and every `onTick`
   * listener before `preUpdate`, so propagation is in `tick`, not here.
   */
  cpu: SeriesStats | undefined;
  /**
   * All of `clock.tick()`, every `onTick` listener included, so it grows with the
   * clock multiplier. At 5,000 satellites as points it held 460 ms of a frame
   * whose `cpu` read 1.2 ms.
   */
  tick: SeriesStats | undefined;
  /**
   * From `EXT_disjoint_timer_query_webgl2`; undefined without it. Its own
   * population: results arrive frames late and only some frames are queried.
   * Drivers can lie, so the report gates it against the frame interval.
   */
  gpu: SeriesStats | undefined;
  /**
   * `usedJSHeapSize` in MB, once per frame; undefined outside Chrome. It counts
   * uncollected garbage, so a single reading means nothing (86 vs 462 MB on two
   * passes over one scene).
   *
   * - `min` is not the live set: the zero-satellite step read 59, 436 and 270 MB
   *   against a live set of 39.5 MB. Differences down one sweep's column cancel
   *   the offset to about 1%.
   * - `max - min` is the allocation rate, and repeats: 13 MB at 0 satellites,
   *   24 MB at 1,000, 31 MB at 5,000.
   *
   * An absolute figure needs a forced GC (DevTools, or `HeapProfiler.collectGarbage` over CDP).
   */
  heap: SeriesStats | undefined;
  jankFrames: number;
  jankRatio: number;
}

/**
 * Frame timings, bounded to the last `limit` frames (0 = unbounded). Stores
 * deltas, so a paused tab shows up as one huge frame.
 */
export class FrameSampler {
  readonly #limit: number;

  #wall: number[] = [];

  #cpu: number[] = [];

  #tick: number[] = [];

  #gpu: number[] = [];

  #heap: number[] = [];

  #last: number | undefined;

  #epoch = 0;

  constructor(limit = 0) {
    this.#limit = limit;
  }

  /** Separate from `push`: a query resolves frames after the frame it timed, or never. */
  pushGpu(ms: number): void {
    this.#gpu.push(ms);
    if (this.#limit > 0 && this.#gpu.length > this.#limit) {
      this.#gpu.shift();
    }
  }

  /** In MB. Separate from `push` because only Chrome has a reading. */
  pushHeap(mb: number): void {
    this.#heap.push(mb);
    if (this.#limit > 0 && this.#heap.length > this.#limit) {
      this.#heap.shift();
    }
  }

  /** `now` is monotonic; `tickMs` is the clock tick that preceded this render. */
  push(now: number, cpuMs?: number, tickMs?: number): void {
    const previous = this.#last;
    this.#last = now;
    if (previous === undefined) {
      // The first push only sets the origin.
      return;
    }
    this.#wall.push(now - previous);
    if (cpuMs !== undefined) {
      this.#cpu.push(cpuMs);
    }
    if (tickMs !== undefined) {
      this.#tick.push(tickMs);
    }
    if (this.#limit > 0 && this.#wall.length > this.#limit) {
      this.#wall.shift();
      this.#cpu.shift();
      this.#tick.shift();
    }
  }

  /** Keeps the origin, so discarding the warmup loses no frame at the seam. */
  reset(): void {
    this.#wall = [];
    this.#cpu = [];
    this.#tick = [];
    this.#gpu = [];
    this.#heap = [];
    this.#epoch += 1;
  }

  /**
   * Bumped by every `reset`. A GPU query issued during the warmup resolves after
   * it; without this check, shader compiles leak into the sample.
   */
  get epoch(): number {
    return this.#epoch;
  }

  get frames(): number {
    return this.#wall.length;
  }

  snapshot(): FrameSample {
    const wall = seriesStats(this.#wall);
    const elapsedMs = this.#wall.reduce((total, value) => total + value, 0);
    const jankFrames = this.#wall.filter((value) => value > JANK_MS).length;
    return {
      frames: this.#wall.length,
      elapsedMs,
      fps: elapsedMs > 0 ? (this.#wall.length / elapsedMs) * 1000 : 0,
      wall,
      cpu: seriesStats(this.#cpu),
      tick: seriesStats(this.#tick),
      gpu: seriesStats(this.#gpu),
      heap: seriesStats(this.#heap),
      jankFrames,
      jankRatio: this.#wall.length > 0 ? jankFrames / this.#wall.length : 0,
    };
  }
}
