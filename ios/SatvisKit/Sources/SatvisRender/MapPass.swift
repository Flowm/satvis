import Metal
import SatvisCore

/// The flat map's own draws (Shaders/Map.msl): its tiles, and the satellites'
/// lines, points and names on it. The 3D models, the stations and their links are
/// the globe's draws, which the renderer places on the map.
@MainActor
struct MapPass {
    /// A line: two quads of six vertices a segment, `lineNodes` segments at most
    /// (`mapLineVertex`).
    private static let lineVertices = 12 * GlobeRenderer.lineNodes

    /// The tiles, flat (`mapGlobeVertex`, `mapGlobeFragment`).
    let tiles: MTLRenderPipelineState
    /// The satellites' points (`mapPointVertex`).
    let points: MTLRenderPipelineState
    /// Their orbits and orbit tracks (`mapLineVertex`).
    let lines: MTLRenderPipelineState
    /// Their names (`mapLabelVertex`).
    let labels: MTLRenderPipelineState

    /// The map's tiles, each placed by its corner from the view's centre, worked
    /// out in double precision, once for each copy of the map the view shows it
    /// in, with the ground tracks of `overlay`. Writing no depth.
    func drawTiles(
        _ encoder: MTLRenderCommandEncoder, _ tiles: [Surface.Tile], map: MapCamera, aspectRatio: Double, surface: Surface, overlay: GroundOverlay,
        sampler: MTLSamplerState, depth: MTLDepthStencilState
    ) {
        guard !tiles.isEmpty else {
            return
        }
        encoder.setRenderPipelineState(self.tiles)
        encoder.setDepthStencilState(depth)
        encoder.setCullMode(.none)
        encoder.setFragmentTexture(overlay.texture, index: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        var overlayShown = Int32(overlay.hasCoverage ? 1 : 0)
        encoder.setFragmentBytes(&overlayShown, length: MemoryLayout<Int32>.size, index: 2)
        for tile in tiles {
            let (corner, size) = map.rectangle(of: tile.bounds)
            for copy in Surface.mapCopies(west: corner.x, width: size.x, map: map, aspectRatio: aspectRatio) {
                var placed = MapTile(
                    corner: SIMD2<Float>(corner + SIMD2(Double(copy) * MapCamera.mapWidth, 0)), size: SIMD2<Float>(size), centre: SIMD3<Float>(tile.centre))
                encoder.setVertexBytes(&placed, length: MemoryLayout<MapTile>.stride, index: 2)
                encoder.setVertexBuffer(tile.vertices, offset: 0, index: 0)
                encoder.setFragmentTexture(tile.texture, index: 0)
                encoder.drawIndexedPrimitives(type: .triangle, indexCount: surface.indexCount, indexType: .uint32, indexBuffer: surface.indexBuffer, indexBufferOffset: 0)
            }
        }
    }

    /// The `count` satellites' orbits and orbit tracks, points and names, as
    /// `components` asks, from the samples, instances and frames bound at 0, 2
    /// and 3. The lines and points test depth against the models; the names are
    /// over everything, as on the globe. `stepsLines` lets a line small on the map
    /// step over samples.
    func drawSatellites(
        _ encoder: MTLRenderCommandEncoder, count: Int, components: SatelliteComponents, labels: (atlas: LabelAtlas, instances: MTLBuffer)?, stepsLines: Bool,
        depthTest: MTLDepthStencilState, noDepth: MTLDepthStencilState
    ) {
        encoder.setDepthStencilState(depthTest)
        encoder.setCullMode(.none)
        for (component, kind) in [(SatelliteComponents.orbit, 0), (.orbitTrack, 1)] where components.contains(component) {
            var kind = Int32(kind)
            encoder.setRenderPipelineState(lines)
            encoder.setVertexBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            encoder.setFragmentBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            var steps = Int32(stepsLines ? 1 : 0)
            encoder.setVertexBytes(&steps, length: MemoryLayout<Int32>.size, index: 6)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: Self.lineVertices, instanceCount: count)
        }
        if components.contains(.point) {
            encoder.setRenderPipelineState(points)
            encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: count)
        }
        if components.contains(.label), let labels {
            encoder.setDepthStencilState(noDepth)
            encoder.setRenderPipelineState(self.labels)
            encoder.setVertexBuffer(labels.instances, offset: 0, index: 4)
            encoder.setFragmentTexture(labels.atlas.texture, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: labels.atlas.instances.count)
        }
    }
}

/// Mirrors `MapTile` in Shaders/Map.msl: a tile on the map from the view's centre.
struct MapTile {
    /// Its north-west corner, in metres east and north.
    var corner: SIMD2<Float>
    /// Its width and height, in metres.
    var size: SIMD2<Float>
    /// Its centre in the fixed frame, which the ground tracks are looked up by.
    var centre: SIMD3<Float>
}
