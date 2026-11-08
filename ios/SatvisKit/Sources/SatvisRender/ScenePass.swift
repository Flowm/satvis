import Metal
import SatvisCore
import simd

/// What a frame draws, worked out before its scene pass is encoded.
struct FramePlan {
    var uniforms: FrameUniforms
    var pose: CameraPose
    var drawn: DrawnFrame
    var placements: [ModelPlacement]
    /// The globe's tiles that have a texture.
    var surfaceTiles: [Surface.Tile]
    /// Where each satellite's stencil sits this frame, and how wide its 3D model
    /// is drawn (`PointFrame`); nil with no satellite to draw.
    var pointFrames: MTLBuffer?
}

/// The scene pass of one frame, into the HDR image: the globe, the sky, the
/// models, the stations and the satellites, or on the map `MapPass`'s draws and
/// the globe's own over it. Made each frame from what the renderer holds.
@MainActor
struct ScenePass {
    /// Samples a line runs through, the satellite's own place aside; mirrors
    /// `lineNodes` in Shaders/Lines.msl.
    static let lineNodes = 121
    /// A line's triangle strip, two vertices a point: `lineNodes` samples in
    /// Shaders/Lines.msl, and where the satellite is now between two of them.
    private static let lineVertices = 2 * (lineNodes + 1)
    /// Past this many satellites, where one orbit is no longer told from the next,
    /// a line small on the screen steps over samples (`lineStride` in
    /// Shaders/Lines.msl): with every active one's orbit on, an iPad mini drew
    /// 36 frames a second with every sample and 43 with these steps.
    private static let lineLevelOfDetailSatellites = 1000
    /// From the Earth's centre, in metres: past this the sky atmosphere is drawn
    /// as the ring round the globe (`skyRingVertex`), nearer as the whole shell,
    /// which the eye can be inside. 10 % outside the shell.
    private static let skyRingDistance = 1.1 * 1.025 * 6_378_137.0
    /// Mirrors `coneSides` in Shaders/Footprints.msl.
    private static let coneSides = 48
    /// What `setVertexBytes` takes, 4 KB, in the larger of the two instances.
    private static let maximumInlineInstances = 4096 / MemoryLayout<LinkInstance>.stride

    let pipelines: ScenePipelines
    let surface: Surface
    let overlay: GroundOverlay
    let points: SatellitePoints
    let stars: MTLTexture?
    let pin: MTLTexture?
    let stations: [StationMarker]
    let links: [StationLink]
    let components: SatelliteComponents
    let cameraMode: CameraMode
    /// Whether the camera's picture is behind the scene, which then leaves the sky
    /// clear and the ground in depth alone.
    let showsCamera: Bool

    /// The scene pass, into the HDR image, and into `screen` too where the
    /// tonemap is its last draw.
    func encode(_ plan: FramePlan, commands: MTLCommandBuffer, hdr: MTLTexture, depth: MTLTexture, screen: MTLTexture) {
        let tonemapTilePipeline = pipelines.tonemapTilePipeline
        let scene = MTLRenderPassDescriptor()
        scene.colorAttachments[0].texture = hdr
        scene.colorAttachments[0].loadAction = .clear
        scene.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: showsCamera ? 0 : 1)
        scene.colorAttachments[0].storeAction = tonemapTilePipeline == nil ? .store : .dontCare
        if tonemapTilePipeline != nil {
            scene.colorAttachments[1].texture = screen
            scene.colorAttachments[1].loadAction = .dontCare
            scene.colorAttachments[1].storeAction = .store
        }
        scene.depthAttachment.texture = depth
        scene.depthAttachment.loadAction = .clear
        scene.depthAttachment.clearDepth = 0
        scene.depthAttachment.storeAction = .dontCare
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: scene) else {
            return
        }
        var frame = plan.uniforms
        encoder.setFrontFacing(.counterClockwise)
        encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
        encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)

        if let map = plan.pose.mapCamera {
            drawMap(encoder, plan, map: map)
            encoder.endEncoding()
            return
        }
        drawGlobe(encoder, tiles: plan.surfaceTiles, eye: plan.pose.position)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: false)
        // Behind the globe and the models, drawn after them so that only the
        // sky they leave is shaded: half the screen and more, close up.
        drawSky(encoder, eye: plan.pose.position)
        // Over the sky: they write no depth, so the stars and the atmosphere,
        // drawn where depth is still clear, would paint over them.
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: true)
        // Under the satellites and their names: a pin marks the ground.
        drawStations(encoder, eye: plan.pose.position, now: plan.drawn.time)
        drawSatellites(encoder, pointFrames: plan.pointFrames)
        drawTileTonemap(encoder)
        encoder.endEncoding()
    }

    /// The tonemap in a pass of its own, from the HDR image the scene pass stored;
    /// for a GPU that cannot read its render targets in place.
    func encodeTonemapPass(_ commands: MTLCommandBuffer, screen: MTLRenderPassDescriptor, hdr: MTLTexture) {
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: screen) else {
            return
        }
        encoder.setRenderPipelineState(pipelines.tonemapPipeline)
        encoder.setFragmentTexture(hdr, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    /// The 2D scene: the map, the models over it, the stations, the satellites'
    /// lines, points and names. No stars, atmosphere or sensor cones, as the web
    /// app's 2D draws none. The map writes no depth; the models and what is drawn
    /// at a satellite's height test it, each against the others.
    private func drawMap(_ encoder: MTLRenderCommandEncoder, _ plan: FramePlan, map: MapCamera) {
        pipelines.mapPass.drawTiles(
            encoder, plan.surfaceTiles, map: map, aspectRatio: plan.drawn.size.x / plan.drawn.size.y, surface: surface, overlay: overlay,
            sampler: pipelines.tileSampler, depth: pipelines.noDepth)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: false)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: true)
        drawStations(encoder, eye: plan.pose.position, now: plan.drawn.time, map: map)
        if let samples = points.prepared?.samples, let instances = points.prepared?.instances, let states = plan.pointFrames {
            encoder.setVertexBuffer(samples, offset: 0, index: 0)
            encoder.setVertexBuffer(instances, offset: 0, index: 2)
            encoder.setVertexBuffer(states, offset: 0, index: 3)
            pipelines.mapPass.drawSatellites(
                encoder, count: points.count, components: components, labels: points.prepared?.labels,
                stepsLines: points.count > Self.lineLevelOfDetailSatellites, depthTest: pipelines.depthTest, noDepth: pipelines.noDepth)
        }
        drawTileTonemap(encoder)
    }

    /// The globe's tiles, each placed by its centre from the eye, writing depth.
    private func drawGlobe(_ encoder: MTLRenderCommandEncoder, tiles: [Surface.Tile], eye: SIMD3<Double>) {
        guard !tiles.isEmpty else {
            return
        }
        // In depth alone under the camera's picture, which shows the real
        // ground, and still hides what is behind it.
        encoder.setRenderPipelineState(showsCamera ? pipelines.groundDepthPipeline : pipelines.globePipeline)
        encoder.setDepthStencilState(pipelines.depthWrite)
        encoder.setCullMode(.back)
        encoder.setFragmentTexture(overlay.texture, index: 1)
        encoder.setFragmentSamplerState(pipelines.tileSampler, index: 0)
        var overlayShown = Int32(overlay.hasCoverage ? 1 : 0)
        encoder.setFragmentBytes(&overlayShown, length: MemoryLayout<Int32>.size, index: 2)
        for tile in tiles {
            var centre = SIMD3<Float>(tile.centre - eye)
            encoder.setVertexBytes(&centre, length: MemoryLayout<SIMD3<Float>>.stride, index: 2)
            encoder.setVertexBuffer(surface.vertices(tile), offset: 0, index: 0)
            encoder.setFragmentTexture(tile.texture, index: 0)
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: surface.indexCount, indexType: .uint32, indexBuffer: surface.indexBuffer, indexBufferOffset: 0)
        }
    }

    /// The stars and the sky atmosphere, where nothing has been drawn; neither
    /// under the camera's picture.
    private func drawSky(_ encoder: MTLRenderCommandEncoder, eye: SIMD3<Double>) {
        if let stars, !showsCamera {
            encoder.setRenderPipelineState(pipelines.skyBoxPipeline)
            encoder.setDepthStencilState(pipelines.depthEmpty)
            encoder.setCullMode(.none)
            encoder.setFragmentTexture(stars, index: 0)
            encoder.setFragmentSamplerState(pipelines.linearSampler, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        // At the far plane, as the stars: the shell's far side, where the globe
        // stands in front of it, fails the depth test. Under the camera's
        // picture, the real sky stands in for both.
        encoder.setDepthStencilState(pipelines.depthEmpty)
        if !showsCamera {
            if simd_length(eye) > Self.skyRingDistance {
                encoder.setRenderPipelineState(pipelines.skyRingPipeline)
                encoder.setCullMode(.none)
                encoder.drawIndexedPrimitives(
                    type: .triangle, indexCount: pipelines.skyRing.count, indexType: .uint32, indexBuffer: pipelines.skyRing.indices, indexBufferOffset: 0)
            } else {
                encoder.setRenderPipelineState(pipelines.skyAtmospherePipeline)
                encoder.setCullMode(.front)
                encoder.setVertexBuffer(pipelines.skyShell.vertices, offset: 0, index: 0)
                encoder.drawIndexedPrimitives(
                    type: .triangle, indexCount: pipelines.skyShell.count, indexType: .uint32, indexBuffer: pipelines.skyShell.indices, indexBufferOffset: 0)
            }
        }
    }

    /// The satellites' orbits, points, sensor cones and labels, as the components
    /// ask.
    private func drawSatellites(_ encoder: MTLRenderCommandEncoder, pointFrames: MTLBuffer?) {
        guard let samples = points.prepared?.samples, let instances = points.prepared?.instances, let states = pointFrames else {
            return
        }
        encoder.setDepthStencilState(pipelines.depthTest)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(samples, offset: 0, index: 0)
        encoder.setVertexBuffer(instances, offset: 0, index: 2)
        encoder.setVertexBuffer(states, offset: 0, index: 3)
        for (component, kind) in [(SatelliteComponents.orbit, 0), (.orbitTrack, 1)] where components.contains(component) {
            var kind = Int32(kind)
            encoder.setRenderPipelineState(pipelines.linePipeline)
            encoder.setVertexBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            encoder.setFragmentBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            var stepsLines = Int32(points.count > Self.lineLevelOfDetailSatellites ? 1 : 0)
            encoder.setVertexBytes(&stepsLines, length: MemoryLayout<Int32>.size, index: 6)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: Self.lineVertices, instanceCount: points.count)
        }
        if components.contains(.point) {
            encoder.setRenderPipelineState(pipelines.pointPipeline)
            encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: points.count)
        }
        if components.contains(.sensorCone), let cones = points.prepared?.cones {
            // Each side of the translucent cone shows, as Cesium draws it.
            encoder.setVertexBuffer(cones.buffer, offset: 0, index: 4)
            encoder.setRenderPipelineState(pipelines.conePipeline)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3 * Self.coneSides, instanceCount: cones.count)
            encoder.setDepthStencilState(pipelines.noDepth)
            encoder.setRenderPipelineState(pipelines.coneRimPipeline)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6 * Self.coneSides, instanceCount: cones.count)
            encoder.setDepthStencilState(pipelines.depthTest)
        }
        if components.contains(.label), let labels = points.prepared?.labels {
            // Over the globe, unless the eye is on the ground (Shaders/Labels.msl).
            var occludedByEarth = Int32(cameraMode == .sky ? 0 : 1)
            encoder.setDepthStencilState(cameraMode == .sky ? pipelines.depthTest : pipelines.noDepth)
            encoder.setVertexBytes(&occludedByEarth, length: MemoryLayout<Int32>.size, index: 5)
            encoder.setRenderPipelineState(pipelines.labelPipeline)
            labels.draw(encoder)
        }
    }

    /// The tonemap as the scene pass's last draw, where the GPU reads its render
    /// targets in place; nothing where it cannot.
    private func drawTileTonemap(_ encoder: MTLRenderCommandEncoder) {
        guard let tonemapTilePipeline = pipelines.tonemapTilePipeline else {
            return
        }
        encoder.setRenderPipelineState(tonemapTilePipeline)
        encoder.setDepthStencilState(pipelines.noDepth)
        encoder.setCullMode(.none)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    /// The opaque and cut-out parts, writing depth, or the blended ones, testing
    /// it, drawn after the opaque scene: as CesiumJS draws glTF's translucent parts.
    /// A model the sky view dims is blended whole.
    private func drawModels(
        _ encoder: MTLRenderCommandEncoder, _ placements: [ModelPlacement], frame: FrameUniforms, viewProjection: simd_double4x4, blended: Bool
    ) {
        guard !placements.isEmpty else {
            return
        }
        encoder.setFragmentSamplerState(pipelines.tileSampler, index: 0)
        encoder.setRenderPipelineState(blended ? pipelines.modelPipelines.blended : pipelines.modelPipelines.opaque)
        encoder.setDepthStencilState(blended ? pipelines.depthTest : pipelines.depthWrite)
        for placement in placements {
            let base = ModelInstance(
                modelViewProjection: float4x4(viewProjection * placement.toEye), rotation: placement.rotation,
                modelToEye: float4x4(placement.lightingToEye), baseColor: .one, sunDirection: frame.sunDirection, hasTexture: 0, metallic: 0,
                roughness: 0, alphaCutoff: 0, opacity: placement.opacity)
            placement.model.encodeParts(blended: blended, wholeBlended: placement.opacity < 1, base: base, encoder: encoder)
        }
        // The frame's uniforms, which the passes after this one read there.
        var frame = frame
        encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
        encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
    }

    /// The links of the passes under way, then the pins of the stations facing
    /// the eye. Few enough to go in with the draw call.
    /// On the map (`map`), each is placed on it from the view's centre, and a
    /// link runs straight the shorter way round, from its station.
    private func drawStations(_ encoder: MTLRenderCommandEncoder, eye: SIMD3<Double>, now: Double, map: MapCamera? = nil) {
        func relative(_ position: SIMD3<Double>) -> (Float, Float, Float) {
            let offset = map.map { $0.offset(of: position) } ?? position - eye
            return (Float(offset.x), Float(offset.y), Float(offset.z))
        }
        func placed(from station: SIMD3<Double>, to satellite: SIMD3<Double>) -> LinkInstance {
            guard let map else {
                return LinkInstance(satellite: relative(satellite), station: relative(station))
            }
            let (from, to) = (map.offset(of: station), map.offset(of: satellite))
            let east = to.x - MapCamera.mapWidth * ((to.x - from.x) / MapCamera.mapWidth).rounded()
            return LinkInstance(satellite: (Float(east), Float(to.y), Float(to.z)), station: (Float(from.x), Float(from.y), Float(from.z)))
        }
        if components.contains(.groundStationLink) {
            let instances = links.filter { $0.start <= now && now <= $0.end }.compactMap { link in
                points.position(of: link.satellite, at: now).map { placed(from: link.station, to: $0) }
            }.prefix(Self.maximumInlineInstances)
            if !instances.isEmpty {
                encoder.setRenderPipelineState(pipelines.linkPipeline)
                encoder.setDepthStencilState(pipelines.depthTest)
                encoder.setCullMode(.none)
                Array(instances).withUnsafeBytes { encoder.setVertexBytes($0.baseAddress!, length: $0.count, index: 2) }
                encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: instances.count)
            }
        }
        // On the map, at the size they have on the globe seen from as high.
        let pins = stations.filter { map != nil || isAboveHorizon($0.position, from: eye) }.prefix(Self.maximumInlineInstances).map {
            StationInstance(position: relative($0.position), distance: Float(map != nil ? heightAboveEllipsoid(eye) : simd.distance($0.position, eye)))
        }
        if let pin, !pins.isEmpty {
            encoder.setRenderPipelineState(pipelines.stationPipeline)
            encoder.setDepthStencilState(pipelines.noDepth)
            encoder.setCullMode(.none)
            pins.withUnsafeBytes { encoder.setVertexBytes($0.baseAddress!, length: $0.count, index: 2) }
            encoder.setFragmentTexture(pin, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: pins.count)
        }
    }
}
