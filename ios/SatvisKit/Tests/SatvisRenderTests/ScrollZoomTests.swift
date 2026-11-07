import Foundation
import Testing

@testable import SatvisRender

@Suite struct ScrollZoomTests {
    @Test func upComesNearerAndDownGoesBack() {
        let near = ScrollZoom.scale(deltaY: 40, precise: true)
        #expect(near > 1)
        #expect(abs(near * ScrollZoom.scale(deltaY: -40, precise: true) - 1) < 1e-12)
    }

    @Test func aWheelNotchIsTenPercent() {
        #expect(abs(ScrollZoom.scale(deltaY: 1, precise: false) - 1.1) < 1e-12)
    }

    @Test func nothingFiniteLeavesTheViewAlone() {
        #expect(ScrollZoom.scale(deltaY: .nan, precise: true) == 1)
        #expect(ScrollZoom.scale(deltaY: .infinity, precise: false) == 1)
        #expect(ScrollZoom.scale(deltaY: 0, precise: false) == 1)
    }
}
