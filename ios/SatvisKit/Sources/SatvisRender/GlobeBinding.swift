import Foundation
import SatvisCore

/// What `GlobeBinding` sets on a globe: `GlobeRenderer`, or a fake in tests. The
/// members are `GlobeRenderer`'s, and documented there.
@MainActor
protocol Globe: AnyObject {
    /// Satellites packed for drawing.
    associatedtype Prepared: Sendable

    var clock: (_ ahead: Double) -> Double { get set }
    var tileLoader: (@Sendable (TileRequest) async -> Data?)? { get set }
    var modelLoader: (@Sendable (String) async -> Data?)? { get set }
    var onGPUFault: (@MainActor @Sendable (GPUFault) -> Void)? { get set }
    var unseen: UnseenMode { get set }
    var cameraFrame: CameraFrame { get set }
    var components: SatelliteComponents { get set }
    var passthrough: CameraLens? { get set }
    var chasing: Set<String> { get set }
    func setImagery(_ layer: BaseLayer, site: URL)
    func setInstrumentImagery(_ overlays: [ImageryOverlay])
    func setTerrain(_ enabled: Bool)
    func setStations(_ stations: [StationMarker])
    func setLinks(_ links: [StationLink])
    func setGranules(_ granules: [GranuleDrawing], fans: Set<String>)
    func prepare(_ satellites: [PointSatellite], labelled: Bool) async -> Prepared
    func setSatellites(_ prepared: Prepared)
    func setStarMap(faces: [Data])
    func enterSky(_ camera: SkyCamera, animated: Bool)
    func leaveSky(animated: Bool)
    func track(_ id: String, animated: Bool)
    func stopTracking(animated: Bool)
    func flyHome(animated: Bool)
    func setProjection(_ projection: GlobeProjection, animated: Bool)
    func startBroadcast(satellite: String, station: GroundPoint, animated: Bool) -> Bool
    func stopBroadcast()
    func currentView() -> CameraView?
    func fly(to view: CameraView, animated: Bool)
}

extension GlobeRenderer: Globe {}

/// Everything the app sets on the globe, kept for a globe that arrives late: the
/// renderer compiles its shaders first, and a link can open before it. Each change
/// goes to the globe at once if one is attached, and all of it, in the order
/// declared here, to each globe that attaches. Questions (picking, the sky lock,
/// a snapshot) go to the renderer itself.
@MainActor
public final class GlobeBinding {
    /// Where the camera stands when a globe attaches: what the camera commands
    /// left it on, such as a link that opened on the sky view, with no globe to fly
    /// from yet, or on something followed.
    enum Camera: Equatable, Sendable {
        /// On the ground with this camera.
        case sky(SkyCamera)
        /// Following what has this id.
        case tracking(String)
        /// On the free camera, flown to this view.
        case view(CameraView)
    }

    /// The globe attached last; nil until the renderer has compiled its shaders.
    private var globe: (any Globe)?

    /// The instant to draw `ahead` seconds from now, in UTC milliseconds since 1970.
    public var clock: (_ ahead: Double) -> Double = GlobeRenderer.wallClock {
        didSet { globe?.clock = clock }
    }
    /// What fetches a map tile's bytes.
    public var tileLoader: (@Sendable (TileRequest) async -> Data?)? {
        didSet { globe?.tileLoader = tileLoader }
    }
    /// What fetches a 3D model's bytes by its path under /data/models/.
    public var modelLoader: (@Sendable (String) async -> Data?)? {
        didSet { globe?.modelLoader = modelLoader }
    }
    /// The base map, and the site its finer levels come from; nil leaves the globe's own.
    private var imagery: (layer: BaseLayer, site: URL)?
    /// The instrument imagery over the base map (`GlobeRenderer.setInstrumentImagery`).
    public var instrumentImagery: [ImageryOverlay] = [] {
        didSet { globe?.setInstrumentImagery(instrumentImagery) }
    }
    /// Whether the globe follows the terrain.
    public var terrain = false {
        didSet { globe?.setTerrain(terrain) }
    }
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen = UnseenMode.dim {
        didSet { globe?.unseen = unseen }
    }
    /// What the free camera holds still in.
    public var cameraFrame = CameraFrame.fixed {
        didSet { globe?.cameraFrame = cameraFrame }
    }
    /// How the globe is drawn, as a globe or as the flat map; in the sky view the
    /// projection it goes back to. Set with `setProjection`.
    private var projection = GlobeProjection.threeD
    /// The ground stations to stand pins on.
    public var stations: [StationMarker] = [] {
        didSet { globe?.setStations(stations) }
    }
    /// Called with the first frame the GPU fails of each kind.
    public var onGPUFault: (@MainActor @Sendable (GPUFault) -> Void)? {
        didSet { globe?.onGPUFault = onGPUFault }
    }
    /// Where the camera stands when a globe attaches; nil leaves it where the
    /// globe opens.
    private var camera: Camera?
    /// The camera whose picture the sky view is drawn over, while it is drawn
    /// over (`GlobeRenderer.passthrough`).
    public var passthrough: CameraLens? {
        didSet { globe?.passthrough = passthrough }
    }
    /// The ground station links to draw (`GlobeRenderer.setLinks`).
    public var links: [StationLink] = [] {
        didSet { globe?.setLinks(links) }
    }
    /// Satellites (`PointSatellite.id`) whose own granule layer is on: tracking one
    /// chases its swath, from behind and above it, looking down at 50° at the ground
    /// under it (ADR 0023). When the tracked satellite joins or leaves them, it is
    /// tracked again, into the chase or out of it.
    public var chasing: Set<String> = [] {
        didSet { globe?.chasing = chasing }
    }
    /// The granules replayed behind the clock, and the satellites whose ground track
    /// fan is drawn with the component off (`GlobeRenderer.setGranules`).
    private var granules: (list: [GranuleDrawing], fans: Set<String>) = ([], [])
    /// What of each satellite is drawn.
    public var components: SatelliteComponents = [.point, .label] {
        didSet { globe?.components = components }
    }
    /// The last satellites given, the components they come with, and who is told
    /// once a globe draws them.
    private var satellites: (list: [PointSatellite], components: SatelliteComponents?, onDrawn: @MainActor () -> Void)?
    /// Bumped by every set handed over, so a slow packing never replaces a newer one.
    private var satellitesGeneration = 0
    /// The star map's six faces (`GlobeRenderer.setStarMap`); nil until fetched.
    public var starMap: [Data]? {
        didSet {
            if let starMap {
                globe?.setStarMap(faces: starMap)
            }
        }
    }

    public init() {}

    /// Takes over the renderer (`attach(globe:)`).
    public func attach(_ renderer: GlobeRenderer) {
        attach(globe: renderer)
    }

    /// Takes over a globe, and sets everything on it: the loaders before what
    /// fetches through them, the camera after the stations it may follow, and the
    /// satellites last, once packed, after the components they are drawn with.
    func attach(globe: any Globe) {
        self.globe = globe
        globe.clock = clock
        globe.tileLoader = tileLoader
        globe.modelLoader = modelLoader
        if let imagery {
            globe.setImagery(imagery.layer, site: imagery.site)
        }
        globe.setInstrumentImagery(instrumentImagery)
        globe.setTerrain(terrain)
        globe.unseen = unseen
        globe.cameraFrame = cameraFrame
        globe.setProjection(projection, animated: false)
        globe.setStations(stations)
        globe.onGPUFault = onGPUFault
        globe.chasing = chasing
        switch camera {
        case .sky(let sky): globe.enterSky(sky, animated: false)
        case .tracking(let id): globe.track(id, animated: false)
        case .view(let view): globe.fly(to: view, animated: false)
        case nil: break
        }
        globe.passthrough = passthrough
        globe.setLinks(links)
        globe.components = components
        globe.setGranules(granules.list, fans: granules.fans)
        Task { await handSatellites(to: globe) }
        if let starMap {
            globe.setStarMap(faces: starMap)
        }
    }

    /// The base map, and the site its finer levels come from (`GlobeRenderer.setImagery`).
    public func setImagery(_ layer: BaseLayer, site: URL) {
        imagery = (layer, site)
        globe?.setImagery(layer, site: site)
    }

    /// The granules to draw (`GlobeRenderer.setGranules`).
    public func setGranules(_ granules: [GranuleDrawing], fans: Set<String>) {
        self.granules = (granules, fans)
        globe?.setGranules(granules, fans: fans)
    }

    /// The satellites to draw, packed off the main thread first, and the
    /// `components` they are drawn with from then on, if new. `onDrawn` is called
    /// once a globe draws them, now or when one attaches, unless a newer set has
    /// come meanwhile. Waits for the packing while a globe is attached.
    public func setSatellites(
        _ satellites: [PointSatellite], components: SatelliteComponents? = nil, onDrawn: @escaping @MainActor () -> Void
    ) async {
        self.satellites = (satellites, components, onDrawn)
        if let globe {
            await handSatellites(to: globe)
        }
    }

    /// Packs the last satellites given and has `globe` draw them, unless a newer
    /// set has come meanwhile.
    private func handSatellites(to globe: some Globe) async {
        guard let satellites else {
            return
        }
        satellitesGeneration += 1
        let mine = satellitesGeneration
        let prepared = await globe.prepare(satellites.list, labelled: (satellites.components ?? components).contains(.label))
        if mine == satellitesGeneration {
            if let components = satellites.components {
                self.components = components
            }
            globe.setSatellites(prepared)
            satellites.onDrawn()
        }
    }

    // MARK: Camera

    /// Draws the globe as a globe or as the flat map (`GlobeRenderer.setProjection`).
    public func setProjection(_ projection: GlobeProjection, animated: Bool) {
        self.projection = projection
        globe?.setProjection(projection, animated: animated)
    }

    /// Follows what has this id (`GlobeRenderer.track`).
    public func track(_ id: String, animated: Bool) {
        camera = .tracking(id)
        globe?.track(id, animated: animated)
    }

    /// Lets go of what is followed (`GlobeRenderer.stopTracking`).
    public func stopTracking(animated: Bool) {
        if case .tracking = camera {
            camera = nil
        }
        globe?.stopTracking(animated: animated)
    }

    /// Stands in the sky view (`GlobeRenderer.enterSky`).
    public func enterSky(_ sky: SkyCamera, animated: Bool) {
        camera = .sky(sky)
        globe?.enterSky(sky, animated: animated)
    }

    /// Back to the globe camera (`GlobeRenderer.leaveSky`).
    public func leaveSky(animated: Bool) {
        if case .sky = camera {
            camera = nil
        }
        globe?.leaveSky(animated: animated)
    }

    /// Back to where the app opens (`GlobeRenderer.flyHome`).
    public func flyHome(animated: Bool) {
        camera = nil
        globe?.flyHome(animated: animated)
    }

    /// Straight down on a place, in degrees, north up, from `height` metres above
    /// the ellipsoid, letting go of what is followed and ending any broadcast:
    /// `animated` flies there over two seconds, eased by smootherstep, else the
    /// camera cuts. Not in the sky view.
    public func flyOver(latitude: Double, longitude: Double, height: Double, animated: Bool) {
        fly(to: .over(latitude: latitude, longitude: longitude, height: height), animated: animated)
    }

    /// The broadcast camera of an overpass replay (`GlobeRenderer.startBroadcast`):
    /// held beyond `station` on its side of the ground track, 1,800 km up, turning
    /// each frame to keep the satellite with this id in view. False where it cannot
    /// start now, as before the renderer has arrived; the app then flies over the
    /// station instead.
    public func startBroadcast(satellite: String, station: GroundPoint, animated: Bool) -> Bool {
        guard globe?.startBroadcast(satellite: satellite, station: station, animated: animated) == true else {
            return false
        }
        camera = nil
        return true
    }

    /// Ends the broadcast (`GlobeRenderer.stopBroadcast`).
    public func stopBroadcast() {
        globe?.stopBroadcast()
    }

    /// The camera's view now, on the globe or the map, to fly back to with
    /// `fly(to:)`; nil before the renderer has arrived.
    public func currentView() -> CameraView? {
        globe?.currentView()
    }

    /// Flies back to a view `currentView` gave (`GlobeRenderer.fly(to:)`).
    public func fly(to view: CameraView, animated: Bool) {
        camera = .view(view)
        globe?.fly(to: view, animated: animated)
    }
}
