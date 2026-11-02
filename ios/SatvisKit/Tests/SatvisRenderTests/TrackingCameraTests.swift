import Foundation
import Testing
import simd

@testable import SatvisRender

struct TrackingCameraTests {
    /// The axes CesiumJS's `EntityView` tracked the parity element sets in
    /// (scripts/parity/generate.mjs). Regenerate them; never edit them.
    struct Frames: Decodable {
        struct Frame: Decodable {
            struct Axes: Decodable {
                let x: [Double]
                let y: [Double]
                let z: [Double]
            }

            let record: Int
            let instant: String
            let positionMetres: [Double]
            let millisecondOnMetres: [Double]
            let axes: Axes
        }

        let frames: [Frame]
    }

    private static func vector(_ values: [Double]) -> SIMD3<Double> {
        SIMD3(values[0], values[1], values[2])
    }

    // A low orbit's along its motion, a higher one's north-up.
    @Test func holdsTheOffsetInCesiumsAxes() throws {
        let url = try #require(Bundle.module.url(forResource: "tracking-frames", withExtension: "json", subdirectory: "Fixtures"))
        let frames = try JSONDecoder().decode(Frames.self, from: Data(contentsOf: url)).frames
        #expect(frames.count == 30)
        for frame in frames {
            let target = Self.vector(frame.positionMetres)
            let velocity = (Self.vector(frame.millisecondOnMetres) - target) * 1000
            let axes = TrackingCamera.axes(target: target, velocity: velocity)
            for (axis, expected) in [(axes.x, frame.axes.x), (axes.y, frame.axes.y), (axes.z, frame.axes.z)] {
                #expect(simd.distance(axis, Self.vector(expected)) < 1e-6, "record \(frame.record) at \(frame.instant)")
            }
        }
    }

    @Test func framesAModelAlongTheAxes() throws {
        let target = SIMD3(6_780_000.0, 0, 0)
        let velocity = SIMD3(0, 4_000.0, 6_000)
        let axes = TrackingCamera.axes(target: target, velocity: velocity)
        let pose = TrackingCamera.framing(modelRadius: 10).pose(target: target, velocity: velocity)
        let offset = pose.position - target
        let expected = normalize(SIMD3(9.0, -10, 9)) * 60
        #expect(simd.distance(SIMD3(dot(offset, axes.x), dot(offset, axes.y), dot(offset, axes.z)), expected) < 1e-6)
    }

    @Test func standsStillInEastNorthUp() {
        let target = SIMD3(0, 6_378_137.0, 0)
        let axes = TrackingCamera.axes(target: target, velocity: .zero)
        #expect(simd.distance(axes.x, SIMD3(-1, 0, 0)) < 1e-12)
        #expect(simd.distance(axes.y, SIMD3(0, 0, 1)) < 1e-12)
        #expect(simd.distance(axes.z, SIMD3(0, 1, 0)) < 1e-12)
    }
}
