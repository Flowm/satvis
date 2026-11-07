import Foundation
import MetalKit

/// The frames in flight, three at most: each begun once one of them is free and a
/// drawable is (`DrawableGate`), timed to when it is shown (`FramePresentation`),
/// and checked for a GPU fault as it completes (`GPUFaults`).
@MainActor
final class FrameLoop {
    /// A frame begun: its command buffer, the drawable it ends on and the screen's
    /// pass, with how long each was waited for while measuring.
    struct Frame {
        let commands: MTLCommandBuffer
        let drawable: CAMetalDrawable
        let screen: MTLRenderPassDescriptor
        let waitedForBuffer: Double
        let waitedForDrawable: Double
    }

    private static let framesInFlight = 3

    let drawables = DrawableGate()
    /// When the frames begun are shown, which their content is timed to.
    let presentation = FramePresentation()
    let faults = GPUFaults()
    private let queue: MTLCommandQueue
    private let inFlight = DispatchSemaphore(value: framesInFlight)
    /// The frame in flight begun last, which its buffers are kept for.
    private var index = 0
    /// Each frame in flight's stencils (`PointFrame`).
    private var pointFrameBuffers: [MTLBuffer?] = Array(repeating: nil, count: framesInFlight)

    init(queue: MTLCommandQueue) {
        self.queue = queue
    }

    /// A command buffer once one of the frames in flight is free, and the drawable
    /// it ends on; nil, the frame given back, where either is missing or no
    /// drawable is free yet.
    func begin(_ view: MTKView, measuring: Bool) -> Frame? {
        // The simulator's drawables say nothing of being presented, so there
        // every frame takes one, as MTKView's own loop does.
        #if !targetEnvironment(simulator)
            let maximumDrawables = (view.layer as? CAMetalLayer)?.maximumDrawableCount ?? 3
            guard drawables.mayTake(maximum: maximumDrawables, at: ProcessInfo.processInfo.systemUptime) else {
                return nil
            }
        #endif
        let waitStarted = measuring ? ProcessInfo.processInfo.systemUptime : 0
        inFlight.wait()
        let waitedForBuffer = measuring ? ProcessInfo.processInfo.systemUptime - waitStarted : 0
        // Taken only once a frame is free: taken before, a drawable was held while
        // the main thread waited on a GPU running behind (every orbit on).
        let drawableStarted = ProcessInfo.processInfo.systemUptime
        let currentDrawable = view.currentDrawable
        let waitedForDrawable = ProcessInfo.processInfo.systemUptime - drawableStarted
        if currentDrawable != nil {
            drawables.drawableTaken(waited: waitedForDrawable, interval: 1 / Double(max(1, view.preferredFramesPerSecond)))
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
        let faults = faults
        commands.addCompletedHandler { buffer in
            semaphore.signal()
            if buffer.status == .error {
                faults.record(buffer.error)
            }
        }
        index = (index + 1) % Self.framesInFlight
        return Frame(commands: commands, drawable: drawable, screen: screen, waitedForBuffer: waitedForBuffer, waitedForDrawable: waitedForDrawable)
    }

    /// A buffer of at least `length` bytes for the stencils of the frame begun
    /// last, which the GPU is not still reading.
    func pointFrameBuffer(length: Int, device: MTLDevice) -> MTLBuffer? {
        if (pointFrameBuffers[index]?.length ?? 0) < length {
            pointFrameBuffers[index] = device.makeBuffer(length: length, options: .storageModeShared)
        }
        return pointFrameBuffers[index]
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
