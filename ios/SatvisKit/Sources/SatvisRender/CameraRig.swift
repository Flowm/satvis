import Foundation
import SatvisCore
import os
import simd

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "globe")

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

/// How the tracked satellite's 3D model can be framed close up, as the scene has it.
enum TrackedModel {
    /// Not drawn yet, as a link tracks one before it is: asked again next frame.
    case notDrawn
    /// No model, or models are not drawn.
    case noModel
    /// Asked for, not loaded yet.
    case loading
    /// Its bounding sphere's radius, in metres.
    case loaded(radius: Double)
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
    /// How the map frames what it follows, kept apart from the free map camera
    /// as the 3D tracking camera is from the free one.
    private var trackingMap: TrackedMap?
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

    /// Shows the globe as a globe or as the flat map, keeping the place in sight on
    /// a view of `aspectRatio`, nil before a frame is drawn. `animated` fades from
    /// one to the other. In the sky view, the projection it goes back to.
    mutating func setProjection(_ projection: GlobeProjection, animated: Bool, aspectRatio: Double?) {
        guard projection != self.projection else {
            return
        }
        self.projection = projection
        fadesProjection = animated
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
            if tracking, let mapCamera {
                trackingMap = TrackedMap(span: MapCamera.span(atAltitude: trackingCamera.range), heading: mapCamera.heading)
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

    /// The home view, the first time the view has a size.
    mutating func openHome(aspectRatio: Double) {
        if orbitCamera == nil {
            orbitCamera = OrbitCamera.home(aspectRatio: aspectRatio)
        }
    }

    /// Stands on the ground at the camera's observer and looks up from there.
    /// `animated` flies there from the last pose, as seen on a view of
    /// `aspectRatio`, nil before a frame is drawn; without it the camera cuts.
    mutating func enterSky(_ camera: SkyCamera, animated: Bool, uptime now: Double, aspectRatio: Double?) {
        // From wherever a flight into or out of tracking has got to.
        poseFlight = nil
        mapFlight = nil
        fadesProjection = animated
        // From the map, the way back flies to the globe over it, which then gives
        // way to the map.
        if cameraMode != .sky, projection == .twoD, let mapCamera, let aspectRatio {
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
    mutating func leaveSky(animated: Bool, uptime now: Double, aspectRatio: Double?) {
        fadesProjection = animated
        if var flight = skyFlight, flight.entering {
            flight.reverse(at: now)
            skyFlight = flight
        } else if animated, skyFlight == nil, cameraMode == .sky, var globe = orbitCamera?.pose(), let aspectRatio {
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
        startPoseFlight(animated, uptime: uptime)
        cameraMode = .tracking(id)
        trackingCamera = TrackingCamera()
        // On the map, at the scale on screen; on the globe, set when 2D is chosen.
        trackingMap = drawnProjection == .twoD ? lastPose?.mapCamera.map(TrackedMap.init) : nil
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

    /// Back to where the app opens on a view of `aspectRatio`, nil before a frame
    /// is drawn, letting go of what is followed. `animated` flies there; without
    /// it the camera cuts. Not from the sky view, which `leaveSky` leaves first.
    mutating func flyHome(animated: Bool, uptime: Double, aspectRatio: Double?) {
        guard cameraMode != .sky, let aspectRatio else {
            return
        }
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
                trackingMap = TrackedMap(map)
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
    /// `aspectRatio`; `target` is where what has an id is.
    private mutating func mapPose(uptime: Double, aspectRatio: Double, target: (String) -> SIMD3<Double>?) -> CameraPose {
        var map = mapCamera ?? MapCamera.home(aspectRatio: aspectRatio)
        map.clamp(aspectRatio: aspectRatio)
        mapCamera = map
        if case .tracking(let id) = cameraMode, let position = target(id) {
            let place = geodeticPosition(position)
            let held = trackingMap ?? TrackedMap(map)
            map = MapCamera(latitude: place.latitude, longitude: place.longitude, span: held.span, heading: held.heading)
            map.clamp(aspectRatio: aspectRatio)
            trackingMap = TrackedMap(map)
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

    /// Where the frame drawn at `time` (UTC milliseconds) on a view of
    /// `aspectRatio` is seen from: the free camera, what is tracked or the sky
    /// view, partway through any flight between them. `model` is how the tracked
    /// satellite's 3D model can be framed, `target` where what has an id is, and
    /// `groundHeight` the ground's height in metres at a place. Nil before the
    /// view has a size, and nil, with the cameras put back home, where the pose
    /// is not finite.
    mutating func pose(
        uptime: Double, time now: Double, aspectRatio: Double, model: (String) -> TrackedModel, target: (String) -> SIMD3<Double>?,
        groundHeight: (GeoCoordinate) -> Double?
    ) -> CameraPose? {
        guard var orbitCamera else {
            return nil
        }
        if drawnProjection == .twoD {
            inertialAngle = nil
            let pose = mapPose(uptime: uptime, aspectRatio: aspectRatio, target: target)
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
        var pose = orbitCamera.pose()
        frameModel(model)
        if case .tracking(let id) = cameraMode, let target = target(id) {
            pose = trackingCamera.pose(target: target)
        }
        if let flight = poseFlight {
            if cameraMode != .sky {
                pose = PoseFlight.pose(from: flight.from, to: pose, t: flight.progress(at: uptime))
            }
            if flight.isOver(at: uptime) || cameraMode == .sky {
                poseFlight = nil
            }
        }
        if cameraMode == .sky, var camera = skyCamera {
            // Up at once out of the ground; down gently onto finer terrain as it loads.
            if let ground = groundHeight(GeoCoordinate(latitude: camera.latitude, longitude: camera.longitude)) {
                camera.groundHeight = ground > camera.groundHeight ? ground : camera.groundHeight + (ground - camera.groundHeight) * 0.1
            }
            // Read again every frame, as the screen turns under the picture.
            if let passthrough {
                camera.verticalFieldOfView = passthrough.verticalFieldOfView(viewAspectRatio: aspectRatio)
            }
            skyCamera = camera
            pose = camera.pose()
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
        }
        guard pose.isFinite else {
            // Drawn from, it leaves nothing on screen until the app is relaunched.
            let mode = cameraMode
            log.fault("Camera not finite: \(String(describing: orbitCamera), privacy: .public), \(String(describing: mode), privacy: .public)")
            self.orbitCamera = OrbitCamera.home(aspectRatio: aspectRatio)
            trackingCamera = TrackingCamera()
            homeFlight = nil
            poseFlight = nil
            if cameraMode == .sky {
                landOnGlobe()
            }
            return nil
        }
        lastPose = pose
        return pose
    }
}

/// How the map frames what it follows: as wide and as turned as this.
private struct TrackedMap {
    /// Metres across the view's longer side, as `MapCamera.span`.
    var span: Double
    /// Radians, as `MapCamera.heading`.
    var heading: Double

    init(span: Double, heading: Double) {
        self.span = span
        self.heading = heading
    }

    /// As `map` frames its centre.
    init(_ map: MapCamera) {
        self.init(span: map.span, heading: map.heading)
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
