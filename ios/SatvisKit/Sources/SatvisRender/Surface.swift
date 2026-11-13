import CoreGraphics
import Foundation
import ImageIO
import Metal
import SatvisCore
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
    /// Source tiles kept decoded for baking, the base map's and each overlay's,
    /// besides an overlay's stand-ins (`isStandIn`).
    nonisolated private static let maximumSources = 64
    private static let bakesPerFrame = 12
    /// Terrain tiles kept decoded, about 30 MB, unless more are in use.
    private static let maximumTerrainTiles = 96
    /// Tiles laid over the terrain a frame, a few hundred lookups each.
    private static let drapesPerFrame = 16
    /// Seconds before a failed imagery or terrain tile is asked for again.
    private static let retryInterval: TimeInterval = 60
    /// Seconds a frame still loading holds off a newer one: the web's `MAX_LOAD_MS`.
    private static let frameWait: TimeInterval = 20
    private static let maximumScreenSpaceError = 2.0
    /// Counts the terrain tiles that came in and the terrain turned on or off,
    /// for what is worked out from the ground to know it is out of date.
    private(set) var terrainRevision = 0
    /// Counts the imagery and terrain tiles that came in or failed: a frame drawn
    /// before one may no longer be what the surface would draw.
    private(set) var revision = 0
    /// Whether the last selection left nothing to bake or lay over the terrain,
    /// so that the next frame would draw the same tiles until `revision` moves.
    private(set) var isSettled = false
    /// CesiumJS's for an ellipsoid of 65-sample tiles, two at level 0.
    private static let levelZeroGeometricError = 6_378_137.0 * 2 * .pi * 0.25 / (65 * 2)

    final class Tile {
        let key: TileKey
        let bounds: Bounds
        let vertices: MTLBuffer
        /// The surface point nearest the tile's middle, and a sphere around it all,
        /// grown to take in its terrain once laid over it.
        let centre: SIMD3<Double>
        var radius: Double
        /// Points on the tile for the horizon test: corners, edge middles, centre.
        let samples: [SIMD3<Double>]
        var texture: MTLTexture?
        /// Baked from all it asked for, or waiting on sources still loading or
        /// failed.
        var isComplete = false
        /// The maps its texture was baked from, as `generation` counts them: a
        /// parent must not stand in under another base map, or an overlay since
        /// switched off.
        var generation = -1
        var needsBake = true
        var lastUsed = 0
        /// The frame it was last drawn or waiting for its first bake: unlike
        /// `lastUsed`, not a refined tile's, which no longer draws from its sources.
        var lastWanted = 0
        /// The tile's grid laid over the terrain, and the terrain tile it was laid
        /// over: nil for the ellipsoid, where no terrain has loaded.
        var draped: (vertices: MTLBuffer, over: TileKey?)?

        init(key: TileKey, bounds: Bounds, vertices: MTLBuffer, centre: SIMD3<Double>, radius: Double, samples: [SIMD3<Double>]) {
            self.key = key
            self.bounds = bounds
            self.vertices = vertices
            self.centre = centre
            self.radius = radius
            self.samples = samples
        }
    }

    private enum TerrainTile {
        /// Retrying one that failed, which stands in for it meanwhile as it did.
        case loading(Task<TerrainSource?, Never>, retry: Bool)
        case ready(TerrainSource)
        case failed(at: Date)
    }

    private enum Source {
        case loading(Task<DecodedTile?, Never>)
        case ready(MTLTexture, lastUsed: Int)
        case failed(at: Date)
    }

    /// The source tiles of one map as they load: the base map's, or an overlay's at
    /// its frame. A tile asked for before the map changed is dropped when it arrives,
    /// as one cancelled is.
    private final class SourceTiles {
        var source: ImagerySource
        /// Names the map in the log.
        var name: String
        var tiles: [TileKey: Source] = [:]
        /// Whether its stand-ins are kept past the budget (`isStandIn`): an overlay's.
        let keepsStandIns: Bool

        init(_ source: ImagerySource, name: String, keepsStandIns: Bool) {
            self.source = source
            self.name = name
            self.keepsStandIns = keepsStandIns
        }

        /// Cancels what is on its way and forgets every tile.
        func clear() {
            for case .loading(let work) in tiles.values {
                work.cancel()
            }
            tiles = [:]
        }
    }

    /// Fetches a tile's bytes: the app's tile fetcher, nil when it has none.
    var loader: (@Sendable (TileRequest) async -> Data?)?
    private(set) var layer = BaseLayer.naturalEarth
    /// A daily layer's day.
    private(set) var day: String?
    /// Counts the changes of base map, day or overlays, for `Tile.generation`.
    private var generation = 0
    /// Whether the surface follows Re:Earth's terrain or the ellipsoid.
    private(set) var terrainEnabled = false
    private let baseMap: SourceTiles
    private var site: URL

    private let device: MTLDevice
    private let bakePipeline: MTLRenderPipelineState
    /// The triangles of every tile, whose vertices are `vertices(_:)`.
    let indexBuffer: MTLBuffer
    let indexCount: Int
    private let sampler: MTLSamplerState
    private var tiles: [TileKey: Tile] = [:]
    /// The tiles past the roots that hold a texture.
    private var texturedTiles = 0
    /// The instrument imagery over the base map, the last on top.
    private var overlays: [Overlay] = []
    private var terrainTiles: [TileKey: TerrainTile] = [:]
    /// When each terrain tile was last wanted, by frame.
    private var terrainUsed: [TileKey: Int] = [:]
    private var terrainOffset = 0
    private var drapes = 0
    private var frame = 0
    /// What the last settled selection was made from, and what it chose: the
    /// same again while none of it moves. Walking some 1,300 tiles took the sky
    /// view 3 ms of an iPad mini's main thread a frame, standing still.
    private var lastSelection: (inputs: SelectionInputs, draw: [Tile])?

    private struct SelectionInputs: Equatable {
        var eye: SIMD3<Double>
        var viewProjection: simd_double4x4
        var viewportHeightPixels: Double
        var verticalFieldOfView: Double
        var pixelsPerPoint: Double
        var revision: Int
        var generation: Int
        var terrainEnabled: Bool
    }

    init(device: MTLDevice, library: MTLLibrary, site: URL) throws {
        self.device = device
        self.site = site
        baseMap = SourceTiles(BaseLayer.naturalEarth.source(site: site), name: BaseLayer.naturalEarth.rawValue, keepsStandIns: false)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "bakeVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "bakeFragment")
        descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
        bakePipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        let grid = SurfaceMesh.indices()
        indexBuffer = device.makeBuffer(copying: grid)!
        indexCount = grid.count
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        sampler = device.makeSamplerState(descriptor: samplerDescriptor)!
    }

    /// Changes the base map, or a daily one's day, and bakes every tile again, the
    /// nearest first.
    func setLayer(_ layer: BaseLayer, site: URL, frame: String? = nil) {
        guard layer != self.layer || site != self.site || frame != day else {
            return
        }
        self.layer = layer
        self.site = site
        day = frame
        generation += 1
        baseMap.clear()
        baseMap.source = layer.source(site: site, frame: frame)
        baseMap.name = layer.rawValue
        for tile in tiles.values {
            tile.needsBake = true
            tile.isComplete = false
        }
    }

    /// An instrument's layer over the base map, and the tiles of its frame.
    private final class Overlay {
        var imagery: ImageryOverlay
        let sources: SourceTiles
        /// The last frame's tiles, drawn where this frame's have not come yet, so that
        /// a frame change does not show the base map meanwhile.
        var previous: [TileKey: MTLTexture] = [:]
        /// The frame asked for while this one was loading, shown once it has.
        var next: ImageryOverlay?
        /// When this frame was first shown.
        var since = Date()

        init(_ imagery: ImageryOverlay) {
            self.imagery = imagery
            sources = SourceTiles(imagery.source, name: imagery.layer.token, keepsStandIns: true)
        }

        var limits: Bounds? {
            imagery.bounds.flatMap { $0.count == 4 ? Bounds(west: $0[0], south: $0[1], east: $0[2], north: $0[3]) : nil }
        }

        /// Whether any of this frame's tiles is on its way.
        var isLoading: Bool {
            sources.tiles.values.contains { if case .loading = $0 { true } else { false } }
        }

        /// Shows `next`, keeping this frame's tiles until its own come.
        func showNext() {
            guard let next else {
                return
            }
            for case (let key, .ready(let texture, _)) in sources.tiles {
                previous[key] = texture
            }
            // The tiles of the frames before last: what is left of them is coarse.
            if previous.count > Surface.maximumSources {
                previous = previous.filter { key, _ in sources.tiles[key] != nil }
            }
            sources.clear()
            sources.source = next.source
            imagery = next
            self.next = nil
            since = Date()
        }
    }

    /// Lays `imagery` over the base map, in order, the last on top, and bakes every tile
    /// again. A layer at a new frame keeps its last frame's tiles until the new ones
    /// come, and one whose frame is still loading finishes it first (`showNextFrames`):
    /// a clock faster than the service skips frames, as on the web, rather than
    /// cancelling each before it arrives.
    func setOverlays(_ imagery: [ImageryOverlay]) {
        guard imagery != overlays.map({ $0.next ?? $0.imagery }) else {
            return
        }
        let layersChanged = imagery.map(\.layer.token) != overlays.map(\.imagery.layer.token)
        let kept = Dictionary(overlays.map { ($0.imagery.layer.token, $0) }) { first, _ in first }
        overlays = imagery.map { wanted in
            guard let overlay = kept[wanted.layer.token] else {
                return Overlay(wanted)
            }
            overlay.next = wanted == overlay.imagery ? nil : wanted
            return overlay
        }
        for old in kept.values where !overlays.contains(where: { $0 === old }) {
            old.sources.clear()
        }
        if showNextFrames() || layersChanged {
            bakeAgain()
        }
    }

    /// Moves each overlay to the frame it was last asked for, once its own has loaded
    /// or has had `frameWait`. Whether any moved.
    private func showNextFrames() -> Bool {
        var moved = false
        for overlay in overlays where overlay.next != nil && (!overlay.isLoading || Date().timeIntervalSince(overlay.since) >= Self.frameWait) {
            overlay.showNext()
            moved = true
        }
        return moved
    }

    /// Bakes every tile again, for a change of what is laid over them.
    private func bakeAgain() {
        generation += 1
        for tile in tiles.values {
            tile.needsBake = true
            tile.isComplete = false
        }
        revision += 1
    }

    /// Turns the terrain on or off. Loaded terrain is kept for turning it on again.
    func setTerrain(_ enabled: Bool) {
        if enabled != terrainEnabled {
            terrainEnabled = enabled
            terrainRevision += 1
        }
    }

    /// What to draw a tile with: laid over the terrain where that is on, else on the
    /// ellipsoid. Either way with `indexBuffer`.
    func vertices(_ tile: Tile) -> MTLBuffer {
        terrainEnabled ? tile.draped?.vertices ?? tile.vertices : tile.vertices
    }

    /// The finest level the imagery is refined to.
    private var imageryMaximumLevel: Int {
        allSources.map { $0.source.maximumLevel + ($0.source.tileSize == 512 && $0.source.projection == .geographic ? 1 : 0) }.reduce(6, max)
    }

    /// The tiles to draw this frame, each with a texture. A tile is refined only
    /// once its four children have one, so the globe never shows a hole.
    /// The screen-space error is in the drawing's own pixels, as CesiumJS measures
    /// it: a tile's texels are about its geometric error apart, so in points a
    /// texel would cover several pixels on a 3× screen.
    func select(eye: SIMD3<Double>, viewProjection: simd_double4x4, viewportHeightPixels: Double, verticalFieldOfView: Double, pixelsPerPoint: Double) -> (
        draw: [Tile], bake: [Tile]
    ) {
        let inputs = SelectionInputs(
            eye: eye, viewProjection: viewProjection, viewportHeightPixels: viewportHeightPixels, verticalFieldOfView: verticalFieldOfView,
            pixelsPerPoint: pixelsPerPoint, revision: revision, generation: generation, terrainEnabled: terrainEnabled)
        // Without a new frame: the tiles chosen last stay in use for `evict`.
        if let lastSelection, lastSelection.inputs == inputs {
            return (lastSelection.draw, [])
        }
        frame += 1
        drapes = 0
        terrainOffset = Terrain.offset(pixelsPerPoint: pixelsPerPoint)
        let planes = Self.planes(viewProjection)
        let eyeLatLon = geodetic(eye)
        // With terrain, as fine as the terrain goes, whatever the imagery does: the
        // ground's grid is the surface tile's, and stopped where Natural Earth
        // stops, at level 6, it laid level-4 terrain under the sky view, a grid
        // 20 km apart that leaves a valley a plain. Past its own finest level
        // the imagery is drawn magnified from it.
        let maximumLevel = terrainEnabled ? max(imageryMaximumLevel, Terrain.maximumLevel + terrainOffset) : imageryMaximumLevel
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
                // Asked of each child, so each starts loading its terrain.
                guard let waiting = refine(key, ready: { hasGeometry($0) && $0.texture != nil }, visit: visit) else {
                    return
                }
                bake += waiting
            }
            _ = hasGeometry(tile)
            draw.append(tile)
            if tile.needsBake || tile.texture == nil {
                bake.append(tile)
            }
        }
        visit(TileKey(level: 0, x: 0, y: 0))
        visit(TileKey(level: 0, x: 1, y: 0))
        for tile in draw + bake {
            tile.lastWanted = frame
        }
        evict()
        isSettled = bake.isEmpty && drapes < Self.drapesPerFrame
        lastSelection = isSettled ? (inputs, draw) : nil
        return (draw, bake)
    }

    /// The tiles to draw the flat map with this frame, from `map` on a view of
    /// `viewportPixels`, each with a texture: those the view's bounds overlap in
    /// any copy of the map, refined while their geometric error spans more than
    /// two pixels, which on the map is the same at every distance (CesiumJS's
    /// screen-space error in 2D). Flat, as CesiumJS's 2D is, so no terrain is
    /// asked for. As `select`, a tile is refined only once its four children have
    /// a texture.
    func selectMap(_ map: MapCamera, viewportPixels: SIMD2<Double>) -> (draw: [Tile], bake: [Tile]) {
        let aspectRatio = viewportPixels.x / viewportPixels.y
        let inputs = SelectionInputs(
            eye: SIMD3(map.longitude, map.latitude, map.span), viewProjection: map.viewProjection(aspectRatio: aspectRatio),
            viewportHeightPixels: viewportPixels.y, verticalFieldOfView: -1, pixelsPerPoint: 0, revision: revision, generation: generation,
            terrainEnabled: false)
        if let lastSelection, lastSelection.inputs == inputs {
            return (lastSelection.draw, [])
        }
        frame += 1
        let maximumLevel = imageryMaximumLevel
        let metresPerPixel = map.span / max(viewportPixels.x, viewportPixels.y)
        let half = map.boundingHalfExtent(aspectRatio: aspectRatio)
        var draw: [Tile] = []
        var bake: [Tile] = []

        func visit(_ key: TileKey) {
            let tile = self.tile(key)
            tile.lastUsed = frame
            let (corner, size) = map.rectangle(of: tile.bounds)
            guard corner.y >= -half.y, corner.y - size.y <= half.y,
                !Self.mapCopies(west: corner.x, width: size.x, map: map, aspectRatio: aspectRatio).isEmpty
            else {
                return
            }
            let error = Self.levelZeroGeometricError / Double(1 << key.level) / metresPerPixel
            if error > Self.maximumScreenSpaceError, key.level < maximumLevel {
                guard let waiting = refine(key, ready: { $0.texture != nil }, visit: visit) else {
                    return
                }
                bake += waiting
            }
            draw.append(tile)
            if tile.needsBake || tile.texture == nil {
                bake.append(tile)
            }
        }
        visit(TileKey(level: 0, x: 0, y: 0))
        visit(TileKey(level: 0, x: 1, y: 0))
        for tile in draw + bake {
            tile.lastWanted = frame
        }
        evict()
        isSettled = bake.isEmpty
        lastSelection = isSettled ? (inputs, draw) : nil
        return (draw, bake)
    }

    /// Refines the tile at `key` into its four children once each is `ready`,
    /// visiting them; nil then. Else the children that still need a texture, the
    /// tile itself drawn meanwhile. Every child is asked, whatever the others
    /// answer, as asking starts what it waits for.
    private func refine(_ key: TileKey, ready: (Tile) -> Bool, visit: (TileKey) -> Void) -> [Tile]? {
        // Loops: a main-actor method passed to `map` checks its executor at every call.
        var children: [Tile] = []
        var allReady = true
        for childKey in key.children {
            let child = tile(childKey)
            child.lastUsed = frame
            let childReady = ready(child)
            allReady = allReady && childReady
            children.append(child)
        }
        if allReady {
            for child in children {
                visit(child.key)
            }
            return nil
        }
        return children.filter { $0.texture == nil }
    }

    /// Which copies of a tile the view takes in, as whole maps east (positive) or
    /// west of the copy whose west edge, `west` metres east of the view's centre,
    /// is nearest it; `width` is the tile's, in metres. The view never spans more
    /// than a map (`MapCamera.maximumSpan`), so at most two.
    static func mapCopies(west: Double, width: Double, map: MapCamera, aspectRatio: Double) -> [Int] {
        let half = map.boundingHalfExtent(aspectRatio: aspectRatio).x
        return (-1...1).filter { copy in
            let start = west + Double(copy) * MapCamera.mapWidth
            return start <= half && start + width >= -half
        }
    }

    /// Whether a tile has what it needs to be drawn on the terrain, asking for it
    /// when not. Once laid over the terrain, a tile keeps its grid until a better
    /// terrain tile is in.
    private func hasGeometry(_ tile: Tile) -> Bool {
        guard terrainEnabled else {
            return true
        }
        guard let terrain = terrain(under: tile.key) else {
            return tile.draped != nil
        }
        if let draped = tile.draped, draped.over == terrain.key {
            return true
        }
        guard drapes < Self.drapesPerFrame else {
            return tile.draped != nil
        }
        drapes += 1
        let mesh = SurfaceMesh(
            bounds: tile.bounds, level: tile.key.level,
            terrain: terrain.source.map { source in
                (source.sample, Terrain.skirtHeight(level: terrain.key?.level ?? 0))
            })
        guard let vertices = device.makeBuffer(copying: mesh.vertices) else {
            return tile.draped != nil
        }
        tile.draped = (vertices, terrain.key)
        tile.radius = max(tile.radius, mesh.radius)
        return true
    }

    /// The terrain to lay a surface tile over: its terrain tile, or while that is
    /// failing the nearest ancestor that loaded, or the ellipsoid where none has.
    /// Nil while the first try is under way.
    private func terrain(under key: TileKey) -> (key: TileKey?, source: TerrainSource?)? {
        let key = Terrain.key(forSurface: key, offset: terrainOffset)
        terrainUsed[key] = frame
        switch terrainTiles[key] {
        case .ready(let source):
            return (key, source)
        case nil:
            requestTerrain(key, retry: false)
            return nil
        case .loading(_, retry: false):
            return nil
        case .failed(let at):
            if Date().timeIntervalSince(at) > Self.retryInterval {
                requestTerrain(key, retry: true)
            }
        case .loading(_, retry: true):
            break
        }
        var ancestor = key.parent
        while let candidate = ancestor {
            if case .ready(let source) = terrainTiles[candidate] {
                terrainUsed[candidate] = frame
                return (candidate, source)
            }
            ancestor = candidate.parent
        }
        return (nil, nil)
    }

    /// The ground's height at a place, metres above the ellipsoid, from the finest
    /// terrain tile loaded there; nil before any has. 0 with the terrain off.
    func groundHeight(_ place: GeoCoordinate) -> Double? {
        guard terrainEnabled else {
            return 0
        }
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
            if case .ready(let source) = terrainTiles[key] {
                return source.sample(latitude: latitude, longitude: longitude).height
            }
        }
        return nil
    }

    private func requestTerrain(_ key: TileKey, retry: Bool) {
        guard let loader, let url = Terrain.url(key) else {
            terrainTiles[key] = .failed(at: Date())
            return
        }
        let work = Task.detached(priority: .utility) { () -> TerrainSource? in
            guard let data = await loader(TileRequest(url: url, contentType: Terrain.contentType, headers: Terrain.headers)), let mesh = try? QuantizedMesh(data) else {
                return nil
            }
            return TerrainSource(mesh: mesh, key: key)
        }
        terrainTiles[key] = .loading(work, retry: retry)
        Task {
            let source = await work.value
            // Dropped meanwhile, or asked for again.
            guard case .loading(let current, _) = terrainTiles[key], current == work else {
                return
            }
            revision += 1
            if let source {
                terrainTiles[key] = .ready(source)
                terrainRevision += 1
            } else {
                log.error("Terrain \(key, privacy: .public) unavailable")
                terrainTiles[key] = .failed(at: Date())
                // Asked for again by the first frame drawn once the retry interval
                // is up: with the clock stopped and the camera still, that frame
                // waits for this.
                try? await Task.sleep(for: .seconds(Self.retryInterval))
                if case .failed = terrainTiles[key] {
                    revision += 1
                }
            }
        }
    }

    /// Bakes the tiles that need it, the most urgent first, a few a frame.
    func encodeBakes(_ tiles: [Tile], base: MTLTexture, commands: MTLCommandBuffer) {
        var baked: [MTLTexture] = []
        for tile in tiles.prefix(Self.bakesPerFrame) {
            guard let texture = tile.texture ?? makeTexture() else {
                continue
            }
            if tile.texture == nil, tile.key.level > 0 {
                texturedTiles += 1
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
        // Then the parent's texture, what was drawn here until now, so refining
        // never shows less. The sky view's hundreds of tiles evict the source
        // ancestors, which left a tile with a sharp parent flat green, Natural
        // Earth's level 2, until its own source came.
        let parent = tile.key.parent.flatMap { tiles[$0] }.flatMap { $0.generation == generation ? $0 : nil }
        if let parent, let texture = parent.texture {
            draw(texture, bounds: parent.bounds, projection: .geographic)
        }
        var complete = true
        let level = baseMap.source.level(forSurface: tile.key.level)
        // Natural Earth's shipped level is 2: nothing below 3 to fetch. A complete
        // parent is as sharp as any ancestor.
        if layer != .naturalEarth || level > 2, !lay(baseMap, over: tile.bounds, level: level, standIns: parent?.isComplete != true, draw: draw) {
            complete = false
        }
        for overlay in overlays {
            var area = tile.bounds
            if let limits = overlay.limits {
                area = Bounds(
                    west: max(area.west, limits.west), south: max(area.south, limits.south), east: min(area.east, limits.east), north: min(area.north, limits.north))
                guard area.west < area.east, area.south < area.north else {
                    continue
                }
            }
            if !lay(overlay.sources, over: area, level: overlay.sources.source.level(forSurface: tile.key.level), previous: overlay.previous, draw: draw) {
                complete = false
            }
        }
        encoder.endEncoding()
        tile.needsBake = false
        tile.isComplete = complete
        tile.generation = generation
    }

    /// Draws `sources`' tiles at `level` over `area` with `draw`, asking for those it
    /// lacks and drawing meanwhile `previous`'s, or else the nearest ancestor that
    /// has loaded, unless told no `standIns`. False while any is missing.
    private func lay(
        _ sources: SourceTiles, over area: Bounds, level: Int, previous: [TileKey: MTLTexture] = [:], standIns: Bool = true,
        draw: (MTLTexture, Bounds, Projection) -> Void
    ) -> Bool {
        let projection = sources.source.projection
        var complete = true
        for key in projection.covering(area, level: level) {
            if case .ready(let texture, _) = sources.tiles[key] {
                sources.tiles[key] = .ready(texture, lastUsed: frame)
                draw(texture, projection.bounds(key), projection)
                continue
            }
            request(key, of: sources)
            complete = false
            guard standIns else {
                continue
            }
            if let texture = previous[key] {
                draw(texture, projection.bounds(key), projection)
                continue
            }
            var ancestor = key.parent
            while let candidate = ancestor {
                if case .ready(let texture, _) = sources.tiles[candidate] {
                    // In use, as a stand-in: evicted, the tile baked again while its
                    // own source is still missing would have none.
                    sources.tiles[candidate] = .ready(texture, lastUsed: frame)
                    draw(texture, projection.bounds(candidate), projection)
                    break
                }
                if let texture = previous[candidate] {
                    draw(texture, projection.bounds(candidate), projection)
                    break
                }
                ancestor = candidate.parent
            }
        }
        return complete
    }

    /// Starts loading a source tile, unless it is loading, loaded, or failed in the
    /// last minute.
    private func request(_ key: TileKey, of sources: SourceTiles) {
        switch sources.tiles[key] {
        case .loading, .ready: return
        case .failed(let at) where Date().timeIntervalSince(at) < Self.retryInterval: return
        default: break
        }
        guard let loader, let url = sources.source.url(key) else {
            sources.tiles[key] = .failed(at: Date())
            return
        }
        let request = TileRequest(url: url, contentType: sources.source.contentType, headers: [:], keeps: sources.source.keeps)
        let device = device
        let work = Task.detached(priority: .utility) { () -> DecodedTile? in
            guard let data = await loader(request) else {
                return nil
            }
            return Self.decode(data, device: device).map(DecodedTile.init)
        }
        sources.tiles[key] = .loading(work)
        let bounds = sources.source.projection.bounds(key)
        Task {
            let texture = await work.value?.texture
            // Dropped once cancelled, as flown past or of a map no longer shown.
            guard case .loading(let current) = sources.tiles[key], current == work else {
                return
            }
            if texture == nil {
                log.error("Tile \(key, privacy: .public) of \(sources.name, privacy: .public) unavailable")
            }
            sources.tiles[key] = texture.map { .ready($0, lastUsed: frame) } ?? .failed(at: Date())
            revision += 1
            markForBake(covering: bounds)
            if showNextFrames() {
                bakeAgain()
            }
            guard texture == nil else {
                return
            }
            // Asked for again once the retry interval is up, by baking again the
            // tiles still missing it: nothing else would, and they would keep their
            // stand-ins after the network came back.
            try? await Task.sleep(for: .seconds(Self.retryInterval))
            guard case .failed = sources.tiles[key] else {
                return
            }
            markForBake(covering: bounds)
            revision += 1
        }
    }

    /// Tiles that wanted a source tile, or would draw it or one of its descendants.
    private func markForBake(covering bounds: Bounds) {
        for tile in tiles.values where !tile.isComplete && overlaps(tile.bounds, bounds) {
            tile.needsBake = true
        }
    }

    private func overlaps(_ a: Bounds, _ b: Bounds) -> Bool {
        Self.overlaps(a, b)
    }

    nonisolated private static func overlaps(_ a: Bounds, _ b: Bounds) -> Bool {
        a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north
    }

    /// Whether a surface tile at one of `tiles` draws from `source`'s tile at `key`:
    /// one it covers, at the level it asks for. A coarser tile under a finer one
    /// is not: kept for every level zoomed through, EUMETView's, 4 to 5 s each,
    /// took a minute to clear ahead of the tiles in view.
    nonisolated static func isWanted(_ key: TileKey, of source: ImagerySource, by tiles: [TileKey]) -> Bool {
        let bounds = source.projection.bounds(key)
        return tiles.contains { tile in
            source.level(forSurface: tile.level) == key.level && overlaps(Projection.geographic.bounds(tile), bounds)
        }
    }

    /// Whether an overlay's tile at `key` is one the whole globe is drawn from, at
    /// surface level 2, or coarser: kept past the budget, as the stand-in for
    /// whatever is missing. Evicted while zoomed in, they left the base map showing
    /// on the way out until EUMETView drew them again.
    nonisolated static func isStandIn(_ key: TileKey, of source: ImagerySource) -> Bool {
        key.level <= source.level(forSurface: 2)
    }

    nonisolated private static func decode(_ data: Data, device: MTLDevice) -> MTLTexture? {
        // Map tiles are 256 or 512 pixels a side.
        guard let image = Textures.image(data, maximumSide: 2048) else {
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
        let buffer = device.makeBuffer(copying: mesh.vertices)!
        let tile = Tile(key: key, bounds: bounds, vertices: buffer, centre: mesh.centre, radius: mesh.radius, samples: mesh.samples)
        tiles[key] = tile
        return tile
    }

    /// Drops the textures, then the tiles, used longest ago, past the budgets. The
    /// roots stay, and so does whatever this frame uses. The textures as soon as
    /// they are past theirs; the rest every 30 frames, as going through every tile
    /// every frame took the sky view 0.4 ms of each.
    private func evict() {
        if texturedTiles > Self.maximumTextures {
            // Never one this frame uses: a view that needs more than the budget
            // keeps them, rather than losing the tiles it refines into and starting over.
            let unused = tiles.values.filter { $0.texture != nil && $0.key.level > 0 && $0.lastUsed < frame }
            for tile in unused.sorted(by: { $0.lastUsed < $1.lastUsed }).prefix(texturedTiles - Self.maximumTextures) {
                tile.texture = nil
                tile.needsBake = true
                tile.isComplete = false
                tile.draped = nil
                texturedTiles -= 1
            }
        }
        guard frame % 30 == 0 else {
            return
        }
        if tiles.count > 4 * Self.maximumTextures {
            for tile in tiles.values.filter({ $0.texture == nil && $0.lastUsed < frame - 60 }) {
                tiles[tile.key] = nil
            }
        }
        for sources in allSources {
            let ready = sources.tiles.compactMap { key, state -> (TileKey, Int)? in
                if case .ready(_, let used) = state, !(sources.keepsStandIns && Self.isStandIn(key, of: sources.source)) { (key, used) } else { nil }
            }
            for (key, _) in ready.sorted(by: { $0.1 < $1.1 }).prefix(max(ready.count - Self.maximumSources, 0)) {
                sources.tiles[key] = nil
            }
        }
        let waiting = tiles.values.filter { !$0.isComplete && $0.lastWanted >= frame - 60 }.map(\.key)
        // A frame is whole once nothing in view waits on the last one's tiles.
        if waiting.isEmpty {
            for overlay in overlays {
                overlay.previous = [:]
            }
        }
        evictSources(waiting: waiting)
        // Cancelled there, or out of time: nothing else would move it on.
        if showNextFrames() {
            bakeAgain()
        }
        evictTerrain()
    }

    /// Drops the tiles, decoded sources and terrain the frame last chosen does not
    /// draw from, which the budgets otherwise keep for coming back.
    func trim() {
        for tile in tiles.values where tile.key.level > 0 && tile.lastUsed < frame {
            if tile.texture != nil {
                texturedTiles -= 1
            }
            tiles[tile.key] = nil
        }
        for sources in allSources {
            sources.tiles = sources.tiles.filter { _, state in
                if case .ready = state { false } else { true }
            }
        }
        for overlay in overlays {
            overlay.previous = [:]
        }
        terrainTiles = terrainTiles.filter { key, state in
            if case .ready = state { terrainUsed[key, default: 0] >= frame } else { true }
        }
        terrainUsed = terrainUsed.filter { terrainTiles[$0.key] != nil }
    }

    /// The tiles kept, textured or not.
    var tileCount: Int { tiles.count }

    /// The frame each overlay shows.
    var overlayFrames: [String?] { overlays.map(\.imagery.frame) }

    /// The base map's source tiles and each overlay's.
    private var allSources: [SourceTiles] {
        [baseMap] + overlays.map(\.sources)
    }

    /// Cancels the source tiles none of the tiles `waiting` in view asks for, so
    /// that a fast pan or zoom does not leave hundreds of requests for tiles flown
    /// past to be sent, as the terrain's are cancelled; and forgets the failures
    /// past their retry interval, which are asked for again anyway.
    private func evictSources(waiting: [TileKey]) {
        for sources in allSources {
            for (key, state) in sources.tiles {
                switch state {
                case .loading(let work) where !Self.isWanted(key, of: sources.source, by: waiting):
                    work.cancel()
                    sources.tiles[key] = nil
                case .failed(let at) where Date().timeIntervalSince(at) >= Self.retryInterval:
                    sources.tiles[key] = nil
                default:
                    continue
                }
                // Baked again when next drawn, which asks for it again.
                markForBake(covering: sources.source.projection.bounds(key))
            }
        }
    }

    /// Drops the terrain tiles wanted longest ago past the budget, and cancels the
    /// requests for those nothing has wanted for a second, so that a zoom does not
    /// leave a queue of tiles flown past to be sent.
    private func evictTerrain() {
        var ready: [TileKey] = []
        for (key, state) in terrainTiles {
            switch state {
            case .loading(let work, _) where terrainUsed[key, default: 0] < frame - 60:
                work.cancel()
                terrainTiles[key] = nil
            case .ready:
                ready.append(key)
            default:
                break
            }
        }
        if ready.count > Self.maximumTerrainTiles {
            // Never one this frame uses: the sky view lays 118, and dropping those
            // in use decoded them again, 44 a second on an iPad mini.
            let unused = ready.filter { terrainUsed[$0, default: 0] < frame }
            for key in unused.sorted(by: { terrainUsed[$0, default: 0] < terrainUsed[$1, default: 0] }).prefix(ready.count - Self.maximumTerrainTiles) {
                terrainTiles[key] = nil
            }
        }
        terrainUsed = terrainUsed.filter { terrainTiles[$0.key] != nil }
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

/// One tile to fetch.
public struct TileRequest: Sendable {
    public var url: URL
    /// What the answer's Content-Type must start with.
    public var contentType: String
    public var headers: [String: String]
    /// Kept for good once fetched, rather than in a cache the system may purge.
    public var keeps = false
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

    /// A terrain's height and normal at a latitude and longitude, and how deep a
    /// skirt hides the cracks between tiles laid over it.
    typealias Ground = (sample: (_ latitude: Double, _ longitude: Double) -> (height: Double, normal: SIMD3<Double>?), skirt: Double)

    /// On the ellipsoid, or laid over `terrain`.
    init(bounds: Bounds, level: Int, terrain: Ground? = nil) {
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
