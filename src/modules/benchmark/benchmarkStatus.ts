// The benchmark panel's status line; the native BenchmarkStatus is held to it by a parity fixture.

import type { RunKind } from "./benchmarkRunner";
import { driftPct, MIN_MEANINGFUL_DRIFT_MS } from "./report";

/** Where a run stands, as the status line names it. */
export type RunPhase = "idle" | "loading" | "settling" | "measuring" | "done" | "cancelled";

/** What the status line and the progress bar show. */
export interface RunStatus {
  /** Idle until a run of `kind` starts. */
  phase: RunPhase;
  /** Names the loading phase and the count. */
  kind: RunKind;
  /** From 0. */
  index: number;
  /** Before a run, the steps a run would take. */
  total: number;
  /** Before a run, its estimate; during one, what is left. */
  remainingMs: number;
  /** Once a run is done (`shownDrift`). */
  driftPct?: number | null;
  /** Once a run is cancelled, the steps it finished. */
  measured?: number;
}

/** The load, a 3 s settle and a 5 s measure. */
export const SCENE_STEP_ESTIMATE_MS = 12_000;

/**
 * Percent, positive where the repeat got slower; null under `MIN_MEANINGFUL_DRIFT_MS` apart,
 * where a light step's few percent are noise (the iPad's 0.3 ms read -16 % and +22 %).
 */
export function shownDrift(firstMs: number | null | undefined, repeatMs: number | null | undefined): number | null {
  if (firstMs === null || firstMs === undefined || repeatMs === null || repeatMs === undefined || firstMs <= 0) {
    return null;
  }
  return Math.abs(repeatMs - firstMs) < MIN_MEANINGFUL_DRIFT_MS ? null : driftPct(firstMs, repeatMs);
}

/** Whole seconds under 90 s, rounded minutes from there. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The status line's word for a phase, by run kind. */
const PHASES: Record<"loading" | "settling" | "measuring", Record<RunKind, string>> = {
  /** A sweep builds its step rather than loading a link. */
  loading: { scenes: "Loading", sweep: "Building" },
  /** The unrecorded warmup. */
  settling: { scenes: "Settling", sweep: "Settling" },
  /** The recorded sample. */
  measuring: { scenes: "Measuring", sweep: "Measuring" },
};

/** What a step is doing, as the status line and the current scene's row name it. */
export function phaseLabel(phase: keyof typeof PHASES, kind: RunKind): string {
  return PHASES[phase][kind];
}

/** "10 scenes · ≈ 2 min", "4 of 7 · Measuring · 1 min left", "Done · drift +0.4 %", "Cancelled · 3 of 7". */
export function statusLine(status: RunStatus): string {
  const noun = status.kind === "scenes" ? (status.total === 1 ? "scene" : "scenes") : status.total === 1 ? "step" : "steps";
  switch (status.phase) {
    case "idle":
      return status.total === 0 ? `No ${noun}` : `${status.total} ${noun} · ≈ ${formatDuration(status.remainingMs)}`;
    case "done":
      return status.driftPct === null || status.driftPct === undefined ? "Done" : `Done · drift ${status.driftPct > 0 ? "+" : ""}${status.driftPct.toFixed(1)} %`;
    case "cancelled":
      return `Cancelled · ${status.measured ?? 0} of ${status.total}`;
    default:
      return `${status.index + 1} of ${status.total} · ${phaseLabel(status.phase, status.kind)} · ${formatDuration(status.remainingMs)} left`;
  }
}
