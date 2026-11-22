import Foundation
import SatvisCore
import os
import simd

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

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
        /// Counts or indices the tile's own data cannot hold: a tile like that
        /// would index past its vertices.
        case malformed
    }

    init(_ data: Data) throws(DecodingError) {
        var reader = Reader(data: data)
        // Header: the centre (3 doubles), the height range (2 floats), a bounding
        // sphere (4 doubles) and the horizon occlusion point (3 doubles).
        try reader.skip(24)
        minimumHeight = Double(try reader.float())
        maximumHeight = Double(try reader.float())
        guard minimumHeight.isFinite, maximumHeight.isFinite, minimumHeight <= maximumHeight else {
            throw .malformed
        }
        try reader.skip(56)

        // Each count is held to what the bytes left could carry before anything is
        // reserved for it: a count from a corrupt tile reached gigabytes.
        let count = Int(try reader.uint32())
        guard count <= reader.remaining / 6 else {
            throw .truncated
        }
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
        let indexSize = wide ? 4 : 2
        let triangleCount = Int(try reader.uint32())
        guard triangleCount <= reader.remaining / (3 * indexSize) else {
            throw .truncated
        }
        // High-water-mark encoded.
        var highest: UInt32 = 0
        var triangles: [UInt32] = []
        triangles.reserveCapacity(triangleCount * 3)
        for _ in 0..<triangleCount * 3 {
            let code = wide ? try reader.uint32() : UInt32(try reader.uint16())
            guard code <= highest, highest - code < count else {
                throw .malformed
            }
            triangles.append(highest - code)
            if code == 0 {
                highest += 1
            }
        }
        self.triangles = triangles
        func edge() throws(DecodingError) -> [UInt32] {
            let edgeCount = Int(try reader.uint32())
            guard edgeCount <= reader.remaining / indexSize else {
                throw .truncated
            }
            var indices: [UInt32] = []
            indices.reserveCapacity(edgeCount)
            for _ in 0..<edgeCount {
                let index = wide ? try reader.uint32() : UInt32(try reader.uint16())
                guard index < count else {
                    throw .malformed
                }
                indices.append(index)
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
        for index in grid.triangles(near: x, y) {
            let triangle = Int(index)
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
    /// does not search them all. The buckets are one array, each cell's triangles
    /// in order: an array a cell took 19 MB for the 96 terrain tiles kept.
    struct TriangleGrid: Sendable {
        static let size = 32
        /// Where each cell's triangles start in `triangles`, and where the last ends.
        private var starts: [Int32]
        private var triangles: [Int32]

        init(_ mesh: QuantizedMesh) {
            // The cells each triangle covers, counted and then filled in.
            func covered(_ triangle: Int, _ body: (Int) -> Void) {
                let (a, b, c) = (Int(mesh.triangles[3 * triangle]), Int(mesh.triangles[3 * triangle + 1]), Int(mesh.triangles[3 * triangle + 2]))
                let (ua, ub, uc) = (mesh.u[a], mesh.u[b], mesh.u[c])
                let (va, vb, vc) = (mesh.v[a], mesh.v[b], mesh.v[c])
                for row in Self.cell(min(va, vb, vc))...Self.cell(max(va, vb, vc)) {
                    for column in Self.cell(min(ua, ub, uc))...Self.cell(max(ua, ub, uc)) {
                        body(row * Self.size + column)
                    }
                }
            }
            let triangleCount = mesh.triangles.count / 3
            var starts = [Int32](repeating: 0, count: Self.size * Self.size + 1)
            for triangle in 0..<triangleCount {
                covered(triangle) { starts[$0 + 1] += 1 }
            }
            for cell in 1..<starts.count {
                starts[cell] += starts[cell - 1]
            }
            var next = starts
            var triangles = [Int32](repeating: 0, count: Int(starts[starts.count - 1]))
            for triangle in 0..<triangleCount {
                covered(triangle) { cell in
                    triangles[Int(next[cell])] = Int32(triangle)
                    next[cell] += 1
                }
            }
            self.starts = starts
            self.triangles = triangles
        }

        private static func cell(_ value: Double) -> Int {
            min(max(Int(value * Double(size)), 0), size - 1)
        }

        func triangles(near u: Double, _ v: Double) -> ArraySlice<Int32> {
            let cell = Self.cell(v) * Self.size + Self.cell(u)
            return triangles[Int(starts[cell])..<Int(starts[cell + 1])]
        }
    }
}

/// Little-endian values read off a tile's bytes in turn. Loaded from an array:
/// copied out of the `Data` value by value, a tile took an iPad mini 5.3 ms.
private struct Reader {
    /// The tile, copied out of its `Data` once.
    let bytes: [UInt8]
    var offset = 0

    /// Reads `data` from its first byte.
    init(data: Data) {
        bytes = [UInt8](data)
    }

    var isAtEnd: Bool { offset >= bytes.count }
    var remaining: Int { bytes.count - offset }

    mutating func skip(_ count: Int) throws(QuantizedMesh.DecodingError) {
        guard offset + count <= bytes.count else {
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
        guard offset + size <= bytes.count else {
            throw .truncated
        }
        defer { offset += size }
        return bytes.littleEndian(at: offset)
    }

    mutating func uint8() throws(QuantizedMesh.DecodingError) -> UInt8 { try read(UInt8.self) }
    mutating func uint16() throws(QuantizedMesh.DecodingError) -> UInt16 { try read(UInt16.self) }
    mutating func uint32() throws(QuantizedMesh.DecodingError) -> UInt32 { try read(UInt32.self) }
    mutating func float() throws(QuantizedMesh.DecodingError) -> Float { Float(bitPattern: try read(UInt32.self)) }
}

extension [UInt8] {
    /// The little-endian integer at `offset`, which has to lie within the bytes.
    func littleEndian<T: FixedWidthInteger>(_: T.Type = T.self, at offset: Int) -> T {
        T(littleEndian: withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: T.self) })
    }
}

/// Re:Earth's terrain, as the web app asks for it: heights above the ellipsoid,
/// not the geoid, with normals and without the water mask, levels 0 to 14 on the
/// geographic scheme the surface uses.
enum Terrain {
    static let maximumLevel = 14
    static let contentType = "application/vnd.quantized-mesh"
    static let headers = ["Accept": "application/vnd.quantized-mesh;extensions=octvertexnormals,application/octet-stream;q=0.9,*/*;q=0.01"]

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
/// from. A class: copied out of the surface's table for every tile it lies under,
/// every frame, its ten arrays were retained and released each time.
final class TerrainSource: Sendable {
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

/// The terrain tiles as they load, each kept with the frame it was last wanted.
@MainActor
final class TerrainTiles {
    /// Terrain tiles kept decoded, about 30 MB, unless more are in use.
    private static let maximumTiles = 96

    private enum State {
        /// Retrying one that failed, which stands in for it meanwhile as it did.
        case loading(Task<TerrainSource?, Never>, retry: Bool)
        case ready(TerrainSource)
        case failed(at: Date)
    }

    private struct Entry {
        var state: State
        /// The frame it was last wanted.
        var wanted: Int
    }

    /// Fetches a tile's bytes: the app's tile fetcher, nil when it has none.
    var loader: (@Sendable (TileRequest) async -> Data?)?
    /// Counts the tiles that came in.
    private(set) var revision = 0
    /// Called when a tile came in or failed, and when a failed one may be asked
    /// for again.
    var onChange: @MainActor () -> Void = {}
    /// Seconds before a failed tile is asked for again.
    private let retryInterval: TimeInterval
    private var tiles: [TileKey: Entry] = [:]

    init(retryInterval: TimeInterval) {
        self.retryInterval = retryInterval
    }

    /// The terrain to lay a surface tile over, `offset` levels coarser
    /// (`Terrain.key`): its terrain tile, or while that is failing the nearest
    /// ancestor that loaded, or the ellipsoid where none has. Nil while the first
    /// try is under way.
    func source(under surfaceKey: TileKey, offset: Int, frame: Int) -> (key: TileKey?, source: TerrainSource?)? {
        let key = Terrain.key(forSurface: surfaceKey, offset: offset)
        tiles[key]?.wanted = frame
        switch tiles[key]?.state {
        case .ready(let source):
            return (key, source)
        case nil:
            request(key, retry: false, frame: frame)
            return nil
        case .loading(_, retry: false):
            return nil
        case .failed(let at):
            if Date().timeIntervalSince(at) > retryInterval {
                request(key, retry: true, frame: frame)
            }
        case .loading(_, retry: true):
            break
        }
        var ancestor = key.parent
        while let candidate = ancestor {
            if case .ready(let source) = tiles[candidate]?.state {
                tiles[candidate]?.wanted = frame
                return (candidate, source)
            }
            ancestor = candidate.parent
        }
        return (nil, nil)
    }

    /// The ground's height at a place, metres above the ellipsoid, from the finest
    /// tile loaded there; nil before any has.
    func height(_ place: GeoCoordinate) -> Double? {
        let latitude = place.latitude
        // Rows and columns become integers below, which traps on a coordinate far
        // out of range: nothing past the poles, and longitudes wrapped.
        guard latitude.isFinite, place.longitude.isFinite, abs(latitude) <= 90 else {
            return nil
        }
        let longitude = wrappedLongitude(place.longitude)
        for level in stride(from: Terrain.maximumLevel, through: 0, by: -1) {
            let row = Int(Projection.geographic.row(latitude: latitude, level: level))
            let column = Int(Projection.geographic.column(longitude: longitude, level: level))
            let key = TileKey(level: level, x: min(column, Projection.geographic.columns(level) - 1), y: min(row, Projection.geographic.rows(level) - 1))
            if case .ready(let source) = tiles[key]?.state {
                return source.sample(latitude: latitude, longitude: longitude).height
            }
        }
        return nil
    }

    private func request(_ key: TileKey, retry: Bool, frame: Int) {
        guard let loader, let url = Terrain.url(key) else {
            tiles[key] = Entry(state: .failed(at: Date()), wanted: frame)
            return
        }
        let work = Task.detached(priority: .utility) { () -> TerrainSource? in
            guard let data = await loader(TileRequest(url: url, contentType: Terrain.contentType, headers: Terrain.headers)), let mesh = try? QuantizedMesh(data) else {
                return nil
            }
            return TerrainSource(mesh: mesh, key: key)
        }
        tiles[key] = Entry(state: .loading(work, retry: retry), wanted: frame)
        Task {
            let source = await work.value
            // Dropped meanwhile, or asked for again.
            guard case .loading(let current, _) = tiles[key]?.state, current == work else {
                return
            }
            if let source {
                tiles[key]?.state = .ready(source)
                revision += 1
                onChange()
            } else {
                log.error("Terrain \(key, privacy: .public) unavailable")
                tiles[key]?.state = .failed(at: Date())
                onChange()
                // Asked for again by the first frame drawn once the retry interval
                // is up: with the clock stopped and the camera still, that frame
                // waits for this.
                try? await Task.sleep(for: .seconds(retryInterval))
                if case .failed = tiles[key]?.state {
                    onChange()
                }
            }
        }
    }

    /// Drops the tiles wanted longest ago past the budget, and cancels the
    /// requests for those nothing has wanted for a second, so that a zoom does not
    /// leave a queue of tiles flown past to be sent.
    func evict(frame: Int) {
        var ready: [(key: TileKey, wanted: Int)] = []
        for (key, entry) in tiles {
            switch entry.state {
            case .loading(let work, _) where entry.wanted < frame - 60:
                work.cancel()
                tiles[key] = nil
            case .ready:
                ready.append((key, entry.wanted))
            default:
                break
            }
        }
        if ready.count > Self.maximumTiles {
            // Never one this frame uses: the sky view lays 118, and dropping those
            // in use decoded them again, 44 a second on an iPad mini.
            let unused = ready.filter { $0.wanted < frame }
            for tile in unused.sorted(by: { $0.wanted < $1.wanted }).prefix(ready.count - Self.maximumTiles) {
                tiles[tile.key] = nil
            }
        }
    }

    /// Drops the loaded tiles `frame` did not want.
    func trim(frame: Int) {
        tiles = tiles.filter { _, entry in
            if case .ready = entry.state { entry.wanted >= frame } else { true }
        }
    }
}
