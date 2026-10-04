import Metal
import Testing
import simd

@testable import SatvisRender

@Suite struct RendererTests {
    // The shaders compile at run time, so this is where a mistake in them shows.
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func compilesTheShaders() async throws {
        let library = try await ShaderLibrary.make(device: try #require(MTLCreateSystemDefaultDevice()))
        for name in [
            "fullscreenVertex", "skyBoxFragment", "skyAtmosphereVertex", "skyAtmosphereFragment", "globeVertex", "globeFragment", "pointVertex", "pointFragment",
            "lineVertex", "lineFragment", "labelVertex", "labelFragment", "stationVertex", "stationFragment", "linkVertex", "linkFragment",
            "tonemapFragment",
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
        #expect(MemoryLayout<FrameUniforms>.size == 264)
        #expect(MemoryLayout<GlobeVertex>.stride == 64)
        #expect(MemoryLayout<PointInstance>.stride == 32)
        #expect(MemoryLayout<PointFrame>.stride == 8)
        #expect(MemoryLayout<LabelInstance>.stride == 32)
        #expect(MemoryLayout<StationInstance>.stride == 16)
        #expect(MemoryLayout<LinkInstance>.stride == 24)
    }

    // The way back from a tap on the globe to the place it touched.
    @Test func turnsAPointOnTheSurfaceBackIntoItsPlace() {
        for (latitude, longitude) in [(48.1351, 11.582), (-33.9249, 18.4241), (78.2232, -15.6267), (0.0, 180.0)] {
            let place = geodetic(fixedPosition(latitude: latitude, longitude: longitude))
            #expect(abs(place.latitude - latitude) < 1e-9)
            #expect(abs(place.longitude - longitude) < 1e-9 || abs(abs(place.longitude) - 180) < 1e-9)
        }
    }

    @Test func drawsThePin() {
        let pin = StationPin.bitmap()
        func alpha(_ x: Int, _ y: Int) -> UInt8 { pin.bytes[(y * pin.width + x) * 4 + 3] }
        // Opaque in its head, clear in the corners, its tip at the bottom centre.
        #expect(alpha(48, 40) == 255)
        #expect(alpha(2, 2) == 0)
        #expect(alpha(48, 86) > 0)
        #expect(alpha(20, 86) == 0)
    }

    @Test func keepsPrecisionInTheHighLowSplit() {
        let value = SIMD3<Double>(6_378_137.123, -1_234_567.891, 4_000_000.5)
        let (high, low) = encode(value)
        let rebuilt = SIMD3<Double>(high) + SIMD3<Double>(low)
        #expect(simd.distance(rebuilt, value) < 0.01)
    }

    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func packsEveryLabelIntoTheAtlas() throws {
        let names = (0..<200).map { "SATELLITE-\($0)" }
        let device = try #require(MTLCreateSystemDefaultDevice())
        let atlas = try #require(LabelAtlas(names: names, scale: 3, device: device))
        #expect(atlas.instances.count == 200)
        #expect(atlas.instances.allSatisfy { $0.uvRect.z <= 1 && $0.uvRect.w <= 1 && $0.size.x > 0 })
        #expect(atlas.instances.map(\.satellite) == (0..<200).map(UInt32.init))
    }

    // From the satellite, the camera is south of it and above its horizon, and
    // looks back at it.
    @Test func tracksFromWhereTheWebAppDoes() {
        let target = SIMD3<Double>(7_000_000, 0, 0)
        let pose = TrackingCamera().pose(target: target)
        #expect(abs(simd.distance(pose.position, target) - 5_531_727) < 1)
        #expect(pose.position.x > target.x && pose.position.z < 0)
        #expect(simd.distance(normalize(target - pose.position), -pose.back) < 1e-12)
        #expect(abs(dot(cross(pose.right, pose.up), pose.back) - 1) < 1e-12)
    }

    @Test func opensWhereTheWebAppDoes() {
        let camera = OrbitCamera.home(aspectRatio: 390.0 / 844.0)
        #expect(abs(camera.latitude * 180 / .pi - 25) < 1e-9)
        #expect((15_000_000...40_000_000).contains(camera.altitude))
    }
}
