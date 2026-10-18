import Foundation
import Synchronization

/// How the frames are going, for the performance overlay: the web app's FPS
/// switch (`fps=true`), with what a frame costs either side of the GPU. Averaged
/// over half a second.
public struct FrameStats: Sendable, Equatable {
    public var framesPerSecond: Double
    /// The renderer's own work on the main thread, a frame: the waits for a buffer
    /// the GPU still holds and for a drawable left out, the instruments over the
    /// view not counted.
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
    /// The main thread's wait in each frame for a buffer the GPU still holds, in
    /// milliseconds: the GPU running behind.
    public var bufferWait: [Double] = []
    /// Its wait for a drawable the display has given back, in milliseconds.
    /// Counted in `cpu`, it read 16 ms on an iPad mini where the work took 1.
    public var drawableWait: [Double] = []
    /// The GPU's, in milliseconds; empty where it reads nothing.
    public var gpu: [Double] = []

    public init(intervals: [Double] = [], cpu: [Double] = [], bufferWait: [Double] = [], drawableWait: [Double] = [], gpu: [Double] = []) {
        self.intervals = intervals
        self.cpu = cpu
        self.bufferWait = bufferWait
        self.drawableWait = drawableWait
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

    /// The share of frames that missed a refresh of a display refreshing every
    /// `refresh` milliseconds: longer than one and a half refreshes. The web
    /// benchmark's `jankPct` counts frames over 33 ms, which at 60 Hz misses the
    /// frames of two refreshes that came in at 32.5 ms.
    public func slowShare(refresh: Double) -> Double? {
        intervals.isEmpty ? nil : Double(intervals.filter { $0 > 1.5 * refresh }.count) / Double(intervals.count)
    }

    // Means over the recording, in milliseconds; nil where it holds none.
    public var meanCPU: Double? { Self.mean(cpu) }
    public var meanBufferWait: Double? { Self.mean(bufferWait) }
    public var meanDrawableWait: Double? { Self.mean(drawableWait) }
    public var meanGPU: Double? { Self.mean(gpu) }

    private static func mean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }
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

    func frame(cpuSeconds: Double, bufferWaitSeconds: Double, drawableWaitSeconds: Double, at now: Double, satellites: Int) {
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
