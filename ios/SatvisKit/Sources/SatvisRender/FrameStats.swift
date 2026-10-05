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

/// Collects frames on the main thread and GPU times on Metal's, and publishes
/// their averages twice a second.
final class FrameMeter: Sendable {
    private struct Window {
        var start: Double?
        var frames = 0
        var cpu = 0.0
        var gpu = 0.0
        var gpuFrames = 0
        var published: FrameStats?
    }

    private static let window = 0.5
    private let state = Mutex(Window())

    var stats: FrameStats? { state.withLock { $0.published } }

    func frame(cpuSeconds: Double, at now: Double, satellites: Int) {
        state.withLock { window in
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
            window = Window(start: now, published: window.published)
        }
    }

    func gpu(seconds: Double) {
        guard seconds > 0 else {
            return
        }
        state.withLock { window in
            window.gpu += seconds
            window.gpuFrames += 1
        }
    }

    func reset() {
        state.withLock { $0 = Window() }
    }
}
