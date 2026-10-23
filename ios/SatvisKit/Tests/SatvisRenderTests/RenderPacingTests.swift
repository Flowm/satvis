import Foundation
import Testing
import simd

@testable import SatvisRender

/// How fast what is drawn can cross the view, and when a frame stands, as the web
/// app's renderPacing.test.ts has it.
@Suite struct RenderPacingTests {
    /// The ellipsoid's equatorial radius, in metres.
    static let earthRadius = 6_378_137.0
    /// The home view's distance from the Earth's centre, about.
    static let home = SIMD3(25_000_000.0, 0, 0)
    /// An iPad mini's drawable, 60° across its longer side.
    static let pixelsPerRadian = RenderPacing.pixelsPerRadian(width: 2266, height: 1488, verticalFieldOfView: 2 * atan(tan(Double.pi / 6) * 1488 / 2266))

    /// The ISS's orbit, about: 400 to 420 km up, 7.7 km/s.
    static let leo = OrbitMotion(lowest: earthRadius + 400_000, highest: earthRadius + 420_000, farthestStep: 7_660 * 46, step: 46, hasCone: true)!
    /// A Molniya orbit, 7,000 to 46,000 km from the centre.
    static let molniya = OrbitMotion(lowest: 7_000_000, highest: 46_000_000, farthestStep: 10_000 * 360, step: 360, hasCone: false)!

    /// Device pixels a simulation second on the iPad mini's view, every satellite
    /// at `position`.
    static func pixelRate(
        _ motions: [OrbitMotion?], at camera: SIMD3<Double> = home, lines: Bool = false, cones: Bool = false,
        position: SIMD3<Double>? = SIMD3(0, 0, earthRadius + 400_000)
    ) -> Double {
        RenderPacing.pixelRate(motions, position: { _ in position }, lines: lines, cones: cones, camera: camera, pixelsPerRadian: pixelsPerRadian)
    }

    @Test func pixelsPerRadianPeaksInTheCorners() {
        // A square 90° view: f = h/2, and the corners are √2 f out.
        #expect(abs(RenderPacing.pixelsPerRadian(width: 100, height: 100, verticalFieldOfView: .pi / 2) - 150) < 1e-9)
    }

    @Test func aLowOrbitStandsAFewTenthsOfASecondFromTheHomeView() {
        let rate = Self.pixelRate([Self.leo], lines: true)
        #expect(RenderPacing.stands(0.2, pixelRate: rate))
        #expect(!RenderPacing.stands(0.4, pixelRate: rate))
    }

    @Test func aStillClockStandsAndASecondDoesNot() {
        #expect(RenderPacing.stands(0, pixelRate: Self.pixelRate([Self.leo])))
        #expect(RenderPacing.stands(0.9, pixelRate: 0))
        #expect(!RenderPacing.stands(RenderPacing.ceiling, pixelRate: 0))
    }

    @Test func aGeostationaryOrbitTurnsWithTheEarthInTheFixedFrame() throws {
        // Still in the fixed frame, but its orbit's line turns with the Earth.
        let geo = try #require(OrbitMotion(lowest: 42_164_000, highest: 42_164_000, farthestStep: 0, step: 300, hasCone: false))
        #expect(abs(geo.speed - 1.1 * OrbitMotion.earthRotationRate * 42_214_000) < 1e-6)
    }

    @Test func aSatelliteWithoutSamplesOrAPlaceIsLeftOut() {
        #expect(OrbitMotion(lowest: .infinity, highest: 0, farthestStep: 0, step: 46, hasCone: false) == nil)
        #expect(Self.pixelRate([nil]) == 0)
        #expect(Self.pixelRate([Self.molniya], position: nil) == 0)
    }

    @Test func aPointIsTakenWhereItIsAndALineAnywhereOnItsShell() {
        // Within the Molniya shell: placed far off, it is slow; its line could pass
        // through the camera.
        let far = Self.pixelRate([Self.molniya], position: SIMD3(-40_000_000, 0, 0))
        #expect(far < 1)
        #expect(Self.pixelRate([Self.molniya], position: SIMD3(24_000_000, 0, 0)) > 10 * far)
        #expect(Self.pixelRate([Self.molniya], lines: true, position: SIMD3(-40_000_000, 0, 0)) == .infinity)
        // Never nearer than the shell, wherever it is placed.
        #expect(Self.pixelRate([Self.leo], position: Self.home) == Self.pixelRate([Self.leo], lines: true))
    }

    @Test func placesOnlyTheSatellitesWhoseShellsBoundTheRateMost() {
        var placed: [Int] = []
        let motions = Array(repeating: Self.leo, count: 100) + [Self.molniya]
        let rate = RenderPacing.pixelRate(
            motions,
            position: {
                placed.append($0)
                return SIMD3(-40_000_000, 0, 0)
            }, lines: false, cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
        // The Molniya orbit, whose shell holds the camera, and the first of the rest.
        #expect(placed.count == RenderPacing.placed + 1)
        #expect(placed.contains(100))
        // The low orbits left on their shells bound it.
        #expect(rate == Self.pixelRate([Self.leo], lines: true))
    }

    @Test func stopsPlacingOnceEveryFrameIsDrawnAnyway() {
        var placed = 0
        let rate = RenderPacing.pixelRate(
            Array(repeating: Self.molniya, count: 100),
            position: { _ in
                placed += 1
                return SIMD3(25_100_000, 0, 0)
            }, lines: false, cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
        #expect(rate == .infinity)
        #expect(placed == 1)
    }

    @Test func aConeReachesTowardTheCamera() {
        #expect(RenderPacing.stands(0.1, pixelRate: Self.pixelRate([Self.leo], cones: true)))
        // 500 km over the satellite, the cone could reach the camera.
        let camera = SIMD3(Self.earthRadius + 920_000, 0, 0)
        #expect(Self.pixelRate([Self.leo], at: camera, position: SIMD3(Self.earthRadius + 420_000, 0, 0)) < .infinity)
        #expect(Self.pixelRate([Self.leo], at: camera, cones: true, position: SIMD3(Self.earthRadius + 420_000, 0, 0)) == .infinity)
    }
}
