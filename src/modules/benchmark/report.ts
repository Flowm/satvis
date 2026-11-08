// A sweep's tables (ADR 0016). The native app's SweepReport is held to them by a parity
// fixture, so change both together.

import { formatComponents, formatSeries, type PlanSpec } from "./benchmarkPlan";

/** Times in milliseconds; null where the app cannot say. */
export interface SweepResult {
  /** Asked for; `visible` is drawn. */
  satelliteCount: number;
  /** Asked for; `componentsDrawn` is drawn. */
  components: string[];
  /** The clock rate the app ran at, which it can refuse. */
  clock: number;
  /** The closing re-run of the first step, left out of every derived table. */
  repeat: boolean;
  /** Satellites drawn, which can differ from the count asked for. */
  visible: number;
  componentsDrawn: string[];
  /** Satellites drawing each component, by name. */
  componentInstances: Record<string, number>;
  /** Wall time to a complete scene, spread over frames. */
  buildMs: number;
  /** Teardown of the previous scene. */
  clearMs: number;
  /** Frame intervals, one fewer than the frames drawn. */
  frames: number;
  /** 0 where fewer than two frames were drawn. */
  fps: number;
  /** The mean frame interval: GPU work and the vsync wait, for the scaling floor. */
  frameMs: number | null;
  /**
   * The main thread's work on a frame, which sets the frame rate: on the web Cesium's whole
   * frame callback, the clock tick included, since neither half works alone (a fit of the
   * render alone had Point holding 60 fps to 1.66 million satellites; vsync flattened the
   * frame time at 8.33 ms from 0 to 1,000 points while this went 0.64 to 1.21 ms).
   */
  cpuMs: number | null;
  /** Nearest-rank 95th percentile. */
  cpuP95Ms: number | null;
  /** Null without a GPU timer, or once the web's has overrun its frames (`FrameMeter`). */
  gpuMs: number | null;
  /** Nearest-rank 95th percentile. */
  gpuP95Ms: number | null;
  /** The larger side's share of frames over budget. */
  overBudgetPct: number | null;
  /** The busier side's busy share. */
  loadPct: number | null;
  /** The CPU's share alone, the floor of load where the GPU's is unknown. */
  cpuBusyPct: number | null;
  /** Percent of one core, every thread: propagation off the main thread too. */
  cpuTotalPct: number | null;
  /** Chrome's heap floor and peak over the step: garbage included, only slopes mean anything. */
  heapMb: number | null;
  /** See `heapMb`. */
  heapPeakMb: number | null;
  /** Absolute: measureUserAgentSpecificMemory's JavaScript on the web, phys_footprint natively. */
  footprintMb: number | null;
  /** Every scope's, workers included (`FootprintSample.totalMb`). */
  footprintTotalMb: number | null;
  /** Worker scopes' alone. */
  footprintWorkerMb: number | null;
  /** This app's own figures, as `x_<name>` columns; they compare with nothing on the other. */
  extras: Record<string, number | null>;
}

/** A sweep's run as the tables read it; its fields are `BenchmarkRun`'s. */
export interface SweepRun {
  results: readonly SweepResult[];
  startedAtIso: string;
  spec?: PlanSpec;
  environment: Record<string, unknown>;
  options: Record<string, unknown>;
  catalogSize: number;
  cancelled: boolean;
}

/** Rounded as `Number.prototype.toFixed` rounds; the native app's `jsFixed` matches it. */
const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** A missing figure blank, as the CSV writes it. */
const blankOr = (value: number | null | undefined, digits = 2): number | "" => (value === null || value === undefined ? "" : round(value, digits));

/** 0 where the app cannot say. */
const cpuMs = (result: SweepResult): number => result.cpuMs ?? 0;

/** The tables' series: the set, and the clock past ×1. */
const seriesOf = (result: SweepResult): string => formatSeries(result.components, result.clock);

/** Without the closing repeat, which would weight one scene twice and hide the drift. */
const measured = (run: SweepRun): SweepResult[] => run.results.filter((result) => !result.repeat);

/** A row of the per-step table and the CSV: `SweepResult` rounded, missing figures blank. */
export interface ReportRow {
  /** Asked for; `visible` is drawn. */
  sats: number;
  components: string;
  clock: number;
  repeat: boolean;
  /** Blank unless the app drew something other than what was asked for. */
  drawn: string;
  visible: number;
  /** Below MIN_TRUSTWORTHY_FRAMES the row is noise. */
  frames: number;
  fps: number;
  cpuMs: number | "";
  gpuMs: number | "";
  loadPct: number | "";
  cpuBusyPct: number | "";
  cpuP95Ms: number | "";
  gpuP95Ms: number | "";
  overBudgetPct: number | "";
  cpuTotalPct: number | "";
  buildMs: number;
  clearMs: number;
  heapMb: number | "";
  /** `heapPeakMb - heapMb` is the step's allocation rate. */
  heapPeakMb: number | "";
  footprintMb: number | "";
  footprintTotalMb: number | "";
  footprintWorkerMb: number | "";
  [extra: `x_${string}`]: number | "";
}

/** Every step, the repeat included. */
export function reportRows(run: SweepRun): ReportRow[] {
  return run.results.map((result) => {
    const requested = formatComponents(result.components);
    const drawn = formatComponents(result.componentsDrawn);
    const row: ReportRow = {
      sats: result.satelliteCount,
      components: requested,
      clock: result.clock,
      repeat: result.repeat,
      drawn: drawn === requested ? "" : drawn,
      visible: result.visible,
      frames: result.frames,
      fps: round(result.fps, 1),
      cpuMs: blankOr(result.cpuMs),
      gpuMs: blankOr(result.gpuMs),
      loadPct: blankOr(result.loadPct, 1),
      cpuBusyPct: blankOr(result.cpuBusyPct, 1),
      cpuP95Ms: blankOr(result.cpuP95Ms),
      gpuP95Ms: blankOr(result.gpuP95Ms),
      overBudgetPct: blankOr(result.overBudgetPct, 1),
      cpuTotalPct: blankOr(result.cpuTotalPct, 1),
      buildMs: round(result.buildMs),
      clearMs: round(result.clearMs),
      heapMb: blankOr(result.heapMb, 1),
      heapPeakMb: blankOr(result.heapPeakMb, 1),
      footprintMb: blankOr(result.footprintMb, 1),
      footprintTotalMb: blankOr(result.footprintTotalMb, 1),
      footprintWorkerMb: blankOr(result.footprintWorkerMb, 1),
    };
    // eslint-disable-next-line unicorn/no-array-sort -- a fresh array
    for (const name of Object.keys(result.extras).sort()) {
      row[`x_${name}`] = blankOr(result.extras[name]);
    }
    return row;
  });
}

/** CPU time against satellites drawn, per series. */
export interface ScalingFit {
  /** As `formatSeries` names it. */
  series: string;
  /** Steps fitted. */
  points: number;
  /** Least-squares slope of main-thread ms. */
  cpuMsPer1000: number;
  /** The intercept: the series without satellites. */
  baseCpuMs: number;
  /** Read it before the slope. */
  r2: number;
  /** Read it against 16.7 ms before `satsAt60fps`. */
  floorMs: number;
  /**
   * Where the fit crosses 16.7 ms, assuming the GPU is not the limit (at 5,000 points:
   * 11.52 ms main thread, 11.72 ms frame). Blank when the floor is past the budget.
   */
  satsAt60fps: number | "";
}

/** Undefined under two points, or with every x the same. */
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

/** What the scaling table reads its headroom against. */
const FRAME_BUDGET_60FPS_MS = 1000 / 60;

/** The measured steps, by series. */
function bySeries(run: SweepRun): Map<string, SweepResult[]> {
  const groups = new Map<string, SweepResult[]>();
  for (const result of measured(run)) {
    const key = seriesOf(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return groups;
}

/** Against the satellites drawn, not requested. */
export function scalingFits(run: SweepRun): ScalingFit[] {
  const fits: ScalingFit[] = [];
  for (const [series, results] of bySeries(run)) {
    const fit = leastSquares(results.map((result) => ({ x: result.visible, y: cpuMs(result) })));
    if (!fit) {
      continue;
    }
    // GPU work and the vsync wait, which the frame time cannot separate.
    const floor = Math.min(...results.map((result) => result.frameMs ?? Infinity));
    const headroom = FRAME_BUDGET_60FPS_MS - fit.intercept;
    const reachable = Number.isFinite(floor) && floor < FRAME_BUDGET_60FPS_MS;
    fits.push({
      series,
      points: results.length,
      cpuMsPer1000: round(fit.slope * 1000, 3),
      baseCpuMs: round(fit.intercept),
      r2: round(fit.r2, 3),
      floorMs: Number.isFinite(floor) ? round(floor) : 0,
      satsAt60fps: reachable && fit.slope > 0 && headroom > 0 ? Math.round(headroom / fit.slope) : "",
    });
  }
  return fits;
}

/** Memory against satellites drawn, per series. */
export interface MemoryFit {
  /** As `formatSeries` names it. */
  series: string;
  /** Points behind the heap fit; 0, with the four fields below blank, when there was nothing to fit. */
  points: number;
  /** Slope of the heap floor against satellites drawn. */
  mbPer1000Sats: number | "";
  /** The same slope, in KB per satellite. */
  kbPerSatellite: number | "";
  /** Not a footprint: baseline plus standing garbage. Kept only to expose a wild fit. */
  baseMb: number | "";
  /** Check it before trusting `kbPerSatellite`. */
  r2: number | "";
  /**
   * The slope from absolute footprints: on the web an independent check on `kbPerSatellite`
   * (one run: 54.0 vs 54.4 KB), natively the only one.
   */
  absoluteKbPerSatellite: number | "";
  /** Points behind the absolute fit. */
  absolutePoints: number;
  /** Of the absolute fit. */
  absoluteR2: number | "";
}

/** Against satellites drawn, the steps without the figure left out. */
const pointsOf = (results: readonly SweepResult[], pick: (result: SweepResult) => number | null): { x: number; y: number }[] =>
  results.flatMap((result) => {
    const y = pick(result);
    return y === null ? [] : [{ x: result.visible, y }];
  });

/**
 * Memory per satellite within one series. Standing garbage is a near-common offset across one
 * pass, so on the web it lands in the intercept: against forced collections the heap slope
 * read 53.7 vs 52.5 KB (r² 0.999). A GC mid-series breaks it (−2.8 MB per 1,000, r² 0.002), so
 * read r² first.
 */
export function memoryFits(run: SweepRun): MemoryFit[] {
  const fits: MemoryFit[] = [];
  for (const [series, results] of bySeries(run)) {
    const heapPoints = pointsOf(results, (result) => result.heapMb);
    const heapFit = leastSquares(heapPoints);
    const absolutePoints = pointsOf(results, (result) => result.footprintMb);
    const absoluteFit = leastSquares(absolutePoints);
    if (heapFit === undefined && absoluteFit === undefined) {
      continue;
    }
    fits.push({
      series,
      points: heapFit === undefined ? 0 : heapPoints.length,
      mbPer1000Sats: heapFit === undefined ? "" : round(heapFit.slope * 1000, 1),
      kbPerSatellite: heapFit === undefined ? "" : round(heapFit.slope * 1024, 1),
      baseMb: heapFit === undefined ? "" : round(heapFit.intercept, 1),
      r2: heapFit === undefined ? "" : round(heapFit.r2, 3),
      absoluteKbPerSatellite: absoluteFit === undefined ? "" : round(absoluteFit.slope * 1024, 1),
      absolutePoints: absolutePoints.length,
      absoluteR2: absoluteFit === undefined ? "" : round(absoluteFit.r2, 3),
    });
  }
  return fits;
}

/** What a set adds over its largest strict subset, at one count and clock. */
export interface MarginalCost {
  /** Asked for. */
  sats: number;
  clock: number;
  /** The components `over` lacks. */
  added: string;
  /** The subset, measured at the same count and clock. */
  over: string;
  /** CPU time over the subset's. */
  deltaCpuMs: number;
  /** `deltaCpuMs` in microseconds per satellite drawn; 0 with none. */
  usPerSatellite: number;
}

/**
 * Differences rows of the same count and clock; across clocks, propagation would be charged
 * to a component. Each set is compared with its largest strict subset, which serves both the
 * cumulative and the isolated sweep.
 */
export function marginalCosts(run: SweepRun): MarginalCost[] {
  const byCondition = new Map<string, SweepResult[]>();
  for (const result of measured(run)) {
    const key = `${result.satelliteCount}@${result.clock}`;
    byCondition.set(key, [...(byCondition.get(key) ?? []), result]);
  }
  const costs: MarginalCost[] = [];
  const buckets = [...byCondition.values()];
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  buckets.sort((a, b) => (a[0]?.satelliteCount ?? 0) - (b[0]?.satelliteCount ?? 0));
  for (const results of buckets) {
    for (const result of results) {
      const own = new Set(result.components);
      let baseline: SweepResult | undefined;
      for (const candidate of results) {
        const other = candidate.components;
        if (other.length >= own.size || !other.every((component) => own.has(component))) {
          continue;
        }
        if (baseline === undefined || other.length > baseline.components.length) {
          baseline = candidate;
        }
      }
      if (!baseline) {
        continue;
      }
      const base = new Set(baseline.components);
      const delta = cpuMs(result) - cpuMs(baseline);
      costs.push({
        sats: result.satelliteCount,
        clock: result.clock,
        added: formatComponents(result.components.filter((component) => !base.has(component))),
        over: formatComponents(baseline.components),
        deltaCpuMs: round(delta),
        usPerSatellite: result.visible > 0 ? round((delta * 1000) / result.visible, 1) : 0,
      });
    }
  }
  return costs;
}

/** What a clock past ×1 costs one scene. */
export interface PropagationCost {
  /** Asked for. */
  sats: number;
  components: string;
  clock: number;
  /** At this clock. */
  cpuMs: number;
  /** Over the same scene at ×1: what a faster clock costs the frame rate. */
  deltaCpuMs: number;
  /** `deltaCpuMs` in microseconds per satellite drawn; 0 with none. */
  usPerSatellite: number;
  /** At this clock. */
  cpuTotalPct: number | "";
  /** Over ×1: what it costs every thread, propagation off the main thread included. */
  deltaCpuTotalPct: number | "";
}

/**
 * Each clock rate against ×1 for the same scene. Propagation is paid per simulated quarter
 * orbit, so it grows with the rate: on the web on the main thread, in the clock tick (95 % of
 * 462 ms frames at ×10000); natively off it, where only total CPU sees it.
 */
export function propagationCosts(run: SweepRun): PropagationCost[] {
  const byScene = new Map<string, SweepResult[]>();
  for (const result of measured(run)) {
    const key = `${result.satelliteCount}|${formatComponents(result.components)}`;
    byScene.set(key, [...(byScene.get(key) ?? []), result]);
  }
  const costs: PropagationCost[] = [];
  for (const results of byScene.values()) {
    const baseline = results.find((result) => result.clock === 1);
    if (!baseline || results.length < 2) {
      continue;
    }
    for (const result of results) {
      if (result === baseline) {
        continue;
      }
      const delta = cpuMs(result) - cpuMs(baseline);
      costs.push({
        sats: result.satelliteCount,
        components: formatComponents(result.components),
        clock: result.clock,
        cpuMs: round(cpuMs(result)),
        deltaCpuMs: round(delta),
        usPerSatellite: result.visible > 0 ? round((delta * 1000) / result.visible, 1) : 0,
        cpuTotalPct: blankOr(result.cpuTotalPct, 1),
        deltaCpuTotalPct: result.cpuTotalPct === null || baseline.cpuTotalPct === null ? "" : round(result.cpuTotalPct - baseline.cpuTotalPct, 1),
      });
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort -- built locally
  return costs.sort((a, b) => a.sats - b.sats || a.clock - b.clock);
}

/** The first step against its closing re-run. */
export interface RepeatCheck {
  /** Asked for. */
  sats: number;
  components: string;
  clock: number;
  /** The first pass's. */
  firstCpuMs: number;
  /** The re-run's. */
  repeatCpuMs: number;
  /** Positive means the app got slower over the run. */
  cpuDriftPct: number;
  /** The first pass's. */
  firstBuildMs: number;
  /** The re-run's. */
  repeatBuildMs: number;
  /** Usually strongly negative: the first build pays for warmup. */
  buildDriftPct: number;
  // No heap drift: on three healthy runs the floor moved -14.6%, -10.2% and +638%.
}

/** Past it, and past `MIN_MEANINGFUL_DRIFT_MS`, the app moved under the sweep. */
export const MAX_TRUSTWORTHY_DRIFT_PCT = 10;

/** At 0 satellites main-thread time is under 2 ms, so 10% alone is noise. */
export const MIN_MEANINGFUL_DRIFT_MS = 1;

/** Past both drift thresholds. */
export const isDrifted = (check: RepeatCheck): boolean =>
  Math.abs(check.cpuDriftPct) > MAX_TRUSTWORTHY_DRIFT_PCT && Math.abs(check.repeatCpuMs - check.firstCpuMs) >= MIN_MEANINGFUL_DRIFT_MS;

/** A linear series measured 0.999, one broken by a mid-series GC 0.002. */
export const MIN_TRUSTWORTHY_MEMORY_R2 = 0.9;

/** Two points always give r² 1.0. */
export const MIN_MEMORY_FIT_POINTS = 3;

/** The heap fit, by its points and r². */
export const memoryFitTrustworthy = (fit: MemoryFit): boolean => fit.r2 !== "" && fit.points >= MIN_MEMORY_FIT_POINTS && fit.r2 >= MIN_TRUSTWORTHY_MEMORY_R2;

/** Checked on its own points and r²: a refused capture shrinks only this fit. */
export const absoluteFitTrustworthy = (fit: MemoryFit): boolean =>
  fit.absoluteKbPerSatellite !== "" && fit.absolutePoints >= MIN_MEMORY_FIT_POINTS && fit.absoluteR2 !== "" && fit.absoluteR2 >= MIN_TRUSTWORTHY_MEMORY_R2;

/** Whether any step captured an absolute footprint. */
export const hasFootprints = (run: SweepRun): boolean => run.results.some((result) => result.footprintMb !== null);

/** Percent, positive where the repeat got slower. `first` must not be 0. */
export const driftPct = (first: number, repeat: number): number => ((repeat - first) / first) * 100;
/** 0 where `first` is. */
const roundedDriftPct = (first: number, repeat: number): number => (first === 0 ? 0 : round(driftPct(first, repeat), 1));

/** A small `cpuDriftPct` makes the other tables readable. */
export function repeatChecks(run: SweepRun): RepeatCheck[] {
  const checks: RepeatCheck[] = [];
  for (const repeat of run.results.filter((result) => result.repeat)) {
    const first = measured(run).find(
      (candidate) =>
        candidate.satelliteCount === repeat.satelliteCount && candidate.clock === repeat.clock && formatComponents(candidate.components) === formatComponents(repeat.components),
    );
    if (!first) {
      continue;
    }
    checks.push({
      sats: repeat.satelliteCount,
      components: formatComponents(repeat.components),
      clock: repeat.clock,
      firstCpuMs: round(cpuMs(first)),
      repeatCpuMs: round(cpuMs(repeat)),
      cpuDriftPct: roundedDriftPct(cpuMs(first), cpuMs(repeat)),
      firstBuildMs: round(first.buildMs),
      repeatBuildMs: round(repeat.buildMs),
      buildDriftPct: roundedDriftPct(first.buildMs, repeat.buildMs),
    });
  }
  return checks;
}

/** Frame intervals a step needs before its timings mean anything. */
export const MIN_TRUSTWORTHY_FRAMES = 20;

/** The steps under `MIN_TRUSTWORTHY_FRAMES`. */
export const thinRows = (run: SweepRun): ReportRow[] => reportRows(run).filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES);

/** Right-aligned, as the table's columns are. */
const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** For pasting into an issue. Both apps print the same text, character for character. */
export function formatTable(run: SweepRun): string {
  const rows = reportRows(run);
  // No heap column: beside frame times the floor reads as a footprint.
  const showFootprint = rows.some((row) => row.footprintMb !== "");
  const header = [
    "sats",
    "visible",
    "clock",
    "frames",
    "fps",
    "cpuMs",
    "gpuMs",
    "load%",
    "cpuP95",
    "gpuP95",
    "over%",
    "total%",
    "build",
    ...(showFootprint ? ["footprint"] : []),
    "components",
  ];
  // 10 for footprint: the name is 9 characters, and a width of 8 ran it into `build`.
  const widths = [6, 8, 7, 7, 7, 8, 8, 7, 8, 8, 7, 7, 8, ...(showFootprint ? [10] : [])];
  const blank = (value: number | ""): string | number => (value === "" ? "—" : value);
  const lines = [header.map((name, index) => (index < widths.length ? pad(name, widths[index] as number) : ` ${name}`)).join("")];
  for (const row of rows) {
    const values = [
      row.sats,
      row.visible,
      `x${row.clock}`,
      row.frames,
      row.fps,
      blank(row.cpuMs),
      blank(row.gpuMs),
      row.loadPct === "" && row.cpuBusyPct !== "" ? `≥${row.cpuBusyPct}` : blank(row.loadPct),
      blank(row.cpuP95Ms),
      blank(row.gpuP95Ms),
      blank(row.overBudgetPct),
      blank(row.cpuTotalPct),
      row.buildMs,
      ...(showFootprint ? [blank(row.footprintMb)] : []),
    ];
    const suffix = `${row.repeat ? " (repeat)" : ""}${row.drawn ? ` (drew ${row.drawn})` : ""}`;
    lines.push(`${values.map((value, index) => pad(value, widths[index] as number)).join("")} ${row.components}${suffix}`);
  }
  return lines.join("\n");
}

/** The per-step rows, extras as `x_` columns; empty without a step. */
export function toCsv(run: SweepRun): string {
  const rows = reportRows(run);
  const first = rows[0];
  if (!first) {
    return "";
  }
  const keys = Object.keys(first) as (keyof ReportRow)[];
  const escape = (value: string | number | boolean | undefined): string =>
    typeof value === "string" && (value.includes(",") || value.includes('"')) ? `"${value.replaceAll('"', '""')}"` : String(value ?? "");
  return [keys.join(","), ...rows.map((row) => keys.map((key) => escape(row[key])).join(","))].join("\n");
}

/** As both apps export it. */
export function sweepReport(run: SweepRun): Record<string, unknown> {
  return {
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
      sats: result.satelliteCount,
      components: formatComponents(result.components),
      clock: result.clock,
      instances: result.componentInstances,
    })),
  };
}

/** `sweepReport`, indented. */
export const toJson = (run: SweepRun): string => JSON.stringify(sweepReport(run), null, 2);

/** Every table to the console, with a warning where one cannot be read. */
export function logRun(run: SweepRun): void {
  console.group(`satvis benchmark — ${run.results.length} steps${run.cancelled ? " (cancelled)" : ""}`);
  console.log("environment", run.environment);
  console.log("options", run.options, `catalog: ${run.catalogSize}`);
  const thin = thinRows(run);
  if (thin.length > 0) {
    console.warn(
      `${thin.length}/${run.results.length} steps sampled fewer than ${MIN_TRUSTWORTHY_FRAMES} frames — treat their timings as noise.`,
      run.environment.device_visibility === "hidden" ? "The tab was hidden; a hidden tab suspends the render loop entirely." : "",
    );
  }
  if (!run.results.some((result) => result.gpuMs !== null)) {
    console.log(
      "gpuMs: unavailable — the browser has no EXT_disjoint_timer_query_webgl2, or its timer overran the frames (ANGLE/Metal). " +
        "Read fps against cpuMs instead: if the frame interval is well above both cpuMs and the display's fastest interval, the scene is GPU-bound.",
    );
  }
  console.log("%cper step", "font-weight:bold");
  console.table(reportRows(run));
  console.log("%cscaling with satellite count (CPU ms a frame)", "font-weight:bold");
  console.table(scalingFits(run));
  const memory = memoryFits(run);
  if (memory.length > 0) {
    console.log("%cmemory growth with satellite count", "font-weight:bold");
    console.table(memory);
    const untrustworthy = memory.filter((fit) => fit.r2 !== "" && !memoryFitTrustworthy(fit));
    if (untrustworthy.length > 0) {
      console.warn(
        `memory: ${untrustworthy.map((fit) => `${fit.series} (r² ${fit.r2}, ${fit.points} points)`).join(", ")} cannot be read — ` +
          `a fit needs at least ${MIN_MEMORY_FIT_POINTS} counts and r² ${MIN_TRUSTWORTHY_MEMORY_R2}, or a garbage collection landed inside the series. Sweep more counts, or re-run.`,
      );
    }
  } else {
    console.log(`memory: not fitted — a slope needs at least two satellite counts per series (${MIN_MEMORY_FIT_POINTS} to be readable), and a memory reading.`);
  }
  console.log("%cmarginal cost per component (CPU ms a frame)", "font-weight:bold");
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
        `The first step measured ${drifted.map((check) => `${check.cpuDriftPct > 0 ? "+" : ""}${check.cpuDriftPct}% (${round(check.repeatCpuMs - check.firstCpuMs)} ms)`).join(", ")} differently when re-run at the end — ` +
          `over ${MAX_TRUSTWORTHY_DRIFT_PCT}% and ${MIN_MEANINGFUL_DRIFT_MS} ms, so the app moved under the sweep and the trends above are that as much as the scenes.`,
      );
    }
  }
  console.groupEnd();
}
