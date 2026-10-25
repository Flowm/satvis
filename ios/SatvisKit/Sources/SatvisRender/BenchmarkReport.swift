import Foundation

/// One scene of the benchmark: a link the app opens.
public struct BenchmarkScene: Identifiable, Hashable, Sendable {
    /// Its name in the event sent, `scene_<id>_<metric>`.
    public let id: String
    /// One line each in the panel, on a phone too.
    public let title: String
    /// Under the title.
    public let subtitle: String
    /// What it draws, for the event sent.
    public let detail: String
    /// What the app opens, a path and query on the web app's site.
    public let link: String
    /// Whether the info panel a tracking link opens stays open, its cost measured
    /// with the scene's.
    public var keepsPanel = false
    /// Whether it is idle, paced as outside the benchmark: its frame rate is then
    /// the frames drawn.
    public var idle = false

    public init(id: String, title: String, subtitle: String, detail: String, link: String, keepsPanel: Bool = false, idle: Bool = false) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.link = link
        self.keepsPanel = keepsPanel
        self.idle = idle
    }

    /// The scenes a run measures, and the first again, last: the drift check.
    /// `only`, scene ids by commas (`SATVIS_BENCHMARK_SCENES`), runs only those,
    /// without the repeat: for checking a change to one of them.
    public static func plan(_ scenes: [BenchmarkScene], only: String?) -> [BenchmarkScene] {
        if let only = only?.split(separator: ",").map(String.init) {
            return scenes.filter { only.contains($0.id) }
        }
        guard let first = scenes.first else {
            return []
        }
        return scenes + [BenchmarkScene(id: "\(first.id)_repeat", title: "Repeat", subtitle: first.title, detail: first.detail, link: first.link)]
    }
}

/// One scene's measurement.
public struct BenchmarkResult: Identifiable, Sendable {
    /// The scene's, or `<scene>_repeat` for the drift check.
    public let id: String
    /// The scene's.
    public let title: String
    /// The scene's.
    public let detail: String
    /// Satellites handed to the renderer.
    public let satellites: Int
    /// From opening the link to everything active being drawn, in seconds.
    public let loadSeconds: Double
    /// Whether the scene was still loading when the wait gave up.
    public let timedOut: Bool
    /// The frames drawn while it was measured.
    public let recording: FrameRecording
    /// The app's memory footprint once measured; nil where the system does not say.
    public let memoryMegabytes: Int?
    /// The display's interval between refreshes, which slow frames are counted by.
    public let refreshMilliseconds: Double
    /// The scene's `idle`: none of its frames counts as slow.
    public let idle: Bool

    public init(
        id: String, title: String, detail: String, satellites: Int, loadSeconds: Double, timedOut: Bool, recording: FrameRecording, memoryMegabytes: Int?,
        refreshMilliseconds: Double, idle: Bool = false
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.satellites = satellites
        self.loadSeconds = loadSeconds
        self.timedOut = timedOut
        self.recording = recording
        self.memoryMegabytes = memoryMegabytes
        self.refreshMilliseconds = refreshMilliseconds
        self.idle = idle
    }

    /// As PostHog takes them: numbers rounded to what the measurement holds.
    public var metrics: [String: Any] {
        func rounded(_ value: Double?, _ places: Int = 2) -> Any {
            value.map { decimal($0, places: places) } ?? NSNull()
        }
        return [
            "description": detail,
            "satellites": satellites,
            "load_s": rounded(loadSeconds, 1),
            "timed_out": timedOut,
            "frames": recording.intervals.count,
            "fps": rounded(recording.framesPerSecond, 1),
            "frame_p50_ms": rounded(recording.percentile(0.5)),
            "frame_p95_ms": rounded(recording.percentile(0.95)),
            "slow_pct": idle ? NSNull() : rounded(recording.slowShare(refresh: refreshMilliseconds).map { $0 * 100 }, 1),
            "cpu_ms": rounded(recording.meanCPU),
            "buffer_wait_ms": rounded(recording.meanBufferWait),
            "drawable_wait_ms": rounded(recording.meanDrawableWait),
            "gpu_ms": rounded(recording.meanGPU),
            "cpu_busy_pct": rounded(recording.cpuBusy, 1),
            "gpu_busy_pct": rounded(recording.gpuBusy, 1),
            "memory_mb": memoryMegabytes.map { $0 as Any } ?? NSNull(),
        ]
    }
}

/// A benchmark run's results as they are sent.
public enum BenchmarkReport {
    /// The first scene against its repeat at the end, in percent of frame rate:
    /// a device that warmed up and slowed shows here. Nil unless all `planned`
    /// scenes were measured and the last is a repeat.
    public static func drift(_ results: [BenchmarkResult], planned: Int) -> Double? {
        guard results.count == planned, results.last?.id.hasSuffix("_repeat") == true, let first = results.first?.recording.framesPerSecond,
            let repeated = results.last?.recording.framesPerSecond, first > 0
        else {
            return nil
        }
        return (repeated - first) / first * 100
    }

    /// One flat set of properties for PostHog's insights: `environment`'s
    /// `benchmark_`, `app_` and `device_` ones for the run, and
    /// `scene_<scene>_<metric>` for each scene measured.
    public static func properties(environment: [String: Any], version: Int, results: [BenchmarkResult], planned: Int) -> [String: Any] {
        var properties = environment
        properties["benchmark_version"] = version
        properties["benchmark_scenes"] = results.map(\.id)
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

/// `value` rounded to `places` decimals, as a decimal, which a binary double would
/// print with its last digits wrong.
private func decimal(_ value: Double, places: Int) -> NSDecimalNumber {
    NSDecimalNumber(string: String(format: "%.\(places)f", value))
}
