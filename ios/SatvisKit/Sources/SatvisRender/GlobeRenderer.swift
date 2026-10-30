import Foundation
import MetalKit
import SatvisCore
import simd

public enum RendererError: Error {
    case noDevice
    case missingShader(String)
    case missingFunction(String)
}

/// Compiles Shaders/*.msl. At run time rather than at build time, so that neither
/// the build nor CI needs Xcode's separately downloaded Metal toolchain.
enum ShaderLibrary {
    /// The models' shaders and what they call, which the close-up compiles alone.
    /// In order: `Models` calls `Tonemap`.
    static let models = ["Common", "Tonemap", "Models"]
    static let files = ["Common", "Sky", "Globe", "Surface", "Points", "Lines", "Labels", "Stations", "Footprints", "Map"] + models.dropFirst()

    /// The shaders compiled twice: safe math for the vertex functions that place a
    /// satellite, where fast math may regroup the high/low subtraction from the
    /// camera, and fast math for the rest: the fragment functions, which only
    /// shade, and the globe's and the sky's vertex functions, which need no split
    /// (the globe's tiles are drawn relative to their centres). On an iPad mini
    /// safe math made the star background alone 5.6 ms a frame, 0 with fast math,
    /// and the atmosphere's per-vertex scattering 2.8 ms.
    struct Libraries {
        let precise: MTLLibrary
        let fast: MTLLibrary
    }

    static func make(device: MTLDevice) async throws -> Libraries {
        let source = try source(files)
        func options(_ mode: MTLMathMode) -> MTLCompileOptions {
            let options = MTLCompileOptions()
            options.mathMode = mode
            return options
        }
        return Libraries(
            precise: try await device.makeLibrary(source: source, options: options(.safe)),
            fast: try await device.makeLibrary(source: source, options: options(.fast)))
    }

    /// Only `files`, with fast math throughout: for a pass that places nothing by a
    /// high/low split, as the info panel's close-up draws its model at the origin.
    static func makeFast(device: MTLDevice, files: [String]) async throws -> MTLLibrary {
        let options = MTLCompileOptions()
        options.mathMode = .fast
        return try await device.makeLibrary(source: try source(files), options: options)
    }

    private static func source(_ files: [String]) throws -> String {
        try files.map { name in
            guard let url = Bundle.module.url(forResource: name, withExtension: "msl", subdirectory: "Shaders") else {
                throw RendererError.missingShader(name)
            }
            return try String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n")
    }
}

/// Draws the globe, the sky around it, the ground stations on it and the
/// satellites over it, for one MTKView.
@MainActor
public final class GlobeRenderer: NSObject, MTKViewDelegate {
    /// The cameras, their flights and what the gestures steer.
    private var rig = CameraRig()
    /// Which camera the view is seen through (`CameraRig`).
    public var cameraMode: CameraMode { rig.cameraMode }
    /// The sky view's camera, while it is on the ground.
    public var skyCamera: SkyCamera? { rig.skyCamera }
    /// A line's triangle strip, two vertices a point: `lineNodes` samples in
    /// Shaders/Lines.msl, and where the satellite is now between two of them.
    private static let lineVertices = 2 * (lineNodes + 1)
    /// Samples a line runs through, the satellite's own place aside; mirrors
    /// `lineNodes` in Shaders/Lines.msl.
    static let lineNodes = 121
    /// Past this many satellites, where one orbit is no longer told from the next,
    /// a line small on the screen steps over samples (`lineStride` in
    /// Shaders/Lines.msl): with every active one's orbit on, an iPad mini drew
    /// 36 frames a second with every sample and 43 with these steps.
    private static let lineLevelOfDetailSatellites = 1000
    public var components: SatelliteComponents = [.point, .label] {
        didSet {
            keepModelsInUse()
            needsDraw = true
            // Models switched off come back from their coarsest copies, as on the web.
            if !components.contains(.model) {
                modelLevels = [:]
            }
        }
    }
    /// What the free camera holds still in. Tracking keeps the satellite's own
    /// frame, and the sky view the observer's, so it waits while either is up:
    /// the free camera does not turn meanwhile.
    public var cameraFrame: CameraFrame {
        get { rig.cameraFrame }
        set {
            rig.cameraFrame = newValue
            needsDraw = true
        }
    }
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen = UnseenMode.dim {
        didSet {
            needsDraw = true
            // The crosshair passes over hidden ones: judged again at once.
            skyCache.lockAt = -.infinity
        }
    }
    /// The camera whose picture the sky view is drawn over, while it is shown
    /// (ADR 0013): the view is then clear where the scene leaves the sky, the
    /// ground hides what is behind it without hiding the picture, and the field of
    /// view is the camera's.
    public var passthrough: CameraLens? {
        get { rig.passthrough }
        set {
            rig.passthrough = newValue
            needsDraw = true
        }
    }
    /// The instant to draw `ahead` seconds from now, in UTC milliseconds since
    /// 1970: a frame is drawn for when it will be shown (`FramePresentation`).
    public var clock: (_ ahead: Double) -> Double = wallClock {
        didSet { needsDraw = true }
    }

    /// The device's own clock, for `clock`.
    public static let wallClock: @Sendable (_ ahead: Double) -> Double = { (Date().timeIntervalSince1970 + $0) * 1000 }

    private static let hdrFormat = MTLPixelFormat.rgba16Float
    private static let depthFormat = MTLPixelFormat.depth32Float
    private static let screenFormat = MTLPixelFormat.bgra8Unorm
    private static let framesInFlight = 3

    private nonisolated let device: MTLDevice
    private let queue: MTLCommandQueue
    private let skyBoxPipeline: MTLRenderPipelineState
    private let skyAtmospherePipeline: MTLRenderPipelineState
    private let skyRingPipeline: MTLRenderPipelineState
    private let globePipeline: MTLRenderPipelineState
    /// The globe in depth alone, under the camera's picture.
    private let groundDepthPipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let labelPipeline: MTLRenderPipelineState
    private let stationPipeline: MTLRenderPipelineState
    private let linkPipeline: MTLRenderPipelineState
    private let overlayPipeline: MTLRenderPipelineState
    private let conePipeline: MTLRenderPipelineState
    /// A model's opaque parts, and its blended ones after every opaque one.
    private let modelPipelines: ModelPipelines
    private let coneRimPipeline: MTLRenderPipelineState
    /// The flat map's own draws.
    private let mapPass: MapPass
    private let overlay: GroundOverlay
    private let tonemapPipeline: MTLRenderPipelineState
    /// The tonemap as the scene pass's last draw, on a GPU that reads its own
    /// render targets (`tonemapTileFragment`); nil where it cannot, which
    /// tonemaps in a second pass.
    private let tonemapTilePipeline: MTLRenderPipelineState?
    private let depthWrite: MTLDepthStencilState
    private let depthTest: MTLDepthStencilState
    /// Passes only where nothing has been drawn: depth still at the clear's 0.
    private let depthEmpty: MTLDepthStencilState
    private let noDepth: MTLDepthStencilState
    private let linearSampler: MTLSamplerState
    let surface: Surface
    private let tileSampler: MTLSamplerState
    private let skyShell: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)
    private let skyRing: (indices: MTLBuffer, count: Int)
    private var imagery: MTLTexture?
    private var stars: MTLTexture?
    private var hdr: MTLTexture?
    private var depth: MTLTexture?
    let points = SatellitePoints()
    let models: SatelliteModels
    private var stations: [StationMarker] = []
    private var links: [StationLink] = []
    private var pin: MTLTexture?
    /// The screen's pixels per point, which the labels are drawn at.
    private nonisolated let screenScale: Double
    /// The drawable's pixels per point: the screen's, or fewer at a lower pixel
    /// ratio (`pixelratio`). Whatever is sized in points on the screen is drawn by it.
    private var pixelScale: Double
    /// What the last frame was drawn from, which taps and the sky view's
    /// instruments are answered from.
    private(set) var lastFrame: DrawnFrame?
    /// What the sky view's instruments worked out, kept between frames.
    var skyCache = SkyCache()
    private let meter = FrameMeter()
    private let faults = GPUFaults()

    /// Called with the first frame the GPU fails of each kind, which it logs.
    public var onGPUFault: (@MainActor @Sendable (GPUFault) -> Void)? {
        get { faults.onFault }
        set { faults.onFault = newValue }
    }

    /// Whether frames are measured, for the performance overlay; nothing is
    /// timed while it is off.
    public var measuresFrames = false {
        didSet {
            if measuresFrames != oldValue {
                meter.reset()
            }
        }
    }

    /// Something drawn has changed since the last frame, which the next has to
    /// show whatever the pacing.
    private var needsDraw = true
    /// The last frame of the other projection, fading out over the frames since
    /// the change.
    private var fade: ProjectionFade
    /// What the last frame was drawn from, which the next is skipped against
    /// (`mustDraw`).
    private var drawnFrom: (pose: CameraPose, time: Double, content: Int, pixelRate: Double, links: Range<Double>)?

    /// Counts what came in for the tiles, the models and the ground tracks, each
    /// counting up alone.
    private var contentRevision: Int { surface.revision + models.revision + overlay.revision }
    /// The uptime of the last call to draw a frame, drawn or skipped.
    private var lastDrawCall = -Double.infinity

    /// The frames' averages over the last half second, while measured.
    public var frameStats: FrameStats? { measuresFrames ? meter.stats : nil }

    /// Records every frame until `stopRecordingFrames`, measuring meanwhile. A
    /// measured frame is never skipped, unless `idle`.
    public func startRecordingFrames(idle: Bool = false) {
        measuresFrames = true
        recordsIdle = idle
        meter.startRecording(at: ProcessInfo.processInfo.systemUptime)
    }

    public func stopRecordingFrames() -> FrameRecording {
        recordsIdle = false
        return meter.stopRecording(at: ProcessInfo.processInfo.systemUptime)
    }

    /// Whether the frames recorded are skipped as they are unmeasured.
    private var recordsIdle = false

    /// Lets go of what is kept only for later: the surface's tiles and terrain
    /// out of view, and its decoded sources. For iOS's memory warning.
    public func trimMemory() {
        surface.trim()
        needsDraw = true
    }

    /// What the Metal device holds for the app, in megabytes.
    public var gpuMemoryMegabytes: Int { device.currentAllocatedSize / 1_048_576 }

    /// Satellites handed to the renderer, drawn or not.
    public var satelliteCount: Int { points.count }

    /// The size the last frame was drawn at, in pixels.
    public var drawableSize: CGSize? { lastFrame.map { CGSize(width: $0.size.x, height: $0.size.y) } }
    private var pointFrameBuffers: [MTLBuffer?]
    /// A picture asked for of the next frame that can be read: its width in pixels,
    /// and who waits for it.
    private var snapshotRequest: (id: Int, width: Int, continuation: CheckedContinuation<Data?, Never>)?
    private var snapshotCount = 0
    private var frameIndex = 0
    private let inFlight = DispatchSemaphore(value: framesInFlight)
    private let drawables = DrawableGate()
    /// When the frames begun are shown, which their content is timed to.
    private let presentation = FramePresentation()

    /// Compiles the shaders, which takes a second or two, without holding up the
    /// main thread, then takes over drawing the view. `naturalEarth` is the folder
    /// of the Natural Earth II tiles the app ships (`Textures.naturalEarth(at:)`).
    public static func make(view: MTKView, naturalEarth: URL?) async throws -> GlobeRenderer {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
            throw RendererError.noDevice
        }
        return try GlobeRenderer(view: view, device: device, libraries: try await ShaderLibrary.make(device: device), naturalEarth: naturalEarth)
    }

    private init(view: MTKView, device: MTLDevice, libraries: ShaderLibrary.Libraries, naturalEarth: URL?) throws {
        guard let queue = device.makeCommandQueue() else {
            throw RendererError.noDevice
        }
        self.device = device
        self.queue = queue
        view.device = device
        view.colorPixelFormat = Self.screenFormat
        view.depthStencilPixelFormat = .invalid
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

        // Vertex functions from the precise library, fragment functions from the fast.
        func function(_ name: String, in library: MTLLibrary = libraries.precise) throws -> MTLFunction {
            guard let function = library.makeFunction(name: name) else {
                throw RendererError.missingFunction(name)
            }
            return function
        }
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
            descriptor.vertexFunction = try function(vertex, in: fastVertex ? libraries.fast : libraries.precise)
            descriptor.fragmentFunction = try function(fragment, in: libraries.fast)
            descriptor.colorAttachments[0].pixelFormat = format
            if !writesColor {
                descriptor.colorAttachments[0].writeMask = []
            }
            if tileTonemap != nil, format == Self.hdrFormat, depth {
                descriptor.colorAttachments[1].pixelFormat = screenFormat
                descriptor.colorAttachments[1].writeMask = []
            }
            if blend {
                let attachment = descriptor.colorAttachments[0]!
                attachment.isBlendingEnabled = true
                attachment.sourceRGBBlendFactor = premultiplied ? .one : .sourceAlpha
                attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
                attachment.sourceAlphaBlendFactor = .one
                attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
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
        fade = ProjectionFade(
            pipeline: try pipeline("fullscreenVertex", "fadeFragment", format: view.colorPixelFormat, depth: false, blend: true, fastVertex: true))
        coneRimPipeline = try pipeline("coneRimVertex", "coneRimFragment", blend: true)
        guard let overlay = GroundOverlay(device: device) else {
            throw RendererError.noDevice
        }
        self.overlay = overlay
        tonemapPipeline = try pipeline("fullscreenVertex", "tonemapFragment", format: view.colorPixelFormat, depth: false)
        tonemapTilePipeline = try tileTonemap.map { fragment in
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try function("fullscreenVertex")
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

        func upload<Vertex: BitwiseCopyable>(_ mesh: EllipsoidMesh<Vertex>) -> (MTLBuffer, MTLBuffer, Int) {
            let vertices = mesh.vertices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
            let indices = mesh.indices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count)! }
            return (vertices, indices, mesh.indices.count)
        }
        surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        models = SatelliteModels(device: device)
        let tileSamplerDescriptor = MTLSamplerDescriptor()
        tileSamplerDescriptor.minFilter = .linear
        tileSamplerDescriptor.magFilter = .linear
        tileSamplerDescriptor.mipFilter = .linear
        tileSamplerDescriptor.maxAnisotropy = 8
        tileSamplerDescriptor.sAddressMode = .clampToEdge
        tileSamplerDescriptor.tAddressMode = .clampToEdge
        tileSampler = device.makeSamplerState(descriptor: tileSamplerDescriptor)!
        skyShell = upload(Meshes.skyShell())
        let ringIndices = Meshes.grid(columns: Self.skyRingColumns, rows: Self.skyRingRows)
        guard let ringBuffer = ringIndices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }) else {
            throw RendererError.noDevice
        }
        skyRing = (ringBuffer, ringIndices.count)
        pointFrameBuffers = Array(repeating: nil, count: Self.framesInFlight)
        screenScale = Double(view.contentScaleFactorForPoints)
        pixelScale = screenScale
        pin = Textures.texture2D(StationPin.bitmap(), device: device, queue: queue)
        super.init()
        view.delegate = self
        mtkView(view, drawableSizeWillChange: view.drawableSize)
        loadTextures(naturalEarth: naturalEarth)
    }

    /// What the models draw into in the scene pass: the HDR image and the depth,
    /// and the screen too where the tonemap reads them in tile memory.
    static func modelTargets(tileTonemap: Bool) -> ModelPipelines.Targets {
        ModelPipelines.Targets(color: hdrFormat, screen: tileTonemap ? screenFormat : nil, depth: depthFormat)
    }

    /// Decodes off the main thread; the globe is not drawn until it lands.
    private func loadTextures(naturalEarth: URL?) {
        Task.detached(priority: .userInitiated) {
            let imagery = naturalEarth.flatMap(Textures.naturalEarth(at:))
            await MainActor.run {
                self.imagery = imagery.flatMap { Textures.texture2D($0, device: self.device, queue: self.queue) }
                self.needsDraw = true
            }
        }
    }

    /// The star map behind everything: six encoded square faces in the order
    /// +X, −X, +Y, −Y, +Z, −Z, oriented as a CesiumJS sky box is. The sky is black
    /// until it is set.
    public func setStarMap(faces: [Data]) {
        Task.detached(priority: .utility) {
            let bitmaps = Textures.cubeFaces(faces)
            await MainActor.run {
                self.stars = bitmaps.flatMap { Textures.textureCube($0, device: self.device, queue: self.queue) }
                self.needsDraw = true
            }
        }
    }

    /// Packs satellites for drawing, off the main thread. Hand the result to
    /// `setSatellites`.
    public nonisolated func prepare(_ satellites: [PointSatellite]) async -> PreparedSatellites {
        let device = device
        let scale = screenScale
        return await Task.detached(priority: .userInitiated) {
            PreparedSatellites(satellites, device: device, labelScale: scale)
        }.value
    }

    public func setSatellites(_ prepared: PreparedSatellites) {
        let ids = Set(prepared.satellites.map(\.id))
        modelLevels = modelLevels.filter { ids.contains($0.key) }
        points.install(prepared)
        keepModelsInUse()
        overlay.isStale = true
        needsDraw = true
    }

    /// Keeps only the models of the satellites drawn with theirs.
    private func keepModelsInUse() {
        guard components.contains(.model), let prepared = points.prepared else {
            models.keep(only: [])
            return
        }
        // Every level's file: one asked for later is dropped on arrival unless kept.
        models.keep(only: Set(prepared.modelled.flatMap { prepared.satellites[$0].model?.files ?? [] }))
    }

    /// The base map, the site the shipped one's finer levels come from, and a
    /// daily one's day (`GIBS.frame`).
    public func setImagery(_ layer: BaseLayer, site: URL, frame: String? = nil) {
        surface.setLayer(layer, site: site, frame: frame)
        needsDraw = true
    }

    /// Whether the globe follows Re:Earth's terrain, the sky view's ground too.
    /// Off by default, as on the web.
    public func setTerrain(_ enabled: Bool) {
        surface.setTerrain(enabled)
        needsDraw = true
    }

    /// Stands on the ground at the camera's observer and looks up from there,
    /// over the terrain, which the horizon and the eye's height need. `animated`
    /// flies there; without it, as reduced motion asks, the camera cuts.
    public func enterSky(_ camera: SkyCamera, animated: Bool = true) {
        rig.enterSky(camera, animated: animated, uptime: ProcessInfo.processInfo.systemUptime, aspectRatio: lastAspectRatio)
    }

    /// Back to the globe camera, by the flight in played backwards.
    public func leaveSky(animated: Bool = true) {
        rig.leaveSky(animated: animated, uptime: ProcessInfo.processInfo.systemUptime, aspectRatio: lastAspectRatio)
    }

    /// Whether the sky view has landed, and what is on screen is what it aims at.
    /// Its instruments and its gestures wait for this.
    public var isSkySettled: Bool {
        rig.isSkySettled
    }

    /// The last frame's width over its height, which a flight sets off at; nil
    /// before one is drawn.
    private var lastAspectRatio: Double? {
        lastFrame.map { $0.size.x / $0.size.y }
    }

    /// The device's attitude, in the observer's east, north and up, while the
    /// compass aims the sky view.
    public func setSkyAttitude(_ attitude: simd_quatd) {
        rig.setSkyAttitude(attitude)
    }

    /// Levels the sky view where it is looking, as handing the aim back to a
    /// finger does (ADR 0004).
    public func levelSky() {
        rig.levelSky()
    }

    /// What fetches a 3D model's bytes by its path under /data/models/; models
    /// are not drawn without one.
    public var modelLoader: (@Sendable (String) async -> Data?)? {
        get { models.loader }
        set { models.loader = newValue }
    }

    /// What fetches a map tile's bytes; tiles are not fetched without one.
    public var tileLoader: (@Sendable (TileRequest) async -> Data?)? {
        get { surface.loader }
        set { surface.loader = newValue }
    }

    /// The ground stations to stand pins on.
    public func setStations(_ stations: [StationMarker]) {
        self.stations = stations
        needsDraw = true
    }

    /// The ground station links, each drawn while its pass lasts and the component
    /// is on.
    public func setLinks(_ links: [StationLink]) {
        self.links = links
        needsDraw = true
    }

    /// Follows a satellite or a ground station from where the web app's tracking
    /// view opens.
    /// Follows what has this id. `animated` flies there from where the camera
    /// is, as the web app's Track button does; a link or a double tap cuts.
    public func track(_ id: String, animated: Bool = false) {
        rig.track(id, animated: animated, uptime: ProcessInfo.processInfo.systemUptime, model: { self.trackedModel($0) })
    }

    /// How the tracked satellite's 3D model can be framed: a model not loaded yet
    /// is asked for.
    private func trackedModel(_ id: String) -> TrackedModel {
        guard let satellite = points.satellite(id) else {
            return .notDrawn
        }
        guard components.contains(.model), let model = satellite.model else {
            return .noModel
        }
        // Framed by what is drawn: a copy, until the file it switches to has loaded.
        let level = min(modelLevels[id] ?? model.lods.count, model.lods.count)
        return models.model(model.files[level]).map { .loaded(radius: Double($0.radius)) } ?? .loading
    }

    /// Lets go, and goes back to the view tracking began from, as the web app
    /// does: the free camera is kept while tracking, through switches from one
    /// satellite to another. `animated` flies back.
    public func stopTracking(animated: Bool = false) {
        rig.stopTracking(animated: animated, uptime: ProcessInfo.processInfo.systemUptime)
    }

    /// Back to where the app opens, letting go of what is followed. `animated`
    /// flies there; without it, as reduced motion asks, the camera cuts. Not
    /// from the sky view, which `leaveSky` leaves first.
    public func flyHome(animated: Bool = true) {
        rig.flyHome(animated: animated, uptime: ProcessInfo.processInfo.systemUptime, aspectRatio: lastAspectRatio)
    }

    /// Draws the globe as a globe or as the flat map, keeping the place in sight.
    /// `animated` fades the one into the other; without it, as reduced motion
    /// asks, it cuts.
    public func setProjection(_ projection: GlobeProjection, animated: Bool) {
        rig.setProjection(projection, animated: animated, aspectRatio: lastAspectRatio ?? hdr.map { Double($0.width) / Double($0.height) })
        needsDraw = true
    }

    /// A drag of `points` on a view of `size` points: moves the free camera over
    /// the globe, circles what is followed, or turns the sky view.
    public func drag(by points: SIMD2<Double>, viewSize size: CGSize) {
        rig.drag(by: points, viewSize: size)
    }

    /// A pinch: nearer for a scale above 1.
    public func zoom(by scale: Double) {
        rig.zoom(by: scale)
    }

    /// A twist, in radians.
    public func rotate(by radians: Double) {
        rig.rotate(by: radians)
    }

    private func position(of id: String, at time: Double) -> SIMD3<Double>? {
        points.position(of: id, at: time) ?? stations.first { $0.id == id }?.position
    }

    /// The ground station or satellite drawn nearest a point on the view, within a
    /// fingertip of it and not behind the Earth (`DrawnFrame.entity`), nor hidden
    /// from the sky view as one that cannot be seen.
    public func entity(at point: CGPoint, viewSize: CGSize) -> String? {
        guard let lastFrame else {
            return nil
        }
        let judgement = isSkySettled && unseen == .hide ? skyCamera.map { SkyJudgement(camera: $0, at: lastFrame.time, unseen: unseen) } : nil
        return lastFrame.entity(
            at: point, viewSize: viewSize, stations: stations, satellites: points.installed, components: components,
            labels: points.prepared?.labels?.atlas.instances,
            hidden: { position in judgement.map { $0.opacity(of: position, from: lastFrame.eye) == 0 } ?? false })
    }

    /// Where on the ellipsoid a point on the view lands; nil off the globe.
    public func groundPoint(at point: CGPoint, viewSize: CGSize) -> GeoCoordinate? {
        lastFrame?.groundPoint(at: point, viewSize: viewSize)
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            return
        }
        if view.bounds.width > 0 {
            pixelScale = Double(size.width / view.bounds.width)
        }
        rig.openHome(aspectRatio: size.width / size.height)
        func target(_ format: MTLPixelFormat) -> MTLTexture? {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: Int(size.width), height: Int(size.height), mipmapped: false)
            // In tile memory alone where the tonemap reads it there.
            if tonemapTilePipeline != nil {
                descriptor.usage = .renderTarget
                descriptor.storageMode = .memoryless
            } else {
                descriptor.usage = [.renderTarget, .shaderRead]
                descriptor.storageMode = .private
            }
            return device.makeTexture(descriptor: descriptor)
        }
        hdr = target(Self.hdrFormat)
        depth = target(Self.depthFormat)
        needsDraw = true
    }

    /// The next frame as a JPEG `width` pixels across, for a bookmark's card; nil
    /// where none comes within two seconds, as in the background.
    public func snapshot(width: Int) async -> Data? {
        snapshotCount += 1
        let id = snapshotCount
        return await withCheckedContinuation { continuation in
            snapshotRequest?.continuation.resume(returning: nil)
            snapshotRequest = (id, width, continuation)
            Task {
                try? await Task.sleep(for: .seconds(2))
                finishSnapshot(id, nil)
            }
        }
    }

    private func finishSnapshot(_ id: Int, _ data: Data?) {
        guard let request = snapshotRequest, request.id == id else {
            return
        }
        snapshotRequest = nil
        request.continuation.resume(returning: data)
    }

    /// The most frames a second the screen shows.
    public static var displayMaximumFramesPerSecond: Int {
        #if canImport(UIKit)
            (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.maximumFramesPerSecond ?? 60
        #else
            60
        #endif
    }

    /// Whether the app is in front, where the GPU is the app's.
    private static var isActive: Bool {
        #if canImport(UIKit)
            UIApplication.shared.applicationState == .active
        #else
            true
        #endif
    }

    public func draw(in view: MTKView) {
        let interval = 1 / Double(max(1, view.preferredFramesPerSecond))
        drawables.setBehind((presentation.perFrame ?? 0) > interval)
        // A change of projection that fades draws one frame more of the old one,
        // and keeps it to fade from; one that does not shows the new at once.
        let keepsFrame = rig.drawnProjection != rig.shownProjection && rig.fadesProjection && lastFrame != nil
        if rig.drawnProjection != rig.shownProjection, !keepsFrame {
            rig.showProjection()
        }
        // A drawable can be read only from a view asked for readable ones, which
        // cannot keep them in tile memory: asked for one frame, and back after.
        view.framebufferOnly = snapshotRequest == nil && !keepsFrame
        guard rig.orbitCamera != nil, let hdr, let depth else {
            return
        }
        let measuring = measuresFrames
        let started = ProcessInfo.processInfo.systemUptime
        // Flights and the clock as they stand when the frame is shown; drags as the
        // touches stand now.
        let shown = presentation.predict(at: started, refresh: 1 / Double(Self.displayMaximumFramesPerSecond), interval: interval)
        let now = clock(shown - ProcessInfo.processInfo.systemUptime)
        let size = SIMD2(Double(hdr.width), Double(hdr.height))
        let pose = rig.pose(
            uptime: shown, time: now, aspectRatio: size.x / size.y, model: { self.trackedModel($0) },
            target: { self.position(of: $0, at: now) }, groundHeight: { self.surface.groundHeight(latitude: $0.latitude, longitude: $0.longitude) })
        guard let pose, mustDraw(pose: pose, time: now, size: size) else {
            if measuring {
                meter.skipped(cpuSeconds: ProcessInfo.processInfo.systemUptime - started)
            }
            return
        }
        guard let target = beginFrame(view, measuring: measuring) else {
            if measuring {
                meter.skipped(cpuSeconds: ProcessInfo.processInfo.systemUptime - started)
            }
            needsDraw = true
            return
        }
        let commands = target.commands
        let plan = prepareFrame(pose: pose, size: size, now: now, commands: commands)
        encodeScene(plan, commands: commands, hdr: hdr, depth: depth, screen: target.drawable.texture)
        if tonemapTilePipeline == nil {
            encodeTonemapPass(commands, screen: target.screen, hdr: hdr)
        }
        if keepsFrame {
            keepFrame(target.drawable.texture, commands: commands, at: shown)
        } else {
            encodeFade(onto: target.drawable.texture, commands: commands, at: shown)
        }
        encodeSnapshot(of: target.drawable, into: commands)
        let committed = ProcessInfo.processInfo.systemUptime
        let cpu = committed - started - target.waitedForBuffer - target.waitedForDrawable
        let id = presentation.began(committed: committed, cpu: cpu, shown: shown)
        commands.addCompletedHandler { [presentation, meter] buffer in
            let (start, end) = (buffer.gpuStartTime, buffer.gpuEndTime)
            presentation.done(id, start: start, end: end)
            if measuring {
                meter.gpu(start: start, end: end)
            }
        }
        commands.present(target.drawable)
        commands.commit()
        if measuring {
            let ended = ProcessInfo.processInfo.systemUptime
            meter.frame(
                cpuSeconds: ended - started - target.waitedForBuffer - target.waitedForDrawable, bufferWaitSeconds: target.waitedForBuffer,
                drawableWaitSeconds: target.waitedForDrawable, at: ended, satellites: points.count)
        }
    }

    /// Whether a frame has to be drawn, or the last one still shows what this one
    /// would to within `RenderPacing.pixels`: nothing set or loaded since, the same
    /// pose, and no satellite able to have moved that far on the clock since. Every
    /// frame is drawn while measured, in the sky view and while tracking.
    private func mustDraw(pose: CameraPose, time: Double, size: SIMD2<Double>) -> Bool {
        let uptime = ProcessInfo.processInfo.systemUptime
        // Calls stop while the app is in the background, which may drop the picture.
        let resumed = uptime - lastDrawCall > 0.5
        lastDrawCall = uptime
        let paced =
            (!measuresFrames || recordsIdle) && snapshotRequest == nil && cameraMode == .orbit && !fade.isFading && rig.drawnProjection == rig.shownProjection
        if paced, !needsDraw, !resumed, surface.isSettled, let drawnFrom, drawnFrom.pose == pose, drawnFrom.content == contentRevision,
            RenderPacing.stands(abs(time - drawnFrom.time) / 1000, pixelRate: drawnFrom.pixelRate), drawnFrom.links.contains(time)
        {
            return false
        }
        needsDraw = false
        // Once a frame drawn, not every time the display asks.
        drawnFrom = (pose, time, contentRevision, paced ? pixelRate(pose: pose, time: time, size: size) : .infinity, linkSpan(around: time))
        return true
    }

    /// The instants around `time` within which no ground station link drawn starts
    /// or ends; a link moves no faster than its satellite, which the pacing bounds.
    /// Worked out once a frame drawn: checked at every vsync, 2,455 links took a
    /// quarter of an iPad mini's main thread.
    private func linkSpan(around time: Double) -> Range<Double> {
        guard components.contains(.groundStationLink) else {
            return -Double.infinity..<Double.infinity
        }
        var (from, to) = (-Double.infinity, Double.infinity)
        for link in links {
            // Drawn up to its end inclusive, it is gone from the next instant on.
            for instant in [link.start, link.end.nextUp] {
                if instant <= time {
                    from = max(from, instant)
                } else {
                    to = min(to, instant)
                }
            }
        }
        return from..<to
    }

    /// The most device pixels a simulation second anything on a frame drawn from
    /// `pose` at `time` can move (`RenderPacing.pixelRate`): each satellite where
    /// it is, or its orbit's lines where their nodes are, and its ground station
    /// links, which move no faster than it does, where they pass nearest.
    private func pixelRate(pose: CameraPose, time: Double, size: SIMD2<Double>) -> Double {
        if let map = pose.mapCamera {
            let lines = components.contains(.orbit) || components.contains(.orbitTrack)
            return RenderPacing.mapPixelRate(
                points.prepared?.motions ?? [], lines: lines, pixelsPerMetre: max(size.x, size.y) / map.span,
                latitude: { self.points.satellites[$0].trajectory.position(at: time).map { geodeticPosition($0).latitude } })
        }
        let (satellites, motions, camera) = (points.satellites, points.prepared?.motions ?? [], pose.position)
        let (orbit, track) = (components.contains(.orbit), components.contains(.orbitTrack))
        var stations: [String: [SIMD3<Double>]] = [:]
        if components.contains(.groundStationLink) {
            for link in links where link.start <= time && time <= link.end {
                stations[link.satellite, default: []].append(link.station)
            }
        }
        func nearest(_ index: Int) -> (distance: Double, speed: Double)? {
            let trajectory = satellites[index].trajectory
            // A line is drawn while the satellite is.
            guard let position = trajectory.position(at: time), let motion = motions[index] else {
                return nil
            }
            var nearest = (stations[satellites[index].id] ?? []).reduce(distance(position, camera)) { nearest, station in
                let along = position - station
                let t = min(max(dot(camera - station, along) / length_squared(along), 0), 1)
                return min(nearest, distance(station + t * along, camera))
            }
            let start = (trajectory.startMilliseconds - time) / 1000
            for turned in [true, false] where turned ? orbit : track {
                let line = RenderPacing.lineDistance(
                    trajectory.positions, start: start, step: trajectory.stepMilliseconds / 1000, turned: turned, chord: motion.chord, from: camera)
                nearest = min(nearest, line ?? .infinity)
            }
            return (nearest, motion.speed(atRadius: length(position), turning: orbit))
        }
        return RenderPacing.pixelRate(
            motions, nearest: nearest, lines: orbit || track, linked: Set(stations.keys.compactMap(points.index(of:))),
            cones: components.contains(.sensorCone), camera: camera,
            pixelsPerRadian: RenderPacing.pixelsPerRadian(width: size.x, height: size.y, verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: size.x / size.y)))
    }

    /// A command buffer once one of the frames in flight is free, and the drawable
    /// it ends on, with how long each was waited for while measuring; nil, the
    /// frame given back, where either is missing or no drawable is free yet.
    private func beginFrame(_ view: MTKView, measuring: Bool) -> (
        commands: MTLCommandBuffer, drawable: CAMetalDrawable, screen: MTLRenderPassDescriptor, waitedForBuffer: Double, waitedForDrawable: Double
    )? {
        // The simulator's drawables say nothing of being presented, so there
        // every frame takes one, as MTKView's own loop does.
        #if !targetEnvironment(simulator)
            let maximumDrawables = (view.layer as? CAMetalLayer)?.maximumDrawableCount ?? 3
            guard drawables.mayTake(maximum: maximumDrawables, at: ProcessInfo.processInfo.systemUptime) else {
                return nil
            }
        #endif
        let waitStarted = measuring ? ProcessInfo.processInfo.systemUptime : 0
        inFlight.wait()
        let waitedForBuffer = measuring ? ProcessInfo.processInfo.systemUptime - waitStarted : 0
        // Taken only once a frame is free: taken before, a drawable was held while
        // the main thread waited on a GPU running behind (every orbit on).
        let drawableStarted = ProcessInfo.processInfo.systemUptime
        let currentDrawable = view.currentDrawable
        let waitedForDrawable = ProcessInfo.processInfo.systemUptime - drawableStarted
        if currentDrawable != nil {
            drawables.drawableTaken(waited: waitedForDrawable, interval: 1 / Double(max(1, view.preferredFramesPerSecond)))
        }
        guard let drawable = currentDrawable, let screen = view.currentRenderPassDescriptor, let commands = queue.makeCommandBuffer() else {
            if currentDrawable != nil {
                drawables.drawableUnused()
            }
            inFlight.signal()
            return nil
        }
        #if !targetEnvironment(simulator)
            let gate = drawables
            let presentation = presentation
            drawable.addPresentedHandler { [weak view] presented in
                presentation.shown(at: presented.presentedTime)
                if gate.beginsTurnedAwayFrame(afterPresenting: presented.presentedTime > 0) {
                    // Drawn outside MTKView's loop, which stops in the background.
                    Task { @MainActor in
                        if Self.isActive {
                            view?.draw()
                        }
                    }
                }
            }
        #endif
        let semaphore = inFlight
        let faults = faults
        commands.addCompletedHandler { buffer in
            semaphore.signal()
            if buffer.status == .error {
                faults.record(buffer.error)
            }
        }
        frameIndex = (frameIndex + 1) % Self.framesInFlight
        return (commands, drawable, screen, waitedForBuffer, waitedForDrawable)
    }

    /// What a frame draws, worked out before its scene pass is encoded.
    private struct FramePlan {
        var uniforms: FrameUniforms
        var pose: CameraPose
        var drawn: DrawnFrame
        var placements: [ModelPlacement]
        /// The globe's tiles that have a texture.
        var surfaceTiles: [Surface.Tile]
    }

    /// The frame's uniforms and what it places, and the passes ahead of the
    /// scene's that it samples: the ground overlay and the tiles' textures.
    private func prepareFrame(pose: CameraPose, size: SIMD2<Double>, now: Double, commands: MTLCommandBuffer) -> FramePlan {
        // From the ground, once it has landed, as the instruments wait to.
        let judgement = isSkySettled ? skyCamera.map { SkyJudgement(camera: $0, at: now, unseen: unseen) } : nil
        let placements = components.contains(.model) ? modelPlacements(pose: pose, size: size, now: now, judgement: judgement) : []
        let drawnFrame = DrawnFrame(
            pose: pose, size: size, time: now, modelWidths: Dictionary(placements.map { ($0.index, $0.points) }, uniquingKeysWith: max))
        lastFrame = drawnFrame
        var frame = uniforms(drawnFrame, pose: pose, judgement: judgement)
        if case .tracking(let id) = cameraMode, let index = points.index(of: id), let target = points.position(of: id, at: now) {
            frame.focus = Int32(index)
            frame.focusRelative = SIMD3<Float>(target - pose.position)
        }
        overlay.encode(commands, pipeline: overlayPipeline, satellites: points.satellites, at: now, enabled: components.contains(.groundTrack), device: device)
        var surfaceTiles: [Surface.Tile] = []
        if let imagery, let map = pose.mapCamera {
            let selection = surface.selectMap(map, viewportPixels: size)
            let drawn = Set(selection.draw.map(\.key))
            let bakes = selection.bake.filter { drawn.contains($0.key) } + selection.bake.filter { !drawn.contains($0.key) }
            surface.encodeBakes(bakes, base: imagery, commands: commands)
            surfaceTiles = selection.draw.filter { $0.texture != nil }
        } else if let imagery {
            let selection = surface.select(
                eye: pose.position, viewProjection: drawnFrame.viewProjection, viewportHeightPixels: size.y,
                verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: size.x / size.y), pixelsPerPoint: pixelScale)
            // What is drawn now first, then the children waiting to replace it.
            let drawn = Set(selection.draw.map(\.key))
            let bakes = selection.bake.filter { drawn.contains($0.key) } + selection.bake.filter { !drawn.contains($0.key) }
            surface.encodeBakes(bakes, base: imagery, commands: commands)
            surfaceTiles = selection.draw.filter { $0.texture != nil }
        }
        return FramePlan(uniforms: frame, pose: pose, drawn: drawnFrame, placements: placements, surfaceTiles: surfaceTiles)
    }

    /// The scene pass, into the HDR image, and into `screen` too where the
    /// tonemap is its last draw.
    private func encodeScene(_ plan: FramePlan, commands: MTLCommandBuffer, hdr: MTLTexture, depth: MTLTexture, screen: MTLTexture) {
        // Only once landed: the flight shows the globe from space.
        let showsCamera = passthrough != nil && isSkySettled
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
        drawGlobe(encoder, tiles: plan.surfaceTiles, eye: plan.pose.position, showsCamera: showsCamera)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: false)
        // Behind the globe and the models, drawn after them so that only the
        // sky they leave is shaded: half the screen and more, close up.
        drawSky(encoder, eye: plan.pose.position, showsCamera: showsCamera)
        // Over the sky: they write no depth, so the stars and the atmosphere,
        // drawn where depth is still clear, would paint over them.
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: true)
        // Under the satellites and their names: a pin marks the ground.
        drawStations(encoder, eye: plan.pose.position, now: plan.drawn.time)
        drawSatellites(encoder, now: plan.drawn.time, placements: plan.placements)
        drawTileTonemap(encoder)
        encoder.endEncoding()
    }

    /// The 2D scene: the map, the models over it, the stations, the satellites'
    /// lines, points and names. No stars, atmosphere or sensor cones, as the web
    /// app's 2D draws none. The map writes no depth; the models and what is drawn
    /// at a satellite's height test it, each against the others.
    private func drawMap(_ encoder: MTLRenderCommandEncoder, _ plan: FramePlan, map: MapCamera) {
        mapPass.drawTiles(
            encoder, plan.surfaceTiles, map: map, aspectRatio: plan.drawn.size.x / plan.drawn.size.y, surface: surface, overlay: overlay,
            sampler: tileSampler, depth: noDepth)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: false)
        drawModels(encoder, plan.placements, frame: plan.uniforms, viewProjection: plan.drawn.viewProjection, blended: true)
        drawStations(encoder, eye: plan.pose.position, now: plan.drawn.time, map: map)
        if let samples = points.prepared?.samples, let instances = points.prepared?.instances,
            let states = pointFrames(at: plan.drawn.time, models: plan.placements)
        {
            encoder.setVertexBuffer(samples, offset: 0, index: 0)
            encoder.setVertexBuffer(instances, offset: 0, index: 2)
            encoder.setVertexBuffer(states, offset: 0, index: 3)
            mapPass.drawSatellites(
                encoder, count: points.count, components: components, labels: points.prepared?.labels,
                stepsLines: points.count > Self.lineLevelOfDetailSatellites, depthTest: depthTest, noDepth: noDepth)
        }
        drawTileTonemap(encoder)
    }

    /// The globe's tiles, each placed by its centre from the eye, writing depth.
    private func drawGlobe(_ encoder: MTLRenderCommandEncoder, tiles: [Surface.Tile], eye: SIMD3<Double>, showsCamera: Bool) {
        guard !tiles.isEmpty else {
            return
        }
        // In depth alone under the camera's picture, which shows the real
        // ground, and still hides what is behind it.
        encoder.setRenderPipelineState(showsCamera ? groundDepthPipeline : globePipeline)
        encoder.setDepthStencilState(depthWrite)
        encoder.setCullMode(.back)
        encoder.setFragmentTexture(overlay.texture, index: 1)
        encoder.setFragmentSamplerState(tileSampler, index: 0)
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
    private func drawSky(_ encoder: MTLRenderCommandEncoder, eye: SIMD3<Double>, showsCamera: Bool) {
        if let stars, !showsCamera {
            encoder.setRenderPipelineState(skyBoxPipeline)
            encoder.setDepthStencilState(depthEmpty)
            encoder.setCullMode(.none)
            encoder.setFragmentTexture(stars, index: 0)
            encoder.setFragmentSamplerState(linearSampler, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        // At the far plane, as the stars: the shell's far side, where the globe
        // stands in front of it, fails the depth test. Under the camera's
        // picture, the real sky stands in for both.
        encoder.setDepthStencilState(depthEmpty)
        if !showsCamera {
            if simd_length(eye) > Self.skyRingDistance {
                encoder.setRenderPipelineState(skyRingPipeline)
                encoder.setCullMode(.none)
                encoder.drawIndexedPrimitives(type: .triangle, indexCount: skyRing.count, indexType: .uint32, indexBuffer: skyRing.indices, indexBufferOffset: 0)
            } else {
                encoder.setRenderPipelineState(skyAtmospherePipeline)
                encoder.setCullMode(.front)
                encoder.setVertexBuffer(skyShell.vertices, offset: 0, index: 0)
                encoder.drawIndexedPrimitives(
                    type: .triangle, indexCount: skyShell.count, indexType: .uint32, indexBuffer: skyShell.indices, indexBufferOffset: 0)
            }
        }
    }

    /// The satellites' orbits, points, sensor cones and labels, as the components
    /// ask.
    private func drawSatellites(_ encoder: MTLRenderCommandEncoder, now: Double, placements: [ModelPlacement]) {
        guard let samples = points.prepared?.samples, let instances = points.prepared?.instances, let states = pointFrames(at: now, models: placements) else {
            return
        }
        encoder.setDepthStencilState(depthTest)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(samples, offset: 0, index: 0)
        encoder.setVertexBuffer(instances, offset: 0, index: 2)
        encoder.setVertexBuffer(states, offset: 0, index: 3)
        for (component, kind) in [(SatelliteComponents.orbit, 0), (.orbitTrack, 1)] where components.contains(component) {
            var kind = Int32(kind)
            encoder.setRenderPipelineState(linePipeline)
            encoder.setVertexBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            encoder.setFragmentBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
            var stepsLines = Int32(points.count > Self.lineLevelOfDetailSatellites ? 1 : 0)
            encoder.setVertexBytes(&stepsLines, length: MemoryLayout<Int32>.size, index: 6)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: Self.lineVertices, instanceCount: points.count)
        }
        if components.contains(.point) {
            encoder.setRenderPipelineState(pointPipeline)
            encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: points.count)
        }
        if components.contains(.sensorCone), let cones = points.prepared?.cones {
            // Each side of the translucent cone shows, as Cesium draws it.
            encoder.setVertexBuffer(cones.buffer, offset: 0, index: 4)
            encoder.setRenderPipelineState(conePipeline)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3 * Self.coneSides, instanceCount: cones.count)
            encoder.setDepthStencilState(noDepth)
            encoder.setRenderPipelineState(coneRimPipeline)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6 * Self.coneSides, instanceCount: cones.count)
            encoder.setDepthStencilState(depthTest)
        }
        if components.contains(.label), let labels = points.prepared?.labels {
            // Over the globe, unless the eye is on the ground (Shaders/Labels.msl).
            var occludedByEarth = Int32(cameraMode == .sky ? 0 : 1)
            encoder.setDepthStencilState(cameraMode == .sky ? depthTest : noDepth)
            encoder.setVertexBytes(&occludedByEarth, length: MemoryLayout<Int32>.size, index: 5)
            encoder.setRenderPipelineState(labelPipeline)
            encoder.setVertexBuffer(labels.instances, offset: 0, index: 4)
            encoder.setFragmentTexture(labels.atlas.texture, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: labels.atlas.instances.count)
        }
    }

    /// The tonemap as the scene pass's last draw, where the GPU reads its render
    /// targets in place; nothing where it cannot.
    private func drawTileTonemap(_ encoder: MTLRenderCommandEncoder) {
        guard let tonemapTilePipeline else {
            return
        }
        encoder.setRenderPipelineState(tonemapTilePipeline)
        encoder.setDepthStencilState(noDepth)
        encoder.setCullMode(.none)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    /// The tonemap in a pass of its own, from the HDR image the scene pass stored.
    private func encodeTonemapPass(_ commands: MTLCommandBuffer, screen: MTLRenderPassDescriptor, hdr: MTLTexture) {
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: screen) else {
            return
        }
        encoder.setRenderPipelineState(tonemapPipeline)
        encoder.setFragmentTexture(hdr, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    /// Keeps the frame just drawn, the last of the old projection, to fade from,
    /// and draws the new one from the next frame on.
    private func keepFrame(_ drawable: MTLTexture, commands: MTLCommandBuffer, at uptime: Double) {
        rig.showProjection()
        needsDraw = true
        fade.keep(drawable, commands: commands, device: device, at: uptime)
    }

    /// The kept frame over the screen, fading out.
    private func encodeFade(onto screen: MTLTexture, commands: MTLCommandBuffer, at uptime: Double) {
        if fade.encode(onto: screen, commands: commands, at: uptime) {
            needsDraw = true
        }
    }

    /// A copy of the drawable for the picture asked for, where it can be read.
    private func encodeSnapshot(of drawable: CAMetalDrawable, into commands: MTLCommandBuffer) {
        // Taken off as it is queued: the frames already in flight would copy it again.
        if let request = snapshotRequest, !drawable.texture.isFramebufferOnly,
            let copy = Snapshot.encodeCopy(of: drawable.texture, into: commands, device: device)
        {
            snapshotRequest = nil
            commands.addCompletedHandler { _ in
                request.continuation.resume(returning: copy.jpeg(width: request.width))
            }
        }
    }

    /// The level each modelled satellite with copies is drawn at, by its id: 0 its
    /// file, `i + 1` its copy `i` (ADR 0007). Kept across frames for the hysteresis.
    private var modelLevels: [String: Int] = [:]

    /// A 3D model where it is drawn this frame.
    private struct ModelPlacement {
        var index: Int
        var model: PreparedModel
        /// The model's frame to the eye's, scaled: metres from the eye. On the map,
        /// to the map's east, north and up from the view's centre.
        var toEye: simd_double4x4
        /// The same in the fixed frame, which the sun lights it in: on the map,
        /// seen from straight above (`MapCamera.lighting`).
        var lightingToEye: simd_double4x4
        var rotation: simd_float3x3
        /// How wide its bounding sphere is drawn, in points.
        var points: Double
        /// How the sky view draws it, 1 as usual.
        var opacity: Float
    }

    /// Each modelled satellite's model where it is, its glTF +Z along the velocity
    /// and +Y up from the ellipsoid, as CesiumJS's VelocityOrientationProperty
    /// turns it. At its real size in metres where that is large enough, else
    /// scaled up to the web app's smallest size on screen
    /// (`modelMinimumPixelSize`), but no further than that size at the home
    /// view's distance, so it shrinks with the globe beyond it. A model not
    /// loaded yet is asked for, and has no place until it lands; one the sky view
    /// hides has none either.
    private func modelPlacements(pose: CameraPose, size: SIMD2<Double>, now: Double, judgement: SkyJudgement?) -> [ModelPlacement] {
        guard let prepared = points.prepared, !prepared.modelled.isEmpty else {
            return []
        }
        let aspectRatio = size.x / size.y
        let heightPoints = size.y / pixelScale
        let longerPoints = max(size.x, size.y) / pixelScale
        let tangent = tan(pose.verticalFieldOfView(aspectRatio: aspectRatio) / 2)
        // On the map, no larger than at the zoom-out limit, the whole map across.
        let homeMetresPerPoint =
            pose.mapCamera != nil
            ? MapCamera.maximumSpan(aspectRatio: aspectRatio) / longerPoints : 2 * OrbitCamera.home(aspectRatio: aspectRatio).radius * tangent / heightPoints
        return prepared.modelled.compactMap { index in
            let satellite = prepared.satellites[index]
            guard let satelliteModel = satellite.model, let position = satellite.trajectory.position(at: now),
                let before = satellite.trajectory.position(at: now - 1000), let after = satellite.trajectory.position(at: now + 1000)
            else {
                return nil
            }
            let metresPerPoint = pose.mapCamera.map { $0.span / longerPoints } ?? 2 * simd.distance(position, pose.position) * tangent / heightPoints
            // How large the model is drawn: its scale, and its bounding sphere's diameter in points.
            func size(of model: PreparedModel) -> (scale: Double, points: Double) {
                let diameter = 2 * Double(model.radius)
                let minimum = Self.modelMinimumPoints(diameter: diameter)
                let scale = min(max(1, minimum * metresPerPoint / diameter), minimum * homeMetresPerPoint / diameter)
                return (scale, diameter * scale / metresPerPoint)
            }
            // The file, then its copies (ADR 0007).
            let files = satelliteModel.files
            var level = 0
            if files.count > 1 {
                level = Self.chooseModelLevel(
                    current: modelLevels[satellite.id], lods: satelliteModel.lods, tracked: cameraMode == .tracking(satellite.id),
                    failed: { models.failed(files[$0]) }, points: { models.model(files[$0]).map { size(of: $0).points } },
                    loaded: { models.model(files[$0]) != nil })
                modelLevels[satellite.id] = level
            }
            guard let model = models.model(files[level]) else {
                return nil
            }
            let opacity = judgement?.opacity(of: position, from: pose.position) ?? 1
            guard opacity > 0 else {
                return nil
            }
            let forward = normalize(after - before)
            let surfaceUp = normalize(position / (ellipsoidRadii * ellipsoidRadii))
            let port = normalize(cross(surfaceUp, forward))
            let up = cross(forward, port)
            let (scale, drawnPoints) = size(of: model)
            let axes = simd_double3x3(columns: (port, up, forward))
            let toEye = modelFrame(axes, scale: scale, from: position - pose.position)
            var placement = ModelPlacement(
                index: index, model: model, toEye: toEye, lightingToEye: toEye,
                rotation: simd_float3x3(columns: (SIMD3<Float>(port), SIMD3<Float>(up), SIMD3<Float>(forward))),
                points: drawnPoints, opacity: Float(opacity))
            if let map = pose.mapCamera {
                // On the map, east, north and up from where it is, seen from
                // straight above, as CesiumJS draws a model in 2D.
                placement.toEye = map.placement(of: axes, at: position, scale: scale)
                placement.lightingToEye = MapCamera.lighting(of: axes, at: position, scale: scale)
            }
            return placement
        }
    }

    /// The level a satellite with copies is drawn at this frame, 0 its file and `i + 1`
    /// its copy `i`, from the level drawn last, else the coarsest. A copy that cannot
    /// load gives way to the next finer level; then the file while tracked, else the
    /// level the drawn one's size asks for, once that has loaded. `points` is nil for a
    /// level not loaded; `loaded` asks for the level it is given.
    static func chooseModelLevel(
        current: Int?, lods: [ModelLod], tracked: Bool, failed: (Int) -> Bool, points: (Int) -> Double?, loaded: (Int) -> Bool
    ) -> Int {
        var level = min(current ?? lods.count, lods.count)
        while level > 0, failed(level) {
            level -= 1
        }
        guard let drawn = points(level) else {
            return level
        }
        let wanted = tracked ? 0 : ModelLevel.level(diameter: drawn, current: level, lods: lods)
        return wanted != level && !failed(wanted) && loaded(wanted) ? wanted : level
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
        encoder.setFragmentSamplerState(tileSampler, index: 0)
        encoder.setRenderPipelineState(blended ? modelPipelines.blended : modelPipelines.opaque)
        encoder.setDepthStencilState(blended ? depthTest : depthWrite)
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

    /// The web app's smallest size for a model on screen, by its bounding sphere's
    /// diameter in metres: a cubesat at 20 points, Landsat at 55, the ISS at 72.
    nonisolated static func modelMinimumPoints(diameter: Double) -> Double {
        min(72, max(20, 23 * cbrt(diameter)))
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
                encoder.setRenderPipelineState(linkPipeline)
                encoder.setDepthStencilState(depthTest)
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
            encoder.setRenderPipelineState(stationPipeline)
            encoder.setDepthStencilState(noDepth)
            encoder.setCullMode(.none)
            pins.withUnsafeBytes { encoder.setVertexBytes($0.baseAddress!, length: $0.count, index: 2) }
            encoder.setFragmentTexture(pin, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: pins.count)
        }
    }

    /// Mirror `skyRingColumns` and `skyRingRows` in Shaders/Sky.msl.
    private static let skyRingColumns = 512
    private static let skyRingRows = 16
    /// From the Earth's centre, in metres: past this the sky atmosphere is drawn
    /// as the ring round the globe (`skyRingVertex`), nearer as the whole shell,
    /// which the eye can be inside. 10 % outside the shell.
    private static let skyRingDistance = 1.1 * 1.025 * 6_378_137.0
    /// Mirrors `coneSides` in Shaders/Footprints.msl.
    private static let coneSides = 48

    /// What `setVertexBytes` takes, 4 KB, in the larger of the two instances.
    private static let maximumInlineInstances = 4096 / MemoryLayout<LinkInstance>.stride

    /// This frame's stencils, and how wide each 3D model is drawn, in a buffer
    /// the GPU is not still reading.
    private func pointFrames(at now: Double, models: [ModelPlacement]) -> MTLBuffer? {
        let length = points.count * MemoryLayout<PointFrame>.stride
        guard length > 0 else {
            return nil
        }
        if (pointFrameBuffers[frameIndex]?.length ?? 0) < length {
            pointFrameBuffers[frameIndex] = device.makeBuffer(length: length, options: .storageModeShared)
        }
        guard let buffer = pointFrameBuffers[frameIndex] else {
            return nil
        }
        points.writeFrames(at: now, into: buffer)
        let frames = buffer.contents().bindMemory(to: PointFrame.self, capacity: points.count)
        for model in models where model.index < points.count {
            frames[model.index].modelPoints = Float(model.points)
        }
        return buffer
    }

    private func uniforms(_ drawn: DrawnFrame, pose: CameraPose, judgement: SkyJudgement?) -> FrameUniforms {
        let (viewProjection, size, now) = (drawn.viewProjection, drawn.size, drawn.time)
        let angle = greenwichHourAngle(epochMilliseconds: now)
        let (c, s) = (Float(cos(angle)), Float(sin(angle)))
        let position = pose.position
        let (high, low) = encode(position)
        return FrameUniforms(
            viewProjection: float4x4(viewProjection),
            inverseViewProjection: float4x4(viewProjection.inverse),
            fixedToTEME: simd_float3x3(columns: (SIMD3(c, s, 0), SIMD3(-s, c, 0), SIMD3(0, 0, 1))),
            cameraHigh: high,
            cameraLow: low,
            cameraPosition: SIMD3<Float>(position),
            sunDirection: SIMD3<Float>(Sun.directionFixed(epochMilliseconds: now)),
            viewportSize: SIMD2<Float>(size),
            eyeHeight: Float(pose.eyeHeight),
            // On the map, CesiumJS's camera distance in 2D, which the lighting fades by.
            cameraDistance: Float(pose.mapCamera?.lightingDistance ?? length(position)),
            pointSize: Float(6 * pixelScale),
            pixelScale: Float(pixelScale),
            unseenOpacity: judgement?.uniforms.unseenOpacity ?? 1,
            skyIsDark: judgement?.uniforms.skyIsDark ?? 0,
            mapCentre: pose.mapCamera.map { SIMD2<Float>(Float($0.longitude), Float($0.latitude)) } ?? SIMD2())
    }
}

func float4x4(_ m: simd_double4x4) -> simd_float4x4 {
    simd_float4x4(columns: (SIMD4<Float>(m.columns.0), SIMD4<Float>(m.columns.1), SIMD4<Float>(m.columns.2), SIMD4<Float>(m.columns.3)))
}

extension MTKView {
    /// Pixels per point, on either platform.
    /// The screen's, whatever the view's pixel ratio is set to.
    fileprivate var contentScaleFactorForPoints: CGFloat {
        #if canImport(UIKit)
            traitCollection.displayScale > 0 ? traitCollection.displayScale : contentScaleFactor
        #else
            window?.backingScaleFactor ?? 2
        #endif
    }
}
