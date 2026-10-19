import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct SkyLockTests {
    private static let degree = Double.pi / 180

    // Half the view's height away is half the vertical field of view, whatever it is.
    @Test func reachesHalfTheFieldOfViewAtTheEdge() {
        for fieldOfView in [10.0, 75, 100] {
            let angle = GlobeRenderer.angle(ofRadius: 500, height: 1000, verticalFieldOfView: fieldOfView * Self.degree)
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
        #expect(GlobeRenderer.indices(of: directions, within: reach, of: SIMD3(2, 0, 0)) == [0, 1])
    }
}
