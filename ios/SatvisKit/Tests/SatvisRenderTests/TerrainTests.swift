import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct TerrainTests {
    private static func tile() throws -> QuantizedMesh {
        let url = try #require(Bundle.module.url(forResource: "10-1086-781", withExtension: "terrain", subdirectory: "Fixtures"))
        return try QuantizedMesh(Data(contentsOf: url))
    }

    // As Re:Earth served it: counted with a script that walked the format.
    @Test func decodesAQuantizedMesh() throws {
        let mesh = try Self.tile()
        #expect(mesh.u.count == 4105)
        #expect(mesh.triangles.count == 7960 * 3)
        let edges: [Int] = [mesh.west.count, mesh.south.count, mesh.east.count, mesh.north.count]
        #expect(edges == [63, 62, 65, 62])
        #expect(mesh.triangles.allSatisfy { $0 < 4105 })
        let inside = mesh.u.allSatisfy { (0.0...1.0).contains($0) } && mesh.v.allSatisfy { (0.0...1.0).contains($0) }
        #expect(inside)
        #expect(abs((mesh.heights.max() ?? 0) - mesh.maximumHeight) < 0.01)
        let normals = try #require(mesh.normals)
        #expect(normals.allSatisfy { abs(length($0) - 1) < 1e-9 })
        // Each edge's vertices lie on it.
        let onWest = mesh.west.allSatisfy { mesh.u[Int($0)] == 0.0 }
        let onNorth = mesh.north.allSatisfy { mesh.v[Int($0)] == 1.0 }
        #expect(onWest && onNorth)
    }

    // The Zugspitze, 2,962 m, stands in this tile: its summit is the high ground.
    @Test func findsTheGroundUnderAPoint() throws {
        let source = TerrainSource(mesh: try Self.tile(), key: Self.key)
        let summit = source.sample(latitude: 47.421, longitude: 10.985)
        #expect(summit.height > 2500)
        let normal = try #require(summit.normal)
        #expect(abs(length(normal) - 1) < 1e-9)
        let bounds = source.bounds
        for (u, v) in [(0.0, 0.0), (1.0, 1.0), (0.5, 0.5), (0.123, 0.987)] {
            let latitude = bounds.south + v * (bounds.north - bounds.south)
            let longitude = bounds.west + u * (bounds.east - bounds.west)
            #expect(source.mesh.sample(u: u, v: v, grid: source.grid) != nil, "nothing under \(u), \(v)")
            #expect(source.sample(latitude: latitude, longitude: longitude).height > 500)
        }
    }

    // On a 3x screen the surface is refined two levels past the terrain, as the
    // web app's would be at a point a texel; never past Re:Earth's level 14.
    @Test func takesTheTerrainFromAsCoarseATileAsTheWebApp() {
        #expect(Terrain.offset(pixelsPerPoint: 3) == 2)
        #expect(Terrain.offset(pixelsPerPoint: 2) == 1)
        #expect(Terrain.offset(pixelsPerPoint: 1) == 0)
        let surface = TileKey(level: 12, x: 4345, y: 968)
        #expect(Terrain.key(forSurface: surface, offset: 2) == TileKey(level: 10, x: 1086, y: 242))
        #expect(Terrain.key(forSurface: TileKey(level: 1, x: 3, y: 1), offset: 2) == TileKey(level: 0, x: 1, y: 0))
        #expect(Terrain.key(forSurface: TileKey(level: 19, x: 1 << 19, y: 0), offset: 2).level == 14)
    }

    // A surface tile two levels down the fixture, laid over it: its grid follows
    // the mountain, and its skirt hangs as deep as the terrain tile's.
    @Test func laysASurfaceTileOverTheTerrain() throws {
        let source = TerrainSource(mesh: try Self.tile(), key: Self.key)
        let bounds = Projection.geographic.bounds(TileKey(level: 12, x: 4345, y: 968))
        let skirt = Terrain.skirtHeight(level: 10)
        let flat = SurfaceMesh(bounds: bounds, level: 12)
        let draped = SurfaceMesh(bounds: bounds, level: 12, terrain: (source.sample, skirt))
        #expect(draped.vertices.count == flat.vertices.count)
        let grid = (SurfaceMesh.size + 1) * (SurfaceMesh.size + 1)
        func height(_ vertex: GlobeVertex) -> Double { length(SIMD3<Double>(vertex.high) + SIMD3<Double>(vertex.low)) }
        let raised = zip(draped.vertices.prefix(grid), flat.vertices.prefix(grid)).map { height($0) - height($1) }
        #expect(raised.allSatisfy { $0 > 500 })
        #expect((raised.max() ?? 0) > 1500)
        // Each skirt vertex hangs below the grid vertex on the edge it follows.
        for (index, edge) in SurfaceMesh.edge.enumerated() {
            let top = draped.vertices[edge.row * (SurfaceMesh.size + 1) + edge.column]
            let bottom = draped.vertices[grid + index]
            #expect(abs(height(top) - height(bottom) - skirt) < 50)
        }
    }

    private static let key = TileKey(level: 10, x: 1086, y: (1 << 10) - 1 - 781)
}
