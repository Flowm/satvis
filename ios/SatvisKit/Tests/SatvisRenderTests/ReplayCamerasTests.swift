import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// The overpass replay's cameras (ADR 0023): the chase, the broadcast camera and the
/// flights over a station and back, held to the web app's src/modules/ReplayCamera.ts.
@Suite struct ReplayCamerasTests {
    private static let aspectRatio = 390.0 / 844
    /// 2026-10-03, in UTC milliseconds.
    private static let time = 1_791_000_000_000.0
    private static let degree = Double.pi / 180
    /// The satellite's height above the equator, metres.
    private static let altitude = 800_000.0

    /// A satellite flying east over the equator, `altitude` up, at about 7.5 km/s,
    /// over 0° E at `time`.
    private static func eastbound(_ epochMilliseconds: Double) -> SIMD3<Double>? {
        let radius = ellipsoidRadii.x + altitude
        let angle = (epochMilliseconds - time) / 1000 * 7_500 / radius
        return radius * SIMD3(cos(angle), sin(angle), 0)
    }

    /// On the home view with a frame drawn, which a flight sets off from.
    private static func rig() -> CameraRig {
        var rig = CameraRig()
        rig.resize(aspectRatio: aspectRatio)
        frame(&rig, at: 0)
        return rig
    }

    @discardableResult
    private static func frame(_ rig: inout CameraRig, at uptime: Double, time: Double = time) -> CameraPose? {
        rig.pose(uptime: uptime, time: time, model: { _ in .noModel }, target: { _, at in eastbound(at) }, groundHeight: { _ in 0 })
    }

    /// `a` and `b` within `tolerance` of each other, coordinate by coordinate.
    private static func near(_ a: SIMD3<Double>, _ b: SIMD3<Double>, within tolerance: Double) -> Bool {
        simd.length(a - b) <= tolerance
    }

    // The chase's offset and tilt, metres and radians, as the web app's chaseOffset
    // and chaseTilt give them (node, from src/modules/ReplayCamera.ts): the swath's
    // range at a low height, else the range that keeps the satellite 12° above the aim.
    @Test(arguments: [
        (3000.0, 400_000.0, SIMD3(-1_992_641.590028272, 0, 1_974_737.7736688317), 0.0917791883016893),
        (185, 200_000, SIMD3(-758_489.3794301165, 0, 703_932.442880394), 0.12455505289795776),
        (3000, 830_000, SIMD3(-2_022_082.2782138449, 0, 1_579_823.819582434), 0.20943951023931962),
        (185, 705_000, SIMD3(-1_717_551.8146274223, 0, 1_341_898.545548935), 0.2094395102393195),
    ])
    func chaseMatchesTheWebApp(swathKm: Double, altitude: Double, offset: SIMD3<Double>, tilt: Double) {
        #expect(Self.near(Chase.offset(swathKm: swathKm, altitude: altitude), offset, within: 1e-6))
        #expect(abs(Chase.tilt(swathKm: swathKm, altitude: altitude) - tilt) < 1e-12)
    }

    // The tracking camera of the chase stands at the offset in the axes tracking
    // holds it in, looks 50° down onto the ground under the satellite, and so has
    // the satellite up the screen.
    @Test func chaseCameraStandsAtTheOffsetLookingDownOnTheGround() throws {
        let target = try #require(Self.eastbound(Self.time))
        let velocity = try #require(Self.eastbound(Self.time + 1)) - target
        let camera = TrackingCamera.chase(swathKm: 3000, altitude: Self.altitude)
        let pose = camera.pose(target: target, velocity: velocity * 1000)
        let (x, y, z) = TrackingCamera.axes(target: target, velocity: velocity * 1000)
        let offset = Chase.offset(swathKm: 3000, altitude: Self.altitude)
        #expect(Self.near(pose.position, target + offset.x * x + offset.y * y + offset.z * z, within: 1e-3))
        #expect(abs(dot(-pose.back, z) + sin(Chase.pitch)) < 1e-9)
        // Straight ahead, the ground under the satellite.
        let ground = target - Self.altitude * z
        #expect(simd.length(cross(normalize(ground - pose.position), -pose.back)) < 1e-9)
        #expect(dot(target - pose.position, pose.up) > 0)
        #expect(abs(dot(pose.right, pose.up)) < 1e-12 && abs(dot(pose.up, pose.back)) < 1e-12)
    }

    // A pinch keeps looking past the satellite by the chase's tilt.
    @Test func chaseKeepsItsTiltThroughAZoom() throws {
        let target = try #require(Self.eastbound(Self.time))
        let velocity = (try #require(Self.eastbound(Self.time + 1)) - target) * 1000
        var camera = TrackingCamera.chase(swathKm: 185, altitude: Self.altitude)
        camera.zoom(by: 2)
        let pose = camera.pose(target: target, velocity: velocity)
        let angle = acos(dot(normalize(target - pose.position), -pose.back))
        #expect(abs(angle - camera.tilt) < 1e-9)
    }

    // The flights' easing is smootherstep, the web app's: still at both ends,
    // through the middle at 1.875 times the mean rate.
    @Test func easesBySmootherstep() {
        let web = { (t: Double) in t * t * t * (t * (t * 6 - 15) + 10) }
        for t in stride(from: 0.0, through: 1, by: 0.05) {
            #expect(abs(SkyFlight.ease(t) - web(t)) < 1e-15)
        }
        #expect(SkyFlight.ease(0.25) == 0.103515625)
        #expect(SkyFlight.ease(-1) == 0 && SkyFlight.ease(2) == 1)
        #expect(abs((SkyFlight.ease(0.5 + 1e-6) - SkyFlight.ease(0.5 - 1e-6)) / 2e-6 - 1.875) < 1e-6)
        #expect(abs(SkyFlight.ease(1e-4) / 1e-4) < 1e-6)
        #expect(BroadcastCamera.swingDuration == 2)
    }

    // The broadcast camera stands beyond the station on its side of the ground
    // track, 1,800 km above it, level, looking towards the satellite.
    @Test(arguments: [10.0, -10.0])
    func broadcastStandsBeyondTheStation(latitude: Double) throws {
        let station = GroundPoint(latitude: latitude, longitude: 5)
        var camera = try #require(BroadcastCamera(satellite: "s", station: station, swathKm: 3000, now: Self.time, position: Self.eastbound))
        let track = try #require(BroadcastCamera.groundTrack(now: Self.time, position: Self.eastbound))
        let stationPoint = fixedPosition(latitude: latitude, longitude: 5)
        let up = eastNorthUp(latitude: latitude * Self.degree, longitude: 5 * Self.degree).up
        // Out to the side by half the swath and 900 km, along the track's starboard.
        let side = dot(stationPoint - track.ground, track.right)
        let out = camera.eye - stationPoint - BroadcastCamera.height * up
        #expect(Self.near(out, track.right * (side < 0 ? -1 : 1) * 2_400_000, within: 1e-6))
        #expect((geodetic(camera.eye).latitude - latitude) * latitude > 0)

        let aimed = camera.pose(uptime: 0, time: Self.time, position: Self.eastbound)
        let pose = try #require(aimed)
        #expect(pose.position == camera.eye)
        #expect(abs(dot(pose.right, camera.eyeUp)) < 1e-12)
        let aim = track.ground + track.up * Self.altitude * BroadcastCamera.aimHeightShare
        #expect(simd.length(cross(normalize(aim - pose.position), -pose.back)) < 1e-9)
        let satellite = try #require(Self.eastbound(Self.time))
        #expect(dot(normalize(satellite - pose.position), -pose.back) > cos(15 * Self.degree))
    }

    // It turns with the satellite as the clock moves, holds its last aim while the
    // satellite has no place, and cannot start without one.
    @Test func broadcastTurnsWithTheSatellite() throws {
        let station = GroundPoint(latitude: 10, longitude: 5)
        var camera = try #require(BroadcastCamera(satellite: "s", station: station, swathKm: 200, now: Self.time, position: Self.eastbound))
        let firstAim = camera.pose(uptime: 0, time: Self.time, position: Self.eastbound)
        let laterAim = camera.pose(uptime: 0, time: Self.time + 60_000, position: Self.eastbound)
        let first = try #require(firstAim)
        let later = try #require(laterAim)
        #expect(first.position == later.position && first.back != later.back)
        let held = camera.pose(uptime: 0, time: Self.time, position: { _ in nil })
        #expect(held == later)
        #expect(BroadcastCamera(satellite: "s", station: station, swathKm: 200, now: Self.time, position: { _ in nil }) == nil)
        #expect(BroadcastCamera(satellite: "s", station: station, swathKm: 200, now: Self.time, position: { _ in SIMD3(7e6, 0, 0) }) == nil)
    }

    // Started animated, it swings in from the last pose over two seconds, and lets
    // go of what was tracked; stopped, the free camera looks down on where it looked.
    @Test func broadcastSwingsInAndLeavesTheFreeCameraOverWhereItLooked() throws {
        var rig = Self.rig()
        rig.track("s", animated: false, uptime: 1) { _ in .noModel }
        let tracked = try #require(Self.frame(&rig, at: 1))
        let camera = try #require(
            BroadcastCamera(satellite: "s", station: GroundPoint(latitude: 10, longitude: 5), swathKm: 3000, now: Self.time, position: Self.eastbound))
        let started = rig.startBroadcast(camera, animated: true, uptime: 2)
        #expect(started)
        #expect(rig.cameraMode == .orbit && rig.isBroadcasting)
        let start = try #require(Self.frame(&rig, at: 2))
        #expect(Self.near(start.position, tracked.position, within: 1e-6))
        let partway = try #require(Self.frame(&rig, at: 3))
        #expect(!Self.near(partway.position, camera.eye, within: 1_000))
        let landed = try #require(Self.frame(&rig, at: 4))
        #expect(landed.position == camera.eye)

        rig.stopBroadcast(animated: false, uptime: 5)
        #expect(!rig.isBroadcasting)
        let free = try #require(rig.orbitCamera)
        let after = try #require(Self.frame(&rig, at: 5))
        #expect(after == free.pose())
        // Over the ground the broadcast looked at, with the screen's up kept.
        #expect(abs(free.latitude) < 10 * Self.degree && dot(after.up, landed.up) > 0)
    }

    // Not on the map, nor in the sky view; a change of projection ends it.
    @Test func broadcastNeedsTheGlobe() throws {
        let camera = try #require(
            BroadcastCamera(satellite: "s", station: GroundPoint(latitude: 10, longitude: 5), swathKm: 3000, now: Self.time, position: Self.eastbound))
        var rig = Self.rig()
        rig.enterSky(SkyCamera(latitude: 10, longitude: 5), animated: false, uptime: 1)
        #expect(!rig.canBroadcast)
        let fromTheSky = rig.startBroadcast(camera, animated: false, uptime: 1)
        #expect(!fromTheSky)

        rig = Self.rig()
        let started = rig.startBroadcast(camera, animated: false, uptime: 1)
        #expect(started)
        Self.frame(&rig, at: 1)
        rig.setProjection(.twoD, animated: false)
        #expect(!rig.isBroadcasting)
        rig.showProjection()
        #expect(!rig.canBroadcast)
        let onTheMap = rig.startBroadcast(camera, animated: false, uptime: 2)
        #expect(!onTheMap)
    }

    // Flown over a station, the camera looks straight down on it, north up, from
    // the height asked for, after two seconds; tracking stops on the way.
    @Test func fliesOverAPlaceLookingStraightDownNorthUp() throws {
        var rig = Self.rig()
        rig.track("s", animated: false, uptime: 1) { _ in .noModel }
        let tracked = try #require(Self.frame(&rig, at: 1))
        rig.fly(to: .over(latitude: 48, longitude: 11, height: 5_000_000), animated: true, uptime: 2)
        #expect(rig.cameraMode == .orbit)
        let start = try #require(Self.frame(&rig, at: 2))
        #expect(Self.near(start.position, tracked.position, within: 1e-6))
        let pose = try #require(Self.frame(&rig, at: 4))
        let (_, north, up) = eastNorthUp(latitude: 48 * Self.degree, longitude: 11 * Self.degree)
        #expect(dot(pose.back, up) > 1 - 1e-9)
        #expect(dot(pose.up, north) > 1 - 1e-9)
        #expect(abs(geodeticPosition(pose.position).height - 5_000_000) < 5_000)
        #expect(rig.currentView() == .over(latitude: 48, longitude: 11, height: 5_000_000))
    }

    // Flown back to a view taken earlier, the camera lands on it; a broadcast
    // meanwhile ends.
    @Test func fliesBackToAViewTaken() throws {
        var rig = Self.rig()
        let view = try #require(rig.currentView())
        let home = try #require(Self.frame(&rig, at: 1))
        let camera = try #require(
            BroadcastCamera(satellite: "s", station: GroundPoint(latitude: 10, longitude: 5), swathKm: 3000, now: Self.time, position: Self.eastbound))
        let started = rig.startBroadcast(camera, animated: false, uptime: 1)
        #expect(started)
        Self.frame(&rig, at: 1)
        rig.fly(to: view, animated: false, uptime: 2)
        #expect(!rig.isBroadcasting)
        let back = try #require(Self.frame(&rig, at: 2))
        #expect(back == home)
    }

    // A broadcast waiting for its satellite gives up after five seconds, as the
    // web app's never does.
    @Test func pendingBroadcastLapsesAfterFiveSeconds() {
        let pending = PendingBroadcast(
            satellite: "s", station: GroundPoint(latitude: 10, longitude: 5), fallback: .over(latitude: 10, longitude: 5, height: 5_000_000),
            animated: true, start: 100)
        #expect(!pending.hasLapsed(at: 105))
        #expect(pending.hasLapsed(at: 105.1))
    }
}
