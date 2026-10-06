import CoreGraphics
import DracoBridge
import Foundation
import ImageIO
import simd

/// Mirrors `ModelVertex` in Shaders/Models.msl.
struct ModelVertex {
    var position: SIMD3<Float>
    var normal: SIMD3<Float>
    var uv: SIMD2<Float>
}

/// A satellite's 3D model, read from a glTF binary (.glb) into what the model pass
/// draws: one list of vertices in the model's frame, the nodes' transforms
/// applied, and its triangles in runs of one material each. The model manifest
/// places a model in the frame a satellite is drawn in: glTF +Z along the
/// velocity, +Y to the zenith, +X to port (data/models/README.md).
///
/// What data/models uses is read: triangle primitives, plain or
/// KHR_draco_mesh_compression, metallic-roughness base colours and their
/// textures, PNG, JPEG or EXT_texture_webp. Animation, skins and morph targets
/// are not.
struct ModelAsset {
    struct Material {
        /// Linear RGBA.
        var baseColor = SIMD4<Float>(1, 1, 1, 1)
        /// Into `images`.
        var texture: Int?
        var metallic: Float = 1
        var roughness: Float = 1
        var doubleSided = false
        var blended = false
    }

    /// A run of `indices` drawn with one material.
    struct Part {
        var indexStart: Int
        var indexCount: Int
        var material: Int
    }

    enum Failure: Error {
        case notGLB
        case malformed(String)
    }

    var vertices: [ModelVertex] = []
    var indices: [UInt32] = []
    var parts: [Part] = []
    var materials: [Material] = []
    var images: [CGImage] = []
    /// The sphere around the corners of the model's box, as CesiumJS bounds a model:
    /// what its size on screen and the tracking distance go by. Metres.
    var center = SIMD3<Float>(0, 0, 0)
    var radius: Float = 0

    init(glb data: Data) throws {
        let (json, binary) = try Self.chunks(data)
        guard let document = try JSONSerialization.jsonObject(with: json) as? [String: Any] else {
            throw Failure.malformed("JSON")
        }
        var reader = Reader(document: document, binary: binary)
        materials = (document["materials"] as? [[String: Any]] ?? []).map { reader.material($0) }
        // A primitive without a material takes glTF's default.
        materials.append(Material())
        images = (document["images"] as? [[String: Any]] ?? []).map { reader.image($0) ?? Self.white }

        let scenes = document["scenes"] as? [[String: Any]] ?? []
        let scene = scenes[safe: document["scene"] as? Int ?? 0]
        let roots = scene?["nodes"] as? [Int] ?? Array((reader.nodes.indices))
        for root in roots {
            try add(node: root, parent: matrix_identity_float4x4, reader: &reader, depth: 0)
        }
        guard !vertices.isEmpty else {
            throw Failure.malformed("no triangles")
        }
        let low = vertices.reduce(SIMD3<Float>(repeating: .infinity)) { simd_min($0, $1.position) }
        let high = vertices.reduce(SIMD3<Float>(repeating: -.infinity)) { simd_max($0, $1.position) }
        center = (low + high) / 2
        radius = simd_length(high - low) / 2
    }

    private mutating func add(node index: Int, parent: simd_float4x4, reader: inout Reader, depth: Int) throws {
        guard depth < 64, let node = reader.nodes[safe: index] else {
            throw Failure.malformed("node \(index)")
        }
        let transform = parent * Self.transform(of: node)
        if let mesh = node["mesh"] as? Int, let primitives = reader.meshes[safe: mesh]?["primitives"] as? [[String: Any]] {
            for primitive in primitives where (primitive["mode"] as? Int ?? 4) == 4 {
                try add(primitive, transform: transform, reader: &reader)
            }
        }
        for child in node["children"] as? [Int] ?? [] {
            try add(node: child, parent: transform, reader: &reader, depth: depth + 1)
        }
    }

    private mutating func add(_ primitive: [String: Any], transform: simd_float4x4, reader: inout Reader) throws {
        let mesh = try reader.mesh(primitive)
        guard !mesh.positions.isEmpty, !mesh.indices.isEmpty else {
            return
        }
        let normalTransform = simd_float3x3(columns: (transform.columns.0.xyz, transform.columns.1.xyz, transform.columns.2.xyz)).inverse.transpose
        // A mirroring transform turns the triangles over.
        let mirrored = simd_determinant(normalTransform) < 0
        var normals = mesh.normals
        if normals.count != mesh.positions.count {
            normals = Self.flatNormals(mesh.positions, mesh.indices)
        }
        let base = UInt32(vertices.count)
        for (index, position) in mesh.positions.enumerated() {
            let placed = transform * SIMD4(position, 1)
            let normal = simd_normalize(normalTransform * normals[index])
            vertices.append(ModelVertex(position: placed.xyz, normal: normal.x.isFinite ? normal : SIMD3(0, 0, 1), uv: mesh.uvs[safe: index] ?? .zero))
        }
        let start = indices.count
        for triangle in stride(from: 0, to: mesh.indices.count - 2, by: 3) {
            let (a, b, c) = (mesh.indices[triangle], mesh.indices[triangle + 1], mesh.indices[triangle + 2])
            guard max(a, b, c) < UInt32(mesh.positions.count) else {
                throw Failure.malformed("index out of range")
            }
            indices += mirrored ? [base + a, base + c, base + b] : [base + a, base + b, base + c]
        }
        let material = (primitive["material"] as? Int).flatMap { materials.indices.dropLast().contains($0) ? $0 : nil } ?? materials.count - 1
        parts.append(Part(indexStart: start, indexCount: indices.count - start, material: material))
    }

    /// The JSON and binary chunks of a GLB.
    private static func chunks(_ data: Data) throws -> (json: Data, binary: Data) {
        let bytes = [UInt8](data)
        func word(_ offset: Int) -> UInt32? {
            guard offset + 4 <= bytes.count else {
                return nil
            }
            return UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
        }
        guard word(0) == 0x4654_6C67, word(4) == 2 else {
            throw Failure.notGLB
        }
        var json: Data?
        var binary = Data()
        var offset = 12
        while let length = word(offset), let type = word(offset + 4) {
            let start = offset + 8
            let end = start + Int(length)
            guard end <= bytes.count else {
                throw Failure.malformed("chunk")
            }
            switch type {
            case 0x4E4F_534A: json = Data(bytes[start..<end])
            case 0x004E_4942: binary = Data(bytes[start..<end])
            default: break
            }
            offset = end
        }
        guard let json else {
            throw Failure.malformed("no JSON chunk")
        }
        return (json, binary)
    }

    private static func transform(of node: [String: Any]) -> simd_float4x4 {
        if let m = (node["matrix"] as? [NSNumber])?.map(\.floatValue), m.count == 16 {
            return simd_float4x4(columns: (SIMD4(m[0], m[1], m[2], m[3]), SIMD4(m[4], m[5], m[6], m[7]), SIMD4(m[8], m[9], m[10], m[11]), SIMD4(m[12], m[13], m[14], m[15])))
        }
        let t = (node["translation"] as? [NSNumber])?.map(\.floatValue) ?? [0, 0, 0]
        let r = (node["rotation"] as? [NSNumber])?.map(\.floatValue) ?? [0, 0, 0, 1]
        let s = (node["scale"] as? [NSNumber])?.map(\.floatValue) ?? [1, 1, 1]
        guard t.count == 3, r.count == 4, s.count == 3 else {
            return matrix_identity_float4x4
        }
        let rotation = simd_float3x3(simd_quatf(ix: r[0], iy: r[1], iz: r[2], r: r[3]).normalized)
        return simd_float4x4(
            columns: (
                SIMD4(rotation.columns.0 * s[0], 0), SIMD4(rotation.columns.1 * s[1], 0), SIMD4(rotation.columns.2 * s[2], 0), SIMD4(t[0], t[1], t[2], 1)
            ))
    }

    private static func flatNormals(_ positions: [SIMD3<Float>], _ indices: [UInt32]) -> [SIMD3<Float>] {
        var normals = [SIMD3<Float>](repeating: .zero, count: positions.count)
        for triangle in stride(from: 0, to: indices.count - 2, by: 3) {
            let (a, b, c) = (Int(indices[triangle]), Int(indices[triangle + 1]), Int(indices[triangle + 2]))
            guard max(a, b, c) < positions.count else {
                continue
            }
            let normal = simd_cross(positions[b] - positions[a], positions[c] - positions[a])
            normals[a] += normal
            normals[b] += normal
            normals[c] += normal
        }
        return normals
    }

    /// For a texture that cannot be read: the base colour alone.
    private static let white: CGImage = {
        let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        return context.makeImage()!
    }()
}

/// What one primitive holds, before it is placed.
private struct PrimitiveMesh {
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var uvs: [SIMD2<Float>] = []
    var indices: [UInt32] = []
}

/// The document and its binary chunk, read on demand.
private struct Reader {
    let document: [String: Any]
    let binary: Data
    let bytes: [UInt8]
    let nodes: [[String: Any]]
    let meshes: [[String: Any]]
    let accessors: [[String: Any]]
    let bufferViews: [[String: Any]]
    let textures: [[String: Any]]

    init(document: [String: Any], binary: Data) {
        self.document = document
        self.binary = binary
        bytes = [UInt8](binary)
        nodes = document["nodes"] as? [[String: Any]] ?? []
        meshes = document["meshes"] as? [[String: Any]] ?? []
        accessors = document["accessors"] as? [[String: Any]] ?? []
        bufferViews = document["bufferViews"] as? [[String: Any]] ?? []
        textures = document["textures"] as? [[String: Any]] ?? []
    }

    func material(_ json: [String: Any]) -> ModelAsset.Material {
        var material = ModelAsset.Material()
        let pbr = json["pbrMetallicRoughness"] as? [String: Any] ?? [:]
        if let factor = (pbr["baseColorFactor"] as? [NSNumber])?.map(\.floatValue), factor.count == 4 {
            material.baseColor = SIMD4(factor[0], factor[1], factor[2], factor[3])
        }
        if let texture = (pbr["baseColorTexture"] as? [String: Any])?["index"] as? Int, let source = source(of: texture) {
            material.texture = source
        }
        material.metallic = (pbr["metallicFactor"] as? NSNumber)?.floatValue ?? 1
        material.roughness = (pbr["roughnessFactor"] as? NSNumber)?.floatValue ?? 1
        material.doubleSided = json["doubleSided"] as? Bool ?? false
        material.blended = json["alphaMode"] as? String == "BLEND"
        return material
    }

    /// A texture's image: its own, or the WebP one EXT_texture_webp gives it.
    private func source(of texture: Int) -> Int? {
        guard let texture = textures[safe: texture] else {
            return nil
        }
        let webp = (texture["extensions"] as? [String: Any])?["EXT_texture_webp"] as? [String: Any]
        return webp?["source"] as? Int ?? texture["source"] as? Int
    }

    func image(_ json: [String: Any]) -> CGImage? {
        guard let view = json["bufferView"] as? Int, let bytes = bytes(ofView: view),
            let source = CGImageSourceCreateWithData(bytes as CFData, nil)
        else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    mutating func mesh(_ primitive: [String: Any]) throws -> PrimitiveMesh {
        let attributes = primitive["attributes"] as? [String: Int] ?? [:]
        if let draco = (primitive["extensions"] as? [String: Any])?["KHR_draco_mesh_compression"] as? [String: Any] {
            return try decodeDraco(draco)
        }
        var mesh = PrimitiveMesh()
        mesh.positions = attributes["POSITION"].flatMap { floats($0, components: 3) }.map(vectors3) ?? []
        mesh.normals = attributes["NORMAL"].flatMap { floats($0, components: 3) }.map(vectors3) ?? []
        mesh.uvs = attributes["TEXCOORD_0"].flatMap { floats($0, components: 2) }.map(vectors2) ?? []
        if let accessor = primitive["indices"] as? Int {
            mesh.indices = integers(accessor) ?? []
        } else {
            mesh.indices = (0..<UInt32(mesh.positions.count)).map { $0 }
        }
        return mesh
    }

    private func decodeDraco(_ extension: [String: Any]) throws -> PrimitiveMesh {
        guard let view = `extension`["bufferView"] as? Int, let bytes = bytes(ofView: view) else {
            throw ModelAsset.Failure.malformed("Draco buffer")
        }
        let attributes = `extension`["attributes"] as? [String: Int] ?? [:]
        let decoded = bytes.withUnsafeBytes { buffer in
            draco_decode(buffer.bindMemory(to: UInt8.self).baseAddress!, buffer.count)
        }
        guard let decoded else {
            throw ModelAsset.Failure.malformed("Draco mesh")
        }
        defer { draco_destroy(decoded) }
        let points = Int(draco_point_count(decoded))
        func attribute(_ name: String, components: Int) -> [Float]? {
            guard let id = attributes[name], draco_attribute_components(decoded, UInt32(id)) == components else {
                return nil
            }
            var values = [Float](repeating: 0, count: points * components)
            return draco_attribute_floats(decoded, UInt32(id), &values) ? values : nil
        }
        var mesh = PrimitiveMesh()
        mesh.positions = attribute("POSITION", components: 3).map(vectors3) ?? []
        mesh.normals = attribute("NORMAL", components: 3).map(vectors3) ?? []
        mesh.uvs = attribute("TEXCOORD_0", components: 2).map(vectors2) ?? []
        mesh.indices = [UInt32](repeating: 0, count: Int(draco_face_count(decoded)) * 3)
        draco_indices(decoded, &mesh.indices)
        return mesh
    }

    private func bytes(ofView index: Int) -> Data? {
        guard let view = bufferViews[safe: index], (view["buffer"] as? Int ?? 0) == 0, let length = view["byteLength"] as? Int else {
            return nil
        }
        let offset = view["byteOffset"] as? Int ?? 0
        guard offset >= 0, length >= 0, offset + length <= binary.count else {
            return nil
        }
        return binary.subdata(in: binary.startIndex + offset..<binary.startIndex + offset + length)
    }

    /// An accessor's elements as floats, normalized integers scaled to 0…1 or
    /// −1…1 as glTF says, `components` to an element.
    private func floats(_ index: Int, components: Int) -> [Float]? {
        guard let accessor = accessors[safe: index] else {
            return nil
        }
        let normalized = accessor["normalized"] as? Bool ?? false
        return elements(accessor, components: components) { bytes, type in
            switch type {
            case 5126: Float(bitPattern: UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24)
            case 5121: normalized ? Float(bytes[0]) / 255 : Float(bytes[0])
            case 5123:
                normalized ? Float(UInt16(bytes[0]) | UInt16(bytes[1]) << 8) / 65535 : Float(UInt16(bytes[0]) | UInt16(bytes[1]) << 8)
            case 5120: normalized ? max(Float(Int8(bitPattern: bytes[0])) / 127, -1) : Float(Int8(bitPattern: bytes[0]))
            case 5122:
                normalized
                    ? max(Float(Int16(bitPattern: UInt16(bytes[0]) | UInt16(bytes[1]) << 8)) / 32767, -1)
                    : Float(Int16(bitPattern: UInt16(bytes[0]) | UInt16(bytes[1]) << 8))
            default: nil
            }
        }
    }

    private func integers(_ index: Int) -> [UInt32]? {
        guard let accessor = accessors[safe: index] else {
            return nil
        }
        return elements(accessor, components: 1) { bytes, type in
            switch type {
            case 5121: UInt32(bytes[0])
            case 5123: UInt32(bytes[0]) | UInt32(bytes[1]) << 8
            case 5125: UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24
            default: nil
            }
        }
    }

    /// Reads `count` elements of `components` components each, by the view's
    /// stride, or packed where it has none.
    private func elements<T>(_ accessor: [String: Any], components: Int, read: ([UInt8], Int) -> T?) -> [T]? {
        guard let viewIndex = accessor["bufferView"] as? Int, let view = bufferViews[safe: viewIndex], let count = accessor["count"] as? Int,
            let type = accessor["componentType"] as? Int, let componentSize = [5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4][type]
        else {
            return nil
        }
        let base = (view["byteOffset"] as? Int ?? 0) + (accessor["byteOffset"] as? Int ?? 0)
        let stride = view["byteStride"] as? Int ?? componentSize * components
        guard count >= 0, base >= 0, count == 0 || base + (count - 1) * stride + components * componentSize <= bytes.count else {
            return nil
        }
        var values: [T] = []
        values.reserveCapacity(count * components)
        for element in 0..<count {
            for component in 0..<components {
                let start = base + element * stride + component * componentSize
                guard let value = read(Array(bytes[start..<start + componentSize]), type) else {
                    return nil
                }
                values.append(value)
            }
        }
        return values
    }
}

private func vectors3(_ values: [Float]) -> [SIMD3<Float>] {
    stride(from: 0, to: values.count - 2, by: 3).map { SIMD3(values[$0], values[$0 + 1], values[$0 + 2]) }
}

private func vectors2(_ values: [Float]) -> [SIMD2<Float>] {
    stride(from: 0, to: values.count - 1, by: 2).map { SIMD2(values[$0], values[$0 + 1]) }
}

extension SIMD4 where Scalar == Float {
    fileprivate var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}

extension Array {
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
