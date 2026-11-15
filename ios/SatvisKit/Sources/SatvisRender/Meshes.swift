import Foundation
import simd

/// Mirrors `GlobeVertex` in Shaders/Globe.msl.
struct GlobeVertex {
    /// From its tile's centre, in metres: small enough for a float to hold to the
    /// centimetre on a close tile, so the vertex function adds it to the centre's
    /// offset from the eye with no high/low split, and may use fast math.
    var offset: SIMD3<Float>
    var normal: SIMD3<Float>
    var uv: SIMD2<Float>
}

/// A surface tile's mesh: 16 by 16 quads on the ellipsoid, with a skirt hanging
/// below its edges to hide the cracks where it meets a coarser neighbour.
struct SurfaceMesh {
    static let size = 16

    var vertices: [GlobeVertex]
    var centre: SIMD3<Double>
    var radius: Double
    var samples: [SIMD3<Double>]

    /// A terrain's height and normal at a latitude and longitude, and how deep a
    /// skirt hides the cracks between tiles laid over it.
    typealias Ground = (sample: (_ latitude: Double, _ longitude: Double) -> (height: Double, normal: SIMD3<Double>?), skirt: Double)

    /// On the ellipsoid, or laid over `terrain`.
    init(bounds: Bounds, terrain: Ground? = nil) {
        let n = Self.size
        // Deep enough to cover the sag of a chord of a neighbour a level or two coarser.
        let segment = (bounds.east - bounds.west) * .pi / 180 * 6_371_000 / Double(n)
        let skirt = max(4 * segment * segment / (8 * 6_371_000) + 10, terrain?.skirt ?? 0)
        centre = fixedPosition(latitude: (bounds.south + bounds.north) / 2, longitude: (bounds.west + bounds.east) / 2)
        var vertices: [GlobeVertex] = []
        var points: [SIMD3<Double>] = []
        for row in 0...n {
            for column in 0...n {
                let (vertex, position) = Self.vertex(bounds, row: row, column: column, depth: 0, terrain: terrain?.sample, centre: centre)
                vertices.append(vertex)
                points.append(position)
            }
        }
        // The skirt: the edge again, lowered, in order around the tile.
        for edge in Self.edge {
            vertices.append(Self.vertex(bounds, row: edge.row, column: edge.column, depth: skirt, terrain: terrain?.sample, centre: centre).0)
        }
        self.vertices = vertices
        let centre = centre
        radius = points.map { simd.distance($0, centre) }.max() ?? 0
        samples = [(0, 0), (0, n / 2), (0, n), (n / 2, 0), (n / 2, n / 2), (n / 2, n), (n, 0), (n, n / 2), (n, n)].map { points[$0.0 * (n + 1) + $0.1] }
    }

    /// A grid point of a tile, `depth` metres below the surface.
    private static func vertex(
        _ bounds: Bounds, row: Int, column: Int, depth: Double, terrain: ((Double, Double) -> (height: Double, normal: SIMD3<Double>?))?, centre: SIMD3<Double>
    ) -> (
        GlobeVertex, SIMD3<Double>
    ) {
        let u = Double(column) / Double(size)
        let v = Double(row) / Double(size)
        let latitude = bounds.north - v * (bounds.north - bounds.south)
        let longitude = bounds.west + u * (bounds.east - bounds.west)
        let phi = latitude * .pi / 180
        let lambda = longitude * .pi / 180
        let up = SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
        let ground = terrain?(latitude, longitude)
        let position = fixedPosition(latitude: latitude, longitude: longitude) + ((ground?.height ?? 0) - depth) * up
        return (GlobeVertex(offset: SIMD3<Float>(position - centre), normal: SIMD3<Float>(ground?.normal ?? up), uv: SIMD2(Float(u), Float(v))), position)
    }

    /// The edge vertices around a tile, starting at its north-west corner.
    static let edge: [(row: Int, column: Int)] = {
        let n = size
        return (0..<n).map { (0, $0) } + (0..<n).map { ($0, n) } + (0..<n).map { (n, n - $0) } + (0..<n).map { (n - $0, 0) }
    }()

    /// Triangles for every tile's grid and skirt, wound counter-clockwise from
    /// outside.
    static func indices() -> [UInt32] {
        let stride = UInt32(size) + 1
        var indices = Meshes.grid(columns: size, rows: size)
        let skirtStart = stride * stride
        let ring = UInt32(edge.count)
        for i in 0..<ring {
            let top = UInt32(edge[Int(i)].row) * stride + UInt32(edge[Int(i)].column)
            let next = UInt32(edge[Int((i + 1) % ring)].row) * stride + UInt32(edge[Int((i + 1) % ring)].column)
            let bottom = skirtStart + i
            let nextBottom = skirtStart + (i + 1) % ring
            // Both windings, so a skirt shows from either side under culling.
            indices += [top, bottom, next, next, bottom, nextBottom, top, next, bottom, next, nextBottom, bottom]
        }
        return indices
    }
}

enum Meshes {
    /// Triangles over a grid of `columns + 1` by `rows + 1` vertices, numbered
    /// along the rows.
    static func grid(columns: Int, rows: Int) -> [UInt32] {
        let stride = UInt32(columns + 1)
        var indices: [UInt32] = []
        indices.reserveCapacity(columns * rows * 6)
        for row in 0..<UInt32(rows) {
            for column in 0..<UInt32(columns) {
                let a = row * stride + column
                let b = a + stride
                indices += [a, b, a + 1, a + 1, b, b + 1]
            }
        }
        return indices
    }

    /// The sky atmosphere's shell, 2.5 % outside the ellipsoid (SkyAtmosphere.js): a
    /// latitude-longitude grid, wound counter-clockwise seen from outside.
    static func skyShell() -> (vertices: [SIMD4<Float>], indices: [UInt32]) {
        let radii = ellipsoidRadii * 1.025
        let radiiSquared = radii * radii
        let longitudes = 128
        let latitudes = 64
        var vertices: [SIMD4<Float>] = []
        vertices.reserveCapacity((longitudes + 1) * (latitudes + 1))
        for row in 0...latitudes {
            // Geodetic latitude from the north pole down.
            let latitude = Double.pi / 2 - Double(row) / Double(latitudes) * Double.pi
            for column in 0...longitudes {
                let longitude = -Double.pi + Double(column) / Double(longitudes) * 2 * Double.pi
                // CesiumJS's cartographicToCartesian: the point whose surface normal this is.
                let normal = SIMD3(cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude))
                let k = radiiSquared * normal
                vertices.append(SIMD4<Float>(SIMD3<Float>(k / sqrt(dot(normal, k))), 1))
            }
        }
        return (vertices, grid(columns: longitudes, rows: latitudes))
    }
}
