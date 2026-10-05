// Pure run-to-tables functions, shared by the console and the panel so they cannot disagree.

import { formatComponents, formatSeries } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun } from "./benchmarkRunner";

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

const blankOr = (value: number | undefined, digits = 2): number | "" => (value === undefined ? "" : round(value, digits));

const cpuMs = (result: BenchmarkResult): number => result.frames.cpu?.mean ?? 0;

const tickMs = (result: BenchmarkResult): number => result.frames.tick?.mean ?? 0;

/**
 * Render plus clock tick: the quantity every fit uses.
 *
 * `cpuMs` alone misses the entity position updates, which Cesium runs in an
 * `onTick` listener; a fit of it had Point holding 60 fps to 1.66 million
 * satellites. `frameMs` is quantised by vsync: at 120 Hz it sat at 8.33 ms from 0
 * to 1,000 points while this sum went 0.64 to 1.21 ms. This sum is continuous:
 * 0.64, 0.96, 1.21, 6.25, 8.95, 11.52 ms over 0 to 5,000 points.
 */
const mainThreadMs = (result: BenchmarkResult): number => cpuMs(result) + tickMs(result);

/**
 * The lowest frame time in the series: GPU work and the vsync wait, which
 * `frameMs` cannot separate. A floor past the budget makes the fit irrelevant.
 */
const floorMs = (results: readonly BenchmarkResult[]): number => Math.min(...results.map((result) => result.frames.wall?.mean ?? Infinity));

/** Not a footprint on its own; see `FrameSample.heap`. */
const heapFloorMb = (result: BenchmarkResult): number | undefined => result.frames.heap?.min;

const heapPeakMb = (result: BenchmarkResult): number | undefined => result.frames.heap?.max;

const footprintJsMb = (result: BenchmarkResult): number | undefined => result.footprint?.jsMb;

const seriesOf = (result: BenchmarkResult): string => formatSeries(result.applied.componentsRequested, result.applied.clockMultiplier);

/** Without the closing repeat, which would weight one scene twice and hide the drift. */
const measured = (run: BenchmarkRun): BenchmarkResult[] => run.results.filter((result) => !result.step.repeat);

/**
 * A frame presenting every 14 ms cannot take 49 ms of GPU time. 1.5× the frame
 * interval leaves room for noise and GPU-bound scenes.
 */
export const GPU_TIMER_TRUST_FACTOR = 1.5;

/** On ANGLE/Metal (Apple silicon) the timer reported ~49 ms per frame at 70 fps. */
export function gpuTimerTrustworthy(run: BenchmarkRun): boolean {
  const pairs = run.results
    .map((result) => ({ gpu: result.frames.gpu?.p50, wall: result.frames.wall?.p50 }))
    .filter((pair): pair is { gpu: number; wall: number } => pair.gpu !== undefined && pair.wall !== undefined && pair.wall > 0);
  if (pairs.length === 0) {
    return false;
  }
  const overruns = pairs.filter((pair) => pair.gpu > pair.wall * GPU_TIMER_TRUST_FACTOR).length;
  // One odd step is noise; a majority overrunning is the driver.
  return overruns * 2 <= pairs.length;
}

export interface ReportRow {
  sats: number;
  components: string;
  /** Multiple of real time. */
  clock: number;
  repeat: boolean;
  /** Blank unless the app drew something other than what was asked for. */
  drawn: string;
  visible: number;
  /** Below MIN_TRUSTWORTHY_FRAMES the row is noise. */
  frames: number;
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  cpuP95Ms: number;
  /** A row where `tickMs` dwarfs `cpuMs` is propagation-bound. */
  tickMs: number;
  /** Blank without the timer extension, or when `gpuTimerTrustworthy` fails. */
  gpuMs: number | "";
  jankPct: number;
  buildMs: number;
  clearMs: number;
  entities: number;
  primitives: number;
  /**
   * The heap floor, an input to `memoryFits` and not a footprint. Csv and json
   * only, never the printed tables. See `FrameSample.heap`.
   */
  heapMb: number | "";
  /** `heapPeakMb - heapMb` is the window's allocation rate. */
  heapPeakMb: number | "";
  /** Absolute JavaScript footprint, garbage excluded; blank unless captured. */
  footprintMb: number | "";
  /** See FootprintSample.workerMb. */
  footprintWorkerMb: number | "";
  /** Includes DOM and worker memory. */
  footprintTotalMb: number | "";
}

export function reportRows(run: BenchmarkRun): ReportRow[] {
  // Once per run: trust in the driver's clock is a property of the machine.
  const trustGpu = gpuTimerTrustworthy(run);
  return run.results.map((result) => {
    const requested = formatComponents(result.applied.componentsRequested);
    const drawn = formatComponents(result.applied.componentsDrawn);
    const gpu = trustGpu ? result.frames.gpu?.mean : undefined;
    return {
      sats: result.applied.satellitesRequested,
      components: requested,
      clock: result.applied.clockMultiplier,
      repeat: result.step.repeat,
      drawn: drawn === requested ? "" : drawn,
      visible: result.applied.satellitesVisible,
      frames: result.frames.frames,
      fps: round(result.frames.fps, 1),
      frameMs: round(result.frames.wall?.mean ?? 0),
      p95Ms: round(result.frames.wall?.p95 ?? 0),
      worstMs: round(result.frames.wall?.max ?? 0),
      cpuMs: round(cpuMs(result)),
      cpuP95Ms: round(result.frames.cpu?.p95 ?? 0),
      tickMs: round(tickMs(result)),
      gpuMs: gpu === undefined ? "" : round(gpu),
      jankPct: round(result.frames.jankRatio * 100, 1),
      buildMs: round(result.applied.buildMs),
      clearMs: round(result.applied.clearMs),
      entities: result.applied.entities,
      primitives: result.applied.primitives,
      heapMb: blankOr(heapFloorMb(result), 1),
      heapPeakMb: blankOr(heapPeakMb(result), 1),
      footprintMb: blankOr(footprintJsMb(result), 1),
      footprintTotalMb: blankOr(result.footprint?.totalMb, 1),
      footprintWorkerMb: blankOr(result.footprint?.workerMb, 1),
    };
  });
}

export interface ScalingFit {
  series: string;
  points: number;
  /** Least-squares slope of `mainThreadMs`. */
  mainMsPer1000: number;
  baseMainMs: number;
  r2: number;
  /** GPU work plus the vsync wait. Read it against 16.7 ms before `satsAt60fps`. */
  floorMs: number;
  /**
   * Where the fit crosses 16.7 ms, assuming the GPU is not the limit (at 5,000
   * points: 11.52 ms main thread, 11.72 ms frame). Blank when the floor is past the budget.
   */
  satsAt60fps: number | "";
}

function leastSquares(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const n = points.length;
  const meanX = points.reduce((total, point) => total + point.x, 0) / n;
  const meanY = points.reduce((total, point) => total + point.y, 0) / n;
  const sxx = points.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  const sxy = points.reduce((total, point) => total + (point.x - meanX) * (point.y - meanY), 0);
  if (sxx === 0) {
    return undefined;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssTot = points.reduce((total, point) => total + (point.y - meanY) ** 2, 0);
  const ssRes = points.reduce((total, point) => total + (point.y - (slope * point.x + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

const FRAME_BUDGET_60FPS_MS = 1000 / 60;

/** Measured steps grouped by series; `keep` drops results a fit cannot use. */
function bySeries(run: BenchmarkRun, keep: (result: BenchmarkResult) => boolean = () => true): Map<string, BenchmarkResult[]> {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    if (!keep(result)) {
      continue;
    }
    const key = seriesOf(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return groups;
}

export function scalingFits(run: BenchmarkRun): ScalingFit[] {
  const fits: ScalingFit[] = [];
  for (const [series, results] of bySeries(run)) {
    // Against the satellites drawn, not requested.
    const fit = leastSquares(results.map((result) => ({ x: result.applied.satellitesVisible, y: mainThreadMs(result) })));
    if (!fit) {
      continue;
    }
    const floor = floorMs(results);
    const headroom = FRAME_BUDGET_60FPS_MS - fit.intercept;
    const reachable = Number.isFinite(floor) && floor < FRAME_BUDGET_60FPS_MS;
    fits.push({
      series,
      points: results.length,
      mainMsPer1000: round(fit.slope * 1000, 3),
      baseMainMs: round(fit.intercept),
      r2: round(fit.r2, 3),
      floorMs: Number.isFinite(floor) ? round(floor) : 0,
      satsAt60fps: reachable && fit.slope > 0 && headroom > 0 ? Math.round(headroom / fit.slope) : "",
    });
  }
  return fits;
}

export interface MemoryFit {
  series: string;
  /** Points behind the floor fit; 0, with the four fields below undefined, when there was nothing to fit. */
  points: number;
  /** Slope of the heap floor against satellites drawn. */
  mbPer1000Sats: number | undefined;
  kbPerSatellite: number | undefined;
  /** Not a footprint: baseline plus standing garbage. Kept only to expose a wild fit. */
  baseMb: number | undefined;
  /** Read it before the slope. */
  r2: number | undefined;
  /**
   * The slope from captured footprints, an independent check on `kbPerSatellite`
   * (one run: 54.0 vs 54.4 KB). Its own points and r², because a refused capture
   * shrinks only this fit.
   */
  absoluteKbPerSatellite: number | undefined;
  absolutePoints: number;
  absoluteR2: number | undefined;
}

/** Points for a fit, dropping the results that have no value for `pick`. */
const pointsOf = (results: readonly BenchmarkResult[], pick: (result: BenchmarkResult) => number | undefined): { x: number; y: number }[] =>
  results.flatMap((result) => {
    const y = pick(result);
    return y === undefined ? [] : [{ x: result.applied.satellitesVisible, y }];
  });

const withFootprints = (results: readonly BenchmarkResult[]): { x: number; y: number }[] => pointsOf(results, footprintJsMb);

/**
 * Memory per satellite from the heap floor within one series. Standing garbage is
 * a near-common offset across one pass, so it lands in the intercept: a 5,000
 * satellite scene read +269.9 and +269.4 MB over its zero row on two passes. Against
 * forced collections the slope read 53.7 vs 52.5 KB (r² 0.999). A GC mid-series
 * breaks it (−2.8 MB per 1,000, r² 0.002), so read r² first.
 */
export function memoryFits(run: BenchmarkRun): MemoryFit[] {
  const fits: MemoryFit[] = [];
  // Every series: the absolute fit does not depend on heap readings.
  for (const [series, results] of bySeries(run)) {
    const floorPoints = pointsOf(results, heapFloorMb);
    const floorFit = leastSquares(floorPoints);
    const absolutePoints = withFootprints(results);
    const absoluteFit = leastSquares(absolutePoints);
    if (floorFit === undefined && absoluteFit === undefined) {
      continue;
    }
    fits.push({
      series,
      points: floorFit === undefined ? 0 : floorPoints.length,
      mbPer1000Sats: floorFit === undefined ? undefined : round(floorFit.slope * 1000, 1),
      kbPerSatellite: floorFit === undefined ? undefined : round(floorFit.slope * 1024, 1),
      baseMb: floorFit === undefined ? undefined : round(floorFit.intercept, 1),
      r2: floorFit === undefined ? undefined : round(floorFit.r2, 3),
      absoluteKbPerSatellite: absoluteFit === undefined ? undefined : round(absoluteFit.slope * 1024, 1),
      absolutePoints: absolutePoints.length,
      absoluteR2: absoluteFit === undefined ? undefined : round(absoluteFit.r2, 3),
    });
  }
  return fits;
}

export interface MarginalCost {
  sats: number;
  clock: number;
  added: string;
  over: string;
  deltaMainMs: number;
  usPerSatellite: number;
}

/**
 * Differences rows of the same count and clock; across clocks, propagation would
 * be charged to a component. Each set is compared with its largest strict subset,
 * which serves both the cumulative and the isolated sweep.
 */
export function marginalCosts(run: BenchmarkRun): MarginalCost[] {
  const byCondition = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    const key = `${result.applied.satellitesRequested}@${result.applied.clockMultiplier}`;
    byCondition.set(key, [...(byCondition.get(key) ?? []), result]);
  }
  const costs: MarginalCost[] = [];
  const buckets = [...byCondition.values()];
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  buckets.sort((a, b) => (a[0]?.applied.satellitesRequested ?? 0) - (b[0]?.applied.satellitesRequested ?? 0));
  for (const results of buckets) {
    for (const result of results) {
      const own = new Set(result.applied.componentsRequested);
      let baseline: BenchmarkResult | undefined;
      for (const candidate of results) {
        const other = candidate.applied.componentsRequested;
        if (other.length >= own.size || !other.every((component) => own.has(component))) {
          continue;
        }
        if (baseline === undefined || other.length > baseline.applied.componentsRequested.length) {
          baseline = candidate;
        }
      }
      if (!baseline) {
        continue;
      }
      const base = new Set(baseline.applied.componentsRequested);
      const delta = mainThreadMs(result) - mainThreadMs(baseline);
      const drawn = result.applied.satellitesVisible;
      costs.push({
        sats: result.applied.satellitesRequested,
        clock: result.applied.clockMultiplier,
        added: formatComponents(result.applied.componentsRequested.filter((component) => !base.has(component))),
        over: formatComponents(baseline.applied.componentsRequested),
        deltaMainMs: round(delta),
        usPerSatellite: drawn > 0 ? round((delta * 1000) / drawn, 1) : 0,
      });
    }
  }
  return costs;
}

export interface PropagationCost {
  sats: number;
  components: string;
  clock: number;
  tickMs: number;
  /** Over the same scene at ×1. */
  deltaTickMs: number;
  usPerSatellite: number;
  /** For contrast: propagation does not touch it, so a flat `cpuMs` is expected. */
  cpuMs: number;
}

/**
 * Each clock rate against ×1 for the same scene. Differenced on `tickMs`: `cpuMs`
 * read −0.08 ms at 5,000 points at ×10000, for 462 ms frames that were 95%
 * `SampledTrajectory.update`.
 */
export function propagationCosts(run: BenchmarkRun): PropagationCost[] {
  const byScene = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    const key = `${result.applied.satellitesRequested}|${formatComponents(result.applied.componentsRequested)}`;
    byScene.set(key, [...(byScene.get(key) ?? []), result]);
  }
  const costs: PropagationCost[] = [];
  for (const results of byScene.values()) {
    const baseline = results.find((result) => result.applied.clockMultiplier === 1);
    if (!baseline || results.length < 2) {
      continue;
    }
    for (const result of results) {
      if (result === baseline) {
        continue;
      }
      const delta = tickMs(result) - tickMs(baseline);
      const drawn = result.applied.satellitesVisible;
      costs.push({
        sats: result.applied.satellitesRequested,
        components: formatComponents(result.applied.componentsRequested),
        clock: result.applied.clockMultiplier,
        tickMs: round(tickMs(result)),
        deltaTickMs: round(delta),
        usPerSatellite: drawn > 0 ? round((delta * 1000) / drawn, 1) : 0,
        cpuMs: round(cpuMs(result)),
      });
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort -- built locally
  return costs.sort((a, b) => a.sats - b.sats || a.clock - b.clock);
}

export interface RepeatCheck {
  sats: number;
  components: string;
  clock: number;
  firstMainMs: number;
  repeatMainMs: number;
  /** Positive means the app got slower over the run. */
  mainDriftPct: number;
  firstBuildMs: number;
  repeatBuildMs: number;
  /** Usually strongly negative: the first build pays for warmup. */
  buildDriftPct: number;
  // No heap drift: on three healthy runs the floor moved -14.6%, -10.2% and +638%.
  // To find a leak, repeat one scene with a forced GC between passes.
}

export const MAX_TRUSTWORTHY_DRIFT_PCT = 10;

/** At 0 satellites `mainThreadMs` is under 2 ms, so 10% alone is noise. */
export const MIN_MEANINGFUL_DRIFT_MS = 1;

export const isDrifted = (check: RepeatCheck): boolean =>
  Math.abs(check.mainDriftPct) > MAX_TRUSTWORTHY_DRIFT_PCT && Math.abs(check.repeatMainMs - check.firstMainMs) >= MIN_MEANINGFUL_DRIFT_MS;

/** A linear series measured 0.999, one broken by a mid-series GC 0.002. */
export const MIN_TRUSTWORTHY_MEMORY_R2 = 0.9;

/** Two points always give r² 1.0. */
export const MIN_MEMORY_FIT_POINTS = 3;

export const memoryFitTrustworthy = (fit: MemoryFit): boolean => fit.r2 !== undefined && fit.points >= MIN_MEMORY_FIT_POINTS && fit.r2 >= MIN_TRUSTWORTHY_MEMORY_R2;

/** Checked on its own points and r²: a refused capture shrinks only this fit. */
export const absoluteFitTrustworthy = (fit: MemoryFit): boolean =>
  fit.absoluteKbPerSatellite !== undefined && fit.absolutePoints >= MIN_MEMORY_FIT_POINTS && (fit.absoluteR2 ?? 0) >= MIN_TRUSTWORTHY_MEMORY_R2;

export const hasFootprints = (run: BenchmarkRun): boolean => run.results.some((result) => result.footprint !== undefined);

const driftPct = (first: number, repeat: number): number => (first === 0 ? 0 : round(((repeat - first) / first) * 100, 1));

/**
 * The first step against its re-run at the end. A small `mainDriftPct` is what
 * makes the other tables readable. Measured on `mainThreadMs`: `cpuMs` is under
 * 2 ms at small counts, where noise reads as 25% drift.
 */
export function repeatChecks(run: BenchmarkRun): RepeatCheck[] {
  const checks: RepeatCheck[] = [];
  for (const repeat of run.results.filter((result) => result.step.repeat)) {
    const first = measured(run).find(
      (candidate) =>
        candidate.applied.satellitesRequested === repeat.applied.satellitesRequested &&
        candidate.applied.clockMultiplier === repeat.applied.clockMultiplier &&
        formatComponents(candidate.applied.componentsRequested) === formatComponents(repeat.applied.componentsRequested),
    );
    if (!first) {
      continue;
    }
    checks.push({
      sats: repeat.applied.satellitesRequested,
      components: formatComponents(repeat.applied.componentsRequested),
      clock: repeat.applied.clockMultiplier,
      firstMainMs: round(mainThreadMs(first)),
      repeatMainMs: round(mainThreadMs(repeat)),
      mainDriftPct: driftPct(mainThreadMs(first), mainThreadMs(repeat)),
      firstBuildMs: round(first.applied.buildMs),
      repeatBuildMs: round(repeat.applied.buildMs),
      buildDriftPct: driftPct(first.applied.buildMs, repeat.applied.buildMs),
    });
  }
  return checks;
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** For pasting into an issue. */
export function formatTable(run: BenchmarkRun): string {
  const rows = reportRows(run);
  // No heap column: beside frame times the floor reads as a footprint.
  const showFootprint = rows.some((row) => row.footprintMb !== "");
  const header = [
    "sats",
    "visible",
    "clock",
    "frames",
    "fps",
    "frameMs",
    "p95",
    "worst",
    "cpuMs",
    "cpuP95",
    "tickMs",
    "gpuMs",
    "jank%",
    "build",
    ...(showFootprint ? ["footprint"] : []),
    "components",
  ];
  // 10 for footprint: the name is 9 characters, and a width of 8 ran it into `build`.
  const widths = [6, 8, 7, 7, 7, 8, 7, 8, 7, 7, 8, 7, 6, 8, ...(showFootprint ? [10] : [])];
  const lines = [header.map((name, index) => (index < widths.length ? pad(name, widths[index] as number) : ` ${name}`)).join("")];
  for (const row of rows) {
    const values = [
      row.sats,
      row.visible,
      `x${row.clock}`,
      row.frames,
      row.fps,
      row.frameMs,
      row.p95Ms,
      row.worstMs,
      row.cpuMs,
      row.cpuP95Ms,
      row.tickMs,
      row.gpuMs === "" ? "—" : row.gpuMs,
      row.jankPct,
      row.buildMs,
      ...(showFootprint ? [row.footprintMb] : []),
    ];
    const suffix = `${row.repeat ? " (repeat)" : ""}${row.drawn ? ` (drew ${row.drawn})` : ""}`;
    lines.push(`${values.map((value, index) => pad(value, widths[index] as number)).join("")} ${row.components}${suffix}`);
  }
  return lines.join("\n");
}

export function toCsv(run: BenchmarkRun): string {
  const rows = reportRows(run);
  const first = rows[0];
  if (!first) {
    return "";
  }
  const keys = Object.keys(first) as (keyof ReportRow)[];
  const escape = (value: string | number | boolean): string =>
    typeof value === "string" && (value.includes(",") || value.includes('"')) ? `"${value.replaceAll('"', '""')}"` : String(value);
  return [keys.join(","), ...rows.map((row) => keys.map((key) => escape(row[key])).join(","))].join("\n");
}

export function toJson(run: BenchmarkRun): string {
  return JSON.stringify(
    {
      startedAtIso: run.startedAtIso,
      spec: run.spec,
      environment: run.environment,
      options: run.options,
      catalogSize: run.catalogSize,
      cancelled: run.cancelled,
      rows: reportRows(run),
      scaling: scalingFits(run),
      memory: memoryFits(run),
      marginal: marginalCosts(run),
      propagation: propagationCosts(run),
      repeat: repeatChecks(run),
      componentInstances: run.results.map((result) => ({
        sats: result.applied.satellitesRequested,
        components: formatComponents(result.applied.componentsRequested),
        clock: result.applied.clockMultiplier,
        instances: result.applied.componentInstances,
      })),
    },
    null,
    2,
  );
}

export const MIN_TRUSTWORTHY_FRAMES = 20;

export const thinRows = (run: BenchmarkRun): ReportRow[] => reportRows(run).filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES);

export function logRun(run: BenchmarkRun): void {
  const title = `satvis benchmark — ${run.results.length} steps${run.cancelled ? " (cancelled)" : ""}`;
  console.group(title);
  console.log("environment", run.environment);
  console.log("options", run.options, `catalog: ${run.catalogSize}`);
  const thin = thinRows(run);
  if (thin.length > 0) {
    console.warn(
      `${thin.length}/${run.results.length} steps sampled fewer than ${MIN_TRUSTWORTHY_FRAMES} frames — treat their timings as noise.`,
      run.environment.visibility === "hidden" ? "The tab was hidden; a hidden tab suspends the render loop entirely." : "",
    );
  }
  const anyGpu = run.results.some((result) => result.frames.gpu !== undefined);
  if (!anyGpu) {
    console.log("gpuMs: unavailable — this browser offers no EXT_disjoint_timer_query_webgl2.");
  } else if (!gpuTimerTrustworthy(run)) {
    console.warn(
      `gpuMs: withheld — the driver's timer reported more than ${GPU_TIMER_TRUST_FACTOR}× the frame interval on most steps, ` +
        "which a frame that presented cannot have cost. Known to happen on ANGLE/Metal. Read frameMs against cpuMs instead: " +
        "the gap between them is the GPU, and if frameMs is well above the display's fastest interval the scene is GPU-bound.",
    );
  }
  console.log("%cper step", "font-weight:bold");
  console.table(reportRows(run));
  console.log("%cscaling with satellite count (main-thread frame time: render + clock tick)", "font-weight:bold");
  console.table(scalingFits(run));
  const memory = memoryFits(run);
  if (memory.length > 0) {
    console.log("%cmemory growth with satellite count (heap floor, relative)", "font-weight:bold");
    // No baseMb: a bare MB figure reads as a total.
    console.table(
      memory.map((fit) => ({
        series: fit.series,
        points: fit.points,
        mbPer1000Sats: fit.mbPer1000Sats,
        kbPerSatellite: fit.kbPerSatellite,
        r2: fit.r2,
        absoluteKbPerSatellite: fit.absoluteKbPerSatellite,
        absoluteR2: fit.absoluteR2,
      })),
    );
    const untrustworthy = memory.filter((fit) => fit.r2 !== undefined && !memoryFitTrustworthy(fit));
    if (untrustworthy.length > 0) {
      console.warn(
        `memory: ${untrustworthy.map((fit) => `${fit.series} (r² ${fit.r2}, ${fit.points} points)`).join(", ")} cannot be read — ` +
          `a fit needs at least ${MIN_MEMORY_FIT_POINTS} counts (two points always fit their own line) and r² ${MIN_TRUSTWORTHY_MEMORY_R2}, ` +
          "or else a garbage collection landed inside the series and its offset is not common to the rows. Sweep more counts, or re-run.",
      );
    }
    if (hasFootprints(run)) {
      console.log(
        "absoluteKbPerSatellite comes from absolute footprints (measureUserAgentSpecificMemory) rather than sampled floors. " +
          "Where the two agree, both are trustworthy; a wide gap means the growth fit straddled a collection.",
      );
      const weakAbsolute = memory.filter((fit) => fit.absoluteKbPerSatellite !== undefined && !absoluteFitTrustworthy(fit));
      if (weakAbsolute.length > 0) {
        console.warn(
          `absoluteKbPerSatellite: ${weakAbsolute.map((fit) => `${fit.series} (r² ${fit.absoluteR2}, ${fit.absolutePoints} points)`).join(", ")} cannot be read — ` +
            "fewer captures than counts, so a step's capture was refused. Re-run.",
        );
      }
    } else {
      console.log(
        "Slopes only, and only within a series: the heap floor includes uncollected garbage, so the intercept is not a total. " +
          "Checked against forced collections the slope came within 2% (53.7 vs 52.5 KB per satellite). For absolute figures re-run with captureFootprint.",
      );
    }
  } else if (!run.results.some((result) => result.frames.heap !== undefined) && !hasFootprints(run)) {
    console.log("memory: unavailable — performance.memory is Chrome-only and no footprint was captured, so there is nothing to fit.");
  } else {
    console.log(`memory: not fitted — a slope needs at least two satellite counts per series (${MIN_MEMORY_FIT_POINTS} to be readable). Sweep more counts.`);
  }
  const captured = run.results.filter((result) => result.footprint !== undefined);
  if (captured.length > 0) {
    const waitedMs = captured.reduce((total, result) => total + (result.footprint?.elapsedMs ?? 0), 0);
    console.log("%cabsolute memory footprint (garbage excluded)", "font-weight:bold");
    console.table(
      captured.map((result) => ({
        sats: result.applied.satellitesVisible,
        components: formatComponents(result.applied.componentsRequested),
        jsMb: round(result.footprint?.jsMb ?? 0, 1),
        totalMb: round(result.footprint?.totalMb ?? 0, 1),
        workerMb: round(result.footprint?.workerMb ?? 0, 1),
      })),
    );
    console.log(`${captured.length} captures cost ${Math.round(waitedMs / 1000)} s of waiting — the call resolves only when a collection happens.`);
  } else if (run.environment.crossOriginIsolated !== "true") {
    console.log(
      "footprint: unavailable — the page is not cross-origin isolated, so measureUserAgentSpecificMemory is not exposed. Needs COOP: same-origin and COEP: credentialless.",
    );
  }
  console.log("%cmarginal cost per component (main-thread frame time)", "font-weight:bold");
  console.table(marginalCosts(run));
  // An empty table would read as "propagation is free".
  const propagation = propagationCosts(run);
  if (propagation.length > 0) {
    console.log("%ccost of running the clock faster (propagation)", "font-weight:bold");
    console.table(propagation);
  }
  const repeats = repeatChecks(run);
  if (repeats.length > 0) {
    console.log("%cfirst step re-run at the end (drift)", "font-weight:bold");
    console.table(repeats);
    const drifted = repeats.filter(isDrifted);
    if (drifted.length > 0) {
      console.warn(
        `The first step measured ${drifted.map((check) => `${check.mainDriftPct > 0 ? "+" : ""}${check.mainDriftPct}% (${round(check.repeatMainMs - check.firstMainMs)} ms)`).join(", ")} differently when re-run at the end — ` +
          `over ${MAX_TRUSTWORTHY_DRIFT_PCT}% and ${MIN_MEANINGFUL_DRIFT_MS} ms, so the app moved under the sweep and the trends above are that as much as the scenes.`,
      );
    }
  }
  console.groupEnd();
}
