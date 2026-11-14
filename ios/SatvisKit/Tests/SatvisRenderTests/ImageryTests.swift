import Foundation
import Metal
import Testing
import simd

@testable import SatvisCore
@testable import SatvisRender

@Suite struct ImageryTests {
    @Test func cutsTheGeographicSchemeInTwoAtTheTop() {
        #expect(Projection.geographic.bounds(TileKey(level: 0, x: 0, y: 0)) == Bounds(west: -180, south: -90, east: 0, north: 90))
        #expect(Projection.geographic.bounds(TileKey(level: 2, x: 7, y: 3)) == Bounds(west: 135, south: -90, east: 180, north: -45))
        #expect(TileKey(level: 3, x: 5, y: 2).parent == TileKey(level: 2, x: 2, y: 1))
    }

    @Test func endsWebMercatorAtItsLimit() {
        let world = Projection.webMercator.bounds(TileKey(level: 0, x: 0, y: 0))
        #expect(abs(world.north - Projection.mercatorLimit) < 1e-9)
        #expect(abs(Projection.webMercator.bounds(TileKey(level: 1, x: 0, y: 0)).south) < 1e-9)
    }

    // The source tiles a surface tile is baked from: the one a geographic source of
    // the same level holds it in, or the Mercator ones down its latitudes.
    @Test func findsTheSourceTilesUnderASurfaceTile() {
        // 5.625° to 8.4375° E, 30.9375° to 33.75° N.
        let tile = Projection.geographic.bounds(TileKey(level: 6, x: 66, y: 20))
        #expect(Projection.geographic.covering(tile, level: 6) == [TileKey(level: 6, x: 66, y: 20)])
        let mercator = Projection.webMercator.covering(tile, level: 6)
        #expect(mercator == [TileKey(level: 6, x: 33, y: 25), TileKey(level: 6, x: 33, y: 26)])
        #expect(mercator.count >= 1 && mercator.count <= 3)
        for key in mercator {
            let bounds = Projection.webMercator.bounds(key)
            #expect(bounds.north > tile.south && bounds.south < tile.north)
        }
    }

    // A source tile's texture coordinates down a surface tile, exact at every row:
    // where the strip says a latitude falls is where the Mercator tile has it.
    @Test func placesAMercatorTileExactlyAtLevelNineteen() {
        let source = TileKey(level: 19, x: 275_000, y: 180_000)
        let bounds = Projection.webMercator.bounds(source)
        let strip = Bake.strip(surface: bounds, source: bounds, projection: .webMercator)
        #expect(strip.first?.source == SIMD2(0, 0))
        #expect(strip.last.map { abs($0.source.x - 1) < 1e-6 && abs($0.source.y - 1) < 1e-6 } == true)
        let geographic = Bake.strip(surface: Bounds(west: 0, south: 0, east: 10, north: 10), source: Bounds(west: 0, south: 0, east: 20, north: 20), projection: .geographic)
        #expect(geographic.map(\.source) == [SIMD2(0, 0.5), SIMD2(0.5, 0.5), SIMD2(0, 1), SIMD2(0.5, 1)])
    }

    @Test func asksTheWebAppsServers() {
        let site = URL(string: "https://satvis.space/")!
        #expect(BaseLayer.naturalEarth.source(site: site)?.url(TileKey(level: 3, x: 9, y: 1))?.absoluteString == "https://satvis.space/data/imagery/NaturalEarthII/3/9/6.webp")
        #expect(BaseLayer.versaTiles.source(site: site)?.url(TileKey(level: 5, x: 17, y: 11))?.absoluteString == "https://tiles.versatiles.org/tiles/satellite/5/17/11")
        let gibs = BaseLayer.blackMarble.source(site: site)?.url(TileKey(level: 0, x: 1, y: 0))?.absoluteString ?? ""
        #expect(gibs.contains("layers=VIIRS_Black_Marble") && gibs.contains("bbox=0.0,-90.0,180.0,90.0") && gibs.contains("srs=EPSG:4326"))
        // Laid as an overlay, over the shipped Natural Earth alone.
        #expect(BaseLayer.geoMosaic.source(site: site) == nil)
        // GibsImagery.ts's domain over a day either side of the clock, or all of it.
        let goes = ImageryOverlay(
            layer: SatelliteDetails.ImageryPreview(provider: .gibs, layer: "GOES-East_ABI_GeoColor", maxLevel: 7, format: .png, isDaily: false, end: nil), frame: nil, bounds: nil)
        let october4 = 1_791_072_000_000.0
        #expect(
            goes.framesURL(covering: (october4 + 11 * 3_600_000)...(october4 + 59 * 3_600_000))?.absoluteString
                == "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/2026-10-04T11:00:00Z--2026-10-06T11:00:00Z.xml"
        )
        #expect(goes.framesURL()?.absoluteString.hasSuffix("/GoogleMapsCompatible_Level7/all/all.xml") == true)
    }

    // A dated tile is cached for good, so not one of a day whose swaths may still arrive.
    @Test func cachesOnlyWholeFrames() {
        let day = { (daysAgo: Double) in Date(timeIntervalSinceNow: -daysAgo * 86_400).formatted(.iso8601.year().month().day()) }
        #expect(GIBS.isWhole("2026-11-13T15:30:00Z"))
        #expect(GIBS.isWhole(day(3)))
        #expect(!GIBS.isWhole(day(1)))
        #expect(!GIBS.isWhole("default"))
    }

    @Test func meshesASurfaceTileWithASkirt() {
        let mesh = SurfaceMesh(bounds: Projection.geographic.bounds(TileKey(level: 4, x: 17, y: 4)), level: 4)
        #expect(mesh.vertices.count == 17 * 17 + 64)
        #expect(SurfaceMesh.indices().max() == UInt32(17 * 17 + 63))
        #expect(mesh.radius > 0 && mesh.samples.count == 9)
    }

    // A source tile is waited for only at the level a tile in view asks for: the
    // coarser ones under it, from the levels zoomed through, are not.
    @Test func waitsOnlyForTheLevelATileInViewAsksFor() {
        let inView = TileKey(level: 5, x: 33, y: 9)
        let bounds = Projection.geographic.bounds(inView)
        for (source, level) in [(Self.gibs, 5), (Self.eumetView, 4)] {
            let wanted = source.projection.covering(bounds, level: level)
            #expect(!wanted.isEmpty)
            #expect(wanted.allSatisfy { Surface.isWanted($0, of: source, by: [inView]) })
            #expect(!source.projection.covering(bounds, level: 2).contains { Surface.isWanted($0, of: source, by: [inView]) })
            #expect(!Surface.isWanted(TileKey(level: level, x: 0, y: 0), of: source, by: [inView]))
        }
    }

    // An overlay keeps the tiles the whole globe is drawn from, its stand-ins.
    @Test func keepsTheWholeGlobesTilesAsStandIns() {
        #expect(Surface.isStandIn(TileKey(level: 2, x: 3, y: 1), of: Self.gibs))
        #expect(!Surface.isStandIn(TileKey(level: 3, x: 3, y: 1), of: Self.gibs))
        #expect(Surface.isStandIn(TileKey(level: 1, x: 3, y: 1), of: Self.eumetView))
        #expect(!Surface.isStandIn(TileKey(level: 2, x: 3, y: 1), of: Self.eumetView))
    }

    /// GIBS's Web Mercator tiles and EUMETView's 512-pixel geographic ones.
    static let gibs = ImagerySource(projection: .webMercator, tileSize: 256, maximumLevel: 9, contentType: "image/") { _ in nil }
    static let eumetView = ImagerySource(projection: .geographic, tileSize: 512, maximumLevel: 5, contentType: "image/") { _ in nil }

    // A memory warning drops the tiles the last choice left out, and keeps those it
    // draws from: refined from afar, then nothing in view, the children go.
    @MainActor
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func trimsWhatTheLastChoiceLeftOut() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let libraries = try await ShaderLibrary.make(device: device)
        let surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        let eye = SIMD3<Double>(2e7, 0, 0)
        // Metres from the eye to clip space: the whole globe in view.
        let wholeGlobe = simd_double4x4(diagonal: SIMD4(3e-8, 3e-8, 3e-8, 1))
        _ = surface.select(eye: eye, viewProjection: wholeGlobe, viewportHeightPixels: 1000, verticalFieldOfView: .pi / 3, pixelsPerPoint: 2)
        let refined = surface.tileCount
        #expect(refined > 2)
        surface.trim()
        #expect(surface.tileCount == refined)
        // Unscaled, the globe is far outside clip space: only the roots are visited.
        _ = surface.select(eye: eye, viewProjection: matrix_identity_double4x4, viewportHeightPixels: 1000, verticalFieldOfView: .pi / 3, pixelsPerPoint: 2)
        surface.trim()
        #expect(surface.tileCount == 2)
    }

    // A clock faster than the service: the frames asked for while one loads wait for
    // it, rather than cancelling it, and the last of them follows.
    @MainActor
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func finishesAFrameBeforeTheNext() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let queue = try #require(device.makeCommandQueue())
        let libraries = try await ShaderLibrary.make(device: device)
        let surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        let gate = Gate()
        surface.loader = { _ in
            await gate.wait()
            return nil
        }
        let layer = SatelliteDetails.ImageryPreview(provider: .eumetview, layer: "mtg_fd:rgb_geocolour", maxLevel: 7, format: .png, isDaily: false, end: nil)
        let frame = { (time: String) in ImageryOverlay(layer: layer, frame: time, bounds: nil) }
        surface.setOverlays([frame("08:00")])
        let wholeGlobe = simd_double4x4(diagonal: SIMD4(3e-8, 3e-8, 3e-8, 1))
        let (_, bake) = surface.select(eye: SIMD3(2e7, 0, 0), viewProjection: wholeGlobe, viewportHeightPixels: 1000, verticalFieldOfView: .pi / 3, pixelsPerPoint: 2)
        let base = try #require(
            device.makeTexture(descriptor: .texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 4, height: 4, mipmapped: false)))
        let commands = try #require(queue.makeCommandBuffer())
        surface.encodeBakes(bake, base: base, commands: commands)
        commands.commit()

        surface.setOverlays([frame("08:10")])
        surface.setOverlays([frame("08:20")])
        #expect(surface.overlayFrames == ["08:00"])
        await gate.open()
        for _ in 0..<200 where surface.overlayFrames == ["08:00"] {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(surface.overlayFrames == ["08:20"])

        surface.setOverlays([frame("08:30")])
        #expect(surface.overlayFrames == ["08:30"])
    }

    // A pinch passes through levels: nothing is asked for while the view zooms, and
    // what the tiles in view then lack once it settles.
    @MainActor
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func holdsRequestsWhileZooming() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let queue = try #require(device.makeCommandQueue())
        let libraries = try await ShaderLibrary.make(device: device)
        let surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        let asked = Gauge()
        surface.loader = { _ in
            await asked.add()
            return nil
        }
        let layer = SatelliteDetails.ImageryPreview(provider: .eumetview, layer: "mtg_fd:rgb_geocolour", maxLevel: 7, format: .png, isDaily: false, end: nil)
        surface.setOverlays([ImageryOverlay(layer: layer, frame: "08:00", bounds: nil)])
        let base = try #require(
            device.makeTexture(descriptor: .texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 4, height: 4, mipmapped: false)))
        let wholeGlobe = simd_double4x4(diagonal: SIMD4(3e-8, 3e-8, 3e-8, 1))
        func draw(from distance: Double) throws {
            let (_, bake) = surface.select(eye: SIMD3(distance, 0, 0), viewProjection: wholeGlobe, viewportHeightPixels: 1000, verticalFieldOfView: .pi / 3, pixelsPerPoint: 2)
            let commands = try #require(queue.makeCommandBuffer())
            surface.encodeBakes(bake, base: base, commands: commands)
            commands.commit()
        }

        _ = surface.select(eye: SIMD3(2e7, 0, 0), viewProjection: wholeGlobe, viewportHeightPixels: 1000, verticalFieldOfView: .pi / 3, pixelsPerPoint: 2)
        try draw(from: 1e7)
        try await Task.sleep(for: .milliseconds(50))
        #expect(await asked.count == 0)

        let revision = surface.revision
        for _ in 0..<100 where surface.revision == revision {
            try await Task.sleep(for: .milliseconds(10))
        }
        try draw(from: 1e7)
        for _ in 0..<100 where await asked.count == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await asked.count > 0)
    }

    // The sky view stands on the ground the Map panel draws: the ellipsoid with the
    // terrain off, and what is worked out from the ground redone when it changes.
    @MainActor
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func standsOnTheEllipsoidWithTheTerrainOff() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let libraries = try await ShaderLibrary.make(device: device)
        let surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        #expect(surface.groundHeight(GeoCoordinate(latitude: 46.59, longitude: 7.91)) == 0)
        let revision = surface.terrainRevision
        surface.setTerrain(true)
        #expect(surface.groundHeight(GeoCoordinate(latitude: 46.59, longitude: 7.91)) == nil)
        #expect(surface.terrainRevision == revision + 1)
        surface.setTerrain(true)
        #expect(surface.terrainRevision == revision + 1)
        surface.setTerrain(false)
        #expect(surface.groundHeight(GeoCoordinate(latitude: 46.59, longitude: 7.91)) == 0)
        #expect(surface.terrainRevision == revision + 2)
    }

}

/// Holds the loads back until opened.
private actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if !isOpen {
            await withCheckedContinuation { waiting.append($0) }
        }
    }

    func open() {
        isOpen = true
        for continuation in waiting {
            continuation.resume()
        }
        waiting = []
    }
}

/// Counts the loads asked for.
private actor Gauge {
    private(set) var count = 0

    func add() {
        count += 1
    }
}
