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
    var cameraMode: CameraMode { rig.cameraMode }
    /// The sky view's camera, while it is on the ground.
    public var skyCamera: SkyCamera? { rig.skyCamera }
    public var components: SatelliteComponents = [.point, .label] {
        didSet {
            keepModelsInUse()
            pacer.needsDraw = true
            if !components.contains(.model) {
                placer.reset()
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
            pacer.needsDraw = true
        }
    }
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen = UnseenMode.dim {
        didSet {
            pacer.needsDraw = true
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
            pacer.needsDraw = true
        }
    }
    /// The instant to draw `ahead` seconds from now, in UTC milliseconds since
    /// 1970: a frame is drawn for when it will be shown (`FramePresentation`).
    public var clock: (_ ahead: Double) -> Double = wallClock {
        didSet { pacer.needsDraw = true }
    }

    /// The device's own clock, for `clock`.
    public static let wallClock: @Sendable (_ ahead: Double) -> Double = { (Date().timeIntervalSince1970 + $0) * 1000 }

    private static let framesInFlight = 3

    private nonisolated let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipelines: ScenePipelines
    private let overlay: GroundOverlay
    let surface: Surface
    private var imagery: MTLTexture?
    private var stars: MTLTexture?
    private var hdr: MTLTexture?
    private var depth: MTLTexture?
    let points = SatellitePoints()
    let models: SatelliteModels
    private var placer = ModelPlacer()
    private var pacer = FramePacer()
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

    /// The last frame of the other projection, fading out over the frames since
    /// the change.
    private var fade: ProjectionFade
    /// Counts what came in for the tiles, the models and the ground tracks, each
    /// counting up alone.
    private var contentRevision: Int { surface.revision + models.revision + overlay.revision }
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
        pacer.needsDraw = true
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
        view.colorPixelFormat = ScenePipelines.screenFormat
        view.depthStencilPixelFormat = .invalid
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

        pipelines = try ScenePipelines(device: device, libraries: libraries, viewFormat: view.colorPixelFormat)
        fade = ProjectionFade(pipeline: pipelines.fadePipeline)
        guard let overlay = GroundOverlay(device: device) else {
            throw RendererError.noDevice
        }
        self.overlay = overlay
        surface = try Surface(device: device, library: libraries.precise, site: URL(string: "https://satvis.space/")!)
        models = SatelliteModels(device: device)
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
                self.pacer.needsDraw = true
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
                self.pacer.needsDraw = true
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
        placer.keep(prepared)
        points.install(prepared)
        keepModelsInUse()
        overlay.isStale = true
        pacer.needsDraw = true
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
        pacer.needsDraw = true
    }

    /// Whether the globe follows Re:Earth's terrain, the sky view's ground too.
    /// Off by default, as on the web.
    public func setTerrain(_ enabled: Bool) {
        surface.setTerrain(enabled)
        pacer.needsDraw = true
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
        pacer.needsDraw = true
    }

    /// The ground station links, each drawn while its pass lasts and the component
    /// is on.
    public func setLinks(_ links: [StationLink]) {
        self.links = links
        pacer.needsDraw = true
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
        let level = min(placer.levels[id] ?? model.lods.count, model.lods.count)
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
        pacer.needsDraw = true
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
            if pipelines.tonemapTilePipeline != nil {
                descriptor.usage = .renderTarget
                descriptor.storageMode = .memoryless
            } else {
                descriptor.usage = [.renderTarget, .shaderRead]
                descriptor.storageMode = .private
            }
            return device.makeTexture(descriptor: descriptor)
        }
        hdr = target(ScenePipelines.hdrFormat)
        depth = target(ScenePipelines.depthFormat)
        pacer.needsDraw = true
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
            target: { self.position(of: $0, at: $1) }, groundHeight: { self.surface.groundHeight($0) })
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
            pacer.needsDraw = true
            return
        }
        let commands = target.commands
        let plan = prepareFrame(pose: pose, size: size, now: now, commands: commands)
        let scene = ScenePass(
            pipelines: pipelines, surface: surface, overlay: overlay, points: points, stars: stars, pin: pin, stations: stations, links: links,
            components: components, cameraMode: cameraMode,
            // Only once landed: the flight shows the globe from space.
            showsCamera: passthrough != nil && isSkySettled)
        scene.encode(plan, commands: commands, hdr: hdr, depth: depth, screen: target.drawable.texture)
        if pipelines.tonemapTilePipeline == nil {
            scene.encodeTonemapPass(commands, screen: target.screen, hdr: hdr)
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

    /// Whether the frame has to be drawn (`FramePacer`): every frame is, while
    /// measured, in the sky view and while tracking.
    private func mustDraw(pose: CameraPose, time: Double, size: SIMD2<Double>) -> Bool {
        let paced =
            (!measuresFrames || recordsIdle) && snapshotRequest == nil && cameraMode == .orbit && !fade.isFading && rig.drawnProjection == rig.shownProjection
        return pacer.mustDraw(
            pose: pose, time: time, paced: paced, settled: surface.isSettled, content: contentRevision,
            pixelRate: { FramePacer.pixelRate(points, components: components, links: links, pose: pose, time: time, size: size) },
            linkSpan: { FramePacer.linkSpan(links, shown: components.contains(.groundStationLink), around: time) })
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

    /// The frame's uniforms and what it places, and the passes ahead of the
    /// scene's that it samples: the ground overlay and the tiles' textures.
    private func prepareFrame(pose: CameraPose, size: SIMD2<Double>, now: Double, commands: MTLCommandBuffer) -> FramePlan {
        // From the ground, once it has landed, as the instruments wait to.
        let judgement = isSkySettled ? skyCamera.map { SkyJudgement(camera: $0, at: now, unseen: unseen) } : nil
        var tracked: String?
        if case .tracking(let id) = cameraMode {
            tracked = id
        }
        let placements =
            components.contains(.model)
            ? placer.placements(
                of: points.prepared, models: models, pose: pose, size: size, pixelScale: pixelScale, now: now, tracked: tracked, judgement: judgement) : []
        let drawnFrame = DrawnFrame(
            pose: pose, size: size, time: now, modelWidths: Dictionary(placements.map { ($0.index, $0.points) }, uniquingKeysWith: max))
        lastFrame = drawnFrame
        var frame = uniforms(drawnFrame, pose: pose, judgement: judgement)
        if case .tracking(let id) = cameraMode, let index = points.index(of: id), let target = points.position(of: id, at: now) {
            frame.focus = Int32(index)
            frame.focusRelative = SIMD3<Float>(target - pose.position)
        }
        overlay.encode(commands, pipeline: pipelines.overlayPipeline, satellites: points.satellites, at: now, enabled: components.contains(.groundTrack), device: device)
        var surfaceTiles: [Surface.Tile] = []
        if let imagery {
            let selection =
                if let map = pose.mapCamera {
                    surface.selectMap(map, viewportPixels: size)
                } else {
                    surface.select(
                        eye: pose.position, viewProjection: drawnFrame.viewProjection, viewportHeightPixels: size.y,
                        verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: size.x / size.y), pixelsPerPoint: pixelScale)
                }
            // What is drawn now first, then the children waiting to replace it.
            let drawn = Set(selection.draw.map(\.key))
            let bakes = selection.bake.filter { drawn.contains($0.key) } + selection.bake.filter { !drawn.contains($0.key) }
            surface.encodeBakes(bakes, base: imagery, commands: commands)
            surfaceTiles = selection.draw.filter { $0.texture != nil }
        }
        let pointFrames = points.prepared?.samples != nil && points.prepared?.instances != nil ? pointFrames(at: now, models: placements) : nil
        return FramePlan(
            uniforms: frame, pose: pose, drawn: drawnFrame, placements: placements, surfaceTiles: surfaceTiles, pointFrames: pointFrames)
    }

    /// Keeps the frame just drawn, the last of the old projection, to fade from,
    /// and draws the new one from the next frame on.
    private func keepFrame(_ drawable: MTLTexture, commands: MTLCommandBuffer, at uptime: Double) {
        rig.showProjection()
        pacer.needsDraw = true
        fade.keep(drawable, commands: commands, device: device, at: uptime)
    }

    /// The kept frame over the screen, fading out.
    private func encodeFade(onto screen: MTLTexture, commands: MTLCommandBuffer, at uptime: Double) {
        if fade.encode(onto: screen, commands: commands, at: uptime) {
            pacer.needsDraw = true
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
            eyeHeight: Float(heightAboveEllipsoid(pose.position)),
            // On the map, CesiumJS's camera distance in 2D, which the lighting fades by.
            cameraDistance: Float(pose.mapCamera?.lightingDistance ?? length(position)),
            pointSize: Float(6 * pixelScale),
            pixelScale: Float(pixelScale),
            unseenOpacity: judgement?.uniforms.unseenOpacity ?? 1,
            skyIsDark: judgement?.uniforms.skyIsDark ?? 0,
            mapCentre: pose.mapCamera.map { SIMD2<Float>(Float($0.longitude), Float($0.latitude)) } ?? SIMD2())
    }
}

extension MTLDevice {
    /// A new buffer holding a copy of `array`.
    func makeBuffer<Element>(copying array: [Element]) -> MTLBuffer? {
        array.withUnsafeBytes { makeBuffer(bytes: $0.baseAddress!, length: $0.count) }
    }
}

extension MTLLibrary {
    /// The function called `name`, or an error naming it.
    func function(_ name: String) throws -> MTLFunction {
        guard let function = makeFunction(name: name) else {
            throw RendererError.missingFunction(name)
        }
        return function
    }
}

extension MTLRenderPipelineColorAttachmentDescriptor {
    /// Source over: alpha-weighted, or as is for a premultiplied source.
    func blendOver(premultiplied: Bool = false) {
        isBlendingEnabled = true
        sourceRGBBlendFactor = premultiplied ? .one : .sourceAlpha
        destinationRGBBlendFactor = .oneMinusSourceAlpha
        sourceAlphaBlendFactor = .one
        destinationAlphaBlendFactor = .oneMinusSourceAlpha
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
