import Foundation
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
}
