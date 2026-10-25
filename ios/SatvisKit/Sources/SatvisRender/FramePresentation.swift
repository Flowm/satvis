import Foundation
import Synchronization

/// When a frame begun now reaches the screen, which its content is timed to: timed
/// to its start, every active orbit on an iPad mini moved 22 ms a frame while
/// shown 16.7 and 33.3 ms apart.
enum PresentationTime {
    /// The screen, in seconds of uptime: a refresh every `refresh`, one at `vsync`,
    /// and a frame asked for every `interval`.
    struct Screen {
        var refresh: Double
        var vsync: Double
        var interval: Double
    }

    /// The GPU, in seconds: a frame's `span` from commit to done on an idle GPU,
    /// its joined work `perFrame`, the last frame done at `done`, and the frames
    /// still on it committed at `queued`.
    struct GPU {
        var span: Double
        var perFrame: Double
        var done: Double
        var queued: [Double]
    }

    /// Seconds before a refresh a frame must be done to be shown on it: with 0.6 ms
    /// an iPad mini's frames went a refresh late, 8 % foretold wrong against 2 %.
    static let latch = 0.0015

    /// When a frame begun at `now`, committed `cpu` seconds later, is shown: the
    /// first refresh once the GPU is done with it, an interval after `previous`.
    /// Frames overlap on the GPU; taken one by one, a third were foretold wrong.
    static func predict(now: Double, cpu: Double, gpu: GPU, screen: Screen, previous: Double?) -> Double {
        let gpuFree = gpu.queued.reduce(gpu.done) { max($1 + gpu.span, $0 + gpu.perFrame) }
        let done = max(now + cpu + gpu.span, gpuFree + gpu.perFrame) + latch
        // A hair's slack, for a frame done on a refresh by floating point.
        var shown = screen.vsync + ((done - screen.vsync) / screen.refresh - 1e-3).rounded(.up) * screen.refresh
        if let previous {
            shown = max(shown, previous + max(screen.interval, screen.refresh))
        }
        return shown
    }
}

/// The frames begun, on the GPU and shown, for `PresentationTime`: begun and
/// foretold on the main thread, done and shown on Metal's.
final class FramePresentation: Sendable {
    private struct State {
        /// Averages, in seconds: the main thread's work from a frame's start to its
        /// commit, a frame's span on an idle GPU, and the GPU's joined work a frame.
        var cpu = 0.0
        var span: Double?
        var gpu: Double?
        var spans = GPUSpans()
        /// The frames on the GPU, by when each was committed.
        var queued: [(id: Int, committed: Double)] = []
        /// A refresh a frame was shown on.
        var vsync: Double?
        /// When the last frame begun is to be shown.
        var previous: Double?
        /// Frames begun, for their ids.
        var count = 0
    }

    /// The busier side's seconds a frame lately, the main thread's or the GPU's;
    /// nil before a frame is done.
    var perFrame: Double? {
        state.withLock { state in state.gpu.map { max($0, state.cpu) } }
    }

    /// The weight of a frame's measure in the averages.
    static let weight = 0.1
    private let state = Mutex(State())

    /// When a frame begun at `now` will be shown: never before the last frame begun,
    /// so time never runs back; one foretold and then turned away moves nothing.
    func predict(at now: Double, refresh: Double, interval: Double) -> Double {
        state.withLock { state in
            PresentationTime.predict(
                now: now, cpu: state.cpu,
                gpu: .init(span: state.span ?? 0, perFrame: state.gpu ?? 0, done: state.spans.end, queued: state.queued.map(\.committed)),
                screen: .init(refresh: refresh, vsync: state.vsync ?? now, interval: interval), previous: state.previous)
        }
    }

    /// A frame committed at `committed` after `cpu` seconds of the main thread's
    /// work, to be shown at `shown`; its id for `done`.
    func began(committed: Double, cpu: Double, shown: Double) -> Int {
        state.withLock { state in
            state.count += 1
            state.queued.append((state.count, committed))
            state.previous = shown
            state.cpu += (cpu - state.cpu) * Self.weight
            return state.count
        }
    }

    /// Frame `id`'s span on the GPU, by its clock, in seconds.
    func done(_ id: Int, start: Double, end: Double) {
        state.withLock { state in
            guard let index = state.queued.firstIndex(where: { $0.id == id }) else {
                return
            }
            let committed = state.queued.remove(at: index).committed
            guard end > start else {
                return
            }
            // Behind another frame, a span measures that one too: averaged over
            // every frame, 8 % of every active orbit's were foretold wrong.
            if state.span == nil || start >= state.spans.end {
                state.span = Self.average(state.span, end - committed)
            }
            state.gpu = Self.average(state.gpu, state.spans.join(start: start, end: end))
        }
    }

    private static func average(_ average: Double?, _ value: Double) -> Double {
        average.map { $0 + (value - $0) * weight } ?? value
    }

    /// A frame shown at `time`, in seconds of uptime; 0 where it was dropped.
    func shown(at time: Double) {
        guard time > 0 else {
            return
        }
        state.withLock { $0.vsync = time }
    }
}
