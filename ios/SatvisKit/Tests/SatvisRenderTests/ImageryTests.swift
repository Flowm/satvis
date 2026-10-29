import Foundation
import Metal
import Testing
import simd

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
        #expect(BaseLayer.naturalEarth.source(site: site).url(TileKey(level: 3, x: 9, y: 1))?.absoluteString == "https://satvis.space/data/imagery/NaturalEarthII/3/9/6.webp")
        #expect(BaseLayer.versaTiles.source(site: site).url(TileKey(level: 5, x: 17, y: 11))?.absoluteString == "https://tiles.versatiles.org/tiles/satellite/5/17/11")
        let gibs = BaseLayer.blackMarble.source(site: site).url(TileKey(level: 0, x: 1, y: 0))?.absoluteString ?? ""
        #expect(gibs.contains("layers=VIIRS_Black_Marble") && gibs.contains("bbox=0.0,-90.0,180.0,90.0") && gibs.contains("srs=EPSG:4326"))
        #expect(
            BaseLayer.viirs.source(site: site, frame: "2026-10-04").url(TileKey(level: 3, x: 4, y: 2))?.absoluteString
                == "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-04/GoogleMapsCompatible_Level9/3/2/4.jpg")
        #expect(BaseLayer.viirs.source(site: site).url(TileKey(level: 0, x: 0, y: 0))?.absoluteString.contains("/default/default/") == true)
    }

    // timeDomain.ts's parseDomain and withoutLatestFrame, for a daily layer: the
    // finished days listed, and its snapToFrame: the clock's day, or the one before
    // a gap, held within them.
    @Test func readsADailyLayersDays() throws {
        let xml = "<Dimension><ows:Identifier>Time</ows:Identifier><Domain>2019-01-03/2026-10-06/P1D,2015-11-24/2019-01-01/P1D</Domain></Dimension>"
        let days = try #require(GIBS.days(inDomain: xml))
        #expect(days == ["2015-11-24"..."2019-01-01", "2019-01-03"..."2026-10-05"])
        #expect(GIBS.days(inDomain: "<Domain>2026-09-01/2026-10-01/P1D</Domain>") == ["2026-09-01"..."2026-09-30"])
        #expect(GIBS.days(inDomain: "<Domain>2026-10-01/2026-10-03/P1D,2026-10-05</Domain>") == ["2026-10-01"..."2026-10-03"])
        #expect(GIBS.days(inDomain: "<Domain>2026-10-05</Domain>") == nil)
        #expect(GIBS.days(inDomain: "<Domain></Domain>") == nil)
        #expect(GIBS.days(inDomain: "<html>") == nil)
        let day = 86_400_000.0
        let october4 = 1_791_072_000_000.0
        let january2 = 1_546_387_200_000.0
        #expect(GIBS.frame(at: october4 + 0.5 * day, within: days) == "2026-10-04")
        #expect(GIBS.frame(at: october4 + 10 * day, within: days) == "2026-10-05")
        #expect(GIBS.frame(at: january2 + 0.5 * day, within: days) == "2019-01-01")
        #expect(GIBS.frame(at: january2 + 1.5 * day, within: days) == "2019-01-03")
        #expect(GIBS.frame(at: 0, within: days) == "2015-11-24")
    }

    @Test func meshesASurfaceTileWithASkirt() {
        let mesh = SurfaceMesh(bounds: Projection.geographic.bounds(TileKey(level: 4, x: 17, y: 4)), level: 4)
        #expect(mesh.vertices.count == 17 * 17 + 64)
        #expect(SurfaceMesh.indices().max() == UInt32(17 * 17 + 63))
        #expect(mesh.radius > 0 && mesh.samples.count == 9)
    }

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

    // The sky view stands on the ground the Map panel draws: the ellipsoid with the
    // terrain off, and what is worked out from the ground redone when it changes.
    @MainActor
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func standsOnTheEllipsoidWithTheTerrainOff() async throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        let libraries = try await ShaderLibrary.make(device: device)
        let surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        #expect(surface.groundHeight(latitude: 46.59, longitude: 7.91) == 0)
        let revision = surface.terrainRevision
        surface.setTerrain(true)
        #expect(surface.groundHeight(latitude: 46.59, longitude: 7.91) == nil)
        #expect(surface.terrainRevision == revision + 1)
        surface.setTerrain(true)
        #expect(surface.terrainRevision == revision + 1)
        surface.setTerrain(false)
        #expect(surface.groundHeight(latitude: 46.59, longitude: 7.91) == 0)
        #expect(surface.terrainRevision == revision + 2)
    }

}
