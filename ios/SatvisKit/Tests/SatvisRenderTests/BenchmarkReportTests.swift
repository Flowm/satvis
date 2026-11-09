import Foundation
import SatvisCore
import Testing

@testable import SatvisRender

@Suite struct BenchmarkReportTests {
    private static let scenes = [
        BenchmarkScene(id: "default_view", name: "Default view"),
        BenchmarkScene(id: "starlink_points", name: "Starlink · Points", query: ["tags": "Starlink", "elements": "Point"]),
        BenchmarkScene(id: "default_view_idle", name: "Default view · Idle", paced: true),
    ]

    private static func result(_ id: String, intervals: [Double] = [16, 16, 16, 52], cpu: [Double] = [1, 2]) -> BenchmarkResult {
        BenchmarkResult(
            id: id, satellites: 100, loadSeconds: 1.26, timedOut: false,
            recording: FrameRecording(
                intervals: intervals, cpu: cpu, bufferWait: [0.5, 0.3], drawableWait: [], gpu: [8, 9], duration: 100, gpuActive: 17,
                totalCPU: 12.34),
            memoryMegabytes: 512, gpuMemoryMegabytes: 300, refreshMilliseconds: 1000.0 / 60)
    }

    @Test func plansEverySceneAndTheFirstAgain() {
        let plan = BenchmarkScene.plan(Self.scenes)
        #expect(plan.map(\.id) == ["default_view", "starlink_points", "default_view_idle", "default_view_repeat"])
        #expect(plan.map(\.paced) == [false, false, true, false])
        #expect(plan.last?.label == "Default view (repeat)")
    }

    // `benchscenes`: those named, in the plan's order, without the repeat.
    @Test func plansOnlyTheScenesNamed() {
        #expect(BenchmarkScene.plan(Self.scenes, only: ["default_view_idle", "default_view"]).map(\.id) == ["default_view", "default_view_idle"])
        #expect(BenchmarkScene.plan(Self.scenes, only: ["nothing"]).isEmpty)
    }

    @Test func opensTheSceneOnItsRoute() {
        #expect(Self.scenes[1].link == Link("/?elements=Point&tags=Starlink"))
        #expect(BenchmarkScene(id: "ot", name: "OT", route: "/ot").link == Link(preset: "ot"))
    }

    // Paced, every interval is long by design: over budget counts the work alone.
    @Test func countsTheWorkOverBudgetPacedOrNot() {
        let idle = BenchmarkResult(
            id: "default_view_idle", satellites: 100, loadSeconds: 1, timedOut: false, recording: FrameRecording(intervals: [300, 290, 310], cpu: [1, 20, 1, 1]),
            memoryMegabytes: nil, refreshMilliseconds: 1000.0 / 60)
        #expect(idle.metrics["over_budget_pct"] as? NSDecimalNumber == NSDecimalNumber(string: "25.0"))
        #expect(Self.result("default_view").metrics["over_budget_pct"] as? NSDecimalNumber == NSDecimalNumber(string: "0.0"))
    }

    @Test func driftsByTheRepeatsCPUTime() throws {
        // 1.5 ms a frame, then 2.25, at a frame rate that also changed.
        let results = [Self.result("default_view"), Self.result("default_view_repeat", intervals: [20, 20, 20, 45.263157894736842], cpu: [2, 2.5])]
        #expect(abs(try #require(BenchmarkReport.drift(results, planned: 2)) - 50) < 1e-9)
        #expect(BenchmarkReport.drift(results, planned: 3) == nil)
        #expect(BenchmarkReport.drift([Self.result("default_view"), Self.result("starlink_points")], planned: 2) == nil)
    }

    // The keys of src/modules/benchmark/benchmarkReport.ts, this app's own as `x_`.
    @Test func reportsTheRunAndEveryStepsMetricsAsTheWebAppDoes() throws {
        let results = [Self.result("default_view"), Self.result("default_view_repeat", intervals: [20, 20, 20, 45.263157894736842], cpu: [2, 2.5])]
        let properties = BenchmarkReport.properties(
            environment: ["app_version": "1.2", "device_kind": "iPhone"], scenes: Self.scenes, results: results, planned: 2, cancelled: false)
        let metrics = [
            "satellites", "load_s", "timed_out", "idle", "frames", "fps", "cpu_ms", "gpu_ms", "cpu_p95_ms", "gpu_p95_ms", "over_budget_pct", "cpu_busy_pct",
            "load_pct", "cpu_total_pct", "memory_mb", "memory_source", "x_gpu_memory_mb", "x_buffer_wait_ms", "x_drawable_wait_ms",
        ]
        let stepKeys = ["default_view", "default_view_repeat"].flatMap { step in metrics.map { "scene_\(step)_\($0)" } }
        let runKeys = ["benchmark_version", "benchmark_platform", "benchmark_scenes", "benchmark_definitions", "benchmark_drift_pct"]
        #expect(Set(properties.keys) == Set(["app_version", "device_kind"] + runKeys + stepKeys))
        let cancelled = BenchmarkReport.properties(environment: [:], scenes: Self.scenes, results: results, planned: 3, cancelled: true)
        #expect(cancelled["benchmark_cancelled"] as? Bool == true)
        #expect(properties["benchmark_version"] as? Int == 8)
        #expect(properties["benchmark_platform"] as? String == "ios")
        #expect(properties["benchmark_scenes"] as? [String] == ["default_view", "default_view_repeat"])
        // Only the scene measured, as on the web.
        #expect((properties["benchmark_definitions"] as? [[String: Any]])?.map { $0["id"] as? String } == ["default_view"])
        #expect(properties["benchmark_drift_pct"] as? NSDecimalNumber == NSDecimalNumber(string: "50.0"))
        #expect(properties["scene_default_view_satellites"] as? Int == 100)
        #expect(properties["scene_default_view_timed_out"] as? Bool == false)
        #expect(properties["scene_default_view_idle"] as? Bool == false)
        #expect(properties["scene_default_view_frames"] as? Int == 4)
        #expect(properties["scene_default_view_memory_mb"] as? Int == 512)
        #expect(properties["scene_default_view_memory_source"] as? String == "phys_footprint")
        #expect(properties["scene_default_view_x_gpu_memory_mb"] as? Int == 300)
        #expect(properties["scene_default_view_x_drawable_wait_ms"] is NSNull)
        let decimals = [
            "load_s": "1.3", "fps": "40.0", "cpu_p95_ms": "2.00", "gpu_p95_ms": "9.00", "over_budget_pct": "0.0", "cpu_ms": "1.50", "x_buffer_wait_ms": "0.40",
            "gpu_ms": "8.50", "cpu_busy_pct": "3.0", "load_pct": "17.0", "cpu_total_pct": "12.3",
        ]
        for (metric, value) in decimals {
            #expect(properties["scene_default_view_\(metric)"] as? NSDecimalNumber == NSDecimalNumber(string: value), "\(metric)")
        }
    }
}
