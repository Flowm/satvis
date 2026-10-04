import Foundation
import simd

/// Mirrors `GlobeVertex` in Shaders/Globe.msl.
struct GlobeVertex {
    var high: SIMD3<Float>
    var low: SIMD3<Float>
    var normal: SIMD3<Float>
    var uv: SIMD2<Float>
}

/// A latitude-longitude grid over an ellipsoid, as triangle indices into its
/// vertices. Wound counter-clockwise seen from outside.
struct EllipsoidMesh<Vertex> {
    var vertices: [Vertex]
    var indices: [UInt32]

    init(radii: SIMD3<Double>, longitudes: Int, latitudes: Int, vertex: (_ position: SIMD3<Double>, _ normal: SIMD3<Double>, _ uv: SIMD2<Double>) -> Vertex) {
        vertices = []
        vertices.reserveCapacity((longitudes + 1) * (latitudes + 1))
        let radiiSquared = radii * radii
        for row in 0...latitudes {
            // Geodetic latitude from the north pole down, which is how the imagery's
            // rows run.
            let v = Double(row) / Double(latitudes)
            let latitude = Double.pi / 2 - v * Double.pi
            for column in 0...longitudes {
                let u = Double(column) / Double(longitudes)
                let longitude = -Double.pi + u * 2 * Double.pi
                // CesiumJS's cartographicToCartesian: the point whose surface normal this is.
                let normal = SIMD3(cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude))
                let k = radiiSquared * normal
                vertices.append(vertex(k / sqrt(dot(normal, k)), normal, SIMD2(u, v)))
            }
        }
        indices = []
        indices.reserveCapacity(longitudes * latitudes * 6)
        let stride = UInt32(longitudes + 1)
        for row in 0..<UInt32(latitudes) {
            for column in 0..<UInt32(longitudes) {
                let a = row * stride + column
                let b = a + stride
                indices += [a, b, a + 1, a + 1, b, b + 1]
            }
        }
    }
}

enum Meshes {
    /// The globe: 256 by 128 quads, about 0.7° each.
    static func globe() -> EllipsoidMesh<GlobeVertex> {
        EllipsoidMesh(radii: ellipsoidRadii, longitudes: 256, latitudes: 128) { position, normal, uv in
            let (high, low) = encode(position)
            return GlobeVertex(high: high, low: low, normal: SIMD3<Float>(normal), uv: SIMD2<Float>(uv))
        }
    }

    /// The sky atmosphere's shell, 2.5 % outside the ellipsoid (SkyAtmosphere.js).
    static func skyShell() -> EllipsoidMesh<SIMD4<Float>> {
        EllipsoidMesh(radii: ellipsoidRadii * 1.025, longitudes: 128, latitudes: 64) { position, _, _ in
            SIMD4<Float>(SIMD3<Float>(position), 1)
        }
    }
}
