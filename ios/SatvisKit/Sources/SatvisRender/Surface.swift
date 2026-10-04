import CoreGraphics
import Foundation
import ImageIO
import Metal
import os
import simd

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

/// The globe's surface as a quadtree of geographic tiles, as CesiumJS draws it: two
/// root tiles, each refined into four while its geometric error would show as more
/// than two points on screen, skipped beyond the horizon and outside the view. A
/// tile is drawn with a texture of its own, 256 texels square, baked from the base
/// map's tiles (`Bake`): the shipped Natural Earth first, then whatever of the
/// base map has loaded, an ancestor standing in for a tile still on its way. So
/// the globe never waits on the network, and sharpens as tiles arrive.
@MainActor
final class Surface {
    static let textureSize = 256
    /// Tiles whose texture is kept: about 130 MB.
    private static let maximumTextures = 384
    /// Source tiles kept decoded for baking.
    private static let maximumSources = 64
    private static let bakesPerFrame = 12
    private static let maximumScreenSpaceError = 2.0
    /// CesiumJS's for an ellipsoid of 65-sample tiles, two at level 0.
    private static let levelZeroGeometricError = 6_378_137.0 * 2 * .pi * 0.25 / (65 * 2)

    final class Tile {
        let key: TileKey
        let bounds: Bounds
        let vertices: MTLBuffer
        /// The surface point nearest the tile's middle, and a sphere around it all.
        let centre: SIMD3<Double>
        let radius: Double
        /// Points on the tile for the horizon test: corners, edge middles, centre.
        let samples: [SIMD3<Double>]
        var texture: MTLTexture?
        /// Baked from all it asked for, or waiting on sources still loading.
        var isComplete = false
        var needsBake = true
        var lastUsed = 0

        init(key: TileKey, bounds: Bounds, vertices: MTLBuffer, centre: SIMD3<Double>, radius: Double, samples: [SIMD3<Double>]) {
            self.key = key
            self.bounds = bounds
            self.vertices = vertices
            self.centre = centre
            self.radius = radius
            self.samples = samples
        }
    }

    private enum Source {
        case loading
        case ready(MTLTexture, lastUsed: Int)
        case failed(at: Date)
    }

    /// Fetches a tile's bytes: the app's tile fetcher, nil when it has none.
    var loader: (@Sendable (URL, String) async -> Data?)?
    private(set) var layer = BaseLayer.naturalEarth
    private var source: ImagerySource
    private var site: URL

    private let device: MTLDevice
    private let bakePipeline: MTLRenderPipelineState
    private let indices: MTLBuffer
    let indexCount: Int
    private let sampler: MTLSamplerState
    private var tiles: [TileKey: Tile] = [:]
    private var sources: [TileKey: Source] = [:]
    private var frame = 0

    init(device: MTLDevice, library: MTLLibrary, site: URL) throws {
        self.device = device
        self.site = site
        source = BaseLayer.naturalEarth.source(site: site)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "bakeVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "bakeFragment")
        descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
        bakePipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        let grid = SurfaceMesh.indices()
        indices = grid.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
        indexCount = grid.count
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        sampler = device.makeSamplerState(descriptor: samplerDescriptor)!
    }

    var indexBuffer: MTLBuffer { indices }

    /// Changes the base map, and bakes every tile again, the nearest first.
    func setLayer(_ layer: BaseLayer, site: URL) {
        guard layer != self.layer || site != self.site else {
            return
        }
        self.layer = layer
        self.site = site
        source = layer.source(site: site)
        sources = [:]
        for tile in tiles.values {
            tile.needsBake = true
            tile.isComplete = false
        }
    }

    /// The tiles to draw this frame, each with a texture. A tile is refined only
    /// once its four children have one, so the globe never shows a hole.
    /// The screen-space error is in the drawing's own pixels, as CesiumJS measures
    /// it: a tile's texels are about its geometric error apart, so in points a
    /// texel would cover several pixels on a 3× screen.
    func select(eye: SIMD3<Double>, viewProjection: simd_double4x4, viewportHeightPixels: Double, verticalFieldOfView: Double) -> (draw: [Tile], bake: [Tile]) {
        frame += 1
        let planes = Self.planes(viewProjection)
        let eyeLatLon = geodetic(eye)
        let maximumLevel = max(source.maximumLevel + (source.tileSize == 512 && source.projection == .geographic ? 1 : 0), 6)
        let sseFactor = viewportHeightPixels / (2 * tan(verticalFieldOfView / 2))
        var draw: [Tile] = []
        var bake: [Tile] = []

        func visit(_ key: TileKey) {
            let tile = self.tile(key)
            tile.lastUsed = frame
            guard isVisible(tile, eye: eye, eyeLatLon: eyeLatLon, planes: planes) else {
                return
            }
            let nearest = nearestPoint(tile.bounds, to: eyeLatLon)
            let distance = max(simd.distance(eye, nearest), 1)
            let error = Self.levelZeroGeometricError / Double(1 << key.level) * sseFactor / distance
            if error > Self.maximumScreenSpaceError, key.level < maximumLevel {
                let children = key.children.map(self.tile)
                for child in children {
                    child.lastUsed = frame
                }
                if children.allSatisfy({ $0.texture != nil }) {
                    key.children.forEach(visit)
                    return
                }
                bake += children.filter { $0.texture == nil }
            }
            draw.append(tile)
            if tile.needsBake || tile.texture == nil {
                bake.append(tile)
            }
        }
        visit(TileKey(level: 0, x: 0, y: 0))
        visit(TileKey(level: 0, x: 1, y: 0))
        evict()
        return (draw, bake)
    }

    /// Bakes the tiles that need it, the most urgent first, a few a frame.
    func encodeBakes(_ tiles: [Tile], base: MTLTexture, commands: MTLCommandBuffer) {
        var baked: [MTLTexture] = []
        for tile in tiles.prefix(Self.bakesPerFrame) {
            guard let texture = tile.texture ?? makeTexture() else {
                continue
            }
            tile.texture = texture
            bake(tile, into: texture, base: base, commands: commands)
            baked.append(texture)
        }
        guard !baked.isEmpty, let blit = commands.makeBlitCommandEncoder() else {
            return
        }
        for texture in baked {
            blit.generateMipmaps(for: texture)
        }
        blit.endEncoding()
    }

    private func bake(_ tile: Tile, into texture: MTLTexture, base: MTLTexture, commands: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else {
            return
        }
        encoder.setRenderPipelineState(bakePipeline)
        encoder.setFragmentSamplerState(sampler, index: 0)
        func draw(_ texture: MTLTexture, bounds: Bounds, projection: Projection) {
            let strip = Bake.strip(surface: tile.bounds, source: bounds, projection: projection)
            strip.withUnsafeBytes { encoder.setVertexBytes($0.baseAddress!, length: $0.count, index: 0) }
            encoder.setFragmentTexture(texture, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: strip.count)
        }
        // The shipped Natural Earth under everything.
        draw(base, bounds: Bounds(west: -180, south: -90, east: 180, north: 90), projection: .geographic)
        var complete = true
        let level = source.level(forSurface: tile.key.level)
        // Natural Earth's shipped level is 2: nothing below 3 to fetch.
        if layer != .naturalEarth || level > 2 {
            for key in source.projection.covering(tile.bounds, level: level) {
                if case .ready(let texture, _) = sources[key] {
                    sources[key] = .ready(texture, lastUsed: frame)
                    draw(texture, bounds: source.projection.bounds(key), projection: source.projection)
                    continue
                }
                request(key)
                if case .loading = sources[key] {
                    complete = false
                }
                // Meanwhile the nearest ancestor that has loaded, if any.
                var ancestor = key.parent
                while let candidate = ancestor {
                    if case .ready(let texture, _) = sources[candidate] {
                        draw(texture, bounds: source.projection.bounds(candidate), projection: source.projection)
                        break
                    }
                    ancestor = candidate.parent
                }
            }
        }
        encoder.endEncoding()
        tile.needsBake = false
        tile.isComplete = complete
    }

    /// Starts loading a source tile, unless it is loading, loaded, or failed in the
    /// last minute.
    private func request(_ key: TileKey) {
        switch sources[key] {
        case .loading, .ready: return
        case .failed(let at) where Date().timeIntervalSince(at) < 60: return
        default: break
        }
        guard let loader, let url = source.url(key) else {
            sources[key] = .failed(at: Date())
            return
        }
        sources[key] = .loading
        let contentType = source.contentType
        let layer = layer
        let device = device
        Task {
            let texture = await Task.detached(priority: .utility) { () -> DecodedTile? in
                guard let data = await loader(url, contentType) else {
                    return nil
                }
                return Self.decode(data, device: device).map(DecodedTile.init)
            }.value?.texture
            // A tile of a base map no longer shown is dropped.
            guard layer == self.layer else {
                return
            }
            if texture == nil {
                log.error("Tile \(key, privacy: .public) of \(layer.rawValue, privacy: .public) unavailable")
            }
            sources[key] = texture.map { .ready($0, lastUsed: frame) } ?? .failed(at: Date())
            if texture != nil {
                markForBake(covering: key)
            }
        }
    }

    /// Tiles that wanted a source tile, or would draw it or one of its descendants.
    private func markForBake(covering key: TileKey) {
        let bounds = source.projection.bounds(key)
        for tile in tiles.values where !tile.isComplete && overlaps(tile.bounds, bounds) {
            tile.needsBake = true
        }
    }

    private func overlaps(_ a: Bounds, _ b: Bounds) -> Bool {
        a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north
    }

    nonisolated private static func decode(_ data: Data, device: MTLDevice) -> MTLTexture? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return nil
        }
        let bitmap = Bitmap(width: image.width, height: image.height, alpha: true) { context in
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: bitmap.width, height: bitmap.height, mipmapped: false)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        bitmap.bytes.withUnsafeBytes {
            texture.replace(region: MTLRegionMake2D(0, 0, bitmap.width, bitmap.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: bitmap.width * 4)
        }
        return texture
    }

    private func makeTexture() -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: Self.textureSize, height: Self.textureSize, mipmapped: true)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        return device.makeTexture(descriptor: descriptor)
    }

    private func tile(_ key: TileKey) -> Tile {
        if let tile = tiles[key] {
            return tile
        }
        let bounds = Projection.geographic.bounds(key)
        let mesh = SurfaceMesh(bounds: bounds, level: key.level)
        let buffer = mesh.vertices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
        let tile = Tile(key: key, bounds: bounds, vertices: buffer, centre: mesh.centre, radius: mesh.radius, samples: mesh.samples)
        tiles[key] = tile
        return tile
    }

    /// Drops the textures, then the tiles, used longest ago, past the budgets. The
    /// roots stay.
    private func evict() {
        let textured = tiles.values.filter { $0.texture != nil && $0.key.level > 0 }
        if textured.count > Self.maximumTextures {
            for tile in textured.sorted(by: { $0.lastUsed < $1.lastUsed }).prefix(textured.count - Self.maximumTextures) {
                tile.texture = nil
                tile.needsBake = true
                tile.isComplete = false
            }
        }
        if tiles.count > 4 * Self.maximumTextures {
            for tile in tiles.values.filter({ $0.texture == nil && $0.lastUsed < frame - 60 }) {
                tiles[tile.key] = nil
            }
        }
        let ready = sources.compactMap { key, state -> (TileKey, Int)? in
            if case .ready(_, let used) = state { (key, used) } else { nil }
        }
        if ready.count > Self.maximumSources {
            for (key, _) in ready.sorted(by: { $0.1 < $1.1 }).prefix(ready.count - Self.maximumSources) {
                sources[key] = nil
            }
        }
    }

    // MARK: Culling

    /// The four side planes of the view frustum, from its matrix: a point is inside
    /// where each is positive. Reversed-Z with no far plane leaves no far one, and
    /// the near one never culls a tile on the globe.
    private static func planes(_ m: simd_double4x4) -> [SIMD4<Double>] {
        let rows = (0..<4).map { row in SIMD4(m.columns.0[row], m.columns.1[row], m.columns.2[row], m.columns.3[row]) }
        return [rows[3] + rows[0], rows[3] - rows[0], rows[3] + rows[1], rows[3] - rows[1]].map { $0 / length(SIMD3($0.x, $0.y, $0.z)) }
    }

    private func isVisible(_ tile: Tile, eye: SIMD3<Double>, eyeLatLon: (latitude: Double, longitude: Double), planes: [SIMD4<Double>]) -> Bool {
        for plane in planes where dot(SIMD3(plane.x, plane.y, plane.z), tile.centre - eye) + plane.w < -tile.radius {
            return false
        }
        // Over the horizon when every sample, and the point nearest the eye, are:
        // a point on a sphere is in sight from outside where its dot with the eye
        // reaches its own length squared.
        let nearest = nearestPoint(tile.bounds, to: eyeLatLon)
        return (tile.samples + [nearest]).contains { dot($0, eye) > length_squared($0) * 0.9995 }
    }

    /// The point of a tile nearest below the eye, near enough: its latitude and
    /// longitude clamped into the tile.
    private func nearestPoint(_ bounds: Bounds, to eye: (latitude: Double, longitude: Double)) -> SIMD3<Double> {
        fixedPosition(latitude: min(max(eye.latitude, bounds.south), bounds.north), longitude: min(max(eye.longitude, bounds.west), bounds.east))
    }
}

/// A source tile decoded off the main thread: finished before it is handed over,
/// and not written again.
private struct DecodedTile: @unchecked Sendable {
    let texture: MTLTexture
}

/// A surface tile's mesh: 16 by 16 quads on the ellipsoid, with a skirt hanging
/// below its edges to hide the cracks where it meets a coarser neighbour.
struct SurfaceMesh {
    static let size = 16

    var vertices: [GlobeVertex]
    var centre: SIMD3<Double>
    var radius: Double
    var samples: [SIMD3<Double>]

    init(bounds: Bounds, level: Int) {
        let n = Self.size
        // Deep enough to cover the sag of a chord of a neighbour a level or two coarser.
        let segment = (bounds.east - bounds.west) * .pi / 180 * 6_371_000 / Double(n)
        let skirt = 4 * segment * segment / (8 * 6_371_000) + 10
        centre = fixedPosition(latitude: (bounds.south + bounds.north) / 2, longitude: (bounds.west + bounds.east) / 2)
        var vertices: [GlobeVertex] = []
        var points: [SIMD3<Double>] = []
        for row in 0...n {
            for column in 0...n {
                let (vertex, position) = Self.vertex(bounds, row: row, column: column, depth: 0)
                vertices.append(vertex)
                points.append(position)
            }
        }
        // The skirt: the edge again, lowered, in order around the tile.
        for edge in Self.edge {
            vertices.append(Self.vertex(bounds, row: edge.row, column: edge.column, depth: skirt).0)
        }
        self.vertices = vertices
        let centre = centre
        radius = points.map { simd.distance($0, centre) }.max() ?? 0
        samples = [(0, 0), (0, n / 2), (0, n), (n / 2, 0), (n / 2, n / 2), (n / 2, n), (n, 0), (n, n / 2), (n, n)].map { points[$0.0 * (n + 1) + $0.1] }
    }

    /// A grid point of a tile, `depth` metres below the ellipsoid.
    private static func vertex(_ bounds: Bounds, row: Int, column: Int, depth: Double) -> (GlobeVertex, SIMD3<Double>) {
        let u = Double(column) / Double(size)
        let v = Double(row) / Double(size)
        let latitude = bounds.north - v * (bounds.north - bounds.south)
        let longitude = bounds.west + u * (bounds.east - bounds.west)
        let phi = latitude * .pi / 180
        let lambda = longitude * .pi / 180
        let normal = SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
        let position = fixedPosition(latitude: latitude, longitude: longitude) - depth * normal
        let (high, low) = encode(position)
        return (GlobeVertex(high: high, low: low, normal: SIMD3<Float>(normal), uv: SIMD2(Float(u), Float(v))), position)
    }

    /// The edge vertices around a tile, starting at its north-west corner.
    static let edge: [(row: Int, column: Int)] = {
        let n = size
        return (0..<n).map { (0, $0) } + (0..<n).map { ($0, n) } + (0..<n).map { (n, n - $0) } + (0..<n).map { (n - $0, 0) }
    }()

    /// Triangles for every tile's grid and skirt, wound counter-clockwise from
    /// outside.
    static func indices() -> [UInt32] {
        let n = UInt32(size)
        let stride = n + 1
        var indices: [UInt32] = []
        for row in 0..<n {
            for column in 0..<n {
                let a = row * stride + column
                let b = a + stride
                indices += [a, b, a + 1, a + 1, b, b + 1]
            }
        }
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
