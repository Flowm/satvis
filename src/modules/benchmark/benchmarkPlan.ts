// What a run measures (ADR 0016): a preset's benchmark scenes, or a sweep's count × components × clock.

import { SATELLITE_COMPONENTS } from "@/config/components";
import type { BenchmarkScene } from "@/modules/util/gpSource";

/** A link the target opens, waits for, settles and measures, in both apps. */
export interface SceneStep {
  /** As the preset served it. */
  scene: BenchmarkScene;
  /** `<id>_repeat` for the drift check. */
  id: string;
  /** The scene's: measured as load, not frame rate. */
  paced: boolean;
  /** The drift check's re-run of the first scene. */
  repeat: boolean;
  /** The scene's name, marked on the repeat. */
  label: string;
}

/** What a link cannot say: the first `satelliteCount` of the catalog, past the label and model budgets, unpaced. */
export interface SweepStep {
  /** From 0, the globe alone. */
  satelliteCount: number;
  /** The component set, by `SATELLITE_COMPONENTS` name. */
  components: string[];
  /** ×1 is real time. */
  clockMultiplier: number;
  /** The closing re-run of the first step, left out of every derived table. */
  repeat: boolean;
  /** Count, series and repeat, as the log and the tables show it. */
  label: string;
}

/** One thing a run sets up and measures. */
export type BenchmarkStep = SceneStep | SweepStep;

/** Whether a step opens a scene's link rather than a sweep's set. */
export const isSceneStep = (step: BenchmarkStep): step is SceneStep => "scene" in step;

/** The scenes, then the first again for the drift check. `only` runs those scene ids alone, without it. */
export function planScenes(scenes: readonly BenchmarkScene[], only: readonly string[] = []): SceneStep[] {
  const step = (scene: BenchmarkScene, repeat = false): SceneStep => ({
    scene,
    id: repeat ? `${scene.id}_repeat` : scene.id,
    paced: scene.paced,
    repeat,
    label: repeat ? `${scene.name} (repeat)` : scene.name,
  });
  if (only.length > 0) {
    return scenes.filter((scene) => only.includes(scene.id)).map((scene) => step(scene));
  }
  const first = scenes[0];
  return first ? [...scenes.map((scene) => step(scene)), step(first, true)] : [];
}

/** A sweep's axes; its steps are every combination of them (`buildPlan`). */
export interface PlanSpec {
  /** Deduplicated and sorted; negative and fractional counts are dropped. */
  satelliteCounts: readonly number[];
  /** Outermost, in this order. */
  componentSets: readonly (readonly string[])[];
  /** ×1 alone by default. */
  clockMultipliers?: readonly number[];
  /** On by default: the drift check. */
  repeatFirstStep?: boolean;
}

/** 0, the globe alone, is every row's baseline. Each count costs about 10 s; more barely moved the fit. */
export const DEFAULT_SATELLITE_COUNTS: readonly number[] = [0, 100, 500, 1000, 5000];

/**
 * `SampledTrajectory` re-propagates its window (120 samples per orbit) every simulated
 * quarter orbit, not every frame, so sweeping the clock separates propagation from drawing.
 */
export const DEFAULT_CLOCK_MULTIPLIERS: readonly number[] = [1, 10, 100, 1000];

/** A harness sanity check, not a measurement. */
export const QUICK_SATELLITE_COUNTS: readonly number[] = [0, 100, 1000];

/** Orbit is rebuilt on every trajectory window refresh, so a faster clock shows most there. */
export const CLOCK_COMPONENT_SETS: readonly (readonly string[])[] = [["Point", "Orbit"]];

/** Each set adds one component, so consecutive rows differ by that component's cost. */
export const CUMULATIVE_COMPONENT_SETS: readonly (readonly string[])[] = ((): string[][] => {
  const sets: string[][] = [[]];
  for (const component of SATELLITE_COMPONENTS) {
    sets.push([...(sets[sets.length - 1] as string[]), component]);
  }
  return sets;
})();

/** Point is the baseline, as a satellite exists even without one. */
export const ISOLATED_COMPONENT_SETS: readonly (readonly string[])[] = [
  ["Point"],
  ...SATELLITE_COMPONENTS.filter((component) => component !== "Point").map((component) => ["Point", component]),
];

/** As the console's `bench.<name>()` and both apps' panels run them. */
export const NAMED_SWEEPS: Readonly<Record<"quick" | "run" | "cumulative" | "clock", PlanSpec>> = {
  /** A harness sanity check. */
  quick: { satelliteCounts: QUICK_SATELLITE_COUNTS, componentSets: ISOLATED_COMPONENT_SETS },
  /** Point alone, then each other component beside it. */
  run: { satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: ISOLATED_COMPONENT_SETS },
  /** Components added one by one. */
  cumulative: { satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: CUMULATIVE_COMPONENT_SETS },
  /** The propagation axis. */
  clock: { satelliteCounts: DEFAULT_SATELLITE_COUNTS, componentSets: CLOCK_COMPONENT_SETS, clockMultipliers: DEFAULT_CLOCK_MULTIPLIERS },
};

/** Ground station links need a station to draw. */
export const SWEEP_GROUND_STATION = { lat: 48.1772, lon: 11.7476 } as const;

/** A component set as the tables name it. */
export const formatComponents = (components: readonly string[]): string => (components.length === 0 ? "(none)" : components.join(" + "));

/** A set and a clock as one series of the tables, the clock left out at ×1. */
export const formatSeries = (components: readonly string[], clockMultiplier: number): string =>
  clockMultiplier === 1 ? formatComponents(components) : `${formatComponents(components)} @ ×${clockMultiplier}`;

/**
 * Component sets outermost, so a cancelled sweep leaves whole series. The repeat of the
 * first step detects drift (warm shader caches, JIT, heap growth).
 */
export function buildPlan(spec: PlanSpec): SweepStep[] {
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  const counts = [...new Set(spec.satelliteCounts)].filter((count) => Number.isInteger(count) && count >= 0).sort((a, b) => a - b);
  const multipliers = [...new Set(spec.clockMultipliers ?? [1])].filter((value) => Number.isFinite(value) && value > 0);
  const steps: SweepStep[] = [];
  const push = (satelliteCount: number, components: readonly string[], clockMultiplier: number, repeat: boolean): void => {
    const series = formatSeries(components, clockMultiplier);
    steps.push({
      satelliteCount,
      components: [...components],
      clockMultiplier,
      repeat,
      label: `${satelliteCount} sats · ${series}${repeat ? " (repeat)" : ""}`,
    });
  };

  for (const components of spec.componentSets) {
    for (const clockMultiplier of multipliers) {
      for (const satelliteCount of counts) {
        push(satelliteCount, components, clockMultiplier, false);
      }
    }
  }

  const first = steps[0];
  if (first && steps.length > 1 && (spec.repeatFirstStep ?? true)) {
    push(first.satelliteCount, first.components, first.clockMultiplier, true);
  }
  return steps;
}

/** A footprint capture waits about 17 s for a GC, more than the rest of a step. */
export function estimateDurationMs(steps: readonly unknown[], perStepMs: number, footprintMs = 0): number {
  // 400 ms approximates the build, which grows with the count.
  return steps.length * (perStepMs + 400 + footprintMs);
}
