import CoreGraphics
import Foundation
import Metal
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// Granules on the globe (ADR 0023): where each lies, when it is passed, and that the
/// tile fragments draw it.
@MainActor
@Suite struct GranulesTests {
    /// A closed ring through these corners, in degrees.
    static func ring(_ corners: [(latitude: Double, longitude: Double)]) -> [GroundPoint] {
        let points = corners.map { GroundPoint(latitude: $0.latitude, longitude: $0.longitude) }
        return points + [points[0]]
    }

    /// The direction from the Earth's centre to a place on the ground.
    static func direction(_ latitude: Double, _ longitude: Double) -> SIMD3<Double> {
        normalize(fixedPosition(latitude: latitude, longitude: longitude))
    }

    /// A box 10° a side round the equator at the prime meridian.
    static let box = ring([(-5, -5), (-5, 5), (5, 5), (5, -5)])

    /// A satellite 800 km over the equator at the prime meridian flying north, now and a second on.
    static let northbound = (
        position: fixedPosition(latitude: 0, longitude: 0) * (1 + 800_000 / 6_378_137.0),
        next: fixedPosition(latitude: 0.06, longitude: 0) * (1 + 800_000 / 6_378_137.0)
    )

    @Test func coversWhatItsOutlineHolds() throws {
        let outline = try #require(GnomonicOutline(Self.box))
        #expect(outline.corners.count == 4)
        #expect(outline.contains(Self.direction(0, 0)))
        #expect(outline.contains(Self.direction(4.9, -4.9)))
        #expect(!outline.contains(Self.direction(5.2, 0)))
        #expect(!outline.contains(Self.direction(0, 6)))
        #expect(!outline.contains(Self.direction(0, 180)))
    }

    // CMR's ring across the antimeridian is unwrapped past it; on the plane it has no seam.
    @Test func coversAGranuleAcrossTheAntimeridian() throws {
        let outline = try #require(GnomonicOutline(Self.ring([(10, 175), (10, 185), (20, 185), (20, 175)])))
        #expect(outline.contains(Self.direction(15, 179)))
        #expect(outline.contains(Self.direction(15, -179)))
        #expect(outline.contains(Self.direction(15, 184 - 360)))
        #expect(!outline.contains(Self.direction(15, 170)))
        #expect(!outline.contains(Self.direction(15, -170)))
        #expect(!outline.contains(Self.direction(15, 0)))
    }

    // One round a pole, as Metop's are once the cut up the antimeridian is left out.
    @Test func coversAGranuleRoundAPole() throws {
        let outline = try #require(GnomonicOutline(Self.ring((0..<12).map { (80, Double($0) * 30 - 180) })))
        #expect(outline.contains(Self.direction(90, 0)))
        #expect(outline.contains(Self.direction(85, 123)))
        #expect(outline.contains(Self.direction(81, -45)))
        #expect(!outline.contains(Self.direction(78, 10)))
        #expect(!outline.contains(Self.direction(-85, 10)))
        // Beside the pole, crossing the antimeridian.
        let beside = try #require(GnomonicOutline(Self.ring([(70, 160), (70, 200), (85, 200), (85, 160)])))
        #expect(beside.contains(Self.direction(80, 180)))
        #expect(beside.contains(Self.direction(80, -170)))
        #expect(!beside.contains(Self.direction(80, 0)))
    }

    @Test func refusesWhatCannotBeProjected() {
        #expect(GnomonicOutline(Self.ring([(0, 0), (1, 1)])) == nil)
        // A hemisphere and more.
        #expect(GnomonicOutline(Self.ring([(0, 0), (0, 120), (0, -120)])) == nil)
    }

    // The scan plane stands across the track through the satellite: the ground behind
    // it is swept, ahead not yet.
    @Test func sweepsTheGroundBehindTheScanLine() throws {
        let plane = try #require(ScanPlane(position: Self.northbound.position, next: Self.northbound.next))
        #expect(plane.ahead.z > 0.99)
        #expect(plane.isBehind(fixedPosition(latitude: -1, longitude: 0)))
        #expect(plane.isBehind(fixedPosition(latitude: -1, longitude: 12)))
        #expect(!plane.isBehind(fixedPosition(latitude: 1, longitude: -12)))
        #expect(ScanPlane(position: Self.northbound.position, next: Self.northbound.position) == nil)
    }

    @Test func standsBeforeSweptAndPassed() throws {
        let plane = try #require(ScanPlane(position: Self.northbound.position, next: Self.northbound.next))
        let over = try #require(GnomonicOutline(Self.box)).ground
        let south = try #require(GnomonicOutline(Self.ring([(-15, -5), (-15, 5), (-6, 5), (-6, -5)]))).ground
        let (start, end) = (1_000_000.0, 1_360_000.0)
        // Under the satellite, part swept; south of it, all swept.
        #expect(GranuleStage(start: start, end: end, corners: over, time: start + 1, plane: plane) == .sweeping(plane))
        #expect(GranuleStage(start: start, end: end, corners: south, time: start + 1, plane: plane) == .passed)
        // Two minutes past its end the plane, through the Earth, may turn back to it.
        #expect(GranuleStage(start: start, end: end, corners: over, time: end + GranuleStage.slack, plane: plane) == .sweeping(plane))
        #expect(GranuleStage(start: start, end: end, corners: over, time: end + GranuleStage.slack + 1, plane: plane) == .passed)
        // Without its satellite, by its start alone.
        #expect(GranuleStage(start: start, end: end, corners: over, time: start - 1, plane: nil) == .before)
        #expect(GranuleStage(start: start, end: end, corners: over, time: start, plane: nil) == .passed)
    }

    // Before it is passed a granule fills behind the scan line, with no outline; once
    // passed it has its outline, and its fill where it keeps one.
    @Test func drawsTheFillAndOutlineAsTheWebDoes() throws {
        let outline = try #require(GnomonicOutline(Self.box))
        let plane = try #require(ScanPlane(position: Self.northbound.position, next: Self.northbound.next))
        let drawing = GranuleDrawing(id: "a", satellite: "NOAA 20", start: 0, end: 360_000, outline: Self.box, state: .waiting)
        let noSlot: (ObjectIdentifier) -> Int32? = { _ in nil }
        #expect(GranuleFills.shape(drawing, outline: outline, cornerStart: 0, stage: .before, slot: noSlot) == nil)

        let sweeping = try #require(GranuleFills.shape(drawing, outline: outline, cornerStart: 3, stage: .sweeping(plane), slot: noSlot))
        #expect(sweeping.scan.z > 0.99)
        #expect(abs(sweeping.scan.w) < 1e5)
        #expect(sweeping.tint == GranuleFills.tint)
        #expect(sweeping.outline.w == 0)
        #expect(sweeping.picture == -1)
        #expect((sweeping.cornerStart, sweeping.cornerCount) == (3, 4))

        let passed = try #require(GranuleFills.shape(drawing, outline: outline, cornerStart: 0, stage: .passed, slot: noSlot))
        #expect(passed.scan == SIMD4())
        #expect(passed.outline == GranuleFills.outlineColor)
        #expect(passed.tint == GranuleFills.tint)

        var missing = drawing
        missing.state = .missing
        let grey = try #require(GranuleFills.shape(missing, outline: outline, cornerStart: 0, stage: .passed, slot: noSlot))
        #expect(grey.outline == GranuleFills.missingOutlineColor)
        #expect(grey.tint == GranuleFills.missingTint)

        var replaced = drawing
        replaced.keepsFill = false
        let outlineOnly = try #require(GranuleFills.shape(replaced, outline: outline, cornerStart: 0, stage: .passed, slot: noSlot))
        #expect(outlineOnly.tint.w == 0)
        #expect(outlineOnly.picture == -1)
        #expect(try #require(GranuleFills.shape(replaced, outline: outline, cornerStart: 0, stage: .sweeping(plane), slot: noSlot)).tint.w > 0)

        let image = try #require(Self.image(red: 1, green: 0, blue: 0))
        var pictured = drawing
        pictured.state = .pictured
        pictured.picture = GranulePicture(image: image, bounds: SatelliteDetails.PreviewBounds(west: -6, south: -6, east: 6, north: 6))
        let picture = try #require(GranuleFills.shape(pictured, outline: outline, cornerStart: 0, stage: .passed, slot: { _ in 2 }))
        #expect(picture.picture == 2)
        #expect(picture.tint.w == 0)
        #expect(abs(picture.bounds.z - Float(6 * Double.pi / 180)) < 1e-6)
        // Until its texture is made, the tint.
        #expect(try #require(GranuleFills.shape(pictured, outline: outline, cornerStart: 0, stage: .passed, slot: noSlot)).tint == GranuleFills.tint)

        var polar = pictured
        polar.picture = GranulePicture(image: image, bounds: SatelliteDetails.PreviewBounds(west: -1e6, south: -1e6, east: 1e6, north: 1e6), projection: .arctic)
        let stereographic = try #require(GranuleFills.shape(polar, outline: outline, cornerStart: 0, stage: .passed, slot: { _ in 0 }))
        #expect(stereographic.east.w == 1)
        #expect(abs(Double(stereographic.north.w) - PolarProjection.arctic.radiusScale) < 1)
        #expect(stereographic.bounds.z == 1e6)
    }

    @Test func reachesTheGroundAcrossTheTrack() throws {
        let axes = try #require(FanAxes(position: Self.northbound.position, next: Self.northbound.next))
        let swath = SwathExtents(starboardKm: 1500, portKm: 1000)
        let line = axes.groundLine(swath, steps: 4)
        // Flying north, starboard is east.
        let (port, starboard) = (geodetic(line[0]), geodetic(line[4]))
        #expect(abs(starboard.longitude - 1500 / 111.32) < 0.3)
        #expect(abs(port.longitude + 1000 / 111.32) < 0.3)
        #expect(abs(starboard.latitude) < 0.01 && abs(port.latitude) < 0.01)
        #expect(line.allSatisfy { abs(heightAboveEllipsoid($0)) < 1 })
        // From straight over the satellite, nothing of the fan is nearer than it.
        let above = Self.northbound.position * 1.1
        #expect(abs(axes.distance(from: above, swath: swath) - distance(above, Self.northbound.position)) < 1)
        // From beside the fan's face, its face.
        let beside = fixedPosition(latitude: 0, longitude: 5) * 1.05 + SIMD3(0, 0, 10_000)
        #expect(axes.distance(from: beside, swath: swath) < 10_100)
    }

    // A drawn granule takes its picture's texture once it is made, and is not drawn
    // before it begins without its satellite.
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func makesThePicturesOfTheGranulesDrawn() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let overlay = GranuleFills(device: device, queue: try #require(device.makeCommandQueue()))
        let points = SatellitePoints()
        let image = try #require(Self.image(red: 0, green: 1, blue: 0))
        let picture = GranulePicture(image: image, bounds: SatelliteDetails.PreviewBounds(west: -6, south: -6, east: 6, north: 6))
        #expect(overlay.frame(at: 0, points: points) == nil)
        overlay.set(
            [
                GranuleDrawing(id: "b", satellite: nil, start: 2000, end: 3000, outline: Self.box, state: .pictured, picture: picture),
                GranuleDrawing(id: "a", satellite: "gone", start: 1000, end: 2000, outline: Self.ring([(10, 0), (10, 5), (15, 5)]), state: .waiting),
            ], fans: [])
        #expect(overlay.frame(at: 0, points: points) == nil)
        #expect(overlay.frame(at: 1500, points: points)?.caps.count == 1)
        let deadline = Date().addingTimeInterval(10)
        while overlay.frame(at: 2500, points: points)?.textures.isEmpty ?? true, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let frame = try #require(overlay.frame(at: 2500, points: points))
        #expect(frame.textures.count == 1)
        #expect(frame.caps.count == 2)
        let shapes = frame.shapes.contents().bindMemory(to: GranuleShape.self, capacity: 2)
        // Oldest first.
        #expect(shapes[0].picture == -1 && shapes[0].cornerCount == 3)
        #expect(shapes[1].picture == 0 && shapes[1].cornerStart == 3)
        #expect(overlay.sweepers(at: 2500, points: points).isEmpty)

        overlay.set([], fans: [])
        #expect(overlay.isEmpty)
        #expect(overlay.frame(at: 2500, points: points) == nil)
    }

    // Metal reads these as its own structs, and draws as many vertices as these say.
    @Test func matchesTheShaders() throws {
        #expect(MemoryLayout<GranuleShape>.stride == 128)
        #expect(MemoryLayout<FanInstance>.stride == 12)
        func constant(_ name: String) throws -> Int? {
            let match = try ShaderLibrary.source(["Granules"]).firstMatch(of: try Regex("constant int \(name) = ([0-9]+);"))
            return match.flatMap { Int($0.output[1].substring ?? "") }
        }
        #expect(try constant("fanSegments") == ScenePass.fanSegments)
        #expect(try constant("granulePictureSlots") == GranuleFills.pictureSlots)
    }

    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func buildsTheGranuleAndFanPipelines() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let libraries = try await ShaderLibrary.make(device: device)
        for name in ["globeGranuleVertex", "globeGranuleFragment", "mapGlobeGranuleFragment", "fanVertex", "fanFragment", "fanLineVertex", "fanLineFragment"] {
            #expect(libraries.precise.makeFunction(name: name) != nil && libraries.fast.makeFunction(name: name) != nil, "\(name)")
        }
        _ = try ScenePipelines(device: device, libraries: libraries, viewFormat: ScenePipelines.screenFormat)
    }

    // Drawn by a tile: the picture behind the scan line, the ground ahead of it as it
    // was, and once passed the picture whole, edged by its outline.
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func fillsATileBehindTheScanLine() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let queue = try #require(device.makeCommandQueue())
        let libraries = try await ShaderLibrary.make(device: device)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = try libraries.fast.function("globeGranuleVertex")
        descriptor.fragmentFunction = try libraries.fast.function("globeGranuleFragment")
        descriptor.colorAttachments[0].pixelFormat = .rgba32Float
        let pipeline = try await device.makeRenderPipelineState(descriptor: descriptor)

        // Straight down from 2,000 km over the equator at the prime meridian, east to
        // the right and north up, 4,000 km across.
        let size = 64
        let halfWidth: Float = 2_000_000
        let eye = SIMD3<Double>(6_378_137 + 2_000_000, 0, 0)
        let viewProjection = simd_float4x4(columns: (SIMD4(0, 0, 0, 0), SIMD4(1 / halfWidth, 0, 0, 0), SIMD4(0, 1 / halfWidth, 0, 0), SIMD4(0, 0, 0.5, 1)))
        var frame = FrameUniforms(
            viewProjection: viewProjection, inverseViewProjection: viewProjection.inverse, fixedToTEME: matrix_identity_float3x3, cameraHigh: SIMD3(),
            cameraLow: SIMD3(), cameraPosition: SIMD3<Float>(eye), sunDirection: SIMD3(1, 0, 0), viewportSize: SIMD2(Float(size), Float(size)),
            eyeHeight: 2_000_000, cameraDistance: Float(length(eye)), pointSize: 6, pixelScale: 1)

        // A tile 30° a side, a grid of quads on the ellipsoid.
        let centre = fixedPosition(latitude: 0, longitude: 0)
        var vertices: [GlobeVertex] = []
        let steps = 30
        func vertex(_ i: Int, _ j: Int) -> GlobeVertex {
            let (latitude, longitude) = (Double(j) - 15, Double(i) - 15)
            let position = fixedPosition(latitude: latitude, longitude: longitude)
            return GlobeVertex(
                offset: SIMD3<Float>(position - centre), normal: SIMD3<Float>(normalize(position)), uv: SIMD2(Float(i) / Float(steps), Float(j) / Float(steps)))
        }
        for i in 0..<steps {
            for j in 0..<steps {
                vertices += [vertex(i, j), vertex(i + 1, j), vertex(i + 1, j + 1), vertex(i, j), vertex(i + 1, j + 1), vertex(i, j + 1)]
            }
        }
        let vertexBuffer = try #require(device.makeBuffer(copying: vertices))
        func flat(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> MTLTexture? {
            Textures.texture2D(
                Bitmap(width: 4, height: 4) { context in
                    context.setFillColor(red: red, green: green, blue: blue, alpha: 1)
                    context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
                }, device: device)
        }
        let grey = try #require(flat(0.5, 0.5, 0.5))
        let red = try #require(flat(1, 0, 0))
        let overlayCube = try #require(GroundOverlay.makeCube(size: 1, device: device))
        let sampler = try #require(device.makeLinearSampler(mipmapped: false, s: .clampToEdge, t: .clampToEdge))

        let outline = try #require(GnomonicOutline(Self.box))
        let plane = try #require(ScanPlane(position: Self.northbound.position, next: Self.northbound.next))
        let image = try #require(Self.image(red: 1, green: 0, blue: 0))
        let drawing = GranuleDrawing(
            id: "a", satellite: "NOAA 20", start: 0, end: 1, outline: Self.box, state: .pictured,
            picture: GranulePicture(image: image, bounds: SatelliteDetails.PreviewBounds(west: -6, south: -6, east: 6, north: 6)))
        let corners = try #require(device.makeBuffer(copying: outline.corners.map(SIMD2<Float>.init)))
        let pictures = try #require(device.makeBuffer(length: GranuleFills.pictureSlots * MemoryLayout<MTLResourceID>.stride, options: .storageModeShared))
        pictures.contents().bindMemory(to: MTLResourceID.self, capacity: 1)[0] = red.gpuResourceID

        func draw(_ stage: GranuleStage) async throws -> (SIMD2<Int>) -> SIMD4<Float> {
            let target = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: size, height: size, mipmapped: false)
            target.usage = .renderTarget
            target.storageMode = .shared
            let texture = try #require(device.makeTexture(descriptor: target))
            let pass = MTLRenderPassDescriptor()
            pass.colorAttachments[0].texture = texture
            pass.colorAttachments[0].loadAction = .clear
            pass.colorAttachments[0].storeAction = .store
            let shape = try #require(GranuleFills.shape(drawing, outline: outline, cornerStart: 0, stage: stage, slot: { _ in 0 }))
            let shapes = try #require(device.makeBuffer(copying: [shape]))
            let commands = try #require(queue.makeCommandBuffer())
            let encoder = try #require(commands.makeRenderCommandEncoder(descriptor: pass))
            encoder.setRenderPipelineState(pipeline)
            encoder.setCullMode(.none)
            var tileCentre = SIMD3<Float>(centre - eye)
            var overlayShown: Int32 = 0
            var list: [UInt32] = [1, 0]
            encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
            encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
            encoder.setVertexBytes(&tileCentre, length: MemoryLayout<SIMD3<Float>>.stride, index: 2)
            encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
            encoder.setFragmentBytes(&overlayShown, length: MemoryLayout<Int32>.size, index: 2)
            encoder.setFragmentBytes(&list, length: MemoryLayout<UInt32>.stride * list.count, index: 3)
            encoder.setFragmentBuffer(shapes, offset: 0, index: 4)
            encoder.setFragmentBuffer(corners, offset: 0, index: 5)
            encoder.setFragmentBuffer(pictures, offset: 0, index: 6)
            encoder.useResource(red, usage: .read, stages: .fragment)
            encoder.setFragmentTexture(grey, index: 0)
            encoder.setFragmentTexture(overlayCube, index: 1)
            encoder.setFragmentSamplerState(sampler, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: vertices.count)
            encoder.endEncoding()
            await withCheckedContinuation { finished in
                commands.addCompletedHandler { _ in finished.resume() }
                commands.commit()
            }
            var pixels = [SIMD4<Float>](repeating: SIMD4(), count: size * size)
            pixels.withUnsafeMutableBytes {
                texture.getBytes($0.baseAddress!, bytesPerRow: size * 16, from: MTLRegionMake2D(0, 0, size, size), mipmapLevel: 0)
            }
            return { pixels[$0.y * size + $0.x] }
        }
        // The pixel over a place, by its latitude and longitude.
        func pixel(_ latitude: Double, _ longitude: Double) -> SIMD2<Int> {
            let place = fixedPosition(latitude: latitude, longitude: longitude) - eye
            let x = (Float(place.y) / halfWidth + 1) / 2 * Float(size)
            let y = (1 - Float(place.z) / halfWidth) / 2 * Float(size)
            return SIMD2(Int(x), Int(y))
        }
        let ground = pow(Float(0.5), 2.2)

        let sweeping = try await draw(.sweeping(plane))
        #expect(abs(sweeping(pixel(-2.5, 0)).x - 1) < 0.01 && sweeping(pixel(-2.5, 0)).y < 0.01, "\(sweeping(pixel(-2.5, 0)))")
        #expect(abs(sweeping(pixel(2.5, 0)).x - ground) < 0.02, "\(sweeping(pixel(2.5, 0)))")
        #expect(abs(sweeping(pixel(-8, 0)).x - ground) < 0.02, "\(sweeping(pixel(-8, 0)))")

        let passed = try await draw(.passed)
        #expect(abs(passed(pixel(2.5, 0)).x - 1) < 0.01 && passed(pixel(2.5, 0)).y < 0.01, "\(passed(pixel(2.5, 0)))")
        #expect(abs(passed(pixel(-8, 0)).x - ground) < 0.02)
        // On the outline's edge, its yellow over the ground.
        let edge = (0..<size).map { passed(SIMD2($0, pixel(0, 0).y)) }.filter { $0.y > 0.3 }
        #expect(!edge.isEmpty)
    }

    /// One flat colour, as a picture.
    static func image(red: CGFloat, green: CGFloat, blue: CGFloat) -> CGImage? {
        let context = CGContext(
            data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        context?.setFillColor(red: red, green: green, blue: blue, alpha: 1)
        context?.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        return context?.makeImage()
    }
}
