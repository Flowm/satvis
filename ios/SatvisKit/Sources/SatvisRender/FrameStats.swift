import Foundation
import Synchronization

/// The performance overlay's figures, as the web app's `fps=true`, averaged over
/// half a second.
public struct FrameStats: Sendable, Equatable {
    public var framesPerSecond: Double
    /// The renderer's main-thread work a frame, the waits for a buffer and a
    /// drawable and the overlay's instruments left out.
    public var cpuMilliseconds: Double
    /// By the command buffers' clock; nil where it reads nothing, as in the simulator.
    public var gpuMilliseconds: Double?
    public var satellites: Int
    /// In percent, as `FrameRecording`'s.
    public var cpuBusy: Double = 0
    public var gpuBusy: Double?
    /// Paced frames run slow by design, so load is the figure to read.
    public var paced = false
    /// GPU time left out of load (`FrameRecording.idle`).
    public var idle = false
    /// Percent of one core, every thread: propagation and pass prediction too.
    public var cpuTotal: Double?

    public var load: Double? { idle ? cpuBusy : gpuBusy.map { max(cpuBusy, $0) } }
}

/// One drawn frame, for the performance panel's graph.
public struct MeteredFrame: Sendable, Equatable {
    /// Seconds on the uptime clock.
    public var at: Double
    /// Milliseconds.
    public var cpu: Double
    public var gpu: Double?
    /// Paced, more than two display intervals after the frame before: its GPU time is
    /// at the lowered clock (`FrameRecording.idle`), so the graph keeps it out of the budget.
    public var idle = false
    /// The renderer's number for it, which its GPU time arrives with.
    public var id: Int
}

/// Every frame over a stretch of time, for the benchmark, in milliseconds.
public struct FrameRecording: Sendable, Equatable {
    /// From the end of one frame's work to the next's.
    public var intervals: [Double] = []
    public var cpu: [Double] = []
    /// Waits for a buffer the GPU still holds: the GPU running behind.
    public var bufferWait: [Double] = []
    /// Counted in `cpu`, it read 16 ms on an iPad mini where the work took 1.
    public var drawableWait: [Double] = []
    public var gpu: [Double] = []
    /// The work of each paced call that drew nothing, sixty times a second.
    public var skippedCPU: [Double] = []
    public var duration: Double?
    /// Overlapping spans counted once (`GPUSpans`).
    public var gpuActive: Double?
    /// The process's, every thread's.
    public var totalCPU: Double?
    /// Paced, at under half the display's rate: the GPU clocks down between frames,
    /// and timed each 1.7 to 2 times slower than drawn every frame, so GPU time stays
    /// out of the budget and load.
    public var idle = false

    public init(
        intervals: [Double] = [], cpu: [Double] = [], bufferWait: [Double] = [], drawableWait: [Double] = [], gpu: [Double] = [], skippedCPU: [Double] = [],
        duration: Double? = nil, gpuActive: Double? = nil, totalCPU: Double? = nil, idle: Bool = false
    ) {
        self.intervals = intervals
        self.cpu = cpu
        self.bufferWait = bufferWait
        self.drawableWait = drawableWait
        self.gpu = gpu
        self.skippedCPU = skippedCPU
        self.duration = duration
        self.gpuActive = gpuActive
        self.totalCPU = totalCPU
        self.idle = idle
    }

    public var framesPerSecond: Double? {
        let total = intervals.reduce(0, +)
        return total > 0 ? Double(intervals.count) / total * 1000 : nil
    }

    /// Nearest rank, as the web app's `percentile`.
    public static func percentile(_ values: [Double], _ share: Double) -> Double? {
        guard !values.isEmpty else {
            return nil
        }
        let sorted = values.sorted()
        let rank = Int((Double(sorted.count) * share).rounded(.up)) - 1
        return sorted[max(0, min(rank, sorted.count - 1))]
    }

    /// In percent, each side's own share, as the web times the GPU on only some frames.
    public static func overBudget(cpu: [Double], gpu: [Double], budget: Double) -> Double? {
        func share(_ values: [Double]) -> Double { values.isEmpty ? 0 : Double(values.filter { $0 > budget }.count) / Double(values.count) }
        return cpu.isEmpty ? nil : max(share(cpu), share(gpu)) * 100
    }

    /// Percent of the recording, frames drawn and skipped.
    public var cpuBusy: Double? {
        duration.flatMap { $0 > 0 ? (cpu.reduce(0, +) + skippedCPU.reduce(0, +)) / $0 * 100 : nil }
    }

    /// Percent of the recording the GPU had a frame in hand.
    public var gpuBusy: Double? {
        guard !gpu.isEmpty, let gpuActive, let duration, duration > 0 else {
            return nil
        }
        return min(gpuActive / duration * 100, 100)
    }

    /// Percent of one core.
    public var cpuTotal: Double? {
        guard let totalCPU, let duration, duration > 0 else {
            return nil
        }
        return totalCPU / duration * 100
    }

    /// The busier side's share: the two work on different frames at once, so they do
    /// not add up, and the CPU's alone would miss a GPU-bound device.
    public var load: Double? {
        if idle {
            return cpuBusy
        }
        guard let cpuBusy, let gpuBusy else {
            return nil
        }
        return max(cpuBusy, gpuBusy)
    }

    /// As the web app's `summarize`, which a parity fixture holds this to.
    /// `refresh` is each frame's budget, in milliseconds.
    public func summary(refresh: Double) -> FrameSummary {
        FrameSummary(
            frames: intervals.count, framesPerSecond: framesPerSecond, cpu: meanCPU, gpu: meanGPU, cpuP95: Self.percentile(cpu, 0.95),
            gpuP95: Self.percentile(gpu, 0.95), overBudget: Self.overBudget(cpu: cpu, gpu: idle ? [] : gpu, budget: refresh), cpuBusy: cpuBusy, gpuBusy: gpuBusy,
            load: load, cpuTotal: cpuTotal)
    }

    public var meanCPU: Double? { Self.mean(cpu) }
    public var meanBufferWait: Double? { Self.mean(bufferWait) }
    public var meanDrawableWait: Double? { Self.mean(drawableWait) }
    public var meanGPU: Double? { Self.mean(gpu) }

    private static func mean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }
}

/// A step's comparable core (ADR 0016); times in milliseconds, shares in percent.
public struct FrameSummary: Sendable, Equatable {
    /// Frame intervals, one fewer than the frames drawn.
    public var frames: Int
    public var framesPerSecond: Double?
    public var cpu: Double?
    public var gpu: Double?
    public var cpuP95: Double?
    public var gpuP95: Double?
    public var overBudget: Double?
    public var cpuBusy: Double?
    public var gpuBusy: Double?
    public var load: Double?
    public var cpuTotal: Double?
}

/// The GPU's frame spans, joined where they overlap: a frame's vertices run under
/// the last one's fragments, and summed, a GPU-bound iPhone read 153 % busy.
struct GPUSpans {
    /// Seconds, on the GPU's clock.
    private(set) var end = -Double.infinity

    /// The part no earlier span covered.
    mutating func join(start: Double, end: Double) -> Double {
        defer { self.end = max(self.end, end) }
        return max(0, end - max(start, self.end))
    }
}

/// Collects frames on the main thread and GPU times on Metal's.
final class FrameMeter: Sendable {
    private struct Window {
        var start: Double?
        var frames = 0
        var cpu = 0.0
        var skippedCPU = 0.0
        var gpu = 0.0
        var gpuFrames = 0
        var gpuActive = 0.0
        var recent: [MeteredFrame] = []
        var published: FrameStats?
        var recording: FrameRecording?
        var recordingStart: Double?
        /// Process CPU seconds at the window's start, and at the recording's.
        var processCPU: Double?
        var recordingProcessCPU: Double?
        var lastFrame: Double?
        var spans = GPUSpans()
        /// GPU times, in milliseconds, of frames not yet in `recent`, by id.
        var earlyGPU: [Int: Double] = [:]
    }

    private static let window = 0.5
    /// Seconds.
    static let graphWindow = 5.0
    private let state = Mutex(Window())

    var stats: FrameStats? { state.withLock { $0.published } }
    var recentFrames: [MeteredFrame] { state.withLock { $0.recent } }

    func startRecording(at now: Double) {
        state.withLock {
            $0.recording = FrameRecording(gpuActive: 0)
            $0.recordingStart = now
            $0.recordingProcessCPU = Self.processCPUSeconds()
            $0.lastFrame = nil
            $0.spans = GPUSpans()
        }
    }

    func stopRecording(at now: Double) -> FrameRecording {
        state.withLock { window in
            defer { window.recording = nil }
            guard var recording = window.recording, let start = window.recordingStart else {
                return FrameRecording()
            }
            recording.duration = (now - start) * 1000
            recording.totalCPU = window.recordingProcessCPU.map { (Self.processCPUSeconds() - $0) * 1000 }
            return recording
        }
    }

    func skipped(cpuSeconds: Double) {
        state.withLock {
            $0.recording?.skippedCPU.append(cpuSeconds * 1000)
            $0.skippedCPU += cpuSeconds
        }
    }

    /// `displayInterval` in seconds.
    func frame(
        cpuSeconds: Double, bufferWaitSeconds: Double, drawableWaitSeconds: Double, at now: Double, satellites: Int, paced: Bool = false,
        displayInterval: Double = 1.0 / 60, id: Int
    ) {
        state.withLock { window in
            if window.recording != nil {
                if let last = window.lastFrame {
                    window.recording?.intervals.append((now - last) * 1000)
                }
                window.recording?.cpu.append(cpuSeconds * 1000)
                window.recording?.bufferWait.append(bufferWaitSeconds * 1000)
                window.recording?.drawableWait.append(drawableWaitSeconds * 1000)
                window.lastFrame = now
            }
            let idle = paced && (window.recent.last.map { now - $0.at > 2 * displayInterval } ?? true)
            window.recent.append(MeteredFrame(at: now, cpu: cpuSeconds * 1000, gpu: window.earlyGPU.removeValue(forKey: id), idle: idle, id: id))
            window.recent.removeFirst(window.recent.prefix { $0.at < now - Self.graphWindow }.count)
            guard let start = window.start else {
                window.start = now
                window.processCPU = Self.processCPUSeconds()
                return
            }
            window.frames += 1
            window.cpu += cpuSeconds
            let elapsed = now - start
            guard elapsed >= Self.window else {
                return
            }
            let frames = Double(window.frames)
            let processCPU = Self.processCPUSeconds()
            window.published = FrameStats(
                framesPerSecond: frames / elapsed, cpuMilliseconds: window.cpu / frames * 1000,
                gpuMilliseconds: window.gpuFrames > 0 ? window.gpu / Double(window.gpuFrames) * 1000 : nil, satellites: satellites,
                cpuBusy: (window.cpu + window.skippedCPU) / elapsed * 100, gpuBusy: window.gpuFrames > 0 ? min(window.gpuActive / elapsed * 100, 100) : nil,
                cpuTotal: window.processCPU.map { (processCPU - $0) / elapsed * 100 })
            window = Window(
                start: now, recent: window.recent, published: window.published, recording: window.recording,
                recordingStart: window.recordingStart, processCPU: processCPU, recordingProcessCPU: window.recordingProcessCPU, lastFrame: window.lastFrame,
                spans: window.spans)
        }
    }

    /// Seconds on the GPU's clock, in the order the command buffers were committed.
    func gpu(start: Double, end: Double, frame id: Int) {
        let seconds = end - start
        guard seconds > 0 else {
            return
        }
        state.withLock { window in
            window.gpu += seconds
            window.gpuFrames += 1
            let joined = window.spans.join(start: start, end: end)
            window.gpuActive += joined
            window.recording?.gpu.append(seconds * 1000)
            window.recording?.gpuActive? += joined * 1000
            if let index = window.recent.lastIndex(where: { $0.id == id }) {
                window.recent[index].gpu = seconds * 1000
            } else {
                // Done before the frame was counted; the few kept are those in flight.
                window.earlyGPU = window.earlyGPU.filter { $0.key > id - 8 }
                window.earlyGPU[id] = seconds * 1000
            }
        }
    }

    func reset() {
        state.withLock { $0 = Window() }
    }

    /// User and system time, every thread's.
    private static func processCPUSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func seconds(_ time: timeval) -> Double { Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000 }
        return seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }
}
