import Foundation
import MetalKit
import SatvisCore
import simd

public enum RendererError: Error {
    case noDevice
    case missingShader(String)
    case missingFunction(String)
}

/// Compiles Shaders/*.msl. At run time rather than at build time, so that neither
/// the build nor CI needs Xcode's separately downloaded Metal toolchain.
enum ShaderLibrary {
    static let files = ["Common", "Sky", "Globe", "Points", "Lines", "Labels", "Tonemap"]

    static func make(device: MTLDevice) async throws -> MTLLibrary {
        let source = try files.map { name in
            guard let url = Bundle.module.url(forResource: name, withExtension: "msl", subdirectory: "Shaders") else {
                throw RendererError.missingShader(name)
            }
            return try String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n")
        let options = MTLCompileOptions()
        // Fast math may regroup the high/low subtraction relativeToEye depends on.
        options.mathMode = .safe
        return try await device.makeLibrary(source: source, options: options)
    }
}

/// What is drawn for each satellite: the web app's satellite components, those
/// this milestone draws.
public struct SatelliteComponents: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let point = SatelliteComponents(rawValue: 1 << 0)
    public static let label = SatelliteComponents(rawValue: 1 << 1)
    public static let orbit = SatelliteComponents(rawValue: 1 << 2)
    public static let orbitTrack = SatelliteComponents(rawValue: 1 << 3)

    /// The web app's names, as its `elements` url parameter and presets use them.
    public static let named: [(String, SatelliteComponents)] = [("Point", .point), ("Label", .label), ("Orbit", .orbit), ("Orbit track", .orbitTrack)]
}

/// Draws the globe, the sky around it and the satellites over it, for one MTKView.
@MainActor
public final class GlobeRenderer: NSObject, MTKViewDelegate {
    /// Nil until the view has a size, then the web app's home view.
    public var camera: OrbitCamera?
    /// The satellite the camera follows, by id. Nil for the free camera.
    public private(set) var tracked: String?
    public var trackingCamera = TrackingCamera()
    public var components: SatelliteComponents = [.point, .label]
    /// The instant to draw, in UTC milliseconds since 1970.
    public var clock: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    private static let hdrFormat = MTLPixelFormat.rgba16Float
    private static let depthFormat = MTLPixelFormat.depth32Float
    private static let framesInFlight = 3

    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let skyBoxPipeline: MTLRenderPipelineState
    private let skyAtmospherePipeline: MTLRenderPipelineState
    private let globePipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let labelPipeline: MTLRenderPipelineState
    private let tonemapPipeline: MTLRenderPipelineState
    private let depthWrite: MTLDepthStencilState
    private let depthTest: MTLDepthStencilState
    private let noDepth: MTLDepthStencilState
    private let linearSampler: MTLSamplerState
    private let globe: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)
    private let skyShell: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)
    private var imagery: MTLTexture?
    private var stars: MTLTexture?
    private var hdr: MTLTexture?
    private var depth: MTLTexture?
    private let points = SatellitePoints()
    private var labels: (atlas: LabelAtlas, instances: MTLBuffer)?
    private let pixelScale: Double
    /// What the last frame was drawn from, for picking.
    private var lastFrame: (viewProjection: simd_double4x4, position: SIMD3<Double>, size: SIMD2<Double>, time: Double)?
    private var pointFrameBuffers: [MTLBuffer?]
    private var frameIndex = 0
    private let inFlight = DispatchSemaphore(value: framesInFlight)

    /// Compiles the shaders, which takes a second or two, without holding up the
    /// main thread, then takes over drawing the view.
    public static func make(view: MTKView) async throws -> GlobeRenderer {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
            throw RendererError.noDevice
        }
        return try GlobeRenderer(view: view, device: device, library: try await ShaderLibrary.make(device: device))
    }

    private init(view: MTKView, device: MTLDevice, library: MTLLibrary) throws {
        guard let queue = device.makeCommandQueue() else {
            throw RendererError.noDevice
        }
        self.device = device
        self.queue = queue
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .invalid
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

        func function(_ name: String) throws -> MTLFunction {
            guard let function = library.makeFunction(name: name) else {
                throw RendererError.missingFunction(name)
            }
            return function
        }
        func pipeline(
            _ vertex: String, _ fragment: String, format: MTLPixelFormat = Self.hdrFormat, depth: Bool = true, blend: Bool = false, premultiplied: Bool = false
        ) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try function(vertex)
            descriptor.fragmentFunction = try function(fragment)
            descriptor.colorAttachments[0].pixelFormat = format
            if blend {
                let attachment = descriptor.colorAttachments[0]!
                attachment.isBlendingEnabled = true
                attachment.sourceRGBBlendFactor = premultiplied ? .one : .sourceAlpha
                attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
                attachment.sourceAlphaBlendFactor = .one
                attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            if depth {
                descriptor.depthAttachmentPixelFormat = Self.depthFormat
            }
            return try device.makeRenderPipelineState(descriptor: descriptor)
        }
        skyBoxPipeline = try pipeline("fullscreenVertex", "skyBoxFragment")
        skyAtmospherePipeline = try pipeline("skyAtmosphereVertex", "skyAtmosphereFragment", blend: true)
        globePipeline = try pipeline("globeVertex", "globeFragment")
        pointPipeline = try pipeline("pointVertex", "pointFragment")
        linePipeline = try pipeline("lineVertex", "lineFragment", blend: true)
        labelPipeline = try pipeline("labelVertex", "labelFragment", blend: true, premultiplied: true)
        tonemapPipeline = try pipeline("fullscreenVertex", "tonemapFragment", format: view.colorPixelFormat, depth: false)

        func depthState(compare: MTLCompareFunction, write: Bool) -> MTLDepthStencilState {
            let descriptor = MTLDepthStencilDescriptor()
            descriptor.depthCompareFunction = compare
            descriptor.isDepthWriteEnabled = write
            return device.makeDepthStencilState(descriptor: descriptor)!
        }
        // Reversed-Z: nearer is greater.
        depthWrite = depthState(compare: .greater, write: true)
        depthTest = depthState(compare: .greater, write: false)
        noDepth = depthState(compare: .always, write: false)

        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.mipFilter = .linear
        samplerDescriptor.maxAnisotropy = 8
        samplerDescriptor.sAddressMode = .repeat
        samplerDescriptor.tAddressMode = .clampToEdge
        linearSampler = device.makeSamplerState(descriptor: samplerDescriptor)!

        func upload<Vertex: BitwiseCopyable>(_ mesh: EllipsoidMesh<Vertex>) -> (MTLBuffer, MTLBuffer, Int) {
            let vertices = mesh.vertices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
            let indices = mesh.indices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
            return (vertices, indices, mesh.indices.count)
        }
        globe = upload(Meshes.globe())
        skyShell = upload(Meshes.skyShell())
        pointFrameBuffers = Array(repeating: nil, count: Self.framesInFlight)
        pixelScale = Double(view.contentScaleFactorForPoints)
        super.init()
        view.delegate = self
        mtkView(view, drawableSizeWillChange: view.drawableSize)
        loadTextures()
    }

    /// Decodes off the main thread; the globe is not drawn until it lands.
    private func loadTextures() {
        Task.detached(priority: .userInitiated) {
            let imagery = Textures.naturalEarth()
            await MainActor.run {
                self.imagery = imagery.flatMap { Textures.texture2D($0, device: self.device, queue: self.queue) }
            }
        }
    }

    /// The star map behind everything: six encoded square faces in the order
    /// +X, −X, +Y, −Y, +Z, −Z, oriented as a CesiumJS sky box is. The sky is black
    /// until it is set.
    public func setStarMap(faces: [Data]) {
        Task.detached(priority: .utility) {
            let bitmaps = Textures.cubeFaces(faces)
            await MainActor.run {
                self.stars = bitmaps.flatMap { Textures.textureCube($0, device: self.device, queue: self.queue) }
            }
        }
    }

    public func setSatellites(_ satellites: [PointSatellite]) {
        let names = points.satellites.map(\.name)
        points.update(satellites, device: device)
        guard satellites.map(\.name) != names || labels == nil else {
            return
        }
        labels = nil
        if !satellites.isEmpty, satellites.count <= LabelAtlas.maximumLabels, let atlas = LabelAtlas(names: satellites.map(\.name), scale: pixelScale, device: device) {
            labels = atlas.instances.withUnsafeBytes { bytes in
                device.makeBuffer(bytes: bytes.baseAddress!, length: bytes.count).map { (atlas, $0) }
            }
        }
    }

    /// Follows a satellite from where the web app's tracking view opens.
    public func track(_ id: String) {
        tracked = id
        trackingCamera = TrackingCamera()
    }

    /// Lets go, and leaves the camera 2,000 km straight above the satellite, as the
    /// web app does.
    public func stopTracking() {
        if let tracked, let lastFrame, let position = points.position(of: tracked, at: lastFrame.time) {
            camera = .above(position, altitude: 2_000_000)
        }
        tracked = nil
    }

    /// The satellite drawn nearest a point on the view, within a fingertip of it
    /// and not behind the Earth.
    public func satellite(at point: CGPoint, viewSize: CGSize) -> String? {
        guard let lastFrame, viewSize.width > 0, components.contains(.point) || components.contains(.label) else {
            return nil
        }
        let reach = 24.0
        var best: (id: String, distance: Double)?
        for satellite in points.satellites {
            guard let position = satellite.trajectory.position(at: lastFrame.time), !Self.isHiddenByEarth(position, from: lastFrame.position) else {
                continue
            }
            let clip = lastFrame.viewProjection * SIMD4(position - lastFrame.position, 1)
            guard clip.w > 0 else {
                continue
            }
            let screen = SIMD2((clip.x / clip.w + 1) / 2 * viewSize.width, (1 - clip.y / clip.w) / 2 * viewSize.height)
            let distance = simd.distance(screen, SIMD2(point.x, point.y))
            if distance < reach, distance < best?.distance ?? .infinity {
                best = (satellite.id, distance)
            }
        }
        return best?.id
    }

    /// Whether the line of sight to a point passes through the Earth, taken as a
    /// sphere of its polar radius.
    private static func isHiddenByEarth(_ point: SIMD3<Double>, from eye: SIMD3<Double>) -> Bool {
        let direction = point - eye
        let length = simd.length(direction)
        let unit = direction / length
        let closest = -dot(eye, unit)
        guard closest > 0, closest < length else {
            return false
        }
        return simd.length(eye + closest * unit) < ellipsoidRadii.z
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            return
        }
        if camera == nil {
            camera = OrbitCamera.home(aspectRatio: size.width / size.height)
        }
        func target(_ format: MTLPixelFormat) -> MTLTexture? {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: Int(size.width), height: Int(size.height), mipmapped: false)
            descriptor.usage = [.renderTarget, .shaderRead]
            descriptor.storageMode = .private
            return device.makeTexture(descriptor: descriptor)
        }
        hdr = target(Self.hdrFormat)
        depth = target(Self.depthFormat)
    }

    public func draw(in view: MTKView) {
        guard let camera, let hdr, let depth, let drawable = view.currentDrawable, let screen = view.currentRenderPassDescriptor else {
            return
        }
        let now = clock()
        var pose = camera.pose()
        if let tracked, let target = points.position(of: tracked, at: now) {
            pose = trackingCamera.pose(target: target)
        }
        inFlight.wait()
        guard let commands = queue.makeCommandBuffer() else {
            inFlight.signal()
            return
        }
        let semaphore = inFlight
        commands.addCompletedHandler { _ in semaphore.signal() }
        frameIndex = (frameIndex + 1) % Self.framesInFlight

        var frame = uniforms(pose: pose, size: SIMD2(Double(hdr.width), Double(hdr.height)), now: now)

        let scene = MTLRenderPassDescriptor()
        scene.colorAttachments[0].texture = hdr
        scene.colorAttachments[0].loadAction = .clear
        scene.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        scene.colorAttachments[0].storeAction = .store
        scene.depthAttachment.texture = depth
        scene.depthAttachment.loadAction = .clear
        scene.depthAttachment.clearDepth = 0
        scene.depthAttachment.storeAction = .dontCare
        if let encoder = commands.makeRenderCommandEncoder(descriptor: scene) {
            encoder.setFrontFacing(.counterClockwise)
            encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
            encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)

            if let stars {
                encoder.setRenderPipelineState(skyBoxPipeline)
                encoder.setDepthStencilState(noDepth)
                encoder.setCullMode(.none)
                encoder.setFragmentTexture(stars, index: 0)
                encoder.setFragmentSamplerState(linearSampler, index: 0)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }

            encoder.setRenderPipelineState(skyAtmospherePipeline)
            encoder.setDepthStencilState(noDepth)
            encoder.setCullMode(.front)
            encoder.setVertexBuffer(skyShell.vertices, offset: 0, index: 0)
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: skyShell.count, indexType: .uint32, indexBuffer: skyShell.indices, indexBufferOffset: 0)

            if let imagery {
                encoder.setRenderPipelineState(globePipeline)
                encoder.setDepthStencilState(depthWrite)
                encoder.setCullMode(.back)
                encoder.setVertexBuffer(globe.vertices, offset: 0, index: 0)
                encoder.setFragmentTexture(imagery, index: 0)
                encoder.setFragmentSamplerState(linearSampler, index: 0)
                encoder.drawIndexedPrimitives(type: .triangle, indexCount: globe.count, indexType: .uint32, indexBuffer: globe.indices, indexBufferOffset: 0)
            }

            if let samples = points.samples, let instances = points.instances, let states = pointFrames(at: now) {
                encoder.setDepthStencilState(depthTest)
                encoder.setCullMode(.none)
                encoder.setVertexBuffer(samples, offset: 0, index: 0)
                encoder.setVertexBuffer(instances, offset: 0, index: 2)
                encoder.setVertexBuffer(states, offset: 0, index: 3)
                for (component, kind) in [(SatelliteComponents.orbit, 0), (.orbitTrack, 1)] where components.contains(component) {
                    var kind = Int32(kind)
                    encoder.setRenderPipelineState(linePipeline)
                    encoder.setVertexBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
                    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 2 * 121, instanceCount: points.count)
                }
                if components.contains(.point) {
                    encoder.setRenderPipelineState(pointPipeline)
                    encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: points.count)
                }
                if components.contains(.label), let labels {
                    encoder.setRenderPipelineState(labelPipeline)
                    encoder.setVertexBuffer(labels.instances, offset: 0, index: 4)
                    encoder.setFragmentTexture(labels.atlas.texture, index: 0)
                    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: labels.atlas.instances.count)
                }
            }
            encoder.endEncoding()
        }

        if let encoder = commands.makeRenderCommandEncoder(descriptor: screen) {
            encoder.setRenderPipelineState(tonemapPipeline)
            encoder.setFragmentTexture(hdr, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
        }
        commands.present(drawable)
        commands.commit()
    }

    /// This frame's stencils, in a buffer the GPU is not still reading.
    private func pointFrames(at now: Double) -> MTLBuffer? {
        let frames = points.frames(at: now)
        let length = frames.count * MemoryLayout<PointFrame>.stride
        guard length > 0 else {
            return nil
        }
        if (pointFrameBuffers[frameIndex]?.length ?? 0) < length {
            pointFrameBuffers[frameIndex] = device.makeBuffer(length: length, options: .storageModeShared)
        }
        guard let buffer = pointFrameBuffers[frameIndex] else {
            return nil
        }
        frames.withUnsafeBytes { buffer.contents().copyMemory(from: $0.baseAddress!, byteCount: length) }
        return buffer
    }

    private func uniforms(pose: CameraPose, size: SIMD2<Double>, now: Double) -> FrameUniforms {
        let viewProjection = OrbitCamera.projection(aspectRatio: size.x / size.y) * pose.view()
        lastFrame = (viewProjection, pose.position, size, now)
        let angle = greenwichHourAngle(epochMilliseconds: now)
        let (c, s) = (Float(cos(angle)), Float(sin(angle)))
        let position = pose.position
        let (high, low) = encode(position)
        return FrameUniforms(
            viewProjection: float4x4(viewProjection),
            inverseViewProjection: float4x4(viewProjection.inverse),
            fixedToTEME: simd_float3x3(columns: (SIMD3(c, s, 0), SIMD3(-s, c, 0), SIMD3(0, 0, 1))),
            cameraHigh: high,
            cameraLow: low,
            cameraPosition: SIMD3<Float>(position),
            sunDirection: SIMD3<Float>(Sun.directionFixed(epochMilliseconds: now)),
            viewportSize: SIMD2<Float>(size),
            eyeHeight: Float(pose.eyeHeight),
            cameraDistance: Float(length(position)),
            pointSize: Float(7 * pixelScale),
            pixelScale: Float(pixelScale))
    }
}

private func float4x4(_ m: simd_double4x4) -> simd_float4x4 {
    simd_float4x4(columns: (SIMD4<Float>(m.columns.0), SIMD4<Float>(m.columns.1), SIMD4<Float>(m.columns.2), SIMD4<Float>(m.columns.3)))
}

extension MTKView {
    /// Pixels per point, on either platform.
    fileprivate var contentScaleFactorForPoints: CGFloat {
        #if canImport(UIKit)
            contentScaleFactor
        #else
            window?.backingScaleFactor ?? 2
        #endif
    }
}
