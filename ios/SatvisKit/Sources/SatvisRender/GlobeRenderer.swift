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
        let source = try files.map { name in
            guard let url = Bundle.module.url(forResource: name, withExtension: "msl", subdirectory: "Shaders") else {
                throw RendererError.missingShader(name)
            }
            return try String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n")
        func options(_ mode: MTLMathMode) -> MTLCompileOptions {
            let options = MTLCompileOptions()
            options.mathMode = mode
            return options
        }
        return Libraries(
            precise: try await device.makeLibrary(source: source, options: options(.safe)),
            fast: try await device.makeLibrary(source: source, options: options(.fast)))
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

/// Which camera the view is seen through, and so what the gestures steer: the free
/// camera over the globe, or one following a satellite or a ground station. The
/// sky view (M6) is a third.
public enum CameraMode: Sendable, Equatable {
    case orbit
    /// Following what has this id.
    case tracking(String)
    /// On the ground, looking up (ADR 0003).
    case sky
}

/// What the globe's free camera holds still in: the web app's camera modes, by
/// the names its links give them.
public enum CameraFrame: String, Sendable, CaseIterable {
    /// The Earth: the globe stands still on the screen.
    case fixed = "Fixed"
    /// The stars: the Earth turns under the camera, once a sidereal day.
    case inertial = "Inertial"
}

/// Draws the globe, the sky around it, the ground stations on it and the
/// satellites over it, for one MTKView.
@MainActor
public final class GlobeRenderer: NSObject, MTKViewDelegate {
    public private(set) var cameraMode = CameraMode.orbit
    /// Nil until the view has a size, then the web app's home view. Kept while
    /// tracking: shown when what is followed cannot be placed, and gone back to
    /// when tracking stops.
    private var orbitCamera: OrbitCamera?
    private var trackingCamera = TrackingCamera()
    /// The sky view's camera, while it is on the ground.
    public private(set) var skyCamera: SkyCamera?
    /// The flight to or from the sky view, while one is under way.
    private var skyFlight: SkyFlight?
    /// The flight back to the home view, while one is under way: where it set
    /// off, and when.
    private var homeFlight: (from: OrbitCamera, to: OrbitCamera, start: Double)?
    /// The flight into tracking or out of it, while one is under way.
    private var poseFlight: PoseFlight?
    /// What is tracked and may be framed close up on its 3D model: once the
    /// satellite is drawn, as a link tracks one before it is, and its model has
    /// loaded. A gesture since leaves the camera where the user put it.
    private var framingModel: String?
    /// What the web app frames a model by while it has not loaded: a small
    /// satellite's radius, in metres.
    private static let fallbackModelRadius = 2.5
    private static let homeFlightDuration = 1.5
    /// The pose of the last frame, which a flight sets off from.
    private var lastPose: CameraPose?
    /// The terrain as the Map menu has it; the sky view stands on it regardless.
    private var terrainSetting = false
    public var components: SatelliteComponents = [.point, .label]
    /// What the free camera holds still in. Tracking keeps the satellite's own
    /// frame, and the sky view the observer's, so it waits while either is up:
    /// the free camera does not turn meanwhile.
    public var cameraFrame = CameraFrame.fixed {
        didSet { inertialAngle = nil }
    }
    /// The Greenwich hour angle the free camera was last turned to, while inertial.
    private var inertialAngle: Double?
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen = UnseenMode.dim {
        didSet {
            // The crosshair passes over hidden ones: judged again at once.
            skyCache.lockAt = -.infinity
        }
    }
    /// The instant to draw, in UTC milliseconds since 1970.
    public var clock: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    private static let hdrFormat = MTLPixelFormat.rgba16Float
    private static let depthFormat = MTLPixelFormat.depth32Float
    private static let framesInFlight = 3

    private nonisolated let device: MTLDevice
    private let queue: MTLCommandQueue
    private let skyBoxPipeline: MTLRenderPipelineState
    private let skyAtmospherePipeline: MTLRenderPipelineState
    private let skyRingPipeline: MTLRenderPipelineState
    private let globePipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let labelPipeline: MTLRenderPipelineState
    private let stationPipeline: MTLRenderPipelineState
    private let linkPipeline: MTLRenderPipelineState
    private let overlayPipeline: MTLRenderPipelineState
    private let conePipeline: MTLRenderPipelineState
    private let modelPipeline: MTLRenderPipelineState
    /// For a model's blended parts, after every opaque one.
    private let modelBlendPipeline: MTLRenderPipelineState
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
    /// How wide each 3D model was drawn in the last frame, in points, by
    /// satellite: for picking.
    private var lastModelPoints: [Int: Double] = [:]
    /// What the last frame was drawn from, for picking.
    private(set) var lastFrame: (viewProjection: simd_double4x4, position: SIMD3<Double>, size: SIMD2<Double>, time: Double)?
    /// What the sky view's instruments worked out, kept between frames.
    var skyCache = SkyCache()
    private let meter = FrameMeter()

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
        view.colorPixelFormat = .bgra8Unorm
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
        let screenFormat = view.colorPixelFormat
        func pipeline(
            _ vertex: String, _ fragment: String, format: MTLPixelFormat = Self.hdrFormat, depth: Bool = true, blend: Bool = false, premultiplied: Bool = false,
            // A vertex function that places nothing by the high/low split may take
            // fast math too.
            fastVertex: Bool = false
        ) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try function(vertex, in: fastVertex ? libraries.fast : libraries.precise)
            descriptor.fragmentFunction = try function(fragment, in: libraries.fast)
            descriptor.colorAttachments[0].pixelFormat = format
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
        // Blended, for the sky view to dim what cannot be seen.
        pointPipeline = try pipeline("pointVertex", "pointFragment", blend: true)
        linePipeline = try pipeline("lineVertex", "lineFragment", blend: true)
        modelPipeline = try pipeline("modelVertex", "modelFragment")
        modelBlendPipeline = try pipeline("modelVertex", "modelFragment", blend: true)
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
        terrainSetting = enabled
        surface.setTerrain(enabled || cameraMode == .sky)
    }

    /// Stands on the ground at the camera's observer and looks up from there,
    /// over the terrain, which the horizon and the eye's height need. `animated`
    /// flies there; without it, as reduced motion asks, the camera cuts.
    public func enterSky(_ camera: SkyCamera, animated: Bool = true) {
        let now = ProcessInfo.processInfo.systemUptime
        // From wherever a flight into or out of tracking has got to.
        poseFlight = nil
        if var flight = skyFlight, !flight.entering {
            // Turned around on the way out: carry on from where the camera is.
            flight.reverse(at: now)
            skyFlight = flight
        } else if cameraMode != .sky, animated, var from = lastPose, let size = lastFrame?.size {
            from.verticalFieldOfView = from.verticalFieldOfView(aspectRatio: size.x / size.y)
            skyFlight = SkyFlight(globe: from, start: now, entering: true)
        } else if cameraMode != .sky {
            skyFlight = nil
        }
        skyCamera = camera
        cameraMode = .sky
        surface.setTerrain(true)
    }

    /// Back to the globe camera, by the flight in played backwards.
    public func leaveSky(animated: Bool = true) {
        let now = ProcessInfo.processInfo.systemUptime
        if var flight = skyFlight, flight.entering {
            flight.reverse(at: now)
            skyFlight = flight
        } else if animated, skyFlight == nil, cameraMode == .sky, var globe = orbitCamera?.pose(), let size = lastFrame?.size {
            globe.verticalFieldOfView = globe.verticalFieldOfView(aspectRatio: size.x / size.y)
            skyFlight = SkyFlight(globe: globe, start: now, entering: false)
        } else if skyFlight == nil {
            landOnGlobe()
        }
    }

    /// Whether the sky view has landed, and what is on screen is what it aims at.
    /// Its instruments and its gestures wait for this.
    public var isSkySettled: Bool {
        cameraMode == .sky && skyFlight == nil
    }

    private func landOnGlobe() {
        skyFlight = nil
        skyCamera = nil
        cameraMode = .orbit
        surface.setTerrain(terrainSetting)
    }

    /// The device's attitude, in the observer's east, north and up, while the
    /// compass aims the sky view.
    public func setSkyAttitude(_ attitude: simd_quatd) {
        skyCamera?.attitude = attitude
    }

    /// Levels the sky view where it is looking, as handing the aim back to a
    /// finger does (ADR 0004).
    public func levelSky() {
        guard let camera = skyCamera else {
            return
        }
        skyCamera?.attitude = SkyCamera.attitude(azimuth: camera.azimuth, pitch: camera.pitch)
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
        // From the flight out of the sky view too, which lands only while the
        // camera is the sky's: the ground's camera and its forced terrain go.
        if skyFlight != nil || skyCamera != nil {
            skyFlight = nil
            skyCamera = nil
            surface.setTerrain(terrainSetting)
        }
        startPoseFlight(animated)
        cameraMode = .tracking(id)
        trackingCamera = TrackingCamera()
        framingModel = id
        frameModel()
    }

    /// Closes in on the tracked satellite's 3D model, as the web app does while
    /// the model is on: by the model's size once it has loaded, by a small
    /// satellite's meanwhile.
    private func frameModel() {
        guard let id = framingModel, cameraMode == .tracking(id), let satellite = points.satellite(id) else {
            return
        }
        guard components.contains(.model), let file = satellite.modelFile else {
            framingModel = nil
            return
        }
        let model = models.model(file)
        trackingCamera = .framing(modelRadius: model.map { Double($0.radius) } ?? Self.fallbackModelRadius)
        if model != nil {
            framingModel = nil
        }
    }

    /// Lets go, and goes back to the view tracking began from, as the web app
    /// does: the free camera is kept while tracking, through switches from one
    /// satellite to another. `animated` flies back.
    public func stopTracking(animated: Bool = false) {
        if case .tracking = cameraMode {
            startPoseFlight(animated)
        }
        cameraMode = .orbit
    }

    /// From the pose last drawn, which may be partway through another flight.
    private func startPoseFlight(_ animated: Bool) {
        poseFlight = animated ? lastPose.map { PoseFlight(from: $0, start: ProcessInfo.processInfo.systemUptime) } : nil
    }

    /// Back to where the app opens, letting go of what is followed. `animated`
    /// flies there; without it, as reduced motion asks, the camera cuts. Not
    /// from the sky view, which `leaveSky` leaves first.
    public func flyHome(animated: Bool = true) {
        guard cameraMode != .sky, let size = lastFrame?.size else {
            return
        }
        stopTracking(animated: animated)
        let home = OrbitCamera.home(aspectRatio: size.x / size.y)
        if poseFlight != nil {
            // Already flying out of tracking: on to home instead.
            orbitCamera = home
        } else if animated, let orbitCamera {
            homeFlight = (orbitCamera, home, ProcessInfo.processInfo.systemUptime)
        } else {
            orbitCamera = home
        }
    }

    /// A drag of `points` on a view of `size` points: moves the free camera over
    /// the globe, circles what is followed, or turns the sky view.
    public func drag(by points: SIMD2<Double>, viewSize size: CGSize) {
        let longerSide = Double(max(size.width, size.height))
        switch cameraMode {
        case .orbit:
            homeFlight = nil
            orbitCamera?.pan(by: points, longerSide: longerSide)
        case .tracking:
            framingModel = nil
            trackingCamera.orbit(by: points, longerSide: longerSide)
        case .sky where isSkySettled: skyCamera?.drag(by: points, height: Double(size.height))
        case .sky: break
        }
    }

    /// A pinch: nearer for a scale above 1.
    public func zoom(by scale: Double) {
        switch cameraMode {
        case .orbit:
            homeFlight = nil
            orbitCamera?.zoom(by: scale)
        case .tracking:
            framingModel = nil
            trackingCamera.zoom(by: scale)
        case .sky where isSkySettled: skyCamera?.zoom(by: scale)
        case .sky: break
        }
    }

    /// A twist, in radians.
    public func rotate(by radians: Double) {
        switch cameraMode {
        case .orbit:
            homeFlight = nil
            orbitCamera?.rotate(by: radians)
        case .tracking:
            framingModel = nil
            trackingCamera.rotate(by: radians)
        // Only the device's attitude rolls the sky view.
        case .sky: break
        }
    }

    private func position(of id: String, at time: Double) -> SIMD3<Double>? {
        points.position(of: id, at: time) ?? stations.first { $0.id == id }?.position
    }

    /// The ground station or satellite drawn nearest a point on the view, within a
    /// fingertip of it and not behind the Earth. A satellite is its point and its
    /// label (`Picking`). A station's pin wins: it is the larger target, and one
    /// the user put there.
    public func entity(at point: CGPoint, viewSize: CGSize) -> String? {
        guard let lastFrame, viewSize.width > 0 else {
            return nil
        }
        func screenPoint(_ position: SIMD3<Double>) -> CGPoint? {
            let clip = lastFrame.viewProjection * SIMD4(position - lastFrame.position, 1)
            guard clip.w > 0 else {
                return nil
            }
            return CGPoint(x: (clip.x / clip.w + 1) / 2 * viewSize.width, y: (1 - clip.y / clip.w) / 2 * viewSize.height)
        }
        var best: (id: String, score: Double)?
        for station in stations where Self.isAboveHorizon(station.position, from: lastFrame.position) {
            // The pin's head, a little over half its height above the spot.
            if let spot = screenPoint(station.position) {
                let distance = hypot(spot.x - point.x, spot.y - 10 - point.y)
                if distance < Picking.pointReach, distance < best?.score ?? .infinity {
                    best = (station.id, distance)
                }
            }
        }
        if best != nil {
            return best?.id
        }
        guard components.contains(.point) || components.contains(.label) else {
            return nil
        }
        // As Labels.msl places them, in points.
        let labels = components.contains(.label) ? points.prepared?.labels?.atlas.instances : nil
        for (index, satellite) in points.satellites.enumerated() {
            guard let position = satellite.trajectory.position(at: lastFrame.time), !Self.isHiddenByEarth(position, from: lastFrame.position),
                let spot = screenPoint(position)
            else {
                continue
            }
            var label: CGRect?
            let distance = simd.distance(position, lastFrame.position)
            if let labels, index < labels.count, distance > 2000, distance < 8e7 {
                let size = labels[index].size
                let width = Double(size.x)
                let height = Double(size.y)
                let gap = max(10, (lastModelPoints[index] ?? 0) / 2 + 4)
                label = CGRect(x: spot.x + gap, y: spot.y - height / 2, width: width, height: height)
            }
            let reach = (lastModelPoints[index] ?? 0) / 2
            if let score = Picking.score(of: point, point: spot, label: label, reach: reach), score < best?.score ?? .infinity {
                best = (satellite.id, score)
            }
        }
        return best?.id
    }

    /// Where on the ellipsoid a point on the view lands, in degrees; nil off the
    /// globe.
    public func groundPoint(at point: CGPoint, viewSize: CGSize) -> (latitude: Double, longitude: Double)? {
        guard let lastFrame, viewSize.width > 0, viewSize.height > 0 else {
            return nil
        }
        let ndc = SIMD2(2 * point.x / viewSize.width - 1, 1 - 2 * point.y / viewSize.height)
        let inverse = lastFrame.viewProjection.inverse
        let far = inverse * SIMD4(ndc.x, ndc.y, 0.5, 1)
        let direction = normalize(SIMD3(far.x, far.y, far.z) / far.w)
        // In a frame where the ellipsoid is the unit sphere.
        let origin = lastFrame.position / ellipsoidRadii
        let scaled = direction / ellipsoidRadii
        let a = dot(scaled, scaled)
        let b = 2 * dot(origin, scaled)
        let c = dot(origin, origin) - 1
        let discriminant = b * b - 4 * a * c
        guard discriminant >= 0 else {
            return nil
        }
        let t = (-b - discriminant.squareRoot()) / (2 * a)
        guard t > 0 else {
            return nil
        }
        return geodetic(lastFrame.position + t * direction)
    }

    /// Whether a point on the surface faces the eye.
    private static func isAboveHorizon(_ point: SIMD3<Double>, from eye: SIMD3<Double>) -> Bool {
        dot(point / (ellipsoidRadii * ellipsoidRadii), eye - point) > 0
    }

    /// Whether the line of sight to a point passes through the Earth, taken as a
    /// sphere of its polar radius.
    private static func isHiddenByEarth(_ point: SIMD3<Double>, from eye: SIMD3<Double>) -> Bool {
        let direction = point - eye
        let length = simd.length(direction)
        let unit = direction / length
        let closest = -dot(eye, unit)
        guard closest > 0, closest < length else {
            return false
        }
        return simd.length(eye + closest * unit) < ellipsoidRadii.z
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            return
        }
        if view.bounds.width > 0 {
            pixelScale = Double(size.width / view.bounds.width)
        }
        if orbitCamera == nil {
            orbitCamera = OrbitCamera.home(aspectRatio: size.width / size.height)
        }
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

    public func draw(in view: MTKView) {
        guard var orbitCamera, let hdr, let depth else {
            return
        }
        let measuring = measuresFrames
        let started = measuring ? ProcessInfo.processInfo.systemUptime : 0
        let now = clock()
        if let flight = homeFlight {
            // Called off by anything else the camera is asked to do.
            let t = (ProcessInfo.processInfo.systemUptime - flight.start) / Self.homeFlightDuration
            if cameraMode == .orbit {
                orbitCamera = OrbitCamera.between(flight.from, flight.to, t: t)
                self.orbitCamera = orbitCamera
            }
            if t >= 1 || cameraMode != .orbit {
                homeFlight = nil
            }
        }
        if cameraFrame == .inertial, cameraMode == .orbit {
            // Turned back by as far as the Earth has turned since, in whichever
            // direction the clock went; not mid-flight home, which sets the camera.
            let angle = greenwichHourAngle(epochMilliseconds: now)
            if let last = inertialAngle, homeFlight == nil {
                orbitCamera.holdInertial(from: last, to: angle)
                self.orbitCamera = orbitCamera
            }
            inertialAngle = angle
        } else {
            inertialAngle = nil
        }
        var pose = orbitCamera.pose()
        frameModel()
        if case .tracking(let id) = cameraMode, let target = position(of: id, at: now) {
            pose = trackingCamera.pose(target: target)
        }
        if let flight = poseFlight {
            let uptime = ProcessInfo.processInfo.systemUptime
            if cameraMode != .sky {
                pose = PoseFlight.pose(from: flight.from, to: pose, t: flight.progress(at: uptime))
            }
            if flight.isOver(at: uptime) || cameraMode == .sky {
                poseFlight = nil
            }
        }
        if cameraMode == .sky, var camera = skyCamera {
            // Up at once out of the ground; down gently onto finer terrain as it loads.
            if let ground = surface.groundHeight(latitude: camera.latitude, longitude: camera.longitude) {
                camera.groundHeight = ground > camera.groundHeight ? ground : camera.groundHeight + (ground - camera.groundHeight) * 0.1
                skyCamera = camera
            }
            pose = camera.pose()
            if let flight = skyFlight {
                let uptime = ProcessInfo.processInfo.systemUptime
                var over = SkyCamera(latitude: camera.latitude, longitude: camera.longitude, azimuth: camera.azimuth, pitch: -.pi / 2)
                over.groundHeight = camera.groundHeight
                pose = SkyFlight.pose(from: flight.globe, to: pose, over: over.pose(), t: flight.progress(at: uptime))
                if flight.isOver(at: uptime) {
                    if flight.entering {
                        skyFlight = nil
                    } else {
                        landOnGlobe()
                    }
                }
            }
        }
        lastPose = pose
        let waitStarted = measuring ? ProcessInfo.processInfo.systemUptime : 0
        inFlight.wait()
        let waited = measuring ? ProcessInfo.processInfo.systemUptime - waitStarted : 0
        // Taken only once a frame is free: taken before, a drawable was held while
        // the main thread waited on a GPU running behind (every orbit on).
        guard let drawable = view.currentDrawable, let screen = view.currentRenderPassDescriptor, let commands = queue.makeCommandBuffer() else {
            inFlight.signal()
            return
        }
        let semaphore = inFlight
        commands.addCompletedHandler { _ in semaphore.signal() }
        if measuring {
            let meter = meter
            commands.addCompletedHandler { buffer in meter.gpu(seconds: buffer.gpuEndTime - buffer.gpuStartTime) }
        }
        frameIndex = (frameIndex + 1) % Self.framesInFlight

        // From the ground, once it has landed, as the instruments wait to.
        let judgement = isSkySettled ? skyCamera.map { SkyJudgement(camera: $0, at: now, unseen: unseen) } : nil
        var frame = uniforms(pose: pose, size: SIMD2(Double(hdr.width), Double(hdr.height)), now: now, judgement: judgement)
        let placements =
            components.contains(.model) ? modelPlacements(pose: pose, size: SIMD2(Double(hdr.width), Double(hdr.height)), now: now, judgement: judgement) : []
        lastModelPoints = Dictionary(placements.map { ($0.index, $0.points) }, uniquingKeysWith: max)
        overlay.encode(commands, pipeline: overlayPipeline, satellites: points.satellites, at: now, enabled: components.contains(.groundTrack), device: device)
        var surfaceTiles: [Surface.Tile] = []
        if let imagery, let lastFrame {
            let selection = surface.select(
                eye: pose.position, viewProjection: lastFrame.viewProjection, viewportHeightPixels: Double(hdr.height),
                verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: Double(hdr.width) / Double(hdr.height)), pixelsPerPoint: pixelScale)
            // What is drawn now first, then the children waiting to replace it.
            let drawn = Set(selection.draw.map(\.key))
            let bakes = selection.bake.filter { drawn.contains($0.key) } + selection.bake.filter { !drawn.contains($0.key) }
            surface.encodeBakes(bakes, base: imagery, commands: commands)
            surfaceTiles = selection.draw.filter { $0.texture != nil }
        }

        let scene = MTLRenderPassDescriptor()
        scene.colorAttachments[0].texture = hdr
        scene.colorAttachments[0].loadAction = .clear
        scene.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        scene.colorAttachments[0].storeAction = tonemapTilePipeline == nil ? .store : .dontCare
        if tonemapTilePipeline != nil {
            scene.colorAttachments[1].texture = drawable.texture
            scene.colorAttachments[1].loadAction = .dontCare
            scene.colorAttachments[1].storeAction = .store
        }
        scene.depthAttachment.texture = depth
        scene.depthAttachment.loadAction = .clear
        scene.depthAttachment.clearDepth = 0
        scene.depthAttachment.storeAction = .dontCare
        if let encoder = commands.makeRenderCommandEncoder(descriptor: scene) {
            encoder.setFrontFacing(.counterClockwise)
            encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
            encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)

            if !surfaceTiles.isEmpty {
                encoder.setRenderPipelineState(globePipeline)
                encoder.setDepthStencilState(depthWrite)
                encoder.setCullMode(.back)
                encoder.setFragmentTexture(overlay.texture, index: 1)
                encoder.setFragmentSamplerState(tileSampler, index: 0)
                for tile in surfaceTiles {
                    var centre = SIMD3<Float>(tile.centre - pose.position)
                    encoder.setVertexBytes(&centre, length: MemoryLayout<SIMD3<Float>>.stride, index: 2)
                    encoder.setVertexBuffer(surface.vertices(tile), offset: 0, index: 0)
                    encoder.setFragmentTexture(tile.texture, index: 0)
                    encoder.drawIndexedPrimitives(type: .triangle, indexCount: surface.indexCount, indexType: .uint32, indexBuffer: surface.indexBuffer, indexBufferOffset: 0)
                }
            }

            drawModels(encoder, placements, frame: frame)

            // Behind the globe and the models, drawn after them so that only the
            // sky they leave is shaded: half the screen and more, close up.
            if let stars {
                encoder.setRenderPipelineState(skyBoxPipeline)
                encoder.setDepthStencilState(depthEmpty)
                encoder.setCullMode(.none)
                encoder.setFragmentTexture(stars, index: 0)
                encoder.setFragmentSamplerState(linearSampler, index: 0)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }
            // The shell's far side, where the globe stands in front of it, fails
            // the depth test.
            encoder.setDepthStencilState(depthTest)
            if simd_length(pose.position) > Self.skyRingDistance {
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

            // Under the satellites and their names: a pin marks the ground.
            drawStations(encoder, eye: pose.position, now: now)

            if let samples = points.prepared?.samples, let instances = points.prepared?.instances, let states = pointFrames(at: now, models: placements) {
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
                    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 2 * 121, instanceCount: points.count)
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
            if let tonemapTilePipeline {
                encoder.setRenderPipelineState(tonemapTilePipeline)
                encoder.setDepthStencilState(noDepth)
                encoder.setCullMode(.none)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }
            encoder.endEncoding()
        }

        if tonemapTilePipeline == nil, let encoder = commands.makeRenderCommandEncoder(descriptor: screen) {
            encoder.setRenderPipelineState(tonemapPipeline)
            encoder.setFragmentTexture(hdr, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
        }
        commands.present(drawable)
        commands.commit()
        if measuring {
            let ended = ProcessInfo.processInfo.systemUptime
            meter.frame(cpuSeconds: ended - started - waited, at: ended, satellites: points.count)
        }
    }

    /// The links of the passes under way, then the pins of the stations facing
    /// the eye. Few enough to go in with the draw call.
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

    private func drawModels(_ encoder: MTLRenderCommandEncoder, _ placements: [ModelPlacement], frame: FrameUniforms) {
        guard !placements.isEmpty, let lastFrame else {
            return
        }
        encoder.setFragmentSamplerState(tileSampler, index: 0)
        // The opaque and cut-out parts, writing depth, then the blended ones over
        // them, testing it: as CesiumJS draws glTF's translucent parts. A model the
        // sky view dims is blended whole.
        for blended in [false, true] {
            encoder.setRenderPipelineState(blended ? modelBlendPipeline : modelPipeline)
            encoder.setDepthStencilState(blended ? depthTest : depthWrite)
            for placement in placements {
                encoder.setVertexBuffer(placement.model.vertices, offset: 0, index: 0)
                for part in placement.model.parts where (part.material.alphaMode == .blend || placement.opacity < 1) == blended {
                    var cutoff: Float = 0
                    if case .mask(let value) = part.material.alphaMode {
                        cutoff = value
                    }
                    var instance = ModelInstance(
                        modelViewProjection: float4x4(lastFrame.viewProjection * placement.toEye), rotation: placement.rotation,
                        modelToEye: float4x4(placement.toEye), baseColor: part.material.baseColor, sunDirection: frame.sunDirection,
                        hasTexture: part.texture == nil ? 0 : 1, metallic: part.material.metallic, roughness: part.material.roughness, alphaCutoff: cutoff,
                        opacity: placement.opacity)
                    encoder.setCullMode(part.material.doubleSided ? .none : .back)
                    encoder.setVertexBytes(&instance, length: MemoryLayout<ModelInstance>.stride, index: 1)
                    encoder.setFragmentBytes(&instance, length: MemoryLayout<ModelInstance>.stride, index: 1)
                    encoder.setFragmentTexture(part.texture, index: 0)
                    encoder.drawIndexedPrimitives(
                        type: .triangle, indexCount: part.indexCount, indexType: .uint32, indexBuffer: placement.model.indices,
                        indexBufferOffset: part.indexStart * MemoryLayout<UInt32>.stride)
                }
            }
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
        let pins = stations.filter { Self.isAboveHorizon($0.position, from: eye) }.prefix(Self.maximumInlineInstances).map {
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

    private func uniforms(pose: CameraPose, size: SIMD2<Double>, now: Double, judgement: SkyJudgement?) -> FrameUniforms {
        let viewProjection = pose.projection(aspectRatio: size.x / size.y) * pose.view()
        lastFrame = (viewProjection, pose.position, size, now)
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
            pointSize: Float(7 * pixelScale),
            pixelScale: Float(pixelScale),
            unseenOpacity: judgement?.uniforms.unseenOpacity ?? 1,
            skyIsDark: judgement?.uniforms.skyIsDark ?? 0)
    }
}

private func float4x4(_ m: simd_double4x4) -> simd_float4x4 {
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
