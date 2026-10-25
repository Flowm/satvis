import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct GroundOverlayTests {
    /// Flying north from where the equator meets the prime meridian, so east is +y.
    @Test func reachesEachSideOfTheSwathOnItsOwnSide() throws {
        let north = SIMD3<Double>(cos(0.01), 0, sin(0.01))
        let vertices = GroundOverlay.corridor(from: SIMD3(1, 0, 0), to: north, starboardKm: 150, portKm: 50)
        let port = try #require(vertices.first)
        let starboard = try #require(vertices.dropFirst().first)
        let kmPerRadian = 6_371.0
        #expect(abs(Double(asin(port.1)) * kmPerRadian + 50) < 0.5)
        #expect(abs(Double(asin(starboard.1)) * kmPerRadian - 150) < 0.5)
    }
}
