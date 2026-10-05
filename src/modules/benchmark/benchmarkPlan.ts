// The sweep matrix: a pure spec-to-steps function, readable before anything renders.

import { SATELLITE_COMPONENTS } from "../../config/components";

export interface BenchmarkStep {
  index: number;
  satelliteCount: number;
  components: string[];
  /** See DEFAULT_CLOCK_MULTIPLIERS. */
  clockMultiplier: number;
  /** The closing re-run of the first step. Excluded from every derived table. */
  repeat: boolean;
  /** Component set and clock rate: the report's grouping key, so no fit mixes clocks. */
  series: string;
  label: string;
}

export interface PlanSpec {
  satelliteCounts: readonly number[];
  componentSets: readonly (readonly string[])[];
  /** Defaults to `[1]`. */
  clockMultipliers?: readonly number[];
  /** Close by re-running the first step. Defaults to true. */
  repeatFirstStep?: boolean;
}

/**
 * 0 is the globe on its own, the baseline for every other row. Each count costs
 * about 10 s; more counts barely moved the fit.
 */
export const DEFAULT_SATELLITE_COUNTS: readonly number[] = [0, 100, 500, 1000, 5000];

/**
 * Propagation is paid per simulated quarter orbit, not per frame: `SampledTrajectory`
 * re-propagates its window (120 samples per orbit) on a simulation-time callback.
 * Refreshes per wall second scale with the multiplier, so sweeping it separates
 * propagation from drawing.
 */
export const DEFAULT_CLOCK_MULTIPLIERS: readonly number[] = [1, 10, 100, 1000];

/** Each set adds one component, so consecutive rows differ by that component's cost. */
export const CUMULATIVE_COMPONENT_SETS: readonly (readonly string[])[] = ((): string[][] => {
  const sets: string[][] = [[]];
  for (const component of SATELLITE_COMPONENTS) {
    sets.push([...(sets[sets.length - 1] as string[]), component]);
  }
  return sets;
})();

/** Point plus one other component each. A satellite exists even without a point, so Point is the baseline. */
export const ISOLATED_COMPONENT_SETS: readonly (readonly string[])[] = [
  ["Point"],
  ...SATELLITE_COMPONENTS.filter((component) => component !== "Point").map((component) => ["Point", component]),
];

export const formatComponents = (components: readonly string[]): string => (components.length === 0 ? "(none)" : components.join(" + "));

/** Leaves off the default `×1`. */
export const formatSeries = (components: readonly string[], clockMultiplier: number): string =>
  clockMultiplier === 1 ? formatComponents(components) : `${formatComponents(components)} @ ×${clockMultiplier}`;

/**
 * Component sets outermost, then clock rates, then counts, so a cancelled sweep
 * leaves whole series. The first step is re-run last to detect drift (warm
 * shader caches, JIT, heap growth); `repeatChecks` reports it.
 */
export function buildPlan(spec: PlanSpec): BenchmarkStep[] {
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  const counts = [...new Set(spec.satelliteCounts)].filter((count) => Number.isInteger(count) && count >= 0).sort((a, b) => a - b);
  const multipliers = [...new Set(spec.clockMultipliers ?? [1])].filter((value) => Number.isFinite(value) && value > 0);
  const steps: BenchmarkStep[] = [];
  const push = (satelliteCount: number, components: readonly string[], clockMultiplier: number, repeat: boolean): void => {
    const series = formatSeries(components, clockMultiplier);
    steps.push({
      index: steps.length,
      satelliteCount,
      components: [...components],
      clockMultiplier,
      repeat,
      series,
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
export function estimateDurationMs(steps: readonly BenchmarkStep[], perStepMs: number, footprintMs = 0): number {
  // 400 ms approximates the build, which grows with the count.
  return steps.length * (perStepMs + 400 + footprintMs);
}
