import { expect, test } from "vitest";

import { planScenes } from "./benchmarkPlan";
import { drift, reportProperties, type SceneResult } from "./benchmarkReport";
import { summarize } from "./frameSummary";

const result = (id: string, interval: number, cpu = [1.2, 1.3]): SceneResult => ({
  id,
  satellites: 120,
  loadSeconds: 2.345,
  timedOut: false,
  idle: false,
  summary: summarize({ intervals: [interval, interval], cpu, gpu: [], skippedCpu: [], durationMs: 100 }, 1000 / 60),
  memoryMb: 211.6,
  memorySource: "js_heap",
  extras: { tick_ms: 0.3333 },
});

const scenes = [{ id: "default_view", name: "Default view", route: "/", query: {}, paced: false }];

// By CPU time, as a sweep's: slower reads positive.
test("drift compares the repeat's CPU time with the first step's, once the whole plan ran", () => {
  expect(drift([result("default_view", 10), result("default_view_repeat", 12.5, [1.5, 1.5])], 2)).toBeCloseTo(20, 9);
  expect(drift([result("default_view", 10), result("default_view_repeat", 12.5)], 3)).toBeNull();
  expect(drift([result("default_view", 10), result("starlink", 12.5)], 2)).toBeNull();
});

test("flattens a run into rounded properties under each scene's id", () => {
  const properties = reportProperties({
    platform: "web",
    environment: { app_version: "abc" },
    scenes,
    results: [result("default_view", 10), result("default_view_repeat", 10)],
    planned: 2,
    cancelled: false,
  });
  expect(properties).toMatchObject({
    app_version: "abc",
    benchmark_version: 8,
    benchmark_platform: "web",
    benchmark_scenes: ["default_view", "default_view_repeat"],
    benchmark_definitions: scenes,
    benchmark_drift_pct: 0,
    scene_default_view_fps: 100,
    scene_default_view_load_s: 2.3,
    scene_default_view_cpu_ms: 1.25,
    scene_default_view_gpu_ms: null,
    scene_default_view_cpu_busy_pct: 2.5,
    scene_default_view_load_pct: null,
    scene_default_view_memory_mb: 212,
    scene_default_view_memory_source: "js_heap",
    scene_default_view_idle: false,
    scene_default_view_x_tick_ms: 0.33,
  });
});

// A run of some scenes defines those, not every scene served; cut short, it says so.
test("defines only the scenes it measured, and a cancelled run as such", () => {
  const served = [...scenes, { id: "starlink", name: "Starlink", route: "/", query: { tags: "Starlink" }, paced: false }];
  const properties = reportProperties({ platform: "web", environment: {}, scenes: served, results: [result("starlink", 10)], planned: 2, cancelled: true });
  expect(properties.benchmark_cancelled).toBe(true);
  expect(properties.benchmark_definitions).toEqual([served[1]]);
});

test("plans the scenes and the first again, or only those named, without the repeat", () => {
  const two = [
    { id: "a", name: "A", route: "/", query: {}, paced: false },
    { id: "b", name: "B", route: "/", query: {}, paced: true },
  ];
  expect(planScenes(two).map(({ id, paced, repeat }) => [id, paced, repeat])).toEqual([
    ["a", false, false],
    ["b", true, false],
    ["a_repeat", false, true],
  ]);
  expect(planScenes(two, ["b", "nope"]).map(({ id }) => id)).toEqual(["b"]);
  expect(planScenes([])).toEqual([]);
});
