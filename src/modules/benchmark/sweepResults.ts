// A web sweep as both apps' tables read it (report.ts), the web's own split of the frame as extras.

import type { SweepStep } from "./benchmarkPlan";
import { cpuSplit } from "./benchmarkReport";
import type { BenchmarkResult, BenchmarkRun } from "./benchmarkRunner";
import { mean, summarize } from "./frameSummary";
import type { SweepResult, SweepRun } from "./report";

/** A step's result as the tables read it, the CPU split and Cesium's object counts as extras. */
export function sweepResultOf(result: BenchmarkResult<SweepStep>): SweepResult {
  const { step, applied, recording, heapMb, refreshMs, footprint } = result;
  const summary = summarize(recording, refreshMs);
  return {
    satelliteCount: step.satelliteCount,
    components: step.components,
    clock: applied.clockMultiplier,
    repeat: step.repeat,
    visible: applied.satellitesVisible,
    componentsDrawn: applied.componentsDrawn,
    componentInstances: applied.componentInstances,
    buildMs: applied.buildMs,
    clearMs: applied.clearMs,
    frames: summary.frames,
    fps: summary.fps ?? 0,
    frameMs: mean(recording.intervals),
    cpuMs: summary.cpuMs,
    cpuP95Ms: summary.cpuP95Ms,
    gpuMs: summary.gpuMs,
    gpuP95Ms: summary.gpuP95Ms,
    overBudgetPct: summary.overBudgetPct,
    loadPct: summary.loadPct,
    cpuBusyPct: summary.cpuBusyPct,
    cpuTotalPct: summary.cpuTotalPct,
    // The heap counts garbage, so one reading means little: the step's lowest and highest.
    heapMb: heapMb.length === 0 ? null : Math.min(...heapMb),
    heapPeakMb: heapMb.length === 0 ? null : Math.max(...heapMb),
    footprintMb: footprint?.jsMb ?? null,
    footprintTotalMb: footprint?.totalMb ?? null,
    footprintWorkerMb: footprint?.workerMb ?? null,
    extras: { ...cpuSplit(result), entities: applied.entities, primitives: applied.primitives },
  };
}

/** A run as the tables read it. */
export const sweepRunOf = (run: BenchmarkRun<SweepStep>): SweepRun => ({
  results: run.results.map(sweepResultOf),
  startedAtIso: run.startedAtIso,
  spec: run.spec,
  environment: run.environment,
  options: { ...run.options },
  catalogSize: run.catalogSize,
  cancelled: run.cancelled,
});
