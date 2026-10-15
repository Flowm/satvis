import Foundation
import Testing
import simd

@testable import SatvisRender

/// What the gestures hand the cameras when two fingertips meet: NaN from the
/// rotation, 0 and infinity from the magnification. Each camera stays as it was,
/// so the globe goes on drawing.
@Suite struct CameraGestureTests {
    private static let nonFinite: [Double] = [.nan, .infinity, -.infinity]

    @Test func orbitCameraIgnoresThem() {
        let start = OrbitCamera.home(aspectRatio: 0.5)
        var camera = start
        for value in Self.nonFinite {
            camera.rotate(by: value)
            camera.zoom(by: value)
            camera.pan(by: SIMD2(value, 1), longerSide: 874)
        }
        camera.zoom(by: 0)
        camera.pan(by: SIMD2(1, 1), longerSide: 0)
        #expect(camera == start)
        #expect(camera.pose().isFinite)
    }

    @Test func trackingCameraIgnoresThem() {
        let start = TrackingCamera()
        var camera = start
        for value in Self.nonFinite {
            camera.rotate(by: value)
            camera.zoom(by: value)
            camera.orbit(by: SIMD2(1, value), longerSide: 874)
        }
        camera.zoom(by: 0)
        #expect(camera == start)
    }

    @Test func skyCameraIgnoresThem() {
        let start = SkyCamera(latitude: 46.59, longitude: 7.91)
        var camera = start
        for value in Self.nonFinite {
            camera.zoom(by: value)
            camera.drag(by: SIMD2(value, 1), height: 874)
        }
        camera.zoom(by: 0)
        camera.drag(by: SIMD2(1, 1), height: 0)
        #expect(camera.verticalFieldOfView == start.verticalFieldOfView)
        #expect(camera.pose().isFinite)
    }

    @Test func aNaNHeadingIsNotFinite() {
        var camera = OrbitCamera.home(aspectRatio: 0.5)
        camera.heading = .nan
        #expect(!camera.pose().isFinite)
    }
}
