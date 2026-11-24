import Foundation
import SatvisCore
import os
import simd

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "globe")

/// Which camera the view is seen through, and so what the gestures steer: the free
/// camera over the globe, or one following a satellite or a ground station. The
/// sky view (M6) is a third.
enum CameraMode: Sendable, Equatable {
    case orbit
    /// Following what has this id.
    case tracking(String)
    /// On the ground, looking up (ADR 0003).
    case sky
}

/// How the tracked satellite can be framed, as the scene has it: chasing its swath,
/// or close up on its 3D model.
enum TrackedModel {
    /// Not drawn yet, as a link tracks one before it is: asked again next frame.
    case notDrawn
    /// No model, or models are not drawn.
    case noModel
    /// Asked for, not loaded yet.
    case loading
    /// Its bounding sphere's radius, in metres.
    case loaded(radius: Double)
    /// Chased over its recorded swath from this camera, whatever its model (ADR 0023).
    case chase(TrackingCamera)
}

/// The cameras the globe is seen through, the flights between them and what the
/// gestures steer, down to the pose each frame is drawn from. Timed by the
/// uptime its caller passes, in seconds, never by the clock itself.
struct CameraRig {
    /// Which camera the view is seen through.
    private(set) var cameraMode = CameraMode.orbit
    /// Nil until the view has a size, then the web app's home view. Kept while
    /// tracking: shown when what is followed cannot be placed, and gone back to
    /// when tracking stops.
    private(set) var orbitCamera: OrbitCamera?
    /// The camera around what is followed.
    private var trackingCamera = TrackingCamera()
    /// The sky view's camera, while it is on the ground.
    private(set) var skyCamera: SkyCamera?
    /// The flight to or from the sky view, while one is under way.
    private var skyFlight: SkyFlight?
    /// The flight back to the home view, while one is under way: where it set
    /// off, and when.
    private var homeFlight: (from: OrbitCamera, to: OrbitCamera, start: Double)?
    /// The flight into tracking or out of it, while one is under way.
    private var poseFlight: PoseFlight?
    /// The broadcast camera of an overpass replay, while it holds the free camera's
    /// view (ADR 0023).
    private var broadcast: BroadcastCamera?
    /// What is tracked and may be framed close up on its 3D model: once the
    /// satellite is drawn, as a link tracks one before it is, and its model has
    /// loaded. A gesture since leaves the camera where the user put it.
    private var framingModel: String?
    /// What the web app frames a model by while it has not loaded: a small
    /// satellite's radius, in metres.
    private static let fallbackModelRadius = 2.5
    /// How long the flight home takes, in seconds.
    private static let homeFlightDuration = 1.5
    /// The pose of the last frame, which a flight sets off from.
    private var lastPose: CameraPose?
    /// The view's width over its height in pixels; nil until it has a size.
    private var aspectRatio: Double?
    /// `aspectRatio` once a frame is drawn; before one, the sky view and the way
    /// home leave the globe camera where it is.
    private var drawnAspectRatio: Double? {
        lastPose == nil ? nil : aspectRatio
    }
    /// The projection asked for. The sky view is drawn in 3D whatever it is, and
    /// goes back to it.
    private(set) var projection = GlobeProjection.threeD
    /// The projection the frames are drawn in. It follows `shownProjection` once
    /// the renderer has kept the last frame drawn in the other, to fade from
    /// (`showProjection`).
    private(set) var drawnProjection = GlobeProjection.threeD
    /// Whether the change to `shownProjection` under way fades: what the gesture
    /// that made it asked for.
    private(set) var fadesProjection = false
    /// The free camera over the map; nil until 2D is first drawn.
    private(set) var mapCamera: MapCamera?
    /// How the map frames what it follows, by its span and heading alone, kept
    /// apart from the free map camera as the 3D tracking camera is from the free
    /// one.
    private var trackingMap: MapCamera?
    /// The flight on the map, home or into or out of tracking, while one is under way.
    private var mapFlight: MapFlight?
    /// What the free camera holds still in. Tracking keeps the satellite's own
    /// frame, and the sky view the observer's, so it waits while either is up:
    /// the free camera does not turn meanwhile.
    var cameraFrame = CameraFrame.fixed {
        didSet { inertialAngle = nil }
    }
    /// The Greenwich hour angle the free camera was last turned to, while inertial.
    private var inertialAngle: Double?
    /// The camera whose picture the sky view is drawn over, while it is shown,
    /// whose field of view the sky view takes.
    var passthrough: CameraLens? {
        didSet {
            // A zoomed camera's can be narrower than the sky view's own narrowest.
            if passthrough == nil, let fieldOfView = skyCamera?.verticalFieldOfView {
                let range = SkyCamera.fieldOfViewRange
                skyCamera?.verticalFieldOfView = min(max(fieldOfView, range.lowerBound), range.upperBound)
            }
        }
    }

    /// Whether the sky view has landed, and what is on screen is what it aims at.
    /// Its instruments and its gestures wait for this.
    var isSkySettled: Bool {
        cameraMode == .sky && skyFlight == nil
    }

    /// The projection the frames should be drawn in: 3D for the sky view and its
    /// flights, else the one asked for.
    var shownProjection: GlobeProjection {
        cameraMode == .sky || skyFlight != nil ? .threeD : projection
    }

    /// Draws the frames in `shownProjection` from now on, once the renderer has
    /// kept a frame of the other to fade from, or does without one.
    mutating func showProjection() {
        drawnProjection = shownProjection
    }

    /// Shows the globe as a globe or as the flat map, keeping the place in sight
    /// once the view has a size. `animated` fades from one to the other. In the
    /// sky view, the projection it goes back to.
    mutating func setProjection(_ projection: GlobeProjection, animated: Bool) {
        guard projection != self.projection else {
            return
        }
        self.projection = projection
        fadesProjection = animated
        endBroadcast()
        homeFlight = nil
        poseFlight = nil
        mapFlight = nil
        guard let aspectRatio else {
            return
        }
        // From the sky view, the globe camera is where the flight out lands.
        // What is followed keeps its own scale: the tracking camera's range is
        // the scale at the target, as a globe camera's altitude is under it.
        let tracking = if case .tracking = cameraMode { true } else { false }
        switch projection {
        case .twoD:
            if let orbitCamera {
                mapCamera = MapCamera.matching(orbitCamera, aspectRatio: aspectRatio)
            }
            if tracking, var held = mapCamera {
                held.span = MapCamera.span(atAltitude: trackingCamera.range)
                trackingMap = held
            }
        case .threeD:
            if cameraMode != .sky, skyFlight == nil, let mapCamera {
                orbitCamera = mapCamera.globe(aspectRatio: aspectRatio)
            }
            if tracking, let trackingMap {
                trackingCamera.range = MapCamera.altitude(spanning: trackingMap.span)
                framingModel = nil
            }
        }
    }

    /// The view's new size, as its width over its height in pixels: the home
    /// view, the first time it has one.
    mutating func resize(aspectRatio: Double) {
        self.aspectRatio = aspectRatio
        if orbitCamera == nil {
            orbitCamera = OrbitCamera.home(aspectRatio: aspectRatio)
        }
    }

    /// Stands on the ground at the camera's observer and looks up from there.
    /// `animated` flies there from the last pose, once a frame is drawn; without
    /// it the camera cuts.
    mutating func enterSky(_ camera: SkyCamera, animated: Bool, uptime now: Double) {
        endBroadcast()
        // From wherever a flight into or out of tracking has got to.
        poseFlight = nil
        mapFlight = nil
        fadesProjection = animated
        // From the map, the way back flies to the globe over it, which then gives
        // way to the map.
        if cameraMode != .sky, projection == .twoD, let mapCamera, let aspectRatio = drawnAspectRatio {
            orbitCamera = mapCamera.globe(aspectRatio: aspectRatio)
        }
        if var flight = skyFlight, !flight.entering {
            // Turned around on the way out: carry on from where the camera is.
            flight.reverse(at: now)
            skyFlight = flight
        } else if cameraMode != .sky, animated, var from = lastPose, let aspectRatio {
            from.verticalFieldOfView = from.verticalFieldOfView(aspectRatio: aspectRatio)
            skyFlight = SkyFlight(globe: from, start: now, entering: true)
        } else if cameraMode != .sky {
            skyFlight = nil
        }
        skyCamera = camera
        cameraMode = .sky
    }

    /// Back to the globe camera, by the flight in played backwards.
    mutating func leaveSky(animated: Bool, uptime now: Double) {
        fadesProjection = animated
        if var flight = skyFlight, flight.entering {
            flight.reverse(at: now)
            skyFlight = flight
        } else if animated, skyFlight == nil, cameraMode == .sky, var globe = orbitCamera?.pose(), let aspectRatio = drawnAspectRatio {
            globe.verticalFieldOfView = globe.verticalFieldOfView(aspectRatio: aspectRatio)
            skyFlight = SkyFlight(globe: globe, start: now, entering: false)
        } else if skyFlight == nil {
            landOnGlobe()
        }
    }

    /// Back on the free camera, the sky view's gone.
    private mutating func landOnGlobe() {
        skyFlight = nil
        skyCamera = nil
        cameraMode = .orbit
    }

    /// The device's attitude, in the observer's east, north and up, while the
    /// compass aims the sky view.
    mutating func setSkyAttitude(_ attitude: simd_quatd) {
        skyCamera?.attitude = attitude
    }

    /// Levels the sky view where it is looking, as handing the aim back to a
    /// finger does (ADR 0004).
    mutating func levelSky() {
        guard let camera = skyCamera else {
            return
        }
        skyCamera?.attitude = SkyCamera.attitude(azimuth: camera.azimuth, pitch: camera.pitch)
    }

    /// Follows what has this id. `animated` flies there from the last pose; else
    /// the camera cuts. `model` is how its 3D model can be framed.
    mutating func track(_ id: String, animated: Bool, uptime: Double, model: (String) -> TrackedModel) {
        // From the flight out of the sky view too, which lands only while the
        // camera is the sky's: the ground's camera and its forced terrain go.
        if skyFlight != nil || skyCamera != nil {
            skyFlight = nil
            skyCamera = nil
        }
        endBroadcast()
        startPoseFlight(animated, uptime: uptime)
        cameraMode = .tracking(id)
        trackingCamera = TrackingCamera()
        // On the map, at the scale on screen; on the globe, set when 2D is chosen.
        trackingMap = drawnProjection == .twoD ? lastPose?.mapCamera : nil
        framingModel = id
        frameModel(model)
    }

    /// Closes in on the tracked satellite's 3D model, as the web app does while
    /// the model is on: by the model's size once it has loaded, by a small
    /// satellite's meanwhile.
    private mutating func frameModel(_ model: (String) -> TrackedModel) {
        guard let id = framingModel, cameraMode == .tracking(id) else {
            return
        }
        switch model(id) {
        case .notDrawn:
            return
        case .noModel:
            framingModel = nil
        case .loading:
            trackingCamera = .framing(modelRadius: Self.fallbackModelRadius)
        case .loaded(let radius):
            trackingCamera = .framing(modelRadius: radius)
            framingModel = nil
        case .chase(let camera):
            trackingCamera = camera
            framingModel = nil
        }
    }

    /// Lets go, and goes back to the view tracking began from, as the web app
    /// does: the free camera is kept while tracking, through switches from one
    /// satellite to another. `animated` flies back.
    mutating func stopTracking(animated: Bool, uptime: Double) {
        if case .tracking = cameraMode {
            startPoseFlight(animated, uptime: uptime)
        }
        cameraMode = .orbit
    }

    /// From the pose last drawn, which may be partway through another flight.
    private mutating func startPoseFlight(_ animated: Bool, uptime: Double) {
        poseFlight = animated ? lastPose.map { PoseFlight(from: $0, start: uptime) } : nil
        flyMap(animated, uptime: uptime, duration: PoseFlight.duration)
    }

    /// Back to where the app opens, letting go of what is followed, once a frame
    /// is drawn. `animated` flies there; without it the camera cuts. Not from the
    /// sky view, which `leaveSky` leaves first.
    mutating func flyHome(animated: Bool, uptime: Double) {
        guard cameraMode != .sky, let aspectRatio = drawnAspectRatio else {
            return
        }
        stopBroadcast(animated: animated, uptime: uptime)
        stopTracking(animated: animated, uptime: uptime)
        if drawnProjection == .twoD {
            flyMap(animated, uptime: uptime, duration: Self.homeFlightDuration)
            mapCamera = MapCamera.home(aspectRatio: aspectRatio)
            return
        }
        let home = OrbitCamera.home(aspectRatio: aspectRatio)
        if poseFlight != nil {
            // Already flying out of tracking: on to home instead.
            orbitCamera = home
        } else if animated, let orbitCamera {
            homeFlight = (orbitCamera, home, uptime)
        } else {
            orbitCamera = home
        }
    }

    /// Whether the broadcast camera holds the view.
    var isBroadcasting: Bool { broadcast != nil }

    /// Hands the view to `camera`, letting go of what is followed; `animated`
    /// swings it in from the last pose. False, leaving the camera as it was, in the
    /// sky view, on the way to or from it, or on the map.
    mutating func startBroadcast(_ camera: BroadcastCamera, animated: Bool, uptime: Double) -> Bool {
        guard cameraMode != .sky, skyFlight == nil, projection == .threeD, drawnProjection == .threeD else {
            return false
        }
        endBroadcast()
        var camera = camera
        camera.swing = animated ? lastPose.map { ($0, uptime) } : nil
        broadcast = camera
        cameraMode = .orbit
        homeFlight = nil
        poseFlight = nil
        framingModel = nil
        return true
    }

    /// Ends the broadcast, its view left to the free camera over where it looks
    /// (`OrbitCamera.facing`), which can only look straight down: `animated` flies
    /// there, else the camera cuts.
    mutating func stopBroadcast(animated: Bool, uptime: Double) {
        guard broadcast != nil else {
            return
        }
        endBroadcast()
        poseFlight = animated ? lastPose.map { PoseFlight(from: $0, start: uptime) } : nil
    }

    /// Ends the broadcast, leaving the free camera over where it looks, for what
    /// takes the view over from it to fly from the last pose.
    private mutating func endBroadcast() {
        guard broadcast != nil else {
            return
        }
        broadcast = nil
        if let lastPose, lastPose.mapCamera == nil {
            orbitCamera = OrbitCamera.facing(lastPose)
        }
    }

    /// The view to fly back to (`fly(to:)`): the free camera, the one tracking
    /// began from while something is followed, and in the sky view the one it goes
    /// back to; over where the broadcast looks while it holds the view. Nil before
    /// the view has a size.
    func currentView() -> CameraView? {
        guard let orbitCamera, let aspectRatio else {
            return nil
        }
        if drawnProjection == .twoD, let mapCamera {
            return CameraView(globe: mapCamera.globe(aspectRatio: aspectRatio), map: mapCamera)
        }
        if broadcast != nil, let lastPose, lastPose.mapCamera == nil {
            return CameraView(globe: .facing(lastPose), map: nil)
        }
        return CameraView(globe: orbitCamera, map: nil)
    }

    /// Flies the free camera to `view`, letting go of what is followed and ending
    /// any broadcast, from the last pose over `PoseFlight.duration`; without
    /// `animated` the camera cuts. Not in the sky view or on the way to or from it.
    mutating func fly(to view: CameraView, animated: Bool, uptime: Double) {
        guard cameraMode != .sky, skyFlight == nil else {
            return
        }
        endBroadcast()
        homeFlight = nil
        framingModel = nil
        startPoseFlight(animated, uptime: uptime)
        cameraMode = .orbit
        orbitCamera = view.globe
        if let aspectRatio {
            mapCamera = view.map ?? MapCamera.matching(view.globe, aspectRatio: aspectRatio)
        }
    }

    /// A drag of `points` on a view of `size` points: moves the free camera over
    /// the globe, circles what is followed, or turns the sky view.
    mutating func drag(by points: SIMD2<Double>, viewSize size: CGSize) {
        let longerSide = Double(max(size.width, size.height))
        if steerMap(movesCentre: true, { $0.pan(by: points, longerSide: longerSide) }) {
            return
        }
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
    mutating func zoom(by scale: Double) {
        if steerMap({ $0.zoom(by: scale) }) {
            return
        }
        switch cameraMode {
        case .orbit:
            homeFlight = nil
            orbitCamera?.zoom(by: scale)
        case .tracking:
            framingModel = nil
            trackingCamera.zoom(by: scale)
        case .sky where isSkySettled && passthrough == nil: skyCamera?.zoom(by: scale)
        case .sky: break
        }
    }

    /// A twist, in radians.
    mutating func rotate(by radians: Double) {
        if steerMap({ $0.rotate(by: radians) }) {
            return
        }
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

    /// A gesture on the map, while it is drawn: `change` made to the free map
    /// camera, or to the span and heading of the map that follows something,
    /// which holds what it follows in the middle and so ignores one that
    /// `movesCentre`. False off the map, for the globe's cameras to take it.
    private mutating func steerMap(movesCentre: Bool = false, _ change: (inout MapCamera) -> Void) -> Bool {
        guard drawnProjection == .twoD else {
            return false
        }
        switch cameraMode {
        case .orbit:
            landMapFlight()
            if var map = mapCamera {
                change(&map)
                mapCamera = map
            }
        case .tracking:
            if !movesCentre, var map = lastPose?.mapCamera {
                change(&map)
                trackingMap = map
            }
        case .sky:
            return false
        }
        return true
    }

    /// From the map last drawn, which may be partway through another flight, for
    /// `duration` seconds; none where not `animated`.
    private mutating func flyMap(_ animated: Bool, uptime: Double, duration: Double) {
        mapFlight = animated ? lastPose?.mapCamera.map { MapFlight(from: $0, start: uptime, duration: duration) } : nil
    }

    /// Calls off a flight on the map where it has got to, for a gesture to carry
    /// on from there.
    private mutating func landMapFlight() {
        if mapFlight != nil, let map = lastPose?.mapCamera {
            mapCamera = map
        }
        mapFlight = nil
    }

    /// The map camera a frame is drawn from, as the free one or around what is
    /// followed, partway through any flight on the map, on a view of
    /// `aspectRatio`; `target` is where what has an id is at `now`.
    private mutating func mapPose(uptime: Double, time now: Double, aspectRatio: Double, target: (String, Double) -> SIMD3<Double>?) -> CameraPose {
        var map = mapCamera ?? MapCamera.home(aspectRatio: aspectRatio)
        map.clamp(aspectRatio: aspectRatio)
        mapCamera = map
        if case .tracking(let id) = cameraMode, let position = target(id, now) {
            let place = geodeticPosition(position)
            let held = trackingMap ?? map
            map = MapCamera(latitude: place.latitude, longitude: place.longitude, span: held.span, heading: held.heading)
            map.clamp(aspectRatio: aspectRatio)
            trackingMap = map
        }
        if let flight = mapFlight {
            if let partway = flight.camera(towards: map, at: uptime) {
                // Turning, the limit to the span moves with the heading.
                map = partway
                map.clamp(aspectRatio: aspectRatio)
            } else {
                mapFlight = nil
            }
        }
        var pose = map.globe(aspectRatio: aspectRatio).pose()
        pose.mapCamera = map
        return pose
    }

    /// Where the frame drawn at `time` (UTC milliseconds) is seen from: the free
    /// camera, what is tracked or the sky view, partway through any flight
    /// between them. `model` is how the tracked satellite's 3D model can be
    /// framed, `target` where what has an id is at a time (UTC milliseconds),
    /// and `groundHeight` the ground's height in metres at a place. Nil before
    /// the view has a size, and nil, with the cameras put back home, where the
    /// pose is not finite.
    mutating func pose(
        uptime: Double, time now: Double, model: (String) -> TrackedModel, target: (String, Double) -> SIMD3<Double>?,
        groundHeight: (GeoCoordinate) -> Double?
    ) -> CameraPose? {
        guard var orbitCamera, let aspectRatio else {
            return nil
        }
        if drawnProjection == .twoD {
            inertialAngle = nil
            let pose = mapPose(uptime: uptime, time: now, aspectRatio: aspectRatio, target: target)
            guard pose.isFinite else {
                let map = mapCamera
                log.fault("Map camera not finite: \(String(describing: map), privacy: .public)")
                mapCamera = MapCamera.home(aspectRatio: aspectRatio)
                trackingMap = nil
                mapFlight = nil
                return nil
            }
            lastPose = pose
            return pose
        }
        orbitCamera = freeCamera(orbitCamera, uptime: uptime, time: now)
        var pose = orbitCamera.pose()
        frameModel(model)
        if case .tracking(let id) = cameraMode, let position = target(id, now) {
            // As CesiumJS tells the velocity: by where it is a millisecond on, or one
            // before at the end of what is known.
            let velocity = target(id, now + 1).map { ($0 - position) * 1000 } ?? target(id, now - 1).map { (position - $0) * 1000 } ?? .zero
            trackingCamera.keepAboveGround(target: position, velocity: velocity, groundHeight: groundHeight)
            pose = trackingCamera.pose(target: position, velocity: velocity)
        }
        if cameraMode == .orbit, var camera = broadcast {
            let satellite = camera.satellite
            pose = camera.pose(uptime: uptime, time: now) { target(satellite, $0) } ?? pose
            broadcast = camera
        }
        if let flight = poseFlight {
            if cameraMode != .sky {
                pose = PoseFlight.pose(from: flight.from, to: pose, t: flight.progress(at: uptime))
            }
            if flight.isOver(at: uptime) || cameraMode == .sky {
                poseFlight = nil
            }
        }
        if cameraMode == .sky, let camera = skyCamera {
            pose = skyPose(camera, uptime: uptime, aspectRatio: aspectRatio, groundHeight: groundHeight)
        }
        guard pose.isFinite else {
            resetCameras(orbitCamera, aspectRatio: aspectRatio)
            return nil
        }
        lastPose = pose
        return pose
    }

    /// The free camera from `camera` at `uptime` and the clock at `now`: partway
    /// through any flight home, and turned with the Earth in the inertial frame.
    private mutating func freeCamera(_ camera: OrbitCamera, uptime: Double, time now: Double) -> OrbitCamera {
        var orbitCamera = camera
        if let flight = homeFlight {
            // Called off by anything else the camera is asked to do.
            let t = (uptime - flight.start) / Self.homeFlightDuration
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
        return orbitCamera
    }

    /// The sky view from `skyCamera` on the ground, partway through any flight
    /// down to it or back up.
    private mutating func skyPose(
        _ skyCamera: SkyCamera, uptime: Double, aspectRatio: Double, groundHeight: (GeoCoordinate) -> Double?
    ) -> CameraPose {
        var camera = skyCamera
        // Up at once out of the ground; down gently onto finer terrain as it loads.
        if let ground = groundHeight(GeoCoordinate(latitude: camera.latitude, longitude: camera.longitude)) {
            camera.groundHeight = ground > camera.groundHeight ? ground : camera.groundHeight + (ground - camera.groundHeight) * 0.1
        }
        // Read again every frame, as the screen turns under the picture.
        if let passthrough {
            camera.verticalFieldOfView = passthrough.verticalFieldOfView(viewAspectRatio: aspectRatio)
        }
        self.skyCamera = camera
        var pose = camera.pose()
        if var flight = skyFlight {
            var over = SkyCamera(latitude: camera.latitude, longitude: camera.longitude, azimuth: camera.azimuth, pitch: -.pi / 2)
            over.groundHeight = camera.groundHeight
            let overPose = over.pose()
            let offset = flight.offset ?? SkyFlight.offset(from: flight.globe, to: pose, over: overPose)
            flight.offset = offset
            skyFlight = flight
            pose = SkyFlight.pose(from: flight.globe, to: pose, over: overPose, offset: offset, t: flight.progress(at: uptime))
            if flight.isOver(at: uptime) {
                if flight.entering {
                    skyFlight = nil
                } else {
                    landOnGlobe()
                }
            }
        }
        return pose
    }

    /// Puts the cameras back home after a pose that is not finite: drawn from, it
    /// leaves nothing on screen until the app is relaunched. `orbitCamera` is the
    /// free camera the pose was worked out from, for the log.
    private mutating func resetCameras(_ orbitCamera: OrbitCamera, aspectRatio: Double) {
        let mode = cameraMode
        log.fault("Camera not finite: \(String(describing: orbitCamera), privacy: .public), \(String(describing: mode), privacy: .public)")
        self.orbitCamera = OrbitCamera.home(aspectRatio: aspectRatio)
        trackingCamera = TrackingCamera()
        homeFlight = nil
        poseFlight = nil
        broadcast = nil
        if cameraMode == .sky {
            landOnGlobe()
        }
    }
}

/// A flight on the map, home or into or out of tracking. It heads for where the
/// camera is meant to be each frame, so it lands on a satellite that moved.
private struct MapFlight {
    /// The map camera it set off from.
    let from: MapCamera
    /// Seconds of system uptime when it set off.
    let start: Double
    /// Seconds it takes.
    let duration: Double

    /// The camera partway to `destination` at `uptime`; nil once it has landed.
    func camera(towards destination: MapCamera, at uptime: Double) -> MapCamera? {
        let t = (uptime - start) / duration
        return t < 1 ? MapCamera.between(from, destination, t: t) : nil
    }
}
