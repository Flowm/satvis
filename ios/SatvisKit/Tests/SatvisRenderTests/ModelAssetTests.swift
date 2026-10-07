import CoreGraphics
import Foundation
import ImageIO
import Testing
import simd

@testable import SatvisRender

@Suite struct ModelAssetTests {
    // A Draco-compressed cube under a node that doubles it and lifts it by 1
    // (ios/scripts/make-model-fixture.mjs): decoded, placed, and textured.
    @Test func readsADracoCompressedModel() throws {
        let url = try #require(Bundle.module.url(forResource: "cube", withExtension: "glb", subdirectory: "Fixtures"))
        let model = try ModelAsset(glb: Data(contentsOf: url))
        #expect(model.vertices.count == 24)
        #expect(model.indices.count == 36)
        #expect(model.parts.count == 1 && model.parts[0].indexCount == 36 && model.parts[0].material == 0)
        #expect(model.images.count == 1 && model.images[0].width == 2 && model.materials[0].texture == 0)
        #expect(simd_distance(model.center, SIMD3(0, 0, 1)) < 1e-3)
        #expect(abs(model.radius - Float(3).squareRoot()) < 1e-3)
        for vertex in model.vertices {
            #expect(abs(abs(vertex.position.x) - 1) < 1e-3 || abs(abs(vertex.position.y) - 1) < 1e-3 || vertex.position.z < 1e-3 || vertex.position.z > 2 - 1e-3)
            #expect(abs(simd_length(vertex.normal) - 1) < 1e-3)
            // Outward: the face a corner belongs to points away from the middle.
            #expect(simd_dot(vertex.normal, vertex.position - model.center) > 0)
        }
    }

    @Test func refusesWhatIsNotAGLB() {
        #expect(throws: ModelAsset.Failure.self) { try ModelAsset(glb: Data("<html>".utf8)) }
    }

    /// The cube with its JSON changed, its binary chunk as it was.
    private static func cube(_ change: (inout [String: Any]) -> Void) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "cube", withExtension: "glb", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        func word(_ offset: Int) -> Int { Int(data[offset]) | Int(data[offset + 1]) << 8 | Int(data[offset + 2]) << 16 | Int(data[offset + 3]) << 24 }
        let jsonLength = word(12)
        var document = try #require(try JSONSerialization.jsonObject(with: data.subdata(in: 20..<(20 + jsonLength))) as? [String: Any])
        change(&document)
        var json = try JSONSerialization.data(withJSONObject: document)
        json.append(contentsOf: [UInt8](repeating: 0x20, count: (4 - json.count % 4) % 4))
        let binary = data.subdata(in: (20 + jsonLength)..<data.count)
        func le(_ value: Int) -> [UInt8] { (0..<4).map { UInt8((value >> (8 * $0)) & 0xFF) } }
        var glb = Data([0x67, 0x6C, 0x54, 0x46] + le(2) + le(12 + 8 + json.count + binary.count))
        glb.append(contentsOf: le(json.count) + [0x4A, 0x53, 0x4F, 0x4E])
        glb.append(json)
        glb.append(binary)
        return glb
    }

    // A model file is fetched and cached as the tiles are, so a malformed one would
    // fail on every view of its satellite: each of these is refused or read round,
    // never read out of bounds.
    @Test func refusesMalformedModels() throws {
        // A texture naming an image that is not there: drawn in its base colour.
        let missingImage = try ModelAsset(
            glb: Self.cube { document in
                document["textures"] = [["source": 5]]
            })
        #expect(missingImage.materials[0].texture == nil)

        // An empty Draco buffer.
        #expect(throws: ModelAsset.Failure.self) {
            try ModelAsset(
                glb: Self.cube { document in
                    var views = document["bufferViews"] as! [[String: Any]]
                    views[0]["byteLength"] = 0
                    document["bufferViews"] = views
                })
        }

        // A negative Draco attribute id: no positions, so no triangles.
        #expect(throws: ModelAsset.Failure.self) {
            try ModelAsset(
                glb: Self.cube { document in
                    document["meshes"] = [
                        [
                            "primitives": [
                                ["extensions": ["KHR_draco_mesh_compression": ["bufferView": 0, "attributes": ["POSITION": -1]]]]
                            ]
                        ]
                    ]
                })
        }

        // Plain accessors with a stride under their element's size, and with a count
        // past the buffer.
        for (stride, count) in [(0, 3), (4, 3), (12, 1_000_000_000)] {
            #expect(throws: ModelAsset.Failure.self) {
                try ModelAsset(
                    glb: Self.cube { document in
                        document["bufferViews"] = [["buffer": 0, "byteOffset": 0, "byteLength": 194, "byteStride": stride]]
                        document["accessors"] = [["bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3"]]
                        document["meshes"] = [["primitives": [["attributes": ["POSITION": 0]]]]]
                    })
            }
        }

        // Forty levels of nodes, each listing the next twice: 2^40 visits, which never
        // ended.
        #expect(throws: ModelAsset.Failure.self) {
            try ModelAsset(
                glb: Self.cube { document in
                    var nodes: [[String: Any]] = (0..<40).map { ["children": [$0 + 1, $0 + 1]] }
                    nodes.append([:])
                    document["nodes"] = nodes
                })
        }

        // A transform past what a float holds.
        #expect(throws: ModelAsset.Failure.self) {
            try ModelAsset(
                glb: Self.cube { document in
                    document["nodes"] = [["mesh": 0, "scale": [1e39, 1, 1]]]
                })
        }
    }

    // An image whose header claims more than a tile or a texture has is not decoded.
    @Test func refusesOversizedImages() throws {
        let side = 3000
        let context = try #require(
            CGContext(
                data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try #require(context.makeImage())
        let png = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        #expect(Textures.image(png as Data, maximumSide: 2048) == nil)
        #expect(Textures.image(png as Data, maximumSide: 4096)?.width == side)
        #expect(Textures.image(Data("<html>".utf8), maximumSide: 4096) == nil)
    }
}
