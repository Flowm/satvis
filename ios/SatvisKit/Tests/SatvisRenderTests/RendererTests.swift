import Metal
import Testing
import simd

@testable import SatvisRender

@Suite struct RendererTests {
    // The shaders compile at run time, so this is where a mistake in them shows.
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func compilesTheShaders() async throws {
        let library = try await ShaderLibrary.make(device: try #require(MTLCreateSystemDefaultDevice()))
        for name in [
            "fullscreenVertex", "skyBoxFragment", "skyAtmosphereVertex", "skyAtmosphereFragment", "globeVertex", "globeFragment", "pointVertex", "pointFragment", "tonemapFragment",
        ] {
            #expect(library.makeFunction(name: name) != nil, "\(name)")
        }
    }

    @Test func loadsTheImagery() throws {
        let imagery = try #require(Textures.naturalEarth())
        #expect((imagery.width, imagery.height) == (2048, 1024))
    }

    @Test func takesSixSquareFacesForTheSky() throws {
        let tiles = try #require(Bundle.module.url(forResource: "NaturalEarthII", withExtension: nil))
        let square = try Data(contentsOf: tiles.appending(path: "2/0/0.webp"))
        #expect(Textures.cubeFaces(Array(repeating: square, count: 6))?.count == 6)
        #expect(Textures.cubeFaces(Array(repeating: square, count: 5)) == nil)
        #expect(Textures.cubeFaces(Array(repeating: Data("<html>".utf8), count: 6)) == nil)
    }

    // Metal reads these as its own structs; a mismatch draws garbage silently.
    @Test func matchesTheShaderLayouts() {
        #expect(MemoryLayout<FrameUniforms>.size == 260)
        #expect(MemoryLayout<GlobeVertex>.stride == 64)
        #expect(MemoryLayout<PointInstance>.stride == 32)
        #expect(MemoryLayout<PointFrame>.stride == 8)
    }

    @Test func keepsPrecisionInTheHighLowSplit() {
        let value = SIMD3<Double>(6_378_137.123, -1_234_567.891, 4_000_000.5)
        let (high, low) = encode(value)
        let rebuilt = SIMD3<Double>(high) + SIMD3<Double>(low)
        #expect(simd.distance(rebuilt, value) < 0.01)
    }

    @Test func opensWhereTheWebAppDoes() {
        let camera = OrbitCamera.home(aspectRatio: 390.0 / 844.0)
        #expect(abs(camera.latitude * 180 / .pi - 25) < 1e-9)
        #expect((15_000_000...40_000_000).contains(camera.altitude))
    }
}
