import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// The Inertial camera mode: the free camera held still against the stars.
@Suite struct InertialCameraTests {
    /// Earth-fixed into TEME, the frame the stars stand still in at this precision.
    private static func inertial(_ fixed: SIMD3<Double>, at epochMilliseconds: Double) -> SIMD3<Double> {
        let angle = greenwichHourAngle(epochMilliseconds: epochMilliseconds)
        let (c, s) = (cos(angle), sin(angle))
        return SIMD3(c * fixed.x - s * fixed.y, s * fixed.x + c * fixed.y, fixed.z)
    }

    @Test func staysWhereItWasAgainstTheStars() throws {
        let start = try Date("2026-10-08T03:00:00Z", strategy: .iso8601).timeIntervalSince1970 * 1000
        var camera = OrbitCamera.home(aspectRatio: 0.5)
        let before = Self.inertial(camera.position, at: start)
        var last = greenwichHourAngle(epochMilliseconds: start)
        // An hour on in steps, then a day back at once, as a scrub of the clock goes.
        for step in [600_000.0, 1_200_000, 3_600_000, -82_800_000] {
            let angle = greenwichHourAngle(epochMilliseconds: start + step)
            camera.holdInertial(from: last, to: angle)
            last = angle
            #expect(distance(Self.inertial(camera.position, at: start + step), before) < 1e-3, "\(step) ms on")
        }
    }

    // The Earth turns east under the camera, so the camera drifts west over it.
    @Test func driftsWestOverTheGround() {
        var camera = OrbitCamera(latitude: 0.4, longitude: 0.1, altitude: 20_000_000)
        camera.holdInertial(from: 1.0, to: 1.0 + 15 * .pi / 180)
        #expect(abs(camera.longitude - (0.1 - 15 * .pi / 180)) < 1e-12)
        #expect(camera.latitude == 0.4)
    }
}
