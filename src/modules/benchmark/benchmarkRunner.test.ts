import { describe, expect, test } from "vitest";

import type { PlanSpec } from "./benchmarkPlan";
import { BenchmarkRunner, type BenchmarkOptions, type BenchmarkTarget } from "./benchmarkRunner";

const SPEC: PlanSpec = { satelliteCounts: [0], componentSets: [["Point"]] };
const OPTIONS: BenchmarkOptions = { warmupMs: 0, sampleMs: 0 };

/** A target that records its calls, with `prepare` standing in for the catalog load. */
function fakeTarget(prepare: () => Promise<void>): { target: BenchmarkTarget; calls: string[] } {
  const calls: string[] = [];
  const target: BenchmarkTarget = {
    environment: () => ({}),
    prepare: () => {
      calls.push("prepare");
      return prepare();
    },
    catalogSize: () => 0,
    apply: () => {
      calls.push("apply");
      return Promise.resolve({
        satellitesVisible: 0,
        componentsDrawn: [],
        componentInstances: {},
        clockMultiplier: 1,
        entities: 0,
        primitives: 0,
        clearMs: 0,
        buildMs: 0,
      });
    },
    measure: () => Promise.resolve({ frames: 0, fps: 0, wall: undefined, cpu: undefined, tick: undefined, gpu: undefined, heap: undefined, jankRatio: 0 }),
    measureFootprint: () => Promise.resolve(undefined),
    restore: () => {
      calls.push("restore");
      return Promise.resolve();
    },
  };
  return { target, calls };
}

/** A prepare that waits until `release` is called. */
function heldPrepare(): { prepare: () => Promise<void>; release: () => void } {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { prepare: () => held, release: () => release() };
}

describe("BenchmarkRunner", () => {
  test("is running while the target prepares, before the first step", async () => {
    const { prepare, release } = heldPrepare();
    const { target } = fakeTarget(prepare);
    const runner = new BenchmarkRunner(target);

    const sweep = runner.start(SPEC, OPTIONS);
    expect(runner.running).toBe(true);

    release();
    await sweep;
    expect(runner.running).toBe(false);
  });

  test("refuses a second sweep while the first prepares", async () => {
    const { prepare, release } = heldPrepare();
    const { target, calls } = fakeTarget(prepare);
    const runner = new BenchmarkRunner(target);

    const sweep = runner.start(SPEC, OPTIONS);
    await expect(runner.start(SPEC, OPTIONS)).rejects.toThrow("already running");

    release();
    const run = await sweep;
    expect(run.results).toHaveLength(1);
    expect(calls).toEqual(["prepare", "apply", "restore"]);
  });

  test("restores the target when prepare throws, and can start again", async () => {
    const { target, calls } = fakeTarget(() => Promise.reject(new Error("catalog failed")));
    const runner = new BenchmarkRunner(target);

    await expect(runner.start(SPEC, OPTIONS)).rejects.toThrow("catalog failed");
    expect(calls).toEqual(["prepare", "restore"]);
    expect(runner.running).toBe(false);
    expect(runner.run).toBeUndefined();

    await expect(runner.start(SPEC, OPTIONS)).rejects.toThrow("catalog failed");
    expect(calls).toEqual(["prepare", "restore", "prepare", "restore"]);
  });
});
