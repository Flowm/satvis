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
    static let files = ["Common", "Sky", "Globe", "Surface", "Points", "Lines", "Labels", "Stations", "Footprints", "Models", "Tonemap"]

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

/// What is drawn for each satellite: the web app's satellite components, those
/// this milestone draws.
public struct SatelliteComponents: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let point = SatelliteComponents(rawValue: 1 << 0)
    public static let label = SatelliteComponents(rawValue: 1 << 1)
    public static let orbit = SatelliteComponents(rawValue: 1 << 2)
    public static let orbitTrack = SatelliteComponents(rawValue: 1 << 3)
    public static let groundTrack = SatelliteComponents(rawValue: 1 << 4)
    public static let sensorCone = SatelliteComponents(rawValue: 1 << 5)
    /// For the satellites a model manifest gives a model (ADR 0007).
    public static let model = SatelliteComponents(rawValue: 1 << 6)
    public static let groundStationLink = SatelliteComponents(rawValue: 1 << 7)

    /// Past these many active satellites the web app switches a component off,
    /// once, on the crossing (`COMPONENT_BUDGETS`): labels stop being readable,
    /// every link is a line, and every model is drawn alone. Only a satellite with
    /// a model file counts against the models' budget. Labels past theirs are not
    /// drawn here even when switched back on: their atlas would outgrow a texture.
    public static let labelBudget = 200
    public static let linkBudget = 500
    public static let modelBudget = 200
    public static let budgets: [(component: SatelliteComponents, limit: Int)] = [(.label, labelBudget), (.groundStationLink, linkBudget), (.model, modelBudget)]

    /// The web app's names, as its `elements` url parameter and presets use them.
    public static let named: [(String, SatelliteComponents)] = [
        ("Point", .point), ("Label", .label), ("Orbit", .orbit), ("Orbit track", .orbitTrack), ("Ground track", .groundTrack), ("Sensor cone", .sensorCone), ("3D model", .model),
        ("Ground station link", .groundStationLink),
    ]
}

/// Draws the globe, the sky around it, the ground stations on it and the
/// satellites over it, for one MTKView.
@MainActor
public final class GlobeRenderer: NSObject, MTKViewDelegate {
    /// The cameras, their flights and what the gestures steer. Whatever it asks
    /// of the terrain is applied here alone, after every change.
    private var rig = CameraRig() {
        didSet { surface.setTerrain(rig.wantsTerrain) }
    }
    /// Which camera the view is seen through (`CameraRig`).
    public var cameraMode: CameraMode { rig.cameraMode }
    /// The sky view's camera, while it is on the ground.
    public var skyCamera: SkyCamera? { rig.skyCamera }
    /// A line's triangle strip, two vertices a point: `lineNodes` samples in
    /// Shaders/Lines.msl, and where the satellite is now between two of them.
    private static let lineVertices = 2 * (121 + 1)
    /// Past this many satellites, where one orbit is no longer told from the next,
    /// a line small on the screen steps over samples (`lineStride` in
    /// Shaders/Lines.msl): with every active one's orbit on, an iPad mini drew
    /// 36 frames a second with every sample and 43 with these steps.
    private static let lineLevelOfDetailSatellites = 1000
    public var components: SatelliteComponents = [.point, .label]
    /// What the free camera holds still in. Tracking keeps the satellite's own
    /// frame, and the sky view the observer's, so it waits while either is up:
    /// the free camera does not turn meanwhile.
    public var cameraFrame: CameraFrame {
        get { rig.cameraFrame }
        set { rig.cameraFrame = newValue }
    }
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen = UnseenMode.dim {
        didSet {
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
        set { rig.passthrough = newValue }
    }
    /// The instant to draw, in UTC milliseconds since 1970.
    public var clock: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

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

    /// The frames' averages over the last half second, while measured.
    public var frameStats: FrameStats? { measuresFrames ? meter.stats : nil }

    /// Records every frame until `stopRecordingFrames`, measuring meanwhile.
    public func startRecordingFrames() {
        measuresFrames = true
        meter.startRecording()
    }

    public func stopRecordingFrames() -> FrameRecording {
        meter.stopRecording()
    }

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
        points.install(prepared)
        overlay.isStale = true
    }

    /// The base map, the site the shipped one's finer levels come from, and a
    /// daily one's day (`GIBS.frame`).
    public func setImagery(_ layer: BaseLayer, site: URL, frame: String? = nil) {
        surface.setLayer(layer, site: site, frame: frame)
    }

    /// Whether the globe follows Re:Earth's terrain. Off by default, as on the web.
    public func setTerrain(_ enabled: Bool) {
        rig.terrainSetting = enabled
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
    }

    /// The ground station links, each drawn while its pass lasts and the component
    /// is on.
    public func setLinks(_ links: [StationLink]) {
        self.links = links
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
        guard components.contains(.model), let file = satellite.modelFile else {
            return .noModel
        }
        return models.model(file).map { .loaded(radius: Double($0.radius)) } ?? .loading
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
    /// fingertip of it and not behind the Earth (`DrawnFrame.entity`).
    public func entity(at point: CGPoint, viewSize: CGSize) -> String? {
        lastFrame?.entity(
            at: point, viewSize: viewSize, stations: stations, satellites: points.installed, components: components,
            labels: points.prepared?.labels?.atlas.instances)
    }

    /// Where on the ellipsoid a point on the view lands, in degrees; nil off the
    /// globe.
    public func groundPoint(at point: CGPoint, viewSize: CGSize) -> (latitude: Double, longitude: Double)? {
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

    public func draw(in view: MTKView) {
        // A drawable can be read only from a view asked for readable ones, which
        // cannot keep them in tile memory: asked for one frame, and back after.
        view.framebufferOnly = snapshotRequest == nil
        guard rig.orbitCamera != nil, let hdr, let depth else {
            return
        }
        let measuring = measuresFrames
        let started = measuring ? ProcessInfo.processInfo.systemUptime : 0
        let now = clock()
        let size = SIMD2(Double(hdr.width), Double(hdr.height))
        let pose = rig.pose(
            uptime: ProcessInfo.processInfo.systemUptime, time: now, aspectRatio: size.x / size.y, model: { self.trackedModel($0) },
            target: { self.position(of: $0, at: now) }, groundHeight: { self.surface.groundHeight(latitude: $0.latitude, longitude: $0.longitude) })
        guard let pose else {
            return
        }
        guard let target = beginFrame(view, measuring: measuring) else {
            return
        }
        let commands = target.commands
        let plan = prepareFrame(pose: pose, size: size, now: now, commands: commands)
        encodeScene(plan, commands: commands, hdr: hdr, depth: depth, screen: target.drawable.texture)
        if tonemapTilePipeline == nil {
            encodeTonemapPass(commands, screen: target.screen, hdr: hdr)
        }
        encodeSnapshot(of: target.drawable, into: commands)
        commands.present(target.drawable)
        commands.commit()
        if measuring {
            let ended = ProcessInfo.processInfo.systemUptime
            meter.frame(
                cpuSeconds: ended - started - target.waitedForBuffer - target.waitedForDrawable, bufferWaitSeconds: target.waitedForBuffer,
                drawableWaitSeconds: target.waitedForDrawable, at: ended, satellites: points.count)
        }
    }

    /// A command buffer once one of the frames in flight is free, and the drawable
    /// it ends on, with how long each was waited for while measuring; nil, the
    /// frame given back, where either is missing.
    private func beginFrame(_ view: MTKView, measuring: Bool) -> (
        commands: MTLCommandBuffer, drawable: CAMetalDrawable, screen: MTLRenderPassDescriptor, waitedForBuffer: Double, waitedForDrawable: Double
    )? {
        let waitStarted = measuring ? ProcessInfo.processInfo.systemUptime : 0
        inFlight.wait()
        let waitedForBuffer = measuring ? ProcessInfo.processInfo.systemUptime - waitStarted : 0
        // Taken only once a frame is free: taken before, a drawable was held while
        // the main thread waited on a GPU running behind (every orbit on).
        let drawableStarted = measuring ? ProcessInfo.processInfo.systemUptime : 0
        let currentDrawable = view.currentDrawable
        let waitedForDrawable = measuring ? ProcessInfo.processInfo.systemUptime - drawableStarted : 0
        guard let drawable = currentDrawable, let screen = view.currentRenderPassDescriptor, let commands = queue.makeCommandBuffer() else {
            inFlight.signal()
            return nil
        }
        let semaphore = inFlight
        let faults = faults
        commands.addCompletedHandler { buffer in
            semaphore.signal()
            if buffer.status == .error {
                faults.record(buffer.error)
            }
        }
        if measuring {
            let meter = meter
            commands.addCompletedHandler { buffer in meter.gpu(seconds: buffer.gpuEndTime - buffer.gpuStartTime) }
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
        if let imagery {
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

    /// A 3D model where it is drawn this frame.
    private struct ModelPlacement {
        var index: Int
        var model: PreparedModel
        /// The model's frame to the eye's, scaled: metres from the eye.
        var toEye: simd_double4x4
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
        let tangent = tan(pose.verticalFieldOfView(aspectRatio: aspectRatio) / 2)
        let homeMetresPerPoint = 2 * OrbitCamera.home(aspectRatio: aspectRatio).radius * tangent / heightPoints
        return prepared.modelled.compactMap { index in
            let satellite = prepared.satellites[index]
            guard let file = satellite.modelFile, let model = models.model(file), let position = satellite.trajectory.position(at: now),
                let before = satellite.trajectory.position(at: now - 1000), let after = satellite.trajectory.position(at: now + 1000)
            else {
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
            let diameter = 2 * Double(model.radius)
            let minimum = Self.modelMinimumPoints(diameter: diameter)
            let metresPerPoint = 2 * simd.distance(position, pose.position) * tangent / heightPoints
            let scale = min(max(1, minimum * metresPerPoint / diameter), minimum * homeMetresPerPoint / diameter)
            return ModelPlacement(
                index: index, model: model,
                toEye: simd_double4x4(columns: (SIMD4(port * scale, 0), SIMD4(up * scale, 0), SIMD4(forward * scale, 0), SIMD4(position - pose.position, 1))),
                rotation: simd_float3x3(columns: (SIMD3<Float>(port), SIMD3<Float>(up), SIMD3<Float>(forward))),
                points: diameter * scale / metresPerPoint, opacity: Float(opacity))
        }
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
                modelToEye: float4x4(placement.toEye), baseColor: .one, sunDirection: frame.sunDirection, hasTexture: 0, metallic: 0,
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
    static func modelMinimumPoints(diameter: Double) -> Double {
        min(72, max(20, 23 * cbrt(diameter)))
    }

    /// The links of the passes under way, then the pins of the stations facing
    /// the eye. Few enough to go in with the draw call.
    private func drawStations(_ encoder: MTLRenderCommandEncoder, eye: SIMD3<Double>, now: Double) {
        func relative(_ position: SIMD3<Double>) -> (Float, Float, Float) {
            let offset = position - eye
            return (Float(offset.x), Float(offset.y), Float(offset.z))
        }
        if components.contains(.groundStationLink) {
            let instances = links.filter { $0.start <= now && now <= $0.end }.compactMap { link in
                points.position(of: link.satellite, at: now).map { LinkInstance(satellite: relative($0), station: relative(link.station)) }
            }.prefix(Self.maximumInlineInstances)
            if !instances.isEmpty {
                encoder.setRenderPipelineState(linkPipeline)
                encoder.setDepthStencilState(depthTest)
                encoder.setCullMode(.none)
                Array(instances).withUnsafeBytes { encoder.setVertexBytes($0.baseAddress!, length: $0.count, index: 2) }
                encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: instances.count)
            }
        }
        let pins = stations.filter { isAboveHorizon($0.position, from: eye) }.prefix(Self.maximumInlineInstances).map {
            StationInstance(position: relative($0.position), distance: Float(simd.distance($0.position, eye)))
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
            cameraDistance: Float(length(position)),
            pointSize: Float(6 * pixelScale),
            pixelScale: Float(pixelScale),
            unseenOpacity: judgement?.uniforms.unseenOpacity ?? 1,
            skyIsDark: judgement?.uniforms.skyIsDark ?? 0)
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
