import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

@Suite struct SkyLockTests {
    private static let degree = Double.pi / 180

    // Half the view's height away is half the vertical field of view, whatever it is.
    @Test func reachesHalfTheFieldOfViewAtTheEdge() {
        for fieldOfView in [10.0, 75, 100] {
            let angle = SkyCache.angle(ofRadius: 500, height: 1000, verticalFieldOfView: fieldOfView * Self.degree)
            #expect(abs(angle - fieldOfView / 2 * Self.degree) < 1e-12, "\(fieldOfView)")
        }
    }

    // A kept direction is a candidate within the reach and the drift a second
    // allows it, and not past them; one with no position never is.
    @Test func keepsTheDirectionsWithinReachAndDrift() {
        let reach = 2 * Self.degree
        let edge = reach + SkyCache.directionsMargin
        func tilted(_ angle: Double) -> SIMD3<Float>? {
            SIMD3<Float>(Float(cos(angle)), Float(sin(angle)), 0)
        }
        let directions = [tilted(0), tilted(edge - 0.1 * Self.degree), tilted(edge + 0.1 * Self.degree), nil, tilted(.pi)]
        #expect(SkyCache.indices(of: directions, within: reach, of: SIMD3(2, 0, 0)) == [0, 1])
    }

    // Looking straight up, one satellite 2° off the zenith to the east and one 3°
    // to the west: the crosshair holds the nearer, unless a mountain to the east
    // stands in its way.
    @Test func passesOverASatelliteTheGroundHides() {
        let camera = DrawnFrameTests.sky(azimuth: 0, pitch: 90)
        let frame = DrawnFrameTests.frame(camera.pose())
        let satellites = StillSatellites(places: [
            ("east", DrawnFrameTests.place(from: camera, azimuth: 90, elevation: 88)),
            ("west", DrawnFrameTests.place(from: camera, azimuth: 270, elevation: 87)),
        ])
        func lock(groundHeight: (GeoCoordinate) -> Double?) -> String? {
            var cache = SkyCache()
            return cache.lock(
                in: frame, camera: camera, unseen: .dim, satellites: satellites, viewSize: DrawnFrameTests.viewSize, uptime: 100, terrain: 0,
                groundHeight: groundHeight)?.id
        }
        #expect(lock { _ in nil } == "east")
        #expect(lock { $0.longitude > camera.longitude ? 9_000 : 0 } == "west")
        #expect(lock { _ in 9_000 } == nil)
    }

    // The directions are kept while the satellites, the eye within 100 m, and the
    // clock within a second stay as they were.
    @Test func keepsTheDirectionsUntilTheSatellitesTheEyeOrTheClockMove() {
        let eye = fixedPosition(latitude: 46.5935, longitude: 7.9091)
        let time = DrawnFrameTests.time
        let before = StillSatellites(places: [("a", eye + SIMD3(0, 0, 500_000))])
        var after = before
        after.places[0].position = eye + SIMD3(0, 500_000, 0)
        // Worked out for `before` from `eye` at `time` and an uptime of 100 s, then
        // asked again.
        func directions(_ satellites: StillSatellites, at instant: Double, from position: SIMD3<Double>, uptime: Double) -> SIMD3<Float>?? {
            var cache = SkyCache()
            _ = cache.directions(of: before, at: time, from: eye, uptime: 100)
            return cache.directions(of: satellites, at: instant, from: position, uptime: uptime).map { $0[0] }
        }
        func toward(_ direction: SIMD3<Float>?, _ expected: SIMD3<Float>) -> Bool {
            direction.map { dot($0, expected) > 0.9999 } ?? false
        }
        let (old, new) = (SIMD3<Float>(0, 0, 1), SIMD3<Float>(0, 1, 0))
        #expect(toward(directions(after, at: time + 1000, from: eye, uptime: 100.5) ?? nil, old))
        var installed = after
        installed.generation += 1
        #expect(toward(directions(installed, at: time, from: eye, uptime: 100.5) ?? nil, new))
        #expect(toward(directions(after, at: time, from: eye + SIMD3(99, 0, 0), uptime: 100.5) ?? nil, old))
        #expect(toward(directions(after, at: time, from: eye + SIMD3(101, 0, 0), uptime: 100.5) ?? nil, new))
        // A clock a second on: worked out again, but not twice within a second.
        #expect(toward(directions(after, at: time + 1001, from: eye, uptime: 101) ?? nil, new))
        #expect(directions(after, at: time + 1001, from: eye, uptime: 100.5) == .none)
    }
}
