import Foundation
import Metal
import MetalKit
import simd

/// A 3D model on the GPU.
final class PreparedModel: @unchecked Sendable {
    struct Part {
        var indexStart: Int
        var indexCount: Int
        var material: ModelAsset.Material
        var texture: MTLTexture?
    }

    let vertices: MTLBuffer
    let indices: MTLBuffer
    let parts: [Part]
    /// The bounding sphere's, in metres in the model's frame.
    let center: SIMD3<Float>
    let radius: Float

    /// The asset on the GPU, its textures loaded without holding a thread: the
    /// loader's synchronous call waits on a semaphore for work of its own, and
    /// six models loading at once took all six of an iPad mini 6's cooperative
    /// threads that way, for good, which stopped every task in the app.
    static func prepare(_ asset: ModelAsset, device: MTLDevice) async -> PreparedModel? {
        let loader = MTKTextureLoader(device: device)
        var textures: [MTLTexture?] = []
        for image in asset.images {
            textures.append(
                try? await loader.newTexture(cgImage: image, options: [.SRGB: true, .generateMipmaps: true, .textureStorageMode: MTLStorageMode.private.rawValue]))
        }
        return PreparedModel(asset, textures: textures, device: device)
    }

    private init?(_ asset: ModelAsset, textures: [MTLTexture?], device: MTLDevice) {
        guard let vertices = asset.vertices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }),
            let indices = asset.indices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) })
        else {
            return nil
        }
        self.vertices = vertices
        self.indices = indices
        parts = asset.parts.map { part in
            let material = asset.materials[part.material]
            return Part(
                indexStart: part.indexStart, indexCount: part.indexCount, material: material,
                texture: material.texture.flatMap { textures.indices.contains($0) ? textures[$0] : nil })
        }
        center = asset.center
        radius = asset.radius
    }

    /// A model file fetched, read and put on the GPU off the main thread; nil if any step fails.
    static func load(
        _ file: String, loader: @escaping @Sendable (String) async -> Data?, device: MTLDevice, priority: TaskPriority
    ) async -> PreparedModel? {
        await Task.detached(priority: priority) { () -> PreparedModel? in
            guard let data = await loader(file), let asset = try? ModelAsset(glb: data) else {
                return nil
            }
            return await PreparedModel.prepare(asset, device: device)
        }.value
    }

    /// One of the model pass's two passes: the opaque and cut-out parts, writing
    /// depth, or the blended ones over them, testing it, as CesiumJS draws glTF's
    /// translucent parts. A model drawn see-through is blended whole. `base`
    /// holds what the parts share; each part sets its material.
    func encodeParts(blended: Bool, wholeBlended: Bool, base: ModelInstance, encoder: MTLRenderCommandEncoder) {
        encoder.setVertexBuffer(vertices, offset: 0, index: 0)
        for part in parts where (part.material.alphaMode == .blend || wholeBlended) == blended {
            var instance = base
            instance.baseColor = part.material.baseColor
            instance.hasTexture = part.texture == nil ? 0 : 1
            instance.metallic = part.material.metallic
            instance.roughness = part.material.roughness
            instance.alphaCutoff = 0
            if case .mask(let cutoff) = part.material.alphaMode {
                instance.alphaCutoff = cutoff
            }
            encoder.setCullMode(part.material.doubleSided ? .none : .back)
            encoder.setVertexBytes(&instance, length: MemoryLayout<ModelInstance>.stride, index: 1)
            encoder.setFragmentBytes(&instance, length: MemoryLayout<ModelInstance>.stride, index: 1)
            encoder.setFragmentTexture(part.texture, index: 0)
            encoder.drawIndexedPrimitives(
                type: .triangle, indexCount: part.indexCount, indexType: .uint32, indexBuffer: indices,
                indexBufferOffset: part.indexStart * MemoryLayout<UInt32>.stride)
        }
    }
}

/// Mirrors `ModelInstance` in Shaders/Models.msl.
struct ModelInstance {
    var modelViewProjection: simd_float4x4
    /// The model's frame turned into the fixed one, unscaled: for normals.
    var rotation: simd_float3x3
    /// Relative to the eye, in metres: for the light's highlight.
    var modelToEye: simd_float4x4
    var baseColor: SIMD4<Float>
    var sunDirection: SIMD3<Float>
    var hasTexture: Int32
    var metallic: Float
    var roughness: Float
    /// Below it a fragment is cut out (`AlphaMode.mask`); 0 for none.
    var alphaCutoff: Float
    /// How the sky view draws it, 1 as usual: drawn blended below 1.
    var opacity: Float
}

/// The model pass's two pipelines, the globe's and the close-up's alike: the
/// opaque and cut-out parts, whose alpha is their coverage
/// (`modelOpaqueFragment`), and the blended ones.
struct ModelPipelines {
    /// What the pipelines draw into.
    struct Targets: Equatable {
        var color: MTLPixelFormat
        /// A second colour target the models leave unwritten: the screen, where
        /// the globe tonemaps in tile memory.
        var screen: MTLPixelFormat?
        var depth: MTLPixelFormat
        var sampleCount = 1
    }

    let opaque: MTLRenderPipelineState
    let blended: MTLRenderPipelineState

    /// `vertex` and `fragment` are the libraries each stage's function comes from:
    /// the globe places its models with safe math.
    init(device: MTLDevice, vertex: MTLLibrary, fragment: MTLLibrary, targets: Targets) throws {
        opaque = try device.makeRenderPipelineState(descriptor: try Self.descriptor(blended: false, vertex: vertex, fragment: fragment, targets: targets))
        blended = try device.makeRenderPipelineState(descriptor: try Self.descriptor(blended: true, vertex: vertex, fragment: fragment, targets: targets))
    }

    /// One of the two, not yet built.
    static func descriptor(blended: Bool, vertex: MTLLibrary, fragment: MTLLibrary, targets: Targets) throws -> MTLRenderPipelineDescriptor {
        func function(_ name: String, in library: MTLLibrary) throws -> MTLFunction {
            guard let function = library.makeFunction(name: name) else {
                throw RendererError.missingFunction(name)
            }
            return function
        }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = try function("modelVertex", in: vertex)
        descriptor.fragmentFunction = try function(blended ? "modelFragment" : "modelOpaqueFragment", in: fragment)
        descriptor.colorAttachments[0].pixelFormat = targets.color
        if let screen = targets.screen {
            descriptor.colorAttachments[1].pixelFormat = screen
            descriptor.colorAttachments[1].writeMask = []
        }
        descriptor.depthAttachmentPixelFormat = targets.depth
        descriptor.rasterSampleCount = targets.sampleCount
        if blended {
            let attachment = descriptor.colorAttachments[0]!
            attachment.isBlendingEnabled = true
            attachment.sourceRGBBlendFactor = .sourceAlpha
            attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
            attachment.sourceAlphaBlendFactor = .one
            attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        }
        return descriptor
    }
}

/// The satellites' 3D models: fetched by file when first drawn, read off the main
/// thread, and kept for the session. A file that fails is tried again a minute
/// later.
@MainActor
final class SatelliteModels {
    private enum State {
        case loading
        case ready(PreparedModel)
        case failed(at: Date)
    }

    /// Fetches a model file's bytes by its path under /data/models/: the app's
    /// fetcher, nil when it has none.
    var loader: (@Sendable (String) async -> Data?)?
    private var models: [String: State] = [:]
    /// The files `keep` last left, which a load landing after is kept only if
    /// among; nil, every file.
    private var wanted: Set<String>?
    /// Counts the models that loaded or failed, for the frame that shows them.
    private(set) var revision = 0
    private let device: MTLDevice
    private static let retryInterval: TimeInterval = 60

    init(device: MTLDevice) {
        self.device = device
    }

    /// The model, once it has loaded; asks for it the first time.
    func model(_ file: String) -> PreparedModel? {
        switch models[file] {
        case .ready(let model):
            return model
        case .loading:
            return nil
        case .failed(let at) where Date().timeIntervalSince(at) < Self.retryInterval:
            return nil
        case .failed, nil:
            load(file)
            return nil
        }
    }

    /// Lets go of every model but `files`, loaded or on its way: each holds its
    /// meshes and textures on the GPU for good otherwise, the ISS 128 MB.
    func keep(only files: Set<String>) {
        wanted = files
        models = models.filter { files.contains($0.key) }
    }

    /// Whether the file failed to load and is not due to be tried again yet.
    func failed(_ file: String) -> Bool {
        if case .failed(let at) = models[file] {
            return Date().timeIntervalSince(at) < Self.retryInterval
        }
        return false
    }

    private func load(_ file: String) {
        guard let loader else {
            return
        }
        models[file] = .loading
        let device = device
        Task {
            let prepared = await PreparedModel.load(file, loader: loader, device: device, priority: .utility)
            guard wanted?.contains(file) ?? true else {
                return
            }
            models[file] = prepared.map(State.ready) ?? .failed(at: Date())
            revision += 1
            if prepared == nil {
                // Asked for again by the first frame drawn after this, which a
                // stopped clock and a still camera wait for.
                try? await Task.sleep(for: .seconds(Self.retryInterval))
                revision += 1
            }
        }
    }
}
