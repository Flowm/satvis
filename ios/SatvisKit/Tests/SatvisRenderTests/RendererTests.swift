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
            "lineVertex", "lineFragment", "labelVertex", "labelFragment", "stationVertex", "stationFragment", "linkVertex", "linkFragment", "overlayVertex", "overlayFragment",
            "coneVertex", "coneFragment", "coneRimVertex", "coneRimFragment",
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

    // The overlay is drawn with clip coordinates worked out per cube face, and
    // sampled by the globe with Metal's own cube lookup: the two have to agree on
    // which way each face faces, or every ground track lands somewhere else.
    @MainActor
    @Test(
        .enabled(if: MTLCreateSystemDefaultDevice() != nil),
        arguments: [
            SIMD3<Double>(1, 0.2, 0.1), SIMD3(-1, 0.3, -0.2), SIMD3(0.2, 1, 0.3), SIMD3(-0.1, -1, 0.2), SIMD3(0.3, -0.2, 1), SIMD3(0.1, 0.3, -1),
            SIMD3(0.8, 0.7, 0.1),
        ])
    func drawsTheGroundOverlayWhereTheGlobeSamplesIt(direction: SIMD3<Double>) async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let queue = try #require(device.makeCommandQueue())
        let library = try await ShaderLibrary.make(device: device)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "overlayVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "overlayFragment")
        descriptor.colorAttachments[0].pixelFormat = .r8Unorm
        let pipeline = try await device.makeRenderPipelineState(descriptor: descriptor)
        let overlay = try #require(GroundOverlay(device: device))

        // A corridor across `direction`, 200 km wide.
        let centre = normalize(direction)
        let along = normalize(cross(centre, SIMD3(0, 0, 1) + SIMD3(0.3, 0, 0)))
        let vertices = GroundOverlay.corridor(from: centre - 0.01 * along, to: centre + 0.01 * along, widthKm: 200)
        let buffer = try #require(vertices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) })
        let commands = try #require(queue.makeCommandBuffer())
        overlay.drawForTest(commands, pipeline: pipeline, vertices: buffer, count: vertices.count)

        // Sampled at the corridor and on the far side of the Earth.
        let sampler = try await device.makeLibrary(
            source: """
                #include <metal_stdlib>
                using namespace metal;
                kernel void probe(texturecube<float> overlay [[texture(0)]], device float *out [[buffer(0)]], constant float3 *directions [[buffer(1)]],
                                  uint i [[thread_position_in_grid]]) {
                    constexpr sampler nearest(filter::nearest);
                    out[i] = overlay.sample(nearest, directions[i]).r;
                }
                """, options: nil
        ).makeFunction(name: "probe")
        let probe = try await device.makeComputePipelineState(function: try #require(sampler))
        let output = try #require(device.makeBuffer(length: 2 * MemoryLayout<Float>.stride, options: .storageModeShared))
        var directions = [SIMD3<Float>(centre), SIMD3<Float>(-centre)]
        let encoder = try #require(commands.makeComputeCommandEncoder())
        encoder.setComputePipelineState(probe)
        encoder.setTexture(overlay.texture, index: 0)
        encoder.setBuffer(output, offset: 0, index: 0)
        encoder.setBytes(&directions, length: MemoryLayout<SIMD3<Float>>.stride * 2, index: 1)
        encoder.dispatchThreads(MTLSize(width: 2, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 2, height: 1, depth: 1))
        encoder.endEncoding()
        await withCheckedContinuation { finished in
            commands.addCompletedHandler { _ in finished.resume() }
            commands.commit()
        }
        let values = output.contents().bindMemory(to: Float.self, capacity: 2)
        #expect(values[0] > 0.2, "nothing drawn where \(direction) samples")
        #expect(values[1] == 0, "drawn on the far side of \(direction)")
    }
}
