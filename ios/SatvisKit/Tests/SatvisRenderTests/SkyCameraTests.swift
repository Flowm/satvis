import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct SkyCameraTests {
    private static let degree = Double.pi / 180

    @Test func looksWhereItIsAimed() {
        for (azimuth, pitch) in [(0.0, 30.0), (90, 0), (225, -45), (359, 89.9)] {
            var camera = SkyCamera(latitude: 46.59, longitude: 7.91)
            camera.attitude = SkyCamera.attitude(azimuth: azimuth * Self.degree, pitch: pitch * Self.degree)
            #expect(abs(camera.azimuth - remainder(azimuth * Self.degree, 2 * .pi)) < 1e-9, "\(azimuth)")
            #expect(abs(camera.pitch - pitch * Self.degree) < 1e-9, "\(pitch)")
        }
    }

    // Built by turning, so straight up is an aim like any other: the frame is
    // orthonormal there and keeps the azimuth it came from.
    @Test func staysDefinedAtTheZenith() {
        let camera = SkyCamera(latitude: 0, longitude: 0, azimuth: 120 * Self.degree, pitch: .pi / 2)
        let pose = camera.pose()
        #expect(abs(dot(pose.right, pose.up)) < 1e-12 && abs(dot(pose.up, pose.back)) < 1e-12)
        #expect(abs(camera.azimuth - 120 * Self.degree) < 1e-9)
        // Looking up: the camera's back points at the ground.
        #expect(simd.distance(pose.back, -normalize(pose.position)) < 1e-6)
    }

    // The sky follows the finger: a drag right turns the view left, a drag down
    // raises it, by a field of view per screen height, and levels it.
    @Test func followsADrag() {
        var camera = SkyCamera(latitude: 48, longitude: 11, azimuth: .pi / 2, pitch: 0)
        camera.attitude = camera.attitude * simd_quatd(angle: 0.3, axis: SIMD3(0, 0, 1))
        camera.drag(by: SIMD2(100, 50), height: 1000)
        let perPoint = SkyCamera.defaultFieldOfView / 1000
        #expect(abs(camera.azimuth - (.pi / 2 - 100 * perPoint)) < 1e-9)
        #expect(abs(camera.pitch - 50 * perPoint) < 1e-9)
        #expect(abs(camera.attitude.act(SIMD3(1, 0, 0)).z) < 1e-12, "the camera's right is level again")
    }

    @Test func standsAnEyeHeightAboveTheGround() {
        var camera = SkyCamera(latitude: 46.5935, longitude: 7.9091)
        camera.groundHeight = 800
        let ground = fixedPosition(latitude: 46.5935, longitude: 7.9091)
        #expect(abs(simd.distance(camera.position, ground) - 802) < 1e-6)
    }

    @Test func zoomsWithinItsRange() {
        var camera = SkyCamera(latitude: 0, longitude: 0)
        camera.zoom(by: 100)
        #expect(camera.verticalFieldOfView == SkyCamera.fieldOfViewRange.lowerBound)
        camera.zoom(by: 0.001)
        #expect(camera.verticalFieldOfView == SkyCamera.fieldOfViewRange.upperBound)
    }
}
