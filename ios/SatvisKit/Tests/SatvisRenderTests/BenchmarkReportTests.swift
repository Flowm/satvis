import Foundation
import Testing

@testable import SatvisRender

@Suite struct BenchmarkReportTests {
    private static let scenes = [
        BenchmarkScene(id: "default_view", title: "Default view", subtitle: "Points and labels", detail: "The default preset", link: "/"),
        BenchmarkScene(id: "starlink_points", title: "Starlink", subtitle: "Points", detail: "Starlink, points only", link: "/?tags=Starlink"),
        BenchmarkScene(id: "sky_view", title: "Sky view", subtitle: "Lauterbrunnen", detail: "Looking up", link: "/?scene=Sky"),
    ]

    private static func result(_ id: String, intervals: [Double] = [16, 16, 16, 52]) -> BenchmarkResult {
        BenchmarkResult(
            id: id, title: "Default view", detail: "The default preset", satellites: 100, loadSeconds: 1.26, timedOut: false,
            recording: FrameRecording(intervals: intervals, cpu: [1, 2], bufferWait: [0.5, 0.3], drawableWait: [], gpu: [8, 9]), memoryMegabytes: 512,
            refreshMilliseconds: 1000.0 / 60)
    }

    @Test func plansEverySceneAndTheFirstAgain() {
        let plan = BenchmarkScene.plan(Self.scenes, only: nil)
        #expect(plan.map(\.id) == ["default_view", "starlink_points", "sky_view", "default_view_repeat"])
        #expect(
            plan.last
                == BenchmarkScene(id: "default_view_repeat", title: "Repeat", subtitle: "Default view", detail: "The default preset", link: "/"))
    }

    // `SATVIS_BENCHMARK_SCENES`: those named, in the plan's order, without the repeat.
    @Test func plansOnlyTheScenesNamed() {
        #expect(BenchmarkScene.plan(Self.scenes, only: "sky_view,default_view").map(\.id) == ["default_view", "sky_view"])
        #expect(BenchmarkScene.plan(Self.scenes, only: "nothing").isEmpty)
    }

    // Standing still, every interval is long by design.
    @Test func countsNoPacedFrameAsSlow() {
        let paced = BenchmarkResult(
            id: "default_view_paced", title: "Default view", detail: "Standing still", satellites: 100, loadSeconds: 1, timedOut: false,
            recording: FrameRecording(intervals: [300, 290, 310]), memoryMegabytes: nil, refreshMilliseconds: 1000.0 / 60, paced: true)
        #expect(paced.metrics["slow_pct"] is NSNull)
        #expect(Self.result("default_view").metrics["slow_pct"] is NSDecimalNumber)
    }

    @Test func driftsByTheRepeatsFrameRate() throws {
        // 40 frames a second, then 38.
        let results = [Self.result("default_view"), Self.result("default_view_repeat", intervals: [20, 20, 20, 45.263157894736842])]
        #expect(abs(try #require(BenchmarkReport.drift(results, planned: 2)) + 5) < 1e-9)
        #expect(BenchmarkReport.drift(results, planned: 3) == nil)
        #expect(BenchmarkReport.drift([Self.result("default_view"), Self.result("starlink_points")], planned: 2) == nil)
    }

    @Test func reportsTheRunAndEveryScenesMetrics() throws {
        let results = [Self.result("default_view"), Self.result("default_view_repeat", intervals: [20, 20, 20, 45.263157894736842])]
        let properties = BenchmarkReport.properties(environment: ["app_version": "1.2", "device_kind": "iPhone"], version: 4, results: results, planned: 2)
        let metrics = [
            "description", "satellites", "load_s", "timed_out", "frames", "fps", "frame_p50_ms", "frame_p95_ms", "slow_pct", "cpu_ms", "buffer_wait_ms",
            "drawable_wait_ms", "gpu_ms", "memory_mb",
        ]
        let sceneKeys = ["default_view", "default_view_repeat"].flatMap { scene in metrics.map { "scene_\(scene)_\($0)" } }
        #expect(
            Set(properties.keys) == Set(["app_version", "device_kind", "benchmark_version", "benchmark_scenes", "benchmark_drift_pct"] + sceneKeys))
        #expect(properties["app_version"] as? String == "1.2")
        #expect(properties["benchmark_version"] as? Int == 4)
        #expect(properties["benchmark_scenes"] as? [String] == ["default_view", "default_view_repeat"])
        #expect(properties["benchmark_drift_pct"] as? NSDecimalNumber == NSDecimalNumber(string: "-5.0"))
        #expect(properties["scene_default_view_description"] as? String == "The default preset")
        #expect(properties["scene_default_view_satellites"] as? Int == 100)
        #expect(properties["scene_default_view_timed_out"] as? Bool == false)
        #expect(properties["scene_default_view_frames"] as? Int == 4)
        #expect(properties["scene_default_view_memory_mb"] as? Int == 512)
        #expect(properties["scene_default_view_drawable_wait_ms"] is NSNull)
        let decimals = [
            "load_s": "1.3", "fps": "40.0", "frame_p50_ms": "16.00", "frame_p95_ms": "52.00", "slow_pct": "25.0", "cpu_ms": "1.50", "buffer_wait_ms": "0.40",
            "gpu_ms": "8.50",
        ]
        for (metric, value) in decimals {
            #expect(properties["scene_default_view_\(metric)"] as? NSDecimalNumber == NSDecimalNumber(string: value), "\(metric)")
        }
    }
}
