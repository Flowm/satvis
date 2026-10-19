import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// The camera rig's modes and flights, flown on a made-up uptime.
@Suite struct CameraRigTests {
    private static let aspectRatio = 390.0 / 844
    private static let viewSize = CGSize(width: 390, height: 844)
    private static let observer = SkyCamera(latitude: 46.5935, longitude: 7.9091)
    /// 2026-10-03, in UTC milliseconds.
    private static let time = 1_791_000_000_000.0
    private static let degree = Double.pi / 180

    /// On the home view with a frame drawn, which a flight sets off from.
    private static func rig() -> CameraRig {
        var rig = CameraRig()
        rig.openHome(aspectRatio: aspectRatio)
        frame(&rig, at: 0)
        return rig
    }

    @discardableResult
    private static func frame(
        _ rig: inout CameraRig, at uptime: Double, time: Double = time, target: SIMD3<Double>? = nil, model: TrackedModel = .noModel
    ) -> CameraPose? {
        rig.pose(uptime: uptime, time: time, aspectRatio: aspectRatio, model: { _ in model }, target: { _ in target }, groundHeight: { _ in 0 })
    }

    @Test func landsInTheSkyViewAfterTheFlightAndHoldsTheGesturesTillThen() throws {
        var rig = Self.rig()
        rig.enterSky(Self.observer, animated: true, uptime: 10, aspectRatio: Self.aspectRatio)
        #expect(rig.cameraMode == .sky && !rig.isSkySettled && rig.wantsTerrain)
        let aim = try #require(rig.skyCamera)
        Self.frame(&rig, at: 10 + SkyFlight.duration / 2)
        rig.drag(by: SIMD2(100, 50), viewSize: Self.viewSize)
        rig.zoom(by: 2)
        #expect(rig.skyCamera?.attitude == aim.attitude && rig.skyCamera?.verticalFieldOfView == aim.verticalFieldOfView)
        Self.frame(&rig, at: 10 + SkyFlight.duration - 0.01)
        #expect(!rig.isSkySettled)

        let landed = try #require(Self.frame(&rig, at: 10 + SkyFlight.duration + 0.01))
        #expect(rig.isSkySettled)
        #expect(simd.distance(landed.position, Self.observer.position) < 1e-6)
        rig.drag(by: SIMD2(100, 50), viewSize: Self.viewSize)
        #expect(rig.skyCamera?.attitude != aim.attitude)
    }

    // 3a26c14c: tracking during the flight out of the sky view left the terrain
    // forced on, and a stale flight for the next sky view to turn around.
    @Test func trackingOnTheWayOutOfTheSkyViewEndsTheFlight() {
        var rig = Self.rig()
        rig.enterSky(Self.observer, animated: false, uptime: 10, aspectRatio: Self.aspectRatio)
        Self.frame(&rig, at: 11)
        rig.leaveSky(animated: true, uptime: 12, aspectRatio: Self.aspectRatio)
        Self.frame(&rig, at: 13)
        #expect(rig.cameraMode == .sky && rig.wantsTerrain)

        rig.track("25544", animated: false, uptime: 13) { _ in .noModel }
        #expect(rig.cameraMode == .tracking("25544") && rig.skyCamera == nil && !rig.wantsTerrain)
        Self.frame(&rig, at: 12 + SkyFlight.duration, target: SIMD3(7_000_000, 0, 0))
        #expect(rig.cameraMode == .tracking("25544"))

        rig.stopTracking(animated: false, uptime: 20)
        rig.enterSky(Self.observer, animated: false, uptime: 21, aspectRatio: Self.aspectRatio)
        #expect(rig.isSkySettled)
    }

    // Flying out of tracking already: the free camera is home at once, and the
    // flight lands there.
    @Test func fliesHomeFromTracking() throws {
        var rig = Self.rig()
        rig.zoom(by: 4)
        rig.track("25544", animated: false, uptime: 1) { _ in .noModel }
        let tracked = try #require(Self.frame(&rig, at: 1, target: SIMD3(7_000_000, 0, 0)))

        rig.flyHome(animated: true, uptime: 2, aspectRatio: Self.aspectRatio)
        let home = OrbitCamera.home(aspectRatio: Self.aspectRatio)
        #expect(rig.cameraMode == .orbit && rig.orbitCamera == home)
        let start = try #require(Self.frame(&rig, at: 2))
        #expect(simd.distance(start.position, tracked.position) < 1e-3)
        let end = try #require(Self.frame(&rig, at: 2 + PoseFlight.duration))
        #expect(simd.distance(end.position, home.position) < 1e-3)
    }

    // fd3e7ee7: stopping left the camera 2,000 km above what it followed; it goes
    // back to the free camera tracking began from, through a switch of satellite.
    @Test func goesBackToTheViewTrackingBeganFromWhenItStops() throws {
        var rig = Self.rig()
        rig.zoom(by: 4)
        rig.drag(by: SIMD2(120, -40), viewSize: Self.viewSize)
        let before = try #require(Self.frame(&rig, at: 1))
        let free = try #require(rig.orbitCamera)

        rig.track("25544", animated: true, uptime: 2) { _ in .noModel }
        Self.frame(&rig, at: 2 + PoseFlight.duration, target: SIMD3(7_000_000, 0, 0))
        rig.track("20580", animated: true, uptime: 5) { _ in .noModel }
        let tracked = try #require(Self.frame(&rig, at: 5 + PoseFlight.duration, target: SIMD3(0, 7_000_000, 0)))

        rig.stopTracking(animated: true, uptime: 8)
        #expect(rig.cameraMode == .orbit && rig.orbitCamera == free)
        let start = try #require(Self.frame(&rig, at: 8))
        #expect(simd.distance(start.position, tracked.position) < 1e-3)
        let end = try #require(Self.frame(&rig, at: 8 + PoseFlight.duration))
        #expect(simd.distance(end.position, before.position) < 1e-3)
    }

    @Test func goesHomeFromAPoseThatIsNotFinite() throws {
        var rig = Self.rig()
        rig.zoom(by: 4)
        rig.track("25544", animated: false, uptime: 1) { _ in .noModel }
        #expect(Self.frame(&rig, at: 1, target: SIMD3(.nan, 0, 0)) == nil)
        let home = OrbitCamera.home(aspectRatio: Self.aspectRatio)
        #expect(rig.orbitCamera == home)
        // Still tracking, on the free camera while the target cannot be placed.
        let pose = try #require(Self.frame(&rig, at: 2))
        #expect(rig.cameraMode == .tracking("25544") && pose.position == home.position)
    }

    @Test func landsOnTheGlobeFromASkyCameraThatIsNotFinite() {
        var rig = Self.rig()
        rig.enterSky(SkyCamera(latitude: .nan, longitude: 0), animated: false, uptime: 1, aspectRatio: Self.aspectRatio)
        #expect(Self.frame(&rig, at: 1) == nil)
        #expect(rig.cameraMode == .orbit && rig.skyCamera == nil && !rig.wantsTerrain)
        #expect(Self.frame(&rig, at: 2) != nil)
    }

    // A zoomed camera's field of view can be narrower than the sky view's own
    // narrowest: taken every frame, and brought back within range when it goes.
    @Test func takesTheLensFieldOfViewAndClampsItWhenTheLensGoes() {
        var rig = Self.rig()
        rig.enterSky(Self.observer, animated: false, uptime: 1, aspectRatio: Self.aspectRatio)
        let lens = CameraLens(tanHalfLongSide: tan(2 * Self.degree), aspectRatio: 16 / 9, longSideVertical: true)
        rig.passthrough = lens
        Self.frame(&rig, at: 2)
        let narrow = lens.verticalFieldOfView(viewAspectRatio: Self.aspectRatio)
        #expect(narrow < SkyCamera.fieldOfViewRange.lowerBound)
        #expect(rig.skyCamera?.verticalFieldOfView == narrow)
        rig.passthrough = nil
        #expect(rig.skyCamera?.verticalFieldOfView == SkyCamera.fieldOfViewRange.lowerBound)
    }

    // The pinch zooms the device's camera instead, whose lens the sky view follows.
    @Test func ignoresAZoomWhileTheLensIsOn() {
        var rig = Self.rig()
        rig.enterSky(Self.observer, animated: false, uptime: 1, aspectRatio: Self.aspectRatio)
        let lens = CameraLens(tanHalfLongSide: tan(35 * Self.degree), aspectRatio: 16 / 9, longSideVertical: true)
        rig.passthrough = lens
        Self.frame(&rig, at: 2)
        let fieldOfView = lens.verticalFieldOfView(viewAspectRatio: Self.aspectRatio)
        rig.zoom(by: 2)
        #expect(rig.skyCamera?.verticalFieldOfView == fieldOfView)
        rig.passthrough = nil
        rig.zoom(by: 2)
        #expect(rig.skyCamera?.verticalFieldOfView == fieldOfView / 2)
    }

    // The flight sets the camera; the hold takes over again once it has landed.
    @Test func holdsInertialOnlyOnceTheHomeFlightHasLanded() throws {
        var rig = Self.rig()
        rig.cameraFrame = .inertial
        rig.zoom(by: 4)
        Self.frame(&rig, at: 1)
        let from = try #require(rig.orbitCamera)
        rig.flyHome(animated: true, uptime: 2, aspectRatio: Self.aspectRatio)
        #expect(rig.orbitCamera == from)

        let hour = 3_600_000.0
        Self.frame(&rig, at: 2.75, time: Self.time + hour)
        let home = OrbitCamera.home(aspectRatio: Self.aspectRatio)
        #expect(rig.orbitCamera == OrbitCamera.between(from, home, t: 0.5))
        Self.frame(&rig, at: 3.5, time: Self.time + hour)
        let landed = try #require(rig.orbitCamera)
        #expect(abs(landed.longitude - home.longitude) < 1e-9 && abs(landed.latitude - home.latitude) < 1e-9)

        Self.frame(&rig, at: 4, time: Self.time + 2 * hour)
        let turned = greenwichHourAngle(epochMilliseconds: Self.time + 2 * hour) - greenwichHourAngle(epochMilliseconds: Self.time + hour)
        let held = try #require(rig.orbitCamera)
        #expect(abs(remainder(held.longitude - (landed.longitude - turned), 2 * .pi)) < 1e-9)
    }

    // By a small satellite's radius while the model loads, by its own once it has,
    // and not again: a gesture meanwhile keeps the camera where the user put it.
    @Test func framesTheTrackedModelOnceItLoads() throws {
        let target = SIMD3(7_000_000.0, 0, 0)
        var rig = Self.rig()
        rig.track("25544", animated: false, uptime: 1) { _ in .loading }
        var pose = try #require(Self.frame(&rig, at: 1, target: target, model: .loading))
        #expect(abs(simd.distance(pose.position, target) - 6 * 2.5) < 1e-6)
        pose = try #require(Self.frame(&rig, at: 2, target: target, model: .loaded(radius: 10)))
        #expect(abs(simd.distance(pose.position, target) - 60) < 1e-6)
        pose = try #require(Self.frame(&rig, at: 3, target: target, model: .loaded(radius: 20)))
        #expect(abs(simd.distance(pose.position, target) - 60) < 1e-6)

        rig.track("25544", animated: false, uptime: 4) { _ in .loading }
        rig.zoom(by: 2)
        pose = try #require(Self.frame(&rig, at: 5, target: target, model: .loaded(radius: 10)))
        #expect(abs(simd.distance(pose.position, target) - 6 * 2.5 / 2) < 1e-6)
    }
}
