import Foundation
import MetalKit

/// The frames in flight, three at most: each begun once one of them is free and a
/// drawable is (`DrawableGate`), timed to when it is shown (`FramePresentation`),
/// and checked for a GPU fault as it completes (`GPUFaults`).
@MainActor
final class FrameLoop {
    /// A frame begun: its command buffer, the drawable it ends on and the screen's
    /// pass, with how long each was waited for.
    struct Frame {
        let commands: MTLCommandBuffer
        let drawable: CAMetalDrawable
        let screen: MTLRenderPassDescriptor
        let waitedForBuffer: Double
        let waitedForDrawable: Double

        /// The main thread's own work on the frame from `started` to `end`, the
        /// waits left out.
        func cpu(from started: Double, to end: Double) -> Double {
            end - started - waitedForBuffer - waitedForDrawable
        }
    }

    private static let framesInFlight = 3

    private let drawables = DrawableGate()
    /// When the frames begun are shown, which their content is timed to.
    private let presentation = FramePresentation()
    private let faults: GPUFaults
    private let queue: MTLCommandQueue
    private let inFlight = DispatchSemaphore(value: framesInFlight)
    /// The frame in flight begun last, which its buffers are kept for.
    private var index = 0
    /// Each frame in flight's stencils (`PointFrame`).
    private var pointFrameBuffers: [MTLBuffer?] = Array(repeating: nil, count: framesInFlight)

    /// `faults` is told of each frame the GPU fails.
    init(queue: MTLCommandQueue, faults: GPUFaults) {
        self.queue = queue
        self.faults = faults
    }

    /// When a frame of `view` begun at `started` will be shown, of a screen
    /// refreshed every `refresh` seconds; while the frames' work takes longer than
    /// an interval, the frames to come wait for a free drawable.
    func predict(_ view: MTKView, at started: Double, refresh: Double) -> Double {
        let interval = Self.interval(of: view)
        drawables.setBehind((presentation.perFrame ?? 0) > interval)
        return presentation.predict(at: started, refresh: refresh, interval: interval)
    }

    /// A command buffer once one of the frames in flight is free, and the drawable
    /// it ends on; nil, the frame given back, where either is missing or no
    /// drawable is free yet.
    func begin(_ view: MTKView) -> Frame? {
        // The simulator's drawables say nothing of being presented, so there
        // every frame takes one, as MTKView's own loop does.
        #if !targetEnvironment(simulator)
            let maximumDrawables = (view.layer as? CAMetalLayer)?.maximumDrawableCount ?? 3
            guard drawables.mayTake(maximum: maximumDrawables, at: ProcessInfo.processInfo.systemUptime) else {
                return nil
            }
        #endif
        let waitStarted = ProcessInfo.processInfo.systemUptime
        inFlight.wait()
        let waitedForBuffer = ProcessInfo.processInfo.systemUptime - waitStarted
        // Taken only once a frame is free: taken before, a drawable was held while
        // the main thread waited on a GPU running behind (every orbit on).
        let drawableStarted = ProcessInfo.processInfo.systemUptime
        let currentDrawable = view.currentDrawable
        let waitedForDrawable = ProcessInfo.processInfo.systemUptime - drawableStarted
        if currentDrawable != nil {
            drawables.drawableTaken(waited: waitedForDrawable, interval: Self.interval(of: view))
        }
        guard let drawable = currentDrawable, let screen = view.currentRenderPassDescriptor, let commands = queue.makeCommandBuffer() else {
            if currentDrawable != nil {
                drawables.drawableUnused()
            }
            inFlight.signal()
            return nil
        }
        #if !targetEnvironment(simulator)
            let gate = drawables
            let presentation = presentation
            drawable.addPresentedHandler { [weak view] presented in
                presentation.shown(at: presented.presentedTime)
                if gate.beginsTurnedAwayFrame(afterPresenting: presented.presentedTime > 0) {
                    // Drawn outside MTKView's loop, which stops in the background.
                    Task { @MainActor in
                        if Self.isShowing(view) {
                            view?.draw()
                        }
                    }
                }
            }
        #endif
        let semaphore = inFlight
        commands.addCompletedHandler { _ in semaphore.signal() }
        faults.watch(commands)
        index = (index + 1) % Self.framesInFlight
        return Frame(commands: commands, drawable: drawable, screen: screen, waitedForBuffer: waitedForBuffer, waitedForDrawable: waitedForDrawable)
    }

    /// Presents and commits `frame`, begun at `started` and to be shown at `shown`;
    /// its id, by which `meter`, while measuring, is given its time on the GPU.
    func commit(_ frame: Frame, started: Double, shown: Double, meter: FrameMeter?) -> Int {
        let committed = ProcessInfo.processInfo.systemUptime
        let id = presentation.began(committed: committed, cpu: frame.cpu(from: started, to: committed), shown: shown)
        frame.commands.addCompletedHandler { [presentation] buffer in
            let (start, end) = (buffer.gpuStartTime, buffer.gpuEndTime)
            presentation.done(id, start: start, end: end)
            meter?.gpu(start: start, end: end, frame: id)
        }
        frame.commands.present(frame.drawable)
        frame.commands.commit()
        return id
    }

    /// A buffer of at least `length` bytes for the stencils of the frame begun
    /// last, which the GPU is not still reading.
    func pointFrameBuffer(length: Int, device: MTLDevice) -> MTLBuffer? {
        if (pointFrameBuffers[index]?.length ?? 0) < length {
            pointFrameBuffers[index] = device.makeBuffer(length: length, options: .storageModeShared)
        }
        return pointFrameBuffers[index]
    }

    /// Seconds between the frames `view` asks for.
    private static func interval(of view: MTKView) -> Double {
        1 / Double(max(1, view.preferredFramesPerSecond))
    }

    /// Whether `view` is on screen, where the GPU is the app's: the app in front
    /// on iOS, the window not hidden on a Mac.
    private static func isShowing(_ view: MTKView?) -> Bool {
        #if canImport(UIKit)
            UIApplication.shared.applicationState == .active
        #else
            view?.window?.occlusionState.contains(.visible) ?? false
        #endif
    }
}
