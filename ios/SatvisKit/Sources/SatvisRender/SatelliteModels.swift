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

    init?(_ asset: ModelAsset, device: MTLDevice) {
        guard let vertices = asset.vertices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }),
            let indices = asset.indices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) })
        else {
            return nil
        }
        let loader = MTKTextureLoader(device: device)
        let textures = asset.images.map { image in
            try? loader.newTexture(cgImage: image, options: [.SRGB: true, .generateMipmaps: true, .textureStorageMode: MTLStorageMode.private.rawValue])
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

    private func load(_ file: String) {
        guard let loader else {
            return
        }
        models[file] = .loading
        let device = device
        Task {
            let prepared = await Task.detached(priority: .utility) { () -> PreparedModel? in
                guard let data = await loader(file) else {
                    return nil
                }
                do {
                    return PreparedModel(try ModelAsset(glb: data), device: device)
                } catch {
                    return nil
                }
            }.value
            models[file] = prepared.map(State.ready) ?? .failed(at: Date())
        }
    }
}
