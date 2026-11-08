import Foundation
import SatvisCore

public struct BenchmarkResult: Identifiable, Sendable {
    /// `<scene>_repeat` for the drift check.
    public let id: String
    public let satellites: Int
    /// From opening the link to everything active drawn.
    public let loadSeconds: Double
    public let timedOut: Bool
    public let recording: FrameRecording
    /// Nil where the system does not say.
    public let memoryMegabytes: Int?
    /// Of that, the Metal device's: textures, meshes, buffers.
    public let gpuMemoryMegabytes: Int?
    /// The frame budget: at 30 fps, a frame every other refresh is on time.
    public let refreshMilliseconds: Double

    public init(
        id: String, satellites: Int, loadSeconds: Double, timedOut: Bool, recording: FrameRecording, memoryMegabytes: Int?, gpuMemoryMegabytes: Int? = nil,
        refreshMilliseconds: Double
    ) {
        self.id = id
        self.satellites = satellites
        self.loadSeconds = loadSeconds
        self.timedOut = timedOut
        self.recording = recording
        self.memoryMegabytes = memoryMegabytes
        self.gpuMemoryMegabytes = gpuMemoryMegabytes
        self.refreshMilliseconds = refreshMilliseconds
    }

    public var summary: FrameSummary {
        recording.summary(refresh: refreshMilliseconds)
    }

    /// As the web app's `sceneMetrics`, this app's own figures as `x_`.
    public var metrics: [String: Any] {
        func rounded(_ value: Double?, _ places: Int = 2) -> Any {
            value.map { decimal($0, places: places) } ?? NSNull()
        }
        let summary = summary
        return [
            "satellites": satellites,
            "load_s": rounded(loadSeconds, 1),
            "timed_out": timedOut,
            "idle": recording.idle,
            "frames": summary.frames,
            "fps": rounded(summary.framesPerSecond, 1),
            "cpu_ms": rounded(summary.cpu),
            "gpu_ms": rounded(summary.gpu),
            "cpu_p95_ms": rounded(summary.cpuP95),
            "gpu_p95_ms": rounded(summary.gpuP95),
            "over_budget_pct": rounded(summary.overBudget, 1),
            // Load's floor where the GPU's side is unknown, as in the simulator.
            "cpu_busy_pct": rounded(summary.cpuBusy, 1),
            "load_pct": rounded(summary.load, 1),
            "cpu_total_pct": rounded(summary.cpuTotal, 1),
            "memory_mb": memoryMegabytes.map { $0 as Any } ?? NSNull(),
            "memory_source": memoryMegabytes == nil ? NSNull() : "phys_footprint",
            "x_gpu_memory_mb": gpuMemoryMegabytes.map { $0 as Any } ?? NSNull(),
            "x_buffer_wait_ms": rounded(recording.meanBufferWait),
            "x_drawable_wait_ms": rounded(recording.meanDrawableWait),
        ]
    }
}

public enum BenchmarkReport {
    /// 7 and before: this app alone, its scenes in its code.
    public static let version = 8

    /// Only once all `planned` steps were measured.
    public static func driftSteps(_ results: [BenchmarkResult], planned: Int) -> (first: BenchmarkResult, repeated: BenchmarkResult)? {
        guard results.count == planned, let first = results.first, let repeated = results.last, repeated.id.hasSuffix("_repeat") else {
            return nil
        }
        return (first, repeated)
    }

    /// As the web app's `drift`.
    public static func drift(_ results: [BenchmarkResult], planned: Int) -> Double? {
        guard let steps = driftSteps(results, planned: planned), let first = steps.first.recording.meanCPU, let repeated = steps.repeated.recording.meanCPU,
            first > 0
        else {
            return nil
        }
        return (repeated - first) / first * 100
    }

    /// As the web app's `reportProperties`.
    public static func properties(environment: [String: Any], scenes: [BenchmarkScene], results: [BenchmarkResult], planned: Int, cancelled: Bool) -> [String: Any] {
        var properties = environment
        properties["benchmark_version"] = version
        properties["benchmark_platform"] = "ios"
        properties["benchmark_scenes"] = results.map(\.id)
        // Only the scenes measured, as a run of some of them defines no others.
        let measured = scenes.filter { scene in results.contains { $0.id == scene.id || $0.id == "\(scene.id)_repeat" } }
        properties["benchmark_definitions"] = measured.map { ["id": $0.id, "name": $0.name, "route": $0.route, "query": $0.query, "paced": $0.paced] as [String: Any] }
        if cancelled {
            properties["benchmark_cancelled"] = true
        }
        if let drift = drift(results, planned: planned) {
            properties["benchmark_drift_pct"] = decimal(drift, places: 1)
        }
        for result in results {
            for (metric, value) in result.metrics {
                properties["scene_\(result.id)_\(metric)"] = value
            }
        }
        return properties
    }
}

/// A decimal, which a binary double would print with its last digits wrong, rounded
/// as the web's `toFixed` rounds it (`jsRound`).
private func decimal(_ value: Double, places: Int) -> NSDecimalNumber {
    NSDecimalNumber(string: String(format: "%.\(places)f", jsRound(value, places)))
}
