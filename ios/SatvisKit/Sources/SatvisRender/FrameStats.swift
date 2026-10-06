import Foundation
import Synchronization

/// How the frames are going, for the performance overlay: the web app's FPS
/// switch (`fps=true`), with what a frame costs either side of the GPU. Averaged
/// over half a second.
public struct FrameStats: Sendable, Equatable {
    public var framesPerSecond: Double
    /// The renderer's own work on the main thread, a frame: the wait for a buffer
    /// the GPU still holds left out, the instruments over the view not counted.
    public var cpuMilliseconds: Double
    /// The GPU's, a frame, by the command buffers' own clock; nil where it reads
    /// nothing, as in the simulator.
    public var gpuMilliseconds: Double?
    /// Satellites drawn.
    public var satellites: Int
}

/// Every frame over a stretch of time, for the benchmark: what the averages of
/// `FrameStats` cannot show, how uneven the frames were.
public struct FrameRecording: Sendable, Equatable {
    /// From the end of one frame's work to the next's, in milliseconds: the
    /// display's pace once the renderer keeps up with it.
    public var intervals: [Double] = []
    /// The renderer's own work on the main thread, in milliseconds.
    public var cpu: [Double] = []
    /// The GPU's, in milliseconds; empty where it reads nothing.
    public var gpu: [Double] = []

    public init(intervals: [Double] = [], cpu: [Double] = [], gpu: [Double] = []) {
        self.intervals = intervals
        self.cpu = cpu
        self.gpu = gpu
    }

    /// Frames a second over the whole recording.
    public var framesPerSecond: Double? {
        let total = intervals.reduce(0, +)
        return total > 0 ? Double(intervals.count) / total * 1000 : nil
    }

    /// The frame interval below which this share of frames fall, in milliseconds.
    public func percentile(_ share: Double) -> Double? {
        guard !intervals.isEmpty else {
            return nil
        }
        let sorted = intervals.sorted()
        let rank = Int((Double(sorted.count) * share).rounded(.up)) - 1
        return sorted[max(0, min(rank, sorted.count - 1))]
    }

    /// The share of frames slower than 33 ms, the web benchmark's `jankPct`: at
    /// 60 Hz, every frame that missed a refresh.
    public var slowShare: Double? {
        intervals.isEmpty ? nil : Double(intervals.filter { $0 > 33 }.count) / Double(intervals.count)
    }

    public var meanCPU: Double? { cpu.isEmpty ? nil : cpu.reduce(0, +) / Double(cpu.count) }
    public var meanGPU: Double? { gpu.isEmpty ? nil : gpu.reduce(0, +) / Double(gpu.count) }
}

/// Collects frames on the main thread and GPU times on Metal's, and publishes
/// their averages twice a second; records each frame while asked to.
final class FrameMeter: Sendable {
    private struct Window {
        var start: Double?
        var frames = 0
        var cpu = 0.0
        var gpu = 0.0
        var gpuFrames = 0
        var published: FrameStats?
        var recording: FrameRecording?
        var lastFrame: Double?
    }

    private static let window = 0.5
    private let state = Mutex(Window())

    var stats: FrameStats? { state.withLock { $0.published } }

    func startRecording() {
        state.withLock {
            $0.recording = FrameRecording()
            $0.lastFrame = nil
        }
    }

    func stopRecording() -> FrameRecording {
        state.withLock { window in
            defer { window.recording = nil }
            return window.recording ?? FrameRecording()
        }
    }

    func frame(cpuSeconds: Double, at now: Double, satellites: Int) {
        state.withLock { window in
            if window.recording != nil {
                if let last = window.lastFrame {
                    window.recording?.intervals.append((now - last) * 1000)
                }
                window.recording?.cpu.append(cpuSeconds * 1000)
                window.lastFrame = now
            }
            guard let start = window.start else {
                window.start = now
                return
            }
            window.frames += 1
            window.cpu += cpuSeconds
            let elapsed = now - start
            guard elapsed >= Self.window else {
                return
            }
            let frames = Double(window.frames)
            window.published = FrameStats(
                framesPerSecond: frames / elapsed, cpuMilliseconds: window.cpu / frames * 1000,
                gpuMilliseconds: window.gpuFrames > 0 ? window.gpu / Double(window.gpuFrames) * 1000 : nil, satellites: satellites)
            window = Window(start: now, published: window.published, recording: window.recording, lastFrame: window.lastFrame)
        }
    }

    func gpu(seconds: Double) {
        guard seconds > 0 else {
            return
        }
        state.withLock { window in
            window.gpu += seconds
            window.gpuFrames += 1
            window.recording?.gpu.append(seconds * 1000)
        }
    }

    func reset() {
        state.withLock { $0 = Window() }
    }
}
