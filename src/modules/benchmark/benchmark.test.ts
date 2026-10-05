import { describe, expect, test } from "vitest";

import { buildPlan, CUMULATIVE_COMPONENT_SETS, estimateDurationMs, formatSeries, ISOLATED_COMPONENT_SETS, type BenchmarkStep } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun, SceneApplied } from "./benchmarkRunner";
import { FrameSampler, JANK_MS, seriesStats } from "./frameSampler";
import {
  absoluteFitTrustworthy,
  formatTable,
  gpuTimerTrustworthy,
  hasFootprints,
  isDrifted,
  marginalCosts,
  memoryFits,
  memoryFitTrustworthy,
  propagationCosts,
  repeatChecks,
  reportRows,
  type RepeatCheck,
  scalingFits,
  thinRows,
  toCsv,
} from "./report";

// A result carrying only what the report reads.
function result(options: {
  sats: number;
  components: string[];
  clock?: number;
  cpuMs: number;
  gpuMs?: number;
  wallMs?: number;
  tickMs?: number;
  repeat?: boolean;
  buildMs?: number;
  visible?: number;
  frames?: number;
  heapMb?: readonly number[];
  footprintMb?: number;
}): BenchmarkResult {
  const clock = options.clock ?? 1;
  const components = options.components;
  const step: BenchmarkStep = {
    index: 0,
    satelliteCount: options.sats,
    components,
    clockMultiplier: clock,
    repeat: options.repeat ?? false,
    series: formatSeries(components, clock),
    label: "",
  };
  const applied: SceneApplied = {
    satellitesRequested: options.sats,
    satellitesVisible: options.visible ?? options.sats,
    componentsRequested: components,
    componentsDrawn: components,
    componentInstances: {},
    clockMultiplier: clock,
    entities: 0,
    primitives: 0,
    clearMs: 0,
    buildMs: options.buildMs ?? 0,
  };
  const frames = options.frames ?? 100;
  return {
    step,
    applied,
    frames: {
      frames,
      elapsedMs: frames * 10,
      fps: 100,
      wall: seriesStats([options.wallMs ?? 10]),
      cpu: seriesStats([options.cpuMs]),
      tick: seriesStats([options.tickMs ?? 0]),
      gpu: options.gpuMs === undefined ? undefined : seriesStats([options.gpuMs]),
      heap: options.heapMb === undefined ? undefined : seriesStats(options.heapMb),
      jankFrames: 0,
      jankRatio: 0,
    },
    footprint: options.footprintMb === undefined ? undefined : { totalMb: options.footprintMb * 1.4, jsMb: options.footprintMb, workerMb: 0, elapsedMs: 17_000 },
  };
}

const run = (results: BenchmarkResult[]): BenchmarkRun => ({
  startedAtIso: "2026-01-01T00:00:00.000Z",
  spec: { satelliteCounts: [], componentSets: [] },
  environment: {},
  options: { warmupMs: 0, sampleMs: 0 },
  catalogSize: 0,
  results,
  cancelled: false,
});

describe("seriesStats", () => {
  test("no values means no stats, rather than a row of zeroes", () => {
    expect(seriesStats([])).toBeUndefined();
  });

  test("percentiles come off the sorted values, whatever order they arrived in", () => {
    const stats = seriesStats([50, 10, 30, 20, 40]);
    expect(stats).toMatchObject({ count: 5, min: 10, max: 50, mean: 30, p50: 30 });
  });

  test("the input array is left in its arrival order", () => {
    const values = [3, 1, 2];
    seriesStats(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("FrameSampler", () => {
  test("the first push only sets the origin, so one timestamp is no frame", () => {
    const sampler = new FrameSampler();
    sampler.push(1000);
    expect(sampler.frames).toBe(0);
    expect(sampler.snapshot().wall).toBeUndefined();
  });

  test("deltas between timestamps become the wall series", () => {
    const sampler = new FrameSampler();
    for (const [index, time] of [0, 10, 20, 30].entries()) {
      sampler.push(1000 + time, index);
    }
    const snapshot = sampler.snapshot();
    expect(snapshot.frames).toBe(3);
    expect(snapshot.elapsedMs).toBe(30);
    expect(snapshot.fps).toBeCloseTo(100);
    expect(snapshot.wall?.mean).toBe(10);
  });

  test("reset bumps the epoch, so a reading in flight can tell it is stale", () => {
    const sampler = new FrameSampler();
    const issued = sampler.epoch;
    sampler.pushGpu(5);
    expect(sampler.snapshot().gpu?.mean).toBe(5);

    sampler.reset();
    expect(sampler.epoch).not.toBe(issued);
    // What the collector does with a stale reading: nothing.
    if (sampler.epoch === issued) {
      sampler.pushGpu(250);
    }
    expect(sampler.snapshot().gpu).toBeUndefined();

    // A reading issued after the reset still lands.
    sampler.pushGpu(7);
    expect(sampler.snapshot().gpu?.mean).toBe(7);
  });

  test("frames slower than 30 fps count as jank", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10);
    sampler.push(10 + JANK_MS + 1);
    const snapshot = sampler.snapshot();
    expect(snapshot.jankFrames).toBe(1);
    expect(snapshot.jankRatio).toBeCloseTo(0.5);
  });

  test("reset drops the samples but keeps the origin, so no frame is lost at the seam", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(100);
    sampler.reset();
    sampler.push(110);
    expect(sampler.frames).toBe(1);
    expect(sampler.snapshot().wall?.mean).toBe(10);
  });

  test("a limit makes the window roll rather than grow", () => {
    const sampler = new FrameSampler(2);
    for (let i = 0; i <= 10; i += 1) {
      sampler.push(i * 10);
    }
    expect(sampler.frames).toBe(2);
  });
});

describe("buildPlan", () => {
  test("counts are deduplicated, sorted and cleared of nonsense", () => {
    const steps = buildPlan({ satelliteCounts: [100, 0, 100, -5, 10.5], componentSets: [["Point"]] });
    expect(steps.filter((step) => !step.repeat).map((step) => step.satelliteCount)).toEqual([0, 100]);
  });

  test("component sets are outermost so a cancelled sweep leaves whole series", () => {
    const steps = buildPlan({ satelliteCounts: [1, 2], componentSets: [["Point"], ["Label"]], repeatFirstStep: false });
    expect(steps.map((step) => `${step.components.join()}@${step.satelliteCount}`)).toEqual(["Point@1", "Point@2", "Label@1", "Label@2"]);
  });

  test("the clock is a real axis, and one value unless asked for", () => {
    const plain = buildPlan({ satelliteCounts: [1], componentSets: [["Point"]], repeatFirstStep: false });
    expect(plain.map((step) => step.clockMultiplier)).toEqual([1]);

    const swept = buildPlan({ satelliteCounts: [1, 2], componentSets: [["Point"]], clockMultipliers: [1, 100], repeatFirstStep: false });
    expect(swept.map((step) => `${step.clockMultiplier}@${step.satelliteCount}`)).toEqual(["1@1", "1@2", "100@1", "100@2"]);
  });

  test("the series names the clock only when it is not real time", () => {
    expect(formatSeries(["Point"], 1)).toBe("Point");
    expect(formatSeries(["Point"], 100)).toBe("Point @ ×100");
  });

  test("the first step is re-run last, and marked", () => {
    const steps = buildPlan({ satelliteCounts: [10, 20], componentSets: [["Point"]] });
    const last = steps[steps.length - 1] as BenchmarkStep;
    expect(steps).toHaveLength(3);
    expect(last.repeat).toBe(true);
    expect(last.satelliteCount).toBe(10);
    expect(steps.filter((step) => step.repeat)).toHaveLength(1);
  });

  test("a lone step is not repeated — there would be nothing to compare it against", () => {
    expect(buildPlan({ satelliteCounts: [10], componentSets: [["Point"]] })).toHaveLength(1);
  });

  test("the cumulative sets grow by one component and start from nothing", () => {
    expect(CUMULATIVE_COMPONENT_SETS[0]).toEqual([]);
    expect(CUMULATIVE_COMPONENT_SETS[1]).toEqual(["Point"]);
    for (const [index, set] of CUMULATIVE_COMPONENT_SETS.entries()) {
      expect(set).toHaveLength(index);
    }
  });

  test("the isolated sets are Point plus exactly one other", () => {
    expect(ISOLATED_COMPONENT_SETS[0]).toEqual(["Point"]);
    for (const set of ISOLATED_COMPONENT_SETS.slice(1)) {
      expect(set[0]).toBe("Point");
      expect(set).toHaveLength(2);
    }
  });
});

describe("scalingFits", () => {
  test("a linear cost is reported as its slope per 1,000 satellites", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 500, components: ["Point"], cpuMs: 10 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 15 }),
      ]),
    );
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ series: "Point", mainMsPer1000: 10, baseMainMs: 5, r2: 1 });
  });

  test("clock rates are separate series, never one averaged fit", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 10 }),
        result({ sats: 0, components: ["Point"], clock: 100, cpuMs: 20 }),
        result({ sats: 1000, components: ["Point"], clock: 100, cpuMs: 60 }),
      ]),
    );
    expect(fits.map((fit) => fit.series)).toEqual(["Point", "Point @ ×100"]);
    expect(fits[1]?.mainMsPer1000).toBe(40);
  });

  test("the repeat step is left out, so it cannot weight one point twice", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 15 }),
        result({ sats: 0, components: ["Point"], cpuMs: 500, repeat: true }),
      ]),
    );
    expect(fits[0]).toMatchObject({ points: 2, mainMsPer1000: 10, baseMainMs: 5 });
  });

  test("the fit counts the clock tick, not just the render", () => {
    const fits = scalingFits(run([result({ sats: 0, components: ["Point"], cpuMs: 1, tickMs: 0 }), result({ sats: 1000, components: ["Point"], cpuMs: 1, tickMs: 10 })]));

    // cpuMs is flat across these two rows; all the growth is in the tick.
    expect(fits[0]?.mainMsPer1000).toBe(10);
    expect(fits[0]?.baseMainMs).toBe(1);
  });

  test("satsAt60fps is blank when the floor alone has eaten the budget", () => {
    const fits = scalingFits(run([result({ sats: 0, components: ["Point"], cpuMs: 1, wallMs: 40 }), result({ sats: 1000, components: ["Point"], cpuMs: 2, wallMs: 42 })]));

    expect(fits[0]?.floorMs).toBe(40);
    expect(fits[0]?.satsAt60fps).toBe("");
  });

  test("satsAt60fps is blank when the fixed cost already blows the budget", () => {
    const fits = scalingFits(run([result({ sats: 0, components: ["Point"], cpuMs: 30 }), result({ sats: 1000, components: ["Point"], cpuMs: 40 })]));
    expect(fits[0]?.satsAt60fps).toBe("");
  });
});

describe("marginalCosts", () => {
  test("a set is differenced against the largest subset measured beside it", () => {
    const costs = marginalCosts(
      run([
        result({ sats: 100, components: ["Point"], cpuMs: 10 }),
        result({ sats: 100, components: ["Point", "Label"], cpuMs: 14 }),
        result({ sats: 100, components: ["Point", "Label", "Orbit"], cpuMs: 20 }),
      ]),
    );
    expect(costs).toEqual([
      { sats: 100, clock: 1, added: "Label", over: "Point", deltaMainMs: 4, usPerSatellite: 40 },
      { sats: 100, clock: 1, added: "Orbit", over: "Point + Label", deltaMainMs: 6, usPerSatellite: 60 },
    ]);
  });

  test("rows under different clocks are never differenced against each other", () => {
    const costs = marginalCosts(run([result({ sats: 100, components: ["Point"], cpuMs: 10 }), result({ sats: 100, components: ["Point", "Label"], clock: 100, cpuMs: 90 })]));
    expect(costs).toEqual([]);
  });

  test("a set with no subset beside it yields no row rather than a bogus baseline", () => {
    const costs = marginalCosts(run([result({ sats: 100, components: ["Label"], cpuMs: 10 }), result({ sats: 100, components: ["Orbit"], cpuMs: 20 })]));
    expect(costs).toEqual([]);
  });
});

describe("propagationCosts", () => {
  test("each rate is differenced against x1 for the same scene", () => {
    const costs = propagationCosts(
      run([
        result({ sats: 200, components: ["Point"], cpuMs: 1, tickMs: 10 }),
        result({ sats: 200, components: ["Point"], clock: 100, cpuMs: 1, tickMs: 30 }),
        result({ sats: 200, components: ["Point"], clock: 1000, cpuMs: 1, tickMs: 110 }),
      ]),
    );
    expect(costs.map((cost) => [cost.clock, cost.deltaTickMs, cost.usPerSatellite])).toEqual([
      [100, 20, 100],
      [1000, 100, 500],
    ]);
  });

  test("sees a cost that cpuMs cannot", () => {
    const costs = propagationCosts(
      run([result({ sats: 5000, components: ["Point"], cpuMs: 1.28, tickMs: 0.2 }), result({ sats: 5000, components: ["Point"], clock: 10000, cpuMs: 1.2, tickMs: 460 })]),
    );

    // cpuMs went *down* between these two rows; the tick went up by 460 ms.
    expect(costs).toHaveLength(1);
    expect(costs[0]?.deltaTickMs).toBeCloseTo(459.8, 1);
    expect(costs[0]?.usPerSatellite).toBeGreaterThan(90);
    expect(costs[0]?.cpuMs).toBeLessThan(costs[0]?.tickMs ?? 0);
  });

  test("without a x1 row there is nothing to difference against", () => {
    const costs = propagationCosts(
      run([result({ sats: 200, components: ["Point"], clock: 100, cpuMs: 1, tickMs: 30 }), result({ sats: 200, components: ["Point"], clock: 1000, cpuMs: 1, tickMs: 110 })]),
    );
    expect(costs).toEqual([]);
  });

  test("a run that never swept the clock reports nothing at all", () => {
    expect(propagationCosts(run([result({ sats: 200, components: ["Point"], cpuMs: 10 })]))).toEqual([]);
  });
});

describe("repeatChecks", () => {
  test("the repeat is matched to its original and reported as drift", () => {
    const checks = repeatChecks(
      run([
        result({ sats: 100, components: ["Point"], cpuMs: 10, buildMs: 800 }),
        result({ sats: 500, components: ["Point"], cpuMs: 20, buildMs: 100 }),
        result({ sats: 100, components: ["Point"], cpuMs: 11, buildMs: 200, repeat: true }),
      ]),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ sats: 100, firstMainMs: 10, repeatMainMs: 11, mainDriftPct: 10, firstBuildMs: 800, repeatBuildMs: 200, buildDriftPct: -75 });
  });

  test("drift is only untrustworthy when it is both proportional and material", () => {
    const check = (firstMainMs: number, repeatMainMs: number): RepeatCheck => ({
      sats: 0,
      components: "Point",
      clock: 1,
      firstMainMs,
      repeatMainMs,
      mainDriftPct: ((repeatMainMs - firstMainMs) / firstMainMs) * 100,
      firstBuildMs: 0,
      repeatBuildMs: 0,
      buildDriftPct: 0,
    });

    // Noise on a 2 ms control step.
    expect(isDrifted(check(2.2, 1.79))).toBe(false);
    // The same proportion where it is worth milliseconds.
    expect(isDrifted(check(11, 18))).toBe(true);
    // Material but proportionally small: a big scene that moved a little.
    expect(isDrifted(check(200, 202))).toBe(false);
  });

  test("a run without a repeat step reports nothing", () => {
    expect(repeatChecks(run([result({ sats: 100, components: ["Point"], cpuMs: 10 })]))).toEqual([]);
  });
});

describe("gpu timing", () => {
  test("a plausible GPU time is reported", () => {
    const rows = reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 })]));
    expect(rows[0]?.gpuMs).toBe(9);
  });

  test("a GPU-bound scene, where gpu approaches the frame interval, is still believed", () => {
    const rows = reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 13.5, wallMs: 14 })]));
    expect(rows[0]?.gpuMs).toBe(13.5);
  });

  test("a timer claiming more GPU than the frame it presented in is withheld", () => {
    // The ANGLE/Metal case.
    const bad = run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 49, wallMs: 14 })]);
    expect(gpuTimerTrustworthy(bad)).toBe(false);
    expect(reportRows(bad)[0]?.gpuMs).toBe("");
  });

  test("one odd step does not discredit a run, a majority does", () => {
    const mostlyFine = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
      result({ sats: 1, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
      result({ sats: 2, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
    ]);
    expect(gpuTimerTrustworthy(mostlyFine)).toBe(true);

    const mostlyBad = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
      result({ sats: 1, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
      result({ sats: 2, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
    ]);
    expect(gpuTimerTrustworthy(mostlyBad)).toBe(false);
  });

  test("no GPU samples at all is blank, not zero", () => {
    const none = run([result({ sats: 0, components: ["Point"], cpuMs: 1 })]);
    expect(gpuTimerTrustworthy(none)).toBe(false);
    expect(reportRows(none)[0]?.gpuMs).toBe("");
  });

  test("the sampler keeps GPU timings as their own population", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10, 1);
    sampler.push(20, 1);
    // Two frames, one GPU result — they arrive out of step and are not paired.
    sampler.pushGpu(8);
    const snap = sampler.snapshot();
    expect(snap.frames).toBe(2);
    expect(snap.gpu?.count).toBe(1);
    expect(snap.gpu?.mean).toBe(8);
  });

  test("reset clears GPU timings with everything else", () => {
    const sampler = new FrameSampler();
    sampler.pushGpu(8);
    sampler.reset();
    expect(sampler.snapshot().gpu).toBeUndefined();
  });
});

describe("thinRows", () => {
  test("rows sampled over too few frames are the ones flagged", () => {
    const thin = thinRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, frames: 3 }), result({ sats: 1, components: ["Point"], cpuMs: 1, frames: 300 })]));
    expect(thin.map((row) => row.frames)).toEqual([3]);
  });
});

describe("toCsv", () => {
  test("the header names every column of the row beneath it", () => {
    const csv = toCsv(run([result({ sats: 1, components: ["Point", "Label"], cpuMs: 1 })]));
    const [header, row] = csv.split("\n");
    expect(header?.split(",")).toContain("components");
    expect(row?.split(",")).toHaveLength(header?.split(",").length ?? 0);
  });

  test("a value carrying a comma is quoted rather than left to split the row", () => {
    // Defensive: component names cannot contain commas (CONTEXT.md).
    const csv = toCsv(run([result({ sats: 1, components: ["Point", "A,B"], cpuMs: 1 })]));
    const [header, row] = csv.split("\n");
    expect(row).toContain('"Point + A,B"');
    expect(row?.split(",")).toHaveLength((header?.split(",").length ?? 0) + 1);
  });

  test("an empty run is an empty string rather than a lone header", () => {
    expect(toCsv(run([]))).toBe("");
  });
});

describe("memoryFits", () => {
  // Two series with offsets 400 MB apart and the same per-satellite cost.
  test("the garbage offset lands in the intercept, not the slope", () => {
    const clean = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [40] }),
      result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [93] }),
      result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5000, heapMb: [310] }),
    ]);
    const dirty = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [440] }),
      result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [493] }),
      result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5000, heapMb: [710] }),
    ]);
    expect(memoryFits(clean)[0]?.mbPer1000Sats).toBe(memoryFits(dirty)[0]?.mbPer1000Sats);
    expect(memoryFits(clean)[0]?.baseMb).not.toBe(memoryFits(dirty)[0]?.baseMb);
  });

  test("reports the slope per 1,000 and per satellite", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [40] }),
        result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5000, heapMb: [40 + 250] }),
      ]),
    );
    expect(fits[0]?.mbPer1000Sats).toBe(50);
    // 50 MB per 1,000 is 51.2 KB each, not 50 — the unit change is binary.
    expect(fits[0]?.kbPerSatellite).toBe(51.2);
    expect(fits[0]?.baseMb).toBe(40);
  });

  test("fits against satellites drawn, not the count asked for", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [10] }),
        // Only half applied, so the same heap growth is twice the cost each.
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 500, heapMb: [60] }),
      ]),
    );
    expect(fits[0]?.mbPer1000Sats).toBe(100);
  });

  test("clock rates are separate series, as everywhere else", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [10], clock: 1 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [60], clock: 1 }),
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [10], clock: 100 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [110], clock: 100 }),
      ]),
    );
    expect(fits.map((fit) => fit.mbPer1000Sats)).toEqual([50, 100]);
  });

  // Measured: a major GC between the zero row and the next.
  test("a collection landing mid-series shows up as scatter, not a plausible slope", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [419.2] }),
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1001, heapMb: [100.8] }),
        result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5001, heapMb: [299.9] }),
      ]),
    );
    expect(fits[0]?.mbPer1000Sats).toBeLessThan(0);
    expect(memoryFitTrustworthy(fits[0]!)).toBe(false);
  });

  test("a clean series clears the r² guard comfortably", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [50.7] }),
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1001, heapMb: [95.4] }),
        result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5001, heapMb: [310.5] }),
      ]),
    );
    // Measured: 53.7 KB against 52.5 from a forced collection.
    expect(fits[0]?.kbPerSatellite).toBeCloseTo(53.7, 0);
    expect(memoryFitTrustworthy(fits[0]!)).toBe(true);
  });

  test("a two-count sweep is refused however well it fits", () => {
    const fits = memoryFits(
      run([result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [53] }), result({ sats: 100, components: ["Point"], cpuMs: 1, visible: 100, heapMb: [73.4] })]),
    );
    expect(fits[0]?.r2).toBe(1);
    expect(memoryFitTrustworthy(fits[0]!)).toBe(false);
  });

  test("no heap reading means no rows, rather than a fit through zeroes", () => {
    const fits = memoryFits(run([result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0 }), result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5000 })]));
    expect(fits).toEqual([]);
  });

  test("the repeat step is excluded, as it is from every other fit", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [10] }),
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [60] }),
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [500], repeat: true }),
      ]),
    );
    expect(fits[0]?.points).toBe(2);
    expect(fits[0]?.mbPer1000Sats).toBe(50);
  });
});

describe("the footprint capture", () => {
  const withFootprints = (points: readonly { visible: number; jsMb: number; floorMb: number }[]) =>
    run(points.map((point) => result({ sats: point.visible, visible: point.visible, components: ["Point"], cpuMs: 1, heapMb: [point.floorMb], footprintMb: point.jsMb })));

  test("the measured slope sits beside the derived one", () => {
    const fits = memoryFits(
      withFootprints([
        { visible: 0, jsMb: 30.2, floorMb: 50.7 },
        { visible: 1001, jsMb: 82.8, floorMb: 95.4 },
        { visible: 5001, jsMb: 287.7, floorMb: 310.5 },
      ]),
    );
    // Both near the 52.5 KB a forced collection reported.
    expect(fits[0]?.kbPerSatellite).toBeCloseTo(53.7, 0);
    expect(fits[0]?.absoluteKbPerSatellite).toBeCloseTo(52.7, 0);
    expect(absoluteFitTrustworthy(fits[0]!)).toBe(true);
  });

  test("blank where the run never captured one, rather than zero", () => {
    const fits = memoryFits(
      run([result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [10] }), result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1000, heapMb: [60] })]),
    );
    expect(fits[0]?.absoluteKbPerSatellite).toBeUndefined();
    expect(reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1 })]))[0]?.footprintMb).toBe("");
  });

  test("a refused capture is judged on its own points, not the floor fit's", () => {
    const fits = memoryFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 1, visible: 0, heapMb: [50.7], footprintMb: 30.2 }),
        // Capture refused: heap floor present, footprint absent.
        result({ sats: 1000, components: ["Point"], cpuMs: 1, visible: 1001, heapMb: [95.4] }),
        result({ sats: 5000, components: ["Point"], cpuMs: 1, visible: 5001, heapMb: [310.5], footprintMb: 287.7 }),
      ]),
    );
    expect(memoryFitTrustworthy(fits[0]!)).toBe(true);
    expect(fits[0]?.absolutePoints).toBe(2);
    expect(fits[0]?.absoluteKbPerSatellite).not.toBeUndefined();
    expect(absoluteFitTrustworthy(fits[0]!)).toBe(false);
  });

  test("hasFootprints is the one predicate both readers use", () => {
    expect(hasFootprints(run([result({ sats: 0, components: ["Point"], cpuMs: 1, heapMb: [40] })]))).toBe(false);
    expect(hasFootprints(run([result({ sats: 0, components: ["Point"], cpuMs: 1, heapMb: [40], footprintMb: 30 })]))).toBe(true);
  });

  test("the absolute figures reach the rows, total and js apart", () => {
    const rows = reportRows(withFootprints([{ visible: 5001, jsMb: 297.4, floorMb: 310.5 }]));
    expect(rows[0]?.footprintMb).toBe(297.4);
    expect(Number(rows[0]?.footprintTotalMb)).toBeGreaterThan(297.4);
  });

  test("the pasted table grows a memory column only when one was captured", () => {
    expect(formatTable(withFootprints([{ visible: 0, jsMb: 30, floorMb: 50 }])).split("\n")[0]).toContain("footprint");
    expect(formatTable(run([result({ sats: 0, components: ["Point"], cpuMs: 1 })])).split("\n")[0]).not.toContain("footprint");
  });
});

describe("estimateDurationMs with a footprint capture", () => {
  test("the capture is added per step, not amortised", () => {
    const steps = buildPlan({ satelliteCounts: [0, 100, 500], componentSets: [["Point"]], repeatFirstStep: false });
    const plain = estimateDurationMs(steps, 6000);
    const withCapture = estimateDurationMs(steps, 6000, 17_000);
    expect(withCapture - plain).toBe(steps.length * 17_000);
  });

  test("no capture leaves the estimate exactly as it was", () => {
    const steps = buildPlan({ satelliteCounts: [0, 100], componentSets: [["Point"]], repeatFirstStep: false });
    expect(estimateDurationMs(steps, 6000, 0)).toBe(estimateDurationMs(steps, 6000));
  });
});

describe("the raw heap columns", () => {
  test("stay out of the pasted table but remain in the csv", () => {
    const one = run([result({ sats: 0, components: ["Point"], cpuMs: 1, heapMb: [40, 50] })]);
    expect(formatTable(one).split("\n")[0]).not.toContain("heap");
    expect(toCsv(one).split("\n")[0]?.split(",")).toEqual(expect.arrayContaining(["heapMb", "heapPeakMb"]));
  });

  test("carry the window's floor and peak, not an average", () => {
    const rows = reportRows(run([result({ sats: 5000, components: ["Point"], cpuMs: 1, heapMb: [413, 462.2, 86.3, 300] })]));
    expect(rows[0]?.heapMb).toBe(86.3);
    expect(rows[0]?.heapPeakMb).toBe(462.2);
  });

  test("blank on a browser that offers no reading, rather than zero", () => {
    const rows = reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1 })]));
    expect(rows[0]?.heapMb).toBe("");
    expect(rows[0]?.heapPeakMb).toBe("");
  });
});

describe("FrameSampler heap series", () => {
  test("a frame without a reading is still a frame", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10);
    sampler.push(20);
    expect(sampler.snapshot().frames).toBe(2);
    expect(sampler.snapshot().heap).toBeUndefined();
  });

  test("the heap is its own population, min and max over the window", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10);
    sampler.pushHeap(413);
    sampler.pushHeap(86.3);
    sampler.pushHeap(462.2);
    const heap = sampler.snapshot().heap;
    expect(heap?.min).toBe(86.3);
    expect(heap?.max).toBe(462.2);
    expect(heap?.count).toBe(3);
  });

  test("reset drops the heap samples with the rest of the warmup", () => {
    const sampler = new FrameSampler();
    sampler.pushHeap(999);
    sampler.reset();
    sampler.pushHeap(40);
    expect(sampler.snapshot().heap?.max).toBe(40);
  });

  test("a limit rolls the heap window too, so the live readout stays recent", () => {
    const sampler = new FrameSampler(2);
    sampler.pushHeap(900);
    sampler.pushHeap(41);
    sampler.pushHeap(42);
    expect(sampler.snapshot().heap?.max).toBe(42);
  });
});
