import Foundation
import Testing

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
                == "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-10-04/GoogleMapsCompatible_Level9/3/2/4.jpg")
        #expect(BaseLayer.viirs.source(site: site).url(TileKey(level: 0, x: 0, y: 0))?.absoluteString.contains("/default/default/") == true)
    }

    // timeDomain.ts's parseDomain, for a daily layer: the first and last day listed,
    // and the clock's day held within them.
    @Test func readsADailyLayersDays() throws {
        let xml = "<Dimension><ows:Identifier>Time</ows:Identifier><Domain>2015-11-24/2019-01-01/P1D,2019-01-03/2026-10-06/P1D</Domain></Dimension>"
        let days = try #require(GIBS.days(inDomain: xml))
        #expect(days == "2015-11-24"..."2026-10-06")
        #expect(GIBS.days(inDomain: "<Domain></Domain>") == nil)
        #expect(GIBS.days(inDomain: "<html>") == nil)
        let day = 86_400_000.0
        let october4 = 1_791_072_000_000.0
        #expect(GIBS.frame(at: october4 + 0.5 * day, within: days) == "2026-10-04")
        #expect(GIBS.frame(at: october4 + 10 * day, within: days) == "2026-10-06")
        #expect(GIBS.frame(at: 0, within: days) == "2015-11-24")
    }

    @Test func meshesASurfaceTileWithASkirt() {
        let mesh = SurfaceMesh(bounds: Projection.geographic.bounds(TileKey(level: 4, x: 17, y: 4)), level: 4)
        #expect(mesh.vertices.count == 17 * 17 + 64)
        #expect(SurfaceMesh.indices().max() == UInt32(17 * 17 + 63))
        #expect(mesh.radius > 0 && mesh.samples.count == 9)
    }
}
