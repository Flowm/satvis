import Foundation
import simd

/// A terrain tile in Cesium's quantized-mesh-1.0 format, decoded: vertices placed
/// across the tile and up from its minimum height, triangles, the vertices along
/// each edge, and the oct-encoded normals when the server sent them
/// (https://github.com/CesiumGS/quantized-mesh).
struct QuantizedMesh: Sendable {
    /// Across the tile, 0 at the west and south edges and 1 at the east and north.
    var u: [Double]
    var v: [Double]
    /// Metres above the ellipsoid.
    var heights: [Double]
    var triangles: [UInt32]
    /// Vertex indices along each edge.
    var west: [UInt32]
    var south: [UInt32]
    var east: [UInt32]
    var north: [UInt32]
    var normals: [SIMD3<Double>]?
    var minimumHeight: Double
    var maximumHeight: Double

    enum DecodingError: Error {
        case truncated
    }

    init(_ data: Data) throws(DecodingError) {
        var reader = Reader(data: data)
        // Header: the centre (3 doubles), the height range (2 floats), a bounding
        // sphere (4 doubles) and the horizon occlusion point (3 doubles).
        try reader.skip(24)
        minimumHeight = Double(try reader.float())
        maximumHeight = Double(try reader.float())
        try reader.skip(56)

        let count = Int(try reader.uint32())
        func zigzag(_ count: Int) throws(DecodingError) -> [Double] {
            var value = 0
            var values: [Double] = []
            values.reserveCapacity(count)
            for _ in 0..<count {
                let encoded = Int(try reader.uint16())
                value += (encoded >> 1) ^ -(encoded & 1)
                values.append(Double(value) / 32767)
            }
            return values
        }
        u = try zigzag(count)
        v = try zigzag(count)
        let range = maximumHeight - minimumHeight
        let minimum = minimumHeight
        heights = try zigzag(count).map { minimum + $0 * range }

        let wide = count > 65536
        try reader.align(wide ? 4 : 2)
        let triangleCount = Int(try reader.uint32())
        // High-water-mark encoded.
        var highest: UInt32 = 0
        var triangles: [UInt32] = []
        triangles.reserveCapacity(triangleCount * 3)
        for _ in 0..<triangleCount * 3 {
            let code = wide ? try reader.uint32() : UInt32(try reader.uint16())
            triangles.append(highest &- code)
            if code == 0 {
                highest += 1
            }
        }
        self.triangles = triangles
        func edge() throws(DecodingError) -> [UInt32] {
            let count = Int(try reader.uint32())
            var indices: [UInt32] = []
            for _ in 0..<count {
                indices.append(wide ? try reader.uint32() : UInt32(try reader.uint16()))
            }
            return indices
        }
        west = try edge()
        south = try edge()
        east = try edge()
        north = try edge()

        normals = nil
        while !reader.isAtEnd {
            let id = try reader.uint8()
            let length = Int(try reader.uint32())
            if id == 1, length == 2 * count {
                var normals: [SIMD3<Double>] = []
                normals.reserveCapacity(count)
                for _ in 0..<count {
                    normals.append(Self.octDecode(try reader.uint8(), try reader.uint8()))
                }
                self.normals = normals
            } else {
                try reader.skip(length)
            }
        }
    }

    /// CesiumJS's AttributeCompression.octDecode for 8-bit components.
    static func octDecode(_ x: UInt8, _ y: UInt8) -> SIMD3<Double> {
        var result = SIMD3(Double(x) / 255 * 2 - 1, Double(y) / 255 * 2 - 1, 0)
        result.z = 1 - abs(result.x) - abs(result.y)
        if result.z < 0 {
            let oldX = result.x
            result.x = (1 - abs(result.y)) * (oldX >= 0 ? 1 : -1)
            result.y = (1 - abs(oldX)) * (result.y >= 0 ? 1 : -1)
        }
        return normalize(result)
    }

    /// The height and normal under a point of the tile, from the triangle it falls
    /// in. Nil where none covers it, which a well-formed tile never leaves.
    func sample(u x: Double, v y: Double, grid: TriangleGrid) -> (height: Double, normal: SIMD3<Double>?)? {
        for triangle in grid.triangles(near: x, y) {
            let (a, b, c) = (Int(triangles[3 * triangle]), Int(triangles[3 * triangle + 1]), Int(triangles[3 * triangle + 2]))
            let denominator = (v[b] - v[c]) * (u[a] - u[c]) + (u[c] - u[b]) * (v[a] - v[c])
            guard abs(denominator) > 1e-15 else {
                continue
            }
            let wa = ((v[b] - v[c]) * (x - u[c]) + (u[c] - u[b]) * (y - v[c])) / denominator
            let wb = ((v[c] - v[a]) * (x - u[c]) + (u[a] - u[c]) * (y - v[c])) / denominator
            let wc = 1 - wa - wb
            if wa >= -1e-9, wb >= -1e-9, wc >= -1e-9 {
                let normal = normals.map { normalize(wa * $0[a] + wb * $0[b] + wc * $0[c]) }
                return (wa * heights[a] + wb * heights[b] + wc * heights[c], normal)
            }
        }
        return nil
    }

    /// The triangles bucketed by where they lie, so finding the one under a point
    /// does not search them all.
    struct TriangleGrid: Sendable {
        static let size = 32
        private var buckets: [[Int]]

        init(_ mesh: QuantizedMesh) {
            buckets = Array(repeating: [], count: Self.size * Self.size)
            for triangle in 0..<mesh.triangles.count / 3 {
                let corners = (0..<3).map { Int(mesh.triangles[3 * triangle + $0]) }
                let us = corners.map { mesh.u[$0] }
                let vs = corners.map { mesh.v[$0] }
                for row in Self.cell(vs.min()!)...Self.cell(vs.max()!) {
                    for column in Self.cell(us.min()!)...Self.cell(us.max()!) {
                        buckets[row * Self.size + column].append(triangle)
                    }
                }
            }
        }

        private static func cell(_ value: Double) -> Int {
            min(max(Int(value * Double(size)), 0), size - 1)
        }

        func triangles(near u: Double, _ v: Double) -> [Int] {
            buckets[Self.cell(v) * Self.size + Self.cell(u)]
        }
    }
}

private struct Reader {
    let data: Data
    var offset = 0

    var isAtEnd: Bool { offset >= data.count }

    mutating func skip(_ count: Int) throws(QuantizedMesh.DecodingError) {
        guard offset + count <= data.count else {
            throw .truncated
        }
        offset += count
    }

    mutating func align(_ size: Int) throws(QuantizedMesh.DecodingError) {
        if offset % size != 0 {
            try skip(size - offset % size)
        }
    }

    private mutating func read<T: FixedWidthInteger>(_: T.Type) throws(QuantizedMesh.DecodingError) -> T {
        let size = MemoryLayout<T>.size
        guard offset + size <= data.count else {
            throw .truncated
        }
        var value: T = 0
        withUnsafeMutableBytes(of: &value) { buffer in
            data.copyBytes(to: buffer.bindMemory(to: UInt8.self), from: (data.startIndex + offset)..<(data.startIndex + offset + size))
        }
        offset += size
        return T(littleEndian: value)
    }

    mutating func uint8() throws(QuantizedMesh.DecodingError) -> UInt8 { try read(UInt8.self) }
    mutating func uint16() throws(QuantizedMesh.DecodingError) -> UInt16 { try read(UInt16.self) }
    mutating func uint32() throws(QuantizedMesh.DecodingError) -> UInt32 { try read(UInt32.self) }
    mutating func float() throws(QuantizedMesh.DecodingError) -> Float { Float(bitPattern: try read(UInt32.self)) }
}

/// Re:Earth's terrain, as the web app asks for it: heights above the ellipsoid,
/// not the geoid, with normals and without the water mask, levels 0 to 14 on the
/// geographic scheme the surface uses.
enum Terrain {
    static let maximumLevel = 14
    static let contentType = "application/vnd.quantized-mesh"
    static let headers = ["Accept": "application/vnd.quantized-mesh;extensions=octvertexnormals,application/octet-stream;q=0.9,*/*;q=0.01"]
    static let credit = (text: "Re:Earth Terrain · Mapterhorn (CC BY 4.0)", link: URL(string: "https://terrain.reearth.land/"))

    static func url(_ key: TileKey) -> URL? {
        // A TMS pyramid: rows counted from the south.
        URL(string: "https://terrain.reearth.land/cesium-mesh/ellipsoid/\(key.level)/\(key.x)/\((1 << key.level) - 1 - key.y).terrain")
    }

    /// CesiumJS's skirt for a quantized-mesh tile: five times its level's geometric
    /// error.
    static func skirtHeight(level: Int) -> Double {
        5 * 6_378_137.0 * 2 * .pi * 0.25 / (65 * 2) / Double(1 << level)
    }

    /// The terrain tile a surface tile takes its heights from. CesiumJS measures a
    /// tile's error in CSS pixels, so the web app's terrain is as fine as a tile
    /// a point across per texel would need: `offset` levels coarser than the
    /// surface, which is refined by device pixels for the imagery, and no finer
    /// than Re:Earth goes.
    static func key(forSurface key: TileKey, offset: Int) -> TileKey {
        var key = key
        let level = min(max(key.level - offset, 0), maximumLevel)
        while key.level > level, let parent = key.parent {
            key = parent
        }
        return key
    }

    /// How many levels the surface is refined past the terrain on a screen of
    /// `pixelsPerPoint`.
    static func offset(pixelsPerPoint: Double) -> Int {
        max(Int(log2(pixelsPerPoint).rounded()), 0)
    }
}

/// A terrain tile, decoded, for the surface tiles over it to take their heights
/// from.
struct TerrainSource: Sendable {
    let mesh: QuantizedMesh
    let grid: QuantizedMesh.TriangleGrid
    let bounds: Bounds

    init(mesh: QuantizedMesh, key: TileKey) {
        self.mesh = mesh
        grid = QuantizedMesh.TriangleGrid(mesh)
        bounds = Projection.geographic.bounds(key)
    }

    /// The height and normal at a place in the tile; the ellipsoid where the mesh
    /// leaves a gap.
    func sample(latitude: Double, longitude: Double) -> (height: Double, normal: SIMD3<Double>?) {
        let u = (longitude - bounds.west) / (bounds.east - bounds.west)
        let v = (latitude - bounds.south) / (bounds.north - bounds.south)
        return mesh.sample(u: min(max(u, 0), 1), v: min(max(v, 0), 1), grid: grid) ?? (0, nil)
    }
}
