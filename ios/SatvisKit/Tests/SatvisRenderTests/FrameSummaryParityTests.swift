import Foundation
import Testing

@testable import SatvisRender

/// The benchmark's figures against the web app's own `summarize`
/// (src/modules/benchmark/frameSummary.ts, through scripts/parity/generate.mjs), so
/// a step reads the same in both apps.
struct FrameSummaryParityTests {
    struct Fixture: Decodable {
        struct Case: Decodable {
            struct Recording: Decodable {
                var intervals: [Double]
                var cpu: [Double]
                var gpu: [Double]
                var skippedCpu: [Double]
                var durationMs: Double?
                var gpuActiveMs: Double?
                var totalCpuMs: Double?
                var idle: Bool?
            }

            struct Summary: Decodable {
                var frames: Int
                var fps: Double?
                var cpuMs: Double?
                var gpuMs: Double?
                var cpuP95Ms: Double?
                var gpuP95Ms: Double?
                var overBudgetPct: Double?
                var cpuBusyPct: Double?
                var gpuBusyPct: Double?
                var loadPct: Double?
                var cpuTotalPct: Double?
            }

            var name: String
            var refreshMs: Double
            var recording: Recording
            var summary: Summary
            /// The web's `sceneMetrics`, its numbers only, after a load of 1.25 s.
            var metrics: [String: Double?]
        }

        var cases: [Case]
    }

    @Test func summarisesEachRecordingAsTheWebAppDoes() throws {
        let url = try #require(Bundle.module.url(forResource: "frame-summaries", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(!fixture.cases.isEmpty)
        for test in fixture.cases {
            let given = test.recording
            let recording = FrameRecording(
                intervals: given.intervals, cpu: given.cpu, gpu: given.gpu, skippedCPU: given.skippedCpu, duration: given.durationMs,
                gpuActive: given.gpuActiveMs, totalCPU: given.totalCpuMs, idle: given.idle ?? false)
            let got = recording.summary(refresh: test.refreshMs)
            let want = test.summary
            #expect(got.frames == want.frames, "\(test.name): frames")
            for (label, value, expected) in [
                ("fps", got.framesPerSecond, want.fps), ("cpu", got.cpu, want.cpuMs), ("gpu", got.gpu, want.gpuMs),
                ("cpuP95", got.cpuP95, want.cpuP95Ms), ("gpuP95", got.gpuP95, want.gpuP95Ms), ("overBudget", got.overBudget, want.overBudgetPct),
                ("cpuBusy", got.cpuBusy, want.cpuBusyPct), ("gpuBusy", got.gpuBusy, want.gpuBusyPct), ("load", got.load, want.loadPct),
                ("cpuTotal", got.cpuTotal, want.cpuTotalPct),
            ] {
                if let expected {
                    #expect(value.map { abs($0 - expected) < 1e-9 } == true, "\(test.name): \(label) \(String(describing: value)) != \(expected)")
                } else {
                    #expect(value == nil, "\(test.name): \(label) \(String(describing: value)) != nil")
                }
            }
            let reported = BenchmarkResult(
                id: "x", satellites: 74, loadSeconds: 1.25, timedOut: false, recording: recording, memoryMegabytes: nil, refreshMilliseconds: test.refreshMs
            ).metrics
            for (key, expected) in test.metrics {
                // Through the decimal's text: `doubleValue` reads 26.67 as 26.669999999999998.
                let value = (reported[key] as? NSNumber).flatMap { Double($0.description) }
                #expect(value == expected, "\(test.name): \(key) \(String(describing: value)) != \(String(describing: expected))")
            }
        }
    }
}
