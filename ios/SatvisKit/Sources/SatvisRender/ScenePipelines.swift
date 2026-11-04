import Metal

/// What the scene is drawn with, built once its shaders compile: the pipelines,
/// the depth and sampler states, and the sky's meshes.
@MainActor
struct ScenePipelines {
    static let hdrFormat = MTLPixelFormat.rgba16Float
    static let depthFormat = MTLPixelFormat.depth32Float
    static let screenFormat = MTLPixelFormat.bgra8Unorm
    /// Mirror `skyRingColumns` and `skyRingRows` in Shaders/Sky.msl.
    static let skyRingColumns = 512
    static let skyRingRows = 16

    let skyBoxPipeline: MTLRenderPipelineState
    let skyAtmospherePipeline: MTLRenderPipelineState
    let skyRingPipeline: MTLRenderPipelineState
    let globePipeline: MTLRenderPipelineState
    /// The globe in depth alone, under the camera's picture.
    let groundDepthPipeline: MTLRenderPipelineState
    let pointPipeline: MTLRenderPipelineState
    let linePipeline: MTLRenderPipelineState
    let labelPipeline: MTLRenderPipelineState
    let stationPipeline: MTLRenderPipelineState
    let linkPipeline: MTLRenderPipelineState
    let overlayPipeline: MTLRenderPipelineState
    let conePipeline: MTLRenderPipelineState
    /// A model's opaque parts, and its blended ones after every opaque one.
    let modelPipelines: ModelPipelines
    let coneRimPipeline: MTLRenderPipelineState
    /// The flat map's own draws.
    let mapPass: MapPass
    /// The kept frame of the other projection over the screen (`ProjectionFade`).
    let fadePipeline: MTLRenderPipelineState
    let tonemapPipeline: MTLRenderPipelineState
    /// The tonemap as the scene pass's last draw, on a GPU that reads its own
    /// render targets (`tonemapTileFragment`); nil where it cannot, which
    /// tonemaps in a second pass.
    let tonemapTilePipeline: MTLRenderPipelineState?
    let depthWrite: MTLDepthStencilState
    let depthTest: MTLDepthStencilState
    /// Passes only where nothing has been drawn: depth still at the clear's 0.
    let depthEmpty: MTLDepthStencilState
    let noDepth: MTLDepthStencilState
    let linearSampler: MTLSamplerState
    let tileSampler: MTLSamplerState
    let skyShell: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)
    let skyRing: (indices: MTLBuffer, count: Int)

    /// Everything the scene draws with, for a view whose drawable is `viewFormat`.
    init(device: MTLDevice, libraries: ShaderLibrary.Libraries, viewFormat: MTLPixelFormat) throws {
        // Vertex functions from the precise library, fragment functions from the fast.
        // One pass where the GPU can read its render targets in place: the HDR
        // image and the depth stay in tile memory, and the screen is the scene
        // pass's second target, written by the tonemap alone.
        let tileTonemap = device.supportsFamily(.apple4) ? libraries.fast.makeFunction(name: "tonemapTileFragment") : nil
        let screenFormat = Self.screenFormat
        func pipeline(
            _ vertex: String, _ fragment: String, format: MTLPixelFormat = Self.hdrFormat, depth: Bool = true, blend: Bool = false, premultiplied: Bool = false,
            writesColor: Bool = true,
            // A vertex function that places nothing by the high/low split may take
            // fast math too.
            fastVertex: Bool = false
        ) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try (fastVertex ? libraries.fast : libraries.precise).function(vertex)
            descriptor.fragmentFunction = try libraries.fast.function(fragment)
            descriptor.colorAttachments[0].pixelFormat = format
            if !writesColor {
                descriptor.colorAttachments[0].writeMask = []
            }
            if tileTonemap != nil, format == Self.hdrFormat, depth {
                descriptor.colorAttachments[1].pixelFormat = screenFormat
                descriptor.colorAttachments[1].writeMask = []
            }
            if blend {
                descriptor.colorAttachments[0].blendOver(premultiplied: premultiplied)
            }
            if depth {
                descriptor.depthAttachmentPixelFormat = Self.depthFormat
            }
            return try device.makeRenderPipelineState(descriptor: descriptor)
        }
        skyBoxPipeline = try pipeline("fullscreenVertex", "skyBoxFragment")
        skyAtmospherePipeline = try pipeline("skyAtmosphereVertex", "skyAtmosphereFragment", blend: true, fastVertex: true)
        skyRingPipeline = try pipeline("skyRingVertex", "skyAtmosphereFragment", blend: true, fastVertex: true)
        globePipeline = try pipeline("globeVertex", "globeFragment", fastVertex: true)
        groundDepthPipeline = try pipeline("globeVertex", "globeFragment", writesColor: false, fastVertex: true)
        // Blended, for the sky view to dim what cannot be seen.
        pointPipeline = try pipeline("pointVertex", "pointFragment", blend: true)
        linePipeline = try pipeline("lineVertex", "lineFragment", blend: true)
        modelPipelines = try ModelPipelines(
            device: device, vertex: libraries.precise, fragment: libraries.fast, targets: Self.modelTargets(tileTonemap: tileTonemap != nil))
        labelPipeline = try pipeline("labelVertex", "labelFragment", blend: true, premultiplied: true)
        stationPipeline = try pipeline("stationVertex", "stationFragment", blend: true, premultiplied: true)
        linkPipeline = try pipeline("linkVertex", "linkFragment", blend: true)
        overlayPipeline = try pipeline("overlayVertex", "overlayFragment", format: .r8Unorm, depth: false, blend: true, premultiplied: true)
        conePipeline = try pipeline("coneVertex", "coneFragment", blend: true)
        mapPass = MapPass(
            tiles: try pipeline("mapGlobeVertex", "mapGlobeFragment", fastVertex: true), points: try pipeline("mapPointVertex", "pointFragment", blend: true),
            lines: try pipeline("mapLineVertex", "lineFragment", blend: true),
            labels: try pipeline("mapLabelVertex", "labelFragment", blend: true, premultiplied: true))
        fadePipeline = try pipeline("fullscreenVertex", "fadeFragment", format: viewFormat, depth: false, blend: true, fastVertex: true)
        coneRimPipeline = try pipeline("coneRimVertex", "coneRimFragment", blend: true)
        tonemapPipeline = try pipeline("fullscreenVertex", "tonemapFragment", format: viewFormat, depth: false)
        tonemapTilePipeline = try tileTonemap.map { fragment in
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try libraries.precise.function("fullscreenVertex")
            descriptor.fragmentFunction = fragment
            descriptor.colorAttachments[0].pixelFormat = Self.hdrFormat
            descriptor.colorAttachments[0].writeMask = []
            descriptor.colorAttachments[1].pixelFormat = screenFormat
            descriptor.depthAttachmentPixelFormat = Self.depthFormat
            return try device.makeRenderPipelineState(descriptor: descriptor)
        }

        func depthState(compare: MTLCompareFunction, write: Bool) -> MTLDepthStencilState {
            let descriptor = MTLDepthStencilDescriptor()
            descriptor.depthCompareFunction = compare
            descriptor.isDepthWriteEnabled = write
            return device.makeDepthStencilState(descriptor: descriptor)!
        }
        // Reversed-Z: nearer is greater.
        depthWrite = depthState(compare: .greater, write: true)
        depthTest = depthState(compare: .greater, write: false)
        noDepth = depthState(compare: .always, write: false)
        depthEmpty = depthState(compare: .greaterEqual, write: false)

        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.mipFilter = .linear
        samplerDescriptor.maxAnisotropy = 8
        samplerDescriptor.sAddressMode = .repeat
        samplerDescriptor.tAddressMode = .clampToEdge
        linearSampler = device.makeSamplerState(descriptor: samplerDescriptor)!
        let tileSamplerDescriptor = MTLSamplerDescriptor()
        tileSamplerDescriptor.minFilter = .linear
        tileSamplerDescriptor.magFilter = .linear
        tileSamplerDescriptor.mipFilter = .linear
        tileSamplerDescriptor.maxAnisotropy = 8
        tileSamplerDescriptor.sAddressMode = .clampToEdge
        tileSamplerDescriptor.tAddressMode = .clampToEdge
        tileSampler = device.makeSamplerState(descriptor: tileSamplerDescriptor)!

        let shell = Meshes.skyShell()
        skyShell = (device.makeBuffer(copying: shell.vertices)!, device.makeBuffer(copying: shell.indices)!, shell.indices.count)
        let ringIndices = Meshes.grid(columns: Self.skyRingColumns, rows: Self.skyRingRows)
        guard let ringBuffer = device.makeBuffer(copying: ringIndices) else {
            throw RendererError.noDevice
        }
        skyRing = (ringBuffer, ringIndices.count)
    }

    /// What the models draw into in the scene pass: the HDR image and the depth,
    /// and the screen too where the tonemap reads them in tile memory.
    static func modelTargets(tileTonemap: Bool) -> ModelPipelines.Targets {
        ModelPipelines.Targets(color: hdrFormat, screen: tileTonemap ? screenFormat : nil, depth: depthFormat)
    }
}
