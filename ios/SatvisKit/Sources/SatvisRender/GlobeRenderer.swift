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
    static let files = ["Common", "Sky", "Globe", "Surface", "Points", "Lines", "Labels", "Stations", "Footprints", "Tonemap"]

    static func make(device: MTLDevice) async throws -> MTLLibrary {
        let source = try files.map { name in
            guard let url = Bundle.module.url(forResource: name, withExtension: "msl", subdirectory: "Shaders") else {
                throw RendererError.missingShader(name)
            }
            return try String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n")
        let options = MTLCompileOptions()
        // Fast math may regroup the high/low subtraction relativeToEye depends on.
        options.mathMode = .safe
        return try await device.makeLibrary(source: source, options: options)
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
    public static let groundStationLink = SatelliteComponents(rawValue: 1 << 7)

    /// Past these many satellites a component is not drawn, as the web app
    /// switches it off: labels stop being readable, and every link is a line.
    public static let labelBudget = 200
    public static let linkBudget = 500

    /// The web app's names, as its `elements` url parameter and presets use them.
    public static let named: [(String, SatelliteComponents)] = [
        ("Point", .point), ("Label", .label), ("Orbit", .orbit), ("Orbit track", .orbitTrack), ("Ground track", .groundTrack), ("Sensor cone", .sensorCone),
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

/// Draws the globe, the sky around it, the ground stations on it and the
/// satellites over it, for one MTKView.
@MainActor
public final class GlobeRenderer: NSObject, MTKViewDelegate {
    public private(set) var cameraMode = CameraMode.orbit
    /// Nil until the view has a size, then the web app's home view. Kept while
    /// tracking, for when what is followed cannot be placed.
    private var orbitCamera: OrbitCamera?
    private var trackingCamera = TrackingCamera()
    /// The sky view's camera, while it is on the ground.
    public private(set) var skyCamera: SkyCamera?
    /// The flight to or from the sky view, while one is under way.
    private var skyFlight: SkyFlight?
    /// The pose of the last frame, which a flight sets off from.
    private var lastPose: CameraPose?
    /// The terrain as the Map menu has it; the sky view stands on it regardless.
    private var terrainSetting = false
    public var components: SatelliteComponents = [.point, .label]
    /// The instant to draw, in UTC milliseconds since 1970.
    public var clock: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    private static let hdrFormat = MTLPixelFormat.rgba16Float
    private static let depthFormat = MTLPixelFormat.depth32Float
    private static let framesInFlight = 3

    private nonisolated let device: MTLDevice
    private let queue: MTLCommandQueue
    private let skyBoxPipeline: MTLRenderPipelineState
    private let skyAtmospherePipeline: MTLRenderPipelineState
    private let globePipeline: MTLRenderPipelineState
    private let pointPipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let labelPipeline: MTLRenderPipelineState
    private let stationPipeline: MTLRenderPipelineState
    private let linkPipeline: MTLRenderPipelineState
    private let overlayPipeline: MTLRenderPipelineState
    private let conePipeline: MTLRenderPipelineState
    private let coneRimPipeline: MTLRenderPipelineState
    private let overlay: GroundOverlay
    private let tonemapPipeline: MTLRenderPipelineState
    private let depthWrite: MTLDepthStencilState
    private let depthTest: MTLDepthStencilState
    private let noDepth: MTLDepthStencilState
    private let linearSampler: MTLSamplerState
    let surface: Surface
    private let tileSampler: MTLSamplerState
    private let skyShell: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)
    private var imagery: MTLTexture?
    private var stars: MTLTexture?
    private var hdr: MTLTexture?
    private var depth: MTLTexture?
    let points = SatellitePoints()
    private var stations: [StationMarker] = []
    private var links: [StationLink] = []
    private var pin: MTLTexture?
    private nonisolated let pixelScale: Double
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
    private var pointFrameBuffers: [MTLBuffer?]
    private var frameIndex = 0
    private let inFlight = DispatchSemaphore(value: framesInFlight)

    /// Compiles the shaders, which takes a second or two, without holding up the
    /// main thread, then takes over drawing the view.
    public static func make(view: MTKView) async throws -> GlobeRenderer {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
            throw RendererError.noDevice
        }
        return try GlobeRenderer(view: view, device: device, library: try await ShaderLibrary.make(device: device))
    }

    private init(view: MTKView, device: MTLDevice, library: MTLLibrary) throws {
        guard let queue = device.makeCommandQueue() else {
            throw RendererError.noDevice
        }
        self.device = device
        self.queue = queue
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .invalid
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

        func function(_ name: String) throws -> MTLFunction {
            guard let function = library.makeFunction(name: name) else {
                throw RendererError.missingFunction(name)
            }
            return function
        }
        func pipeline(
            _ vertex: String, _ fragment: String, format: MTLPixelFormat = Self.hdrFormat, depth: Bool = true, blend: Bool = false, premultiplied: Bool = false
        ) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try function(vertex)
            descriptor.fragmentFunction = try function(fragment)
            descriptor.colorAttachments[0].pixelFormat = format
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
        skyAtmospherePipeline = try pipeline("skyAtmosphereVertex", "skyAtmosphereFragment", blend: true)
        globePipeline = try pipeline("globeVertex", "globeFragment")
        pointPipeline = try pipeline("pointVertex", "pointFragment")
        linePipeline = try pipeline("lineVertex", "lineFragment", blend: true)
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
        surface = try Surface(device: device, library: library, site: URL(string: "https://satvis.space/")!)
        let tileSamplerDescriptor = MTLSamplerDescriptor()
        tileSamplerDescriptor.minFilter = .linear
        tileSamplerDescriptor.magFilter = .linear
        tileSamplerDescriptor.mipFilter = .linear
        tileSamplerDescriptor.maxAnisotropy = 8
        tileSamplerDescriptor.sAddressMode = .clampToEdge
        tileSamplerDescriptor.tAddressMode = .clampToEdge
        tileSampler = device.makeSamplerState(descriptor: tileSamplerDescriptor)!
        skyShell = upload(Meshes.skyShell())
        pointFrameBuffers = Array(repeating: nil, count: Self.framesInFlight)
        pixelScale = Double(view.contentScaleFactorForPoints)
        pin = Textures.texture2D(StationPin.bitmap(), device: device, queue: queue)
        super.init()
        view.delegate = self
        mtkView(view, drawableSizeWillChange: view.drawableSize)
        loadTextures()
    }

    /// Decodes off the main thread; the globe is not drawn until it lands.
    private func loadTextures() {
        Task.detached(priority: .userInitiated) {
            let imagery = Textures.naturalEarth()
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
        let scale = pixelScale
        return await Task.detached(priority: .userInitiated) {
            PreparedSatellites(satellites, device: device, labelScale: scale)
        }.value
    }

    public func setSatellites(_ prepared: PreparedSatellites) {
        points.install(prepared)
        overlay.isStale = true
    }

    /// The base map, and the site the shipped one's finer levels come from.
    public func setImagery(_ layer: BaseLayer, site: URL) {
        surface.setLayer(layer, site: site)
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
    public func track(_ id: String) {
        // From the flight out of the sky view too, which lands only while the
        // camera is the sky's: the ground's camera and its forced terrain go.
        if skyFlight != nil || skyCamera != nil {
            skyFlight = nil
            skyCamera = nil
            surface.setTerrain(terrainSetting)
        }
        cameraMode = .tracking(id)
        trackingCamera = TrackingCamera()
    }

    /// Lets go, and leaves the camera 2,000 km straight above what it followed, as
    /// the web app does.
    public func stopTracking() {
        if case .tracking(let id) = cameraMode, let lastFrame, let position = position(of: id, at: lastFrame.time) {
            orbitCamera = .above(position, altitude: 2_000_000)
        }
        cameraMode = .orbit
    }

    /// A drag of `points` on a view of `size` points: moves the free camera over
    /// the globe, circles what is followed, or turns the sky view.
    public func drag(by points: SIMD2<Double>, viewSize size: CGSize) {
        let longerSide = Double(max(size.width, size.height))
        switch cameraMode {
        case .orbit: orbitCamera?.pan(by: points, longerSide: longerSide)
        case .tracking: trackingCamera.orbit(by: points, longerSide: longerSide)
        case .sky where isSkySettled: skyCamera?.drag(by: points, height: Double(size.height))
        case .sky: break
        }
    }

    /// A pinch: nearer for a scale above 1.
    public func zoom(by scale: Double) {
        switch cameraMode {
        case .orbit: orbitCamera?.zoom(by: scale)
        case .tracking: trackingCamera.zoom(by: scale)
        case .sky where isSkySettled: skyCamera?.zoom(by: scale)
        case .sky: break
        }
    }

    /// A twist, in radians.
    public func rotate(by radians: Double) {
        switch cameraMode {
        case .orbit: orbitCamera?.rotate(by: radians)
        case .tracking: trackingCamera.rotate(by: radians)
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
                let width = Double(size.x) / pixelScale
                let height = Double(size.y) / pixelScale
                label = CGRect(x: spot.x + 10, y: spot.y - height / 2, width: width, height: height)
            }
            if let score = Picking.score(of: point, point: spot, label: label), score < best?.score ?? .infinity {
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
        if orbitCamera == nil {
            orbitCamera = OrbitCamera.home(aspectRatio: size.width / size.height)
        }
        func target(_ format: MTLPixelFormat) -> MTLTexture? {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: Int(size.width), height: Int(size.height), mipmapped: false)
            descriptor.usage = [.renderTarget, .shaderRead]
            descriptor.storageMode = .private
            return device.makeTexture(descriptor: descriptor)
        }
        hdr = target(Self.hdrFormat)
        depth = target(Self.depthFormat)
    }

    public func draw(in view: MTKView) {
        guard let orbitCamera, let hdr, let depth, let drawable = view.currentDrawable, let screen = view.currentRenderPassDescriptor else {
            return
        }
        let measuring = measuresFrames
        let started = measuring ? ProcessInfo.processInfo.systemUptime : 0
        let now = clock()
        var pose = orbitCamera.pose()
        if case .tracking(let id) = cameraMode, let target = position(of: id, at: now) {
            pose = trackingCamera.pose(target: target)
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
        guard let commands = queue.makeCommandBuffer() else {
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

        var frame = uniforms(pose: pose, size: SIMD2(Double(hdr.width), Double(hdr.height)), now: now)
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
        scene.colorAttachments[0].storeAction = .store
        scene.depthAttachment.texture = depth
        scene.depthAttachment.loadAction = .clear
        scene.depthAttachment.clearDepth = 0
        scene.depthAttachment.storeAction = .dontCare
        if let encoder = commands.makeRenderCommandEncoder(descriptor: scene) {
            encoder.setFrontFacing(.counterClockwise)
            encoder.setVertexBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)
            encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 1)

            if let stars {
                encoder.setRenderPipelineState(skyBoxPipeline)
                encoder.setDepthStencilState(noDepth)
                encoder.setCullMode(.none)
                encoder.setFragmentTexture(stars, index: 0)
                encoder.setFragmentSamplerState(linearSampler, index: 0)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }

            encoder.setRenderPipelineState(skyAtmospherePipeline)
            encoder.setDepthStencilState(noDepth)
            encoder.setCullMode(.front)
            encoder.setVertexBuffer(skyShell.vertices, offset: 0, index: 0)
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: skyShell.count, indexType: .uint32, indexBuffer: skyShell.indices, indexBufferOffset: 0)

            if !surfaceTiles.isEmpty {
                encoder.setRenderPipelineState(globePipeline)
                encoder.setDepthStencilState(depthWrite)
                encoder.setCullMode(.back)
                encoder.setFragmentTexture(overlay.texture, index: 1)
                encoder.setFragmentSamplerState(tileSampler, index: 0)
                for tile in surfaceTiles {
                    encoder.setVertexBuffer(surface.vertices(tile), offset: 0, index: 0)
                    encoder.setFragmentTexture(tile.texture, index: 0)
                    encoder.drawIndexedPrimitives(type: .triangle, indexCount: surface.indexCount, indexType: .uint32, indexBuffer: surface.indexBuffer, indexBufferOffset: 0)
                }
            }

            // Under the satellites and their names: a pin marks the ground.
            drawStations(encoder, eye: pose.position, now: now)

            if let samples = points.prepared?.samples, let instances = points.prepared?.instances, let states = pointFrames(at: now) {
                encoder.setDepthStencilState(depthTest)
                encoder.setCullMode(.none)
                encoder.setVertexBuffer(samples, offset: 0, index: 0)
                encoder.setVertexBuffer(instances, offset: 0, index: 2)
                encoder.setVertexBuffer(states, offset: 0, index: 3)
                for (component, kind) in [(SatelliteComponents.orbit, 0), (.orbitTrack, 1)] where components.contains(component) {
                    var kind = Int32(kind)
                    encoder.setRenderPipelineState(linePipeline)
                    encoder.setVertexBytes(&kind, length: MemoryLayout<Int32>.size, index: 5)
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
            encoder.endEncoding()
        }

        if let encoder = commands.makeRenderCommandEncoder(descriptor: screen) {
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

    /// Mirrors `coneSides` in Shaders/Footprints.msl.
    private static let coneSides = 48

    /// What `setVertexBytes` takes, 4 KB, in the larger of the two instances.
    private static let maximumInlineInstances = 4096 / MemoryLayout<LinkInstance>.stride

    /// This frame's stencils, in a buffer the GPU is not still reading.
    private func pointFrames(at now: Double) -> MTLBuffer? {
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
        return buffer
    }

    private func uniforms(pose: CameraPose, size: SIMD2<Double>, now: Double) -> FrameUniforms {
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
            pixelScale: Float(pixelScale))
    }
}

private func float4x4(_ m: simd_double4x4) -> simd_float4x4 {
    simd_float4x4(columns: (SIMD4<Float>(m.columns.0), SIMD4<Float>(m.columns.1), SIMD4<Float>(m.columns.2), SIMD4<Float>(m.columns.3)))
}

extension MTKView {
    /// Pixels per point, on either platform.
    fileprivate var contentScaleFactorForPoints: CGFloat {
        #if canImport(UIKit)
            contentScaleFactor
        #else
            window?.backingScaleFactor ?? 2
        #endif
    }
}
