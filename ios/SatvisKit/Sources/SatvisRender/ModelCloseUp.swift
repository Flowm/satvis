import Foundation
import Metal
import MetalKit
import simd

/// One satellite's model on its own, for the info panel's Spacecraft tab, as the
/// web app's ModelCloseUp shows it: framed from ahead, starboard and above, turning
/// once a minute until it is dragged or pinched, under a light kept over the
/// viewer's left shoulder. Drawn by the globe's model shaders (Shaders/Models.msl)
/// in the model's own frame: +Z along the velocity, +Y to the zenith, +X to port.
/// It draws only while the model turns or is moved.
@MainActor
public final class ModelCloseUp: NSObject, MTKViewDelegate {
    /// What the view over the scene shows: a note while loading or failed, the reset button once ready.
    public enum State: Sendable {
        case loading, ready, failed
    }

    /// Told of every state change.
    public var onState: ((State) -> Void)?

    /// Called with the first frame the GPU fails of each kind, which it logs.
    public var onGPUFault: (@MainActor @Sendable (GPUFault) -> Void)? {
        get { faults.onFault }
        set { faults.onFault = newValue }
    }

    private weak var view: MTKView?
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let blendPipeline: MTLRenderPipelineState
    private let depthWrite: MTLDepthStencilState
    private let depthTest: MTLDepthStencilState
    private let sampler: MTLSamplerState
    private let faults = GPUFaults()

    private var model: PreparedModel?
    /// Bumped per load, so a slow load that was superseded discards its model.
    private var generation = 0
    private var state = State.loading {
        didSet { onState?(state) }
    }

    /// Radians about the model's zenith; 0 looks from straight ahead.
    private var yaw = 0.0
    /// Radians above the model's horizon.
    private var pitch = 0.0
    /// Metres from the bounding sphere's centre.
    private var distance = 1.0
    /// Until the first drag or pinch; `resetView` turns it back on.
    private var turning = true
    private var lastFrame: CFTimeInterval?

    /// From ahead and starboard: the web app's heading of −π/4.
    private static let defaultYaw = -Double.pi / 4
    /// The web app's pitch of −0.35 rad, which tilts its camera down; here the eye rises.
    private static let defaultPitch = 0.35
    /// Short of looking straight down or up, where the yaw turns about the line of sight.
    private static let pitchLimit = 1.5
    private static let radiansPerPoint = 0.01
    /// One turn a minute.
    private static let turnRadiansPerSecond = 2 * Double.pi / 60
    private static let verticalFieldOfView = 40 * Double.pi / 180

    /// The models' shaders alone, compiled once for every close-up.
    private static var library: Task<MTLLibrary, Error>?

    /// Sets the view up for the close-up and compiles its shaders off the main thread, the first time.
    public static func make(view: MTKView) async throws -> ModelCloseUp {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
            throw RendererError.noDevice
        }
        view.device = device
        view.colorPixelFormat = .bgra8Unorm_srgb
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount = 4
        // Clear, over the caller's backdrop: the view itself has to be made transparent too.
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        let task = library ?? Task { try await ShaderLibrary.makeFast(device: device, files: ["Common", "Models"]) }
        library = task
        let compiled: MTLLibrary
        do {
            compiled = try await task.value
        } catch {
            // Compiled again by the next close-up rather than failing every one until relaunch.
            library = nil
            throw error
        }
        let closeUp = try ModelCloseUp(view: view, device: device, library: compiled)
        view.delegate = closeUp
        closeUp.updateDrawing()
        return closeUp
    }

    private init(view: MTKView, device: MTLDevice, library: MTLLibrary) throws {
        guard let commandQueue = device.makeCommandQueue() else {
            throw RendererError.noDevice
        }
        self.view = view
        self.device = device
        self.commandQueue = commandQueue
        func pipeline(blend: Bool) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "modelVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "modelFragment")
            descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
            descriptor.depthAttachmentPixelFormat = view.depthStencilPixelFormat
            descriptor.rasterSampleCount = view.sampleCount
            if blend {
                let attachment = descriptor.colorAttachments[0]!
                attachment.isBlendingEnabled = true
                attachment.sourceRGBBlendFactor = .sourceAlpha
                attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
                attachment.sourceAlphaBlendFactor = .one
                attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            return try device.makeRenderPipelineState(descriptor: descriptor)
        }
        self.pipeline = try pipeline(blend: false)
        blendPipeline = try pipeline(blend: true)
        func depthState(write: Bool) -> MTLDepthStencilState? {
            let descriptor = MTLDepthStencilDescriptor()
            descriptor.depthCompareFunction = .less
            descriptor.isDepthWriteEnabled = write
            return device.makeDepthStencilState(descriptor: descriptor)
        }
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.mipFilter = .linear
        samplerDescriptor.sAddressMode = .repeat
        samplerDescriptor.tAddressMode = .repeat
        guard let depthWrite = depthState(write: true), let depthTest = depthState(write: false),
            let sampler = device.makeSamplerState(descriptor: samplerDescriptor)
        else {
            throw RendererError.noDevice
        }
        self.depthWrite = depthWrite
        self.depthTest = depthTest
        self.sampler = sampler
    }

    /// Replaces the shown model with the one `loader` fetches by its path under
    /// /data/models/, clearing the old one at once.
    public func load(_ file: String, loader: @escaping @Sendable (String) async -> Data?) {
        generation += 1
        let generation = generation
        model = nil
        state = .loading
        updateDrawing()
        let device = device
        Task {
            let prepared = await PreparedModel.load(file, loader: loader, device: device, priority: .userInitiated)
            guard generation == self.generation else {
                return
            }
            model = prepared
            resetView()
            state = prepared == nil ? .failed : .ready
        }
    }

    /// Frames the whole model from the default angle and starts it turning again.
    public func resetView() {
        yaw = Self.defaultYaw
        pitch = Self.defaultPitch
        // 0.85 of what fits the bounding sphere, as on the web: models are rarely round.
        distance = 0.85 * fittingDistance
        turning = true
        updateDrawing()
    }

    /// Turns the model under a drag, by its translation since the last call in points.
    public func drag(by translation: SIMD2<Double>) {
        turning = false
        yaw -= translation.x * Self.radiansPerPoint
        pitch = min(max(pitch + translation.y * Self.radiansPerPoint, -Self.pitchLimit), Self.pitchLimit)
        updateDrawing()
    }

    /// Moves in or out by a pinch's change in scale since the last call, between
    /// the web app's limits: 0.6 of the radius from the centre, and 4 times the framing distance.
    public func zoom(by scale: Double) {
        turning = false
        guard scale > 0 else {
            return
        }
        let radius = Double(model?.radius ?? 1)
        distance = min(max(distance / scale, 0.6 * radius), 4 * 0.85 * fittingDistance)
        updateDrawing()
    }

    /// Far enough for the bounding sphere to fill the field of view: the vertical
    /// one, as the close-up is wider than tall.
    private var fittingDistance: Double {
        Double(max(model?.radius ?? 1, 0.01)) / sin(Self.verticalFieldOfView / 2)
    }

    /// Frames on the display's clock while the model turns; otherwise one frame per change.
    private func updateDrawing() {
        guard let view else {
            return
        }
        let animating = turning && model != nil
        view.isPaused = !animating
        view.enableSetNeedsDisplay = !animating
        if !animating {
            lastFrame = nil
            #if canImport(UIKit)
                view.setNeedsDisplay()
            #else
                view.needsDisplay = true
            #endif
        }
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    public func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        if turning, let lastFrame {
            yaw += (now - lastFrame) * Self.turnRadiansPerSecond
        }
        lastFrame = turning ? now : nil
        guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
            let commands = commandQueue.makeCommandBuffer(), let encoder = commands.makeRenderCommandEncoder(descriptor: pass)
        else {
            return
        }
        let faults = faults
        commands.addCompletedHandler { buffer in
            if buffer.status == .error {
                faults.record(buffer.error)
            }
        }
        // With no model the pass only clears, so a load does not leave the last one standing.
        if let model {
            encode(model, size: view.drawableSize, encoder: encoder)
        }
        encoder.endEncoding()
        commands.present(drawable)
        commands.commit()
    }

    private func encode(_ model: PreparedModel, size: CGSize, encoder: MTLRenderCommandEncoder) {
        let aspect = size.height > 0 ? Double(size.width / size.height) : 1
        let center = SIMD3<Double>(model.center)
        let direction = SIMD3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw))
        let eye = center + direction * distance
        let forward = -direction
        let right = normalize(cross(forward, SIMD3(0, 1, 0)))
        let up = cross(right, forward)
        // Over the viewer's left shoulder: space has no fill, and a fixed sun leaves the far side black.
        let light = SIMD3<Float>(normalize(-0.5 * right + 0.6 * up - 0.6 * forward))
        let viewMatrix = simd_double4x4(
            rows: [SIMD4(right, -dot(right, eye)), SIMD4(up, -dot(up, eye)), SIMD4(-forward, dot(forward, eye)), SIMD4(0, 0, 0, 1)])
        let radius = Double(model.radius)
        let near = max(distance - 2 * radius, distance * 0.01)
        let far = distance + 2 * radius
        let projection = Self.perspective(fovy: Self.verticalFieldOfView, aspect: aspect, near: near, far: far)
        let toEye = simd_double4x4(columns: (SIMD4(1, 0, 0, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(-eye, 1)))
        let base = ModelInstance(
            modelViewProjection: float4x4(projection * viewMatrix), rotation: matrix_identity_float3x3, modelToEye: float4x4(toEye), baseColor: .one,
            sunDirection: light, hasTexture: 0, metallic: 0, roughness: 0, alphaCutoff: 0, opacity: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        for blended in [false, true] {
            encoder.setRenderPipelineState(blended ? blendPipeline : pipeline)
            encoder.setDepthStencilState(blended ? depthTest : depthWrite)
            model.encodeParts(blended: blended, wholeBlended: false, base: base, encoder: encoder)
        }
    }

    /// Metal's clip space: depth from 0 at `near` to 1 at `far`.
    private static func perspective(fovy: Double, aspect: Double, near: Double, far: Double) -> simd_double4x4 {
        let y = 1 / tan(fovy / 2)
        let x = y / aspect
        let z = far / (near - far)
        return simd_double4x4(columns: (SIMD4(x, 0, 0, 0), SIMD4(0, y, 0, 0), SIMD4(0, 0, z, -1), SIMD4(0, 0, z * near, 0)))
    }
}
