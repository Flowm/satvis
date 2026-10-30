import CoreGraphics
import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// The flat map, the web app's 2D: its projection, its camera and its limits,
/// the camera rig drawing from it, and a frame drawn on it.
@Suite struct MapCameraTests {
    private static let degree = Double.pi / 180
    private static let portrait = 390.0 / 844
    private static let landscape = 1180.0 / 820
    private static let viewSize = CGSize(width: 390, height: 844)
    /// 2026-10-03, in UTC milliseconds.
    private static let time = 1_791_000_000_000.0

    /// A point `height` metres over a place, in the fixed frame.
    private static func position(latitude: Double, longitude: Double, height: Double) -> SIMD3<Double> {
        let ground = fixedPosition(latitude: latitude, longitude: longitude)
        let (phi, lambda) = (latitude * degree, longitude * degree)
        return ground + height * SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
    }

    // Where CesiumJS's 2D places a satellite: its cartographic position, height and all.
    @Test(arguments: [(48.1, 11.6, 0.0), (51.6, -120.0, 420_000.0), (-89.9, 30.0, 800_000.0), (0.0, 179.9, 35_786_000.0), (90.0, 0.0, 1_000.0)])
    func placesAPointByItsGeodeticPosition(latitude: Double, longitude: Double, height: Double) {
        let place = geodeticPosition(Self.position(latitude: latitude, longitude: longitude, height: height))
        #expect(abs(place.latitude / Self.degree - latitude) < 1e-7)
        #expect(abs(remainder(place.longitude / Self.degree - longitude, 360)) < 1e-7 || abs(latitude) == 90)
        #expect(abs(place.height - height) < 0.01)
    }

    @Test func opensAsTheWebAppAndZoomsOutToTheWholeMap() {
        let home = MapCamera.home(aspectRatio: Self.portrait)
        #expect(home.latitude == 0 && home.longitude == 0 && home.heading == 0)
        // CesiumJS's 2D frustum: 2.5 radii either side across the view's width,
        // whichever side is longer.
        #expect(abs(home.halfExtent(aspectRatio: Self.portrait).x - 2.5 * MapCamera.radius) < 1e-6)
        #expect(abs(MapCamera.home(aspectRatio: Self.landscape).halfExtent(aspectRatio: Self.landscape).x - 2.5 * MapCamera.radius) < 1e-6)
        // No further out than the whole map across the view's width.
        var whole = home
        whole.span = .infinity
        whole.clamp(aspectRatio: Self.landscape)
        #expect(abs(whole.halfExtent(aspectRatio: Self.landscape).x * 2 - MapCamera.mapWidth) < 1e-6)
        // Turned a quarter, its width up the view.
        var turned = home
        turned.heading = .pi / 2
        turned.span = .infinity
        turned.clamp(aspectRatio: Self.portrait)
        #expect(abs(turned.boundingHalfExtent(aspectRatio: Self.portrait).x * 2 - MapCamera.mapWidth) < 1e-3)
    }

    @Test func movesWithTheFingerAndWrapsAtTheAntimeridian() {
        var map = MapCamera(latitude: 0, longitude: 179.5 * Self.degree, span: 2_000_000)
        let metresPerPoint = map.span / Self.viewSize.height
        // Dragged left by a degree's worth: the map follows, its centre goes east, over 180°.
        map.pan(by: SIMD2(-2 * Self.degree * MapCamera.radius / metresPerPoint, 0), longerSide: Self.viewSize.height)
        #expect(abs(map.longitude / Self.degree - -178.5) < 1e-9)
        // Dragged down, the centre goes north, and stops at the pole.
        map.pan(by: SIMD2(0, 1e9), longerSide: Self.viewSize.height)
        #expect(map.latitude == .pi / 2)
        // A place 20° east over the antimeridian is the copy nearest the centre.
        let near = MapCamera(latitude: 0, longitude: 170 * Self.degree, span: 1e6).offset(latitude: 0, longitude: -170 * Self.degree)
        #expect(abs(near.x - 20 * Self.degree * MapCamera.radius) < 1e-6)
    }

    @Test func holdsTheZoomBetweenItsLimits() {
        var map = MapCamera.home(aspectRatio: Self.portrait)
        map.zoom(by: 1e9)
        #expect(map.span == MapCamera.minimumSpan)
        map.zoom(by: 1e-9)
        map.clamp(aspectRatio: Self.portrait)
        #expect(map.span == MapCamera.maximumSpan(aspectRatio: Self.portrait))
        // Gestures that are not finite are ignored, as the globe's are.
        let before = map
        map.zoom(by: .nan)
        map.rotate(by: .nan)
        map.pan(by: SIMD2(.nan, 0), longerSide: 844)
        #expect(map == before)
    }

    // A switch keeps the place: the scale at the globe's centre, or the whole map
    // from where the globe's whole disc is in sight; and back.
    @Test func keepsThePlaceAcrossASwitch() {
        #expect(MapCamera.matching(OrbitCamera.home(aspectRatio: Self.portrait), aspectRatio: Self.portrait) == MapCamera.home(aspectRatio: Self.portrait))
        let globe = OrbitCamera(latitude: 46 * Self.degree, longitude: 8 * Self.degree, altitude: 1_000_000, heading: 0.3)
        let map = MapCamera.matching(globe, aspectRatio: Self.portrait)
        #expect(map.latitude == globe.latitude && map.longitude == globe.longitude && map.heading == globe.heading)
        #expect(abs(map.span - 2 * 1_000_000 * tan(OrbitCamera.fieldOfView / 2)) < 1e-6)
        let back = map.globe(aspectRatio: Self.portrait)
        #expect(abs(back.altitude - globe.altitude) < 1e-6 && back.latitude == globe.latitude && back.heading == globe.heading)
        // The whole map comes back no further out than the home view.
        #expect(MapCamera.home(aspectRatio: Self.portrait).globe(aspectRatio: Self.portrait).altitude == OrbitCamera.home(aspectRatio: Self.portrait).altitude)
    }

    @Test func projectsTheMapTurnedByTheHeading() {
        var map = MapCamera(latitude: 0, longitude: 0, span: 2_000_000)
        let half = map.halfExtent(aspectRatio: Self.portrait)
        func clip(_ east: Double, _ north: Double, _ up: Double = 0) -> SIMD4<Double> {
            map.viewProjection(aspectRatio: Self.portrait) * SIMD4(east, north, up, 1)
        }
        #expect(simd.distance(clip(half.x, 0), SIMD4(1, 0, 0.5, 1)) < 1e-12)
        #expect(simd.distance(clip(0, half.y), SIMD4(0, 1, 0.5, 1)) < 1e-12)
        // Higher is nearer, as reversed-Z has it, out past Chandra's apogee.
        #expect(clip(0, 0, 400_000).z > clip(0, 0, 0).z)
        #expect(clip(0, 0, 150_000_000).z < 1 && clip(0, 0, 150_000_000).z > clip(0, 0, 400_000).z)
        // A quarter turn clockwise: north to the right, as `OrbitCamera`'s heading.
        map.heading = .pi / 2
        #expect(abs(clip(0, half.x).x - 1) < 1e-12)
    }

    // A 3D model stands on the map by its axes in east, north and up there, from
    // where it is on the map.
    @Test func standsAModelOnTheMap() {
        let map = MapCamera(latitude: 0, longitude: 10 * Self.degree, span: 4_000_000)
        let position = Self.position(latitude: 0, longitude: 20, height: 400_000)
        let (east, north, up) = eastNorthUp(latitude: 0, longitude: 20 * Self.degree)
        // A frame whose axes are north, up and east there.
        let placed = map.placement(of: simd_double3x3(columns: (north, up, east)), at: position, scale: 2)
        #expect(simd.distance(placed.columns.0, SIMD4(0, 2, 0, 0)) < 1e-9)
        #expect(simd.distance(placed.columns.1, SIMD4(0, 0, 2, 0)) < 1e-9)
        #expect(simd.distance(placed.columns.2, SIMD4(2, 0, 0, 0)) < 1e-9)
        let offset = placed.columns.3
        #expect(abs(offset.x - 10 * Self.degree * MapCamera.radius) < 1e-6 && abs(offset.y) < 1e-6 && abs(offset.z - 400_000) < 0.01)
        // Lit from straight above: the model less the eye, as the globe's frame
        // is, so the eye looks down at what the map shows of it.
        let lit = MapCamera.lighting(of: simd_double3x3(columns: (north, up, east)), at: position, scale: 2)
        #expect(simd.distance(lit.columns.0, SIMD4(north * 2, 0)) < 1e-12)
        let fromEye = SIMD3(lit.columns.3.x, lit.columns.3.y, lit.columns.3.z)
        #expect(simd.distance(fromEye, -MapCamera.lightingHeight * up) < 1e-6)
    }

    // MARK: The rig

    /// On the home view with a frame drawn, in 2D.
    private static func rig() -> CameraRig {
        var rig = CameraRig()
        rig.openHome(aspectRatio: portrait)
        frame(&rig, at: 0)
        rig.setProjection(.twoD, animated: false, aspectRatio: portrait)
        rig.showProjection()
        frame(&rig, at: 0)
        return rig
    }

    @discardableResult
    private static func frame(_ rig: inout CameraRig, at uptime: Double, target: SIMD3<Double>? = nil) -> CameraPose? {
        rig.pose(uptime: uptime, time: time, aspectRatio: portrait, model: { _ in .noModel }, target: { _ in target }, groundHeight: { _ in 0 })
    }

    @Test func drawsFromTheMapOnceShownAndBack() throws {
        var rig = CameraRig()
        rig.openHome(aspectRatio: Self.portrait)
        Self.frame(&rig, at: 0)
        rig.setProjection(.twoD, animated: true, aspectRatio: Self.portrait)
        // The old projection until the renderer has kept a frame of it.
        #expect(rig.shownProjection == .twoD && rig.drawnProjection == .threeD && rig.fadesProjection)
        #expect(Self.frame(&rig, at: 0)?.mapCamera == nil)
        rig.showProjection()
        let pose = try #require(Self.frame(&rig, at: 0))
        #expect(pose.mapCamera == MapCamera.home(aspectRatio: Self.portrait))
        // Its globe camera is the one over the map, which the sky view flies from.
        #expect(pose.position == MapCamera.home(aspectRatio: Self.portrait).globe(aspectRatio: Self.portrait).pose().position)

        rig.zoom(by: 10)
        rig.setProjection(.threeD, animated: false, aspectRatio: Self.portrait)
        rig.showProjection()
        let globe = try #require(Self.frame(&rig, at: 0))
        #expect(globe.mapCamera == nil)
        #expect(abs(try #require(rig.orbitCamera).altitude - MapCamera.home(aspectRatio: Self.portrait).span / 10 / (2 * tan(OrbitCamera.fieldOfView / 2))) < 1)
    }

    @Test func steersTheMapAndFliesItHome() throws {
        var rig = Self.rig()
        rig.zoom(by: 4)
        rig.drag(by: SIMD2(-100, 0), viewSize: Self.viewSize)
        rig.rotate(by: 0.2)
        let moved = try #require(rig.mapCamera)
        #expect(moved.longitude > 0 && moved.heading == 0.2)
        // The globe camera is not what the gestures steered.
        #expect(rig.orbitCamera == OrbitCamera.home(aspectRatio: Self.portrait))

        // From where the last frame was drawn.
        Self.frame(&rig, at: 9)
        rig.flyHome(animated: true, uptime: 10, aspectRatio: Self.portrait)
        let halfway = try #require(Self.frame(&rig, at: 10.75)?.mapCamera)
        #expect(halfway.span > moved.span && halfway.span < MapCamera.home(aspectRatio: Self.portrait).span)
        #expect(Self.frame(&rig, at: 11.6)?.mapCamera == MapCamera.home(aspectRatio: Self.portrait))
    }

    @Test func followsATargetInTheMiddleAndLetsGo() throws {
        var rig = Self.rig()
        rig.zoom(by: 8)
        // Followed at the scale last drawn.
        let free = try #require(Self.frame(&rig, at: 0)?.mapCamera)
        let iss = Self.position(latitude: 40, longitude: -100, height: 420_000)
        rig.track("25544", animated: false, uptime: 1, model: { _ in .noModel })
        let tracked = try #require(Self.frame(&rig, at: 1, target: iss)?.mapCamera)
        #expect(abs(tracked.latitude / Self.degree - 40) < 1e-7 && abs(tracked.longitude / Self.degree - -100) < 1e-7)
        #expect(tracked.span == free.span)
        // A drag does nothing; a pinch closes in on it.
        rig.drag(by: SIMD2(200, 50), viewSize: Self.viewSize)
        rig.zoom(by: 2)
        let closer = try #require(Self.frame(&rig, at: 1, target: iss)?.mapCamera)
        #expect(closer.latitude == tracked.latitude && abs(closer.span - free.span / 2) < 1e-6)
        // Back where it was, the free camera kept meanwhile.
        rig.stopTracking(animated: false, uptime: 2)
        #expect(Self.frame(&rig, at: 2)?.mapCamera == free)
    }

    // A switch while following something keeps the scale it is followed at,
    // either way.
    @Test func keepsTheTrackedScaleAcrossASwitch() throws {
        var rig = CameraRig()
        rig.openHome(aspectRatio: Self.portrait)
        let iss = Self.position(latitude: 40, longitude: -100, height: 420_000)
        rig.track("25544", animated: false, uptime: 0, model: { _ in .noModel })
        let globe = try #require(Self.frame(&rig, at: 0, target: iss))
        rig.zoom(by: 4)
        let closer = try #require(Self.frame(&rig, at: 0, target: iss))
        let range = simd.distance(closer.position, iss)
        #expect(range < simd.distance(globe.position, iss))
        rig.setProjection(.twoD, animated: false, aspectRatio: Self.portrait)
        rig.showProjection()
        let map = try #require(Self.frame(&rig, at: 0, target: iss)?.mapCamera)
        #expect(abs(map.span - 2 * range * tan(OrbitCamera.fieldOfView / 2)) < 1)
        rig.zoom(by: 2)
        Self.frame(&rig, at: 0, target: iss)
        rig.setProjection(.threeD, animated: false, aspectRatio: Self.portrait)
        rig.showProjection()
        let back = try #require(Self.frame(&rig, at: 0, target: iss))
        #expect(abs(simd.distance(back.position, iss) - range / 2) < 1)
    }

    // A flight that turns the map holds it to the limit at every heading on the way.
    @Test func holdsAFlightToTheZoomLimit() throws {
        var rig = Self.rig()
        rig.rotate(by: .pi / 2)
        rig.zoom(by: 1e-9)
        let turned = try #require(Self.frame(&rig, at: 0)?.mapCamera)
        #expect(abs(turned.span - MapCamera.maximumSpan(aspectRatio: Self.portrait, heading: .pi / 2)) < 1e-6)
        rig.flyHome(animated: true, uptime: 1, aspectRatio: Self.portrait)
        for step in 0...30 {
            let map = try #require(Self.frame(&rig, at: 1 + Double(step) * 0.05)?.mapCamera)
            #expect(map.span <= MapCamera.maximumSpan(aspectRatio: Self.portrait, heading: map.heading) * (1 + 1e-12))
        }
    }

    // The sky view is drawn in 3D, and goes back to the map.
    @Test func goesThroughTheSkyViewAndBackToTheMap() throws {
        var rig = Self.rig()
        rig.zoom(by: 4)
        let map = try #require(rig.mapCamera)
        rig.enterSky(SkyCamera(latitude: 46.5935, longitude: 7.9091), animated: false, uptime: 1, aspectRatio: Self.portrait)
        #expect(rig.shownProjection == .threeD)
        // The way back lands on the globe over the map.
        #expect(rig.orbitCamera == map.globe(aspectRatio: Self.portrait))
        rig.showProjection()
        #expect(Self.frame(&rig, at: 1)?.mapCamera == nil)
        rig.leaveSky(animated: false, uptime: 2, aspectRatio: Self.portrait)
        #expect(rig.shownProjection == .twoD)
        rig.showProjection()
        #expect(Self.frame(&rig, at: 2)?.mapCamera == map)
        // Choosing 3D in the sky view leaves it for the globe.
        rig.enterSky(SkyCamera(latitude: 46.5935, longitude: 7.9091), animated: false, uptime: 3, aspectRatio: Self.portrait)
        rig.showProjection()
        rig.setProjection(.threeD, animated: false, aspectRatio: Self.portrait)
        #expect(rig.shownProjection == .threeD)
        rig.leaveSky(animated: false, uptime: 4, aspectRatio: Self.portrait)
        rig.showProjection()
        #expect(Self.frame(&rig, at: 4)?.mapCamera == nil)
    }

    // MARK: A frame on the map

    @Test func answersTapsOnTheMap() throws {
        let map = MapCamera(latitude: 10 * Self.degree, longitude: 175 * Self.degree, span: 4_000_000, heading: 0.4)
        let pose = CameraPose(position: SIMD3(1, 0, 0), right: SIMD3(0, 1, 0), up: SIMD3(0, 0, 1), back: SIMD3(1, 0, 0), mapCamera: map)
        let frame = DrawnFrame(pose: pose, size: SIMD2(2 * Self.viewSize.width, 2 * Self.viewSize.height), time: Self.time)
        let centre = CGPoint(x: Self.viewSize.width / 2, y: Self.viewSize.height / 2)
        // The centre is the camera's place, and a satellite over it is drawn there.
        let ground = try #require(frame.groundPoint(at: centre, viewSize: Self.viewSize))
        #expect(abs(ground.latitude - 10) < 1e-9 && abs(ground.longitude - 175) < 1e-9)
        let over = Self.position(latitude: 10, longitude: 175, height: 500_000)
        let spot = try #require(frame.screenPoint(over, viewSize: Self.viewSize))
        #expect(hypot(spot.x - centre.x, spot.y - centre.y) < 1e-6)
        // A tap off the centre lands on the place drawn there, over the antimeridian.
        let tap = CGPoint(x: 300, y: 200)
        let place = try #require(frame.groundPoint(at: tap, viewSize: Self.viewSize))
        let back = try #require(frame.screenPoint(fixedPosition(latitude: place.latitude, longitude: place.longitude), viewSize: Self.viewSize))
        #expect(hypot(back.x - tap.x, back.y - tap.y) < 1e-6)
        // Picked whatever is behind the Earth from the globe camera's eye.
        let satellites = StillSatellites(places: [("over", over)])
        #expect(frame.entity(at: centre, viewSize: Self.viewSize, stations: [], satellites: satellites, components: [.point], labels: nil) == "over")
    }

    // An idle map still skips frames: how fast anything crosses it.
    @Test func boundsHowFastSatellitesCrossTheMap() {
        let radius = 6_378_137.0
        let leo = OrbitMotion(lowest: radius + 400_000, highest: radius + 420_000, farthestStep: 7_660 * 46, step: 46, hasCone: false)!
        let pixelsPerMetre = 844 * 2 / MapCamera.maximumSpan(aspectRatio: Self.portrait)
        let equator = RenderPacing.mapPixelRate([leo], lines: false, pixelsPerMetre: pixelsPerMetre, latitude: { _ in 0 })
        #expect(equator > 0 && equator.isFinite)
        // Nearer a pole the map stretches it east to west; a line reaches the poles.
        #expect(RenderPacing.mapPixelRate([leo], lines: false, pixelsPerMetre: pixelsPerMetre, latitude: { _ in 70 * Self.degree }) > 2 * equator)
        #expect(RenderPacing.mapPixelRate([leo], lines: true, pixelsPerMetre: pixelsPerMetre, latitude: { _ in 0 }) > 10 * equator)
        // Not drawn, it bounds nothing; close in, every frame is drawn.
        #expect(RenderPacing.mapPixelRate([leo], lines: false, pixelsPerMetre: pixelsPerMetre, latitude: { _ in nil }) == 0)
        #expect(RenderPacing.mapPixelRate([leo], lines: false, pixelsPerMetre: 1, latitude: { _ in 0 }) == .infinity)
    }
}
