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

    /// Device pixels a simulation second on the iPad mini's view, what every
    /// satellite draws `nearest` metres from the camera.
    static func pixelRate(_ motions: [OrbitMotion?], at camera: SIMD3<Double> = home, cones: Bool = false, nearest: Double? = 30_000_000) -> Double {
        RenderPacing.pixelRate(motions, nearest: { _ in nearest }, lines: false, cones: cones, camera: camera, pixelsPerRadian: pixelsPerRadian)
    }

    /// The low orbit's rate held to its shell.
    static let leoShellRate = 1.1 * (7_660 + OrbitMotion.earthRotationRate * (earthRadius + 470_000)) / (home.x - earthRadius - 470_000) * pixelsPerRadian

    @Test func pixelsPerRadianPeaksInTheCorners() {
        // A square 90° view: f = h/2, and the corners are √2 f out.
        #expect(abs(RenderPacing.pixelsPerRadian(width: 100, height: 100, verticalFieldOfView: .pi / 2) - 150) < 1e-9)
    }

    @Test func aLowOrbitStandsAFewTenthsOfASecondFromTheHomeView() {
        // Straight under the camera, as near as its shell comes.
        let rate = Self.pixelRate([Self.leo], nearest: Self.home.x - Self.earthRadius - 420_000)
        #expect(rate <= Self.leoShellRate)
        #expect(RenderPacing.stands(0.2, pixelRate: rate))
        #expect(!RenderPacing.stands(0.4, pixelRate: rate))
    }

    @Test func aStillClockStandsAndASecondDoesNot() {
        #expect(RenderPacing.stands(0, pixelRate: Self.leoShellRate))
        #expect(RenderPacing.stands(0.9, pixelRate: 0))
        #expect(!RenderPacing.stands(RenderPacing.ceiling, pixelRate: 0))
    }

    @Test func aGeostationaryOrbitTurnsWithTheEarthInTheFixedFrame() throws {
        // Still in the fixed frame, but its orbit's line turns with the Earth.
        let geo = try #require(OrbitMotion(lowest: 42_164_000, highest: 42_164_000, farthestStep: 0, step: 300, hasCone: false))
        #expect(abs(geo.speed - 1.1 * OrbitMotion.earthRotationRate * 42_214_000) < 1e-6)
    }

    @Test func aSatelliteWithoutSamplesOrDrawingNothingIsLeftOut() {
        #expect(OrbitMotion(lowest: .infinity, highest: 0, farthestStep: 0, step: 46, hasCone: false) == nil)
        #expect(Self.pixelRate([nil]) == 0)
        #expect(Self.pixelRate([Self.molniya], nearest: nil) == 0)
    }

    @Test func anOrbitWhoseShellHoldsTheCameraIsTakenWhereItIs() {
        let far = Self.pixelRate([Self.molniya], nearest: 60_000_000)
        #expect(far < 1)
        #expect(Self.pixelRate([Self.molniya], nearest: 1_000_000) > 10 * far)
        // Never faster than its shell allows, wherever it is.
        #expect(Self.pixelRate([Self.leo], nearest: 1) == Self.leoShellRate)
    }

    @Test func placesOnlyTheSatellitesWhoseShellsBoundTheRateMost() {
        var placed: [Int] = []
        let rate = RenderPacing.pixelRate(
            Array(repeating: Self.leo, count: 100) + [Self.molniya],
            nearest: {
                placed.append($0)
                return 40_000_000
            }, lines: false, cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
        // The Molniya orbit, whose shell holds the camera, and the first of the rest.
        #expect(placed.count == RenderPacing.placed + 1)
        #expect(placed.contains(100))
        // The low orbits left on their shells bound it.
        #expect(abs(rate - Self.leoShellRate) < 1e-9)
    }

    @Test func stopsPlacingOnceEveryFrameIsDrawnAnyway() {
        var placed = 0
        let rate = RenderPacing.pixelRate(
            Array(repeating: Self.molniya, count: 100),
            nearest: { _ in
                placed += 1
                return 100_000
            }, lines: false, cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
        #expect(rate == .infinity)
        #expect(placed == 1)
    }

    @Test func aLineWidensTheShell() {
        let (inner, outer) = (Self.leo.inner, Self.leo.outer)
        #expect(Self.leo.shell(lines: false) == (inner, outer))
        #expect(Self.leo.shell(lines: true) == (inner - Self.leo.chord / 2 - RenderPacing.lineDrift, outer + RenderPacing.lineDrift))
    }

    @Test func aConeReachesTowardTheCamera() {
        #expect(RenderPacing.stands(0.1, pixelRate: Self.pixelRate([Self.leo], cones: true)))
        // 500 km over the satellite, the cone could reach the camera.
        let camera = SIMD3(Self.earthRadius + 920_000, 0, 0)
        #expect(Self.pixelRate([Self.leo], at: camera, nearest: 500_000) < .infinity)
        #expect(Self.pixelRate([Self.leo], at: camera, cones: true, nearest: 500_000) == .infinity)
    }

    @Test func aLineIsTakenWhereItsNodesAreNow() throws {
        let margin = 1_000.0 / 2 + RenderPacing.lineDrift
        let node = [SIMD3(7e6, 0, 0)]
        let camera = SIMD3(0, 2e7, 0)
        // An orbit track stays in the fixed frame; an orbit's node a quarter turn
        // of the Earth ahead is turned onto the camera's side.
        let track = try #require(RenderPacing.lineDistance(node, start: 0, step: 60, turned: false, chord: 1_000, from: camera))
        #expect(abs(track - ((4e14 + 4.9e13).squareRoot() - margin)) < 1e-6)
        let quarter = Double.pi / 2 / OrbitMotion.earthRotationRate
        let orbit = try #require(RenderPacing.lineDistance(node, start: quarter, step: 60, turned: true, chord: 1_000, from: camera))
        #expect(abs(orbit - (1.3e7 - margin)) < 1e-3)
        // The second node is turned a step further.
        let second = try #require(
            RenderPacing.lineDistance([SIMD3(1e9, 0, 0), SIMD3(7e6, 0, 0)], start: quarter - 60, step: 60, turned: true, chord: 1_000, from: camera))
        #expect(abs(second - orbit) < 1e-3)
        // A refused node is passed over; none at all, nothing is drawn.
        #expect(RenderPacing.lineDistance(node + [SIMD3(repeating: .nan)], start: 0, step: 60, turned: false, chord: 1_000, from: camera) == track)
        #expect(RenderPacing.lineDistance([SIMD3(repeating: .nan)], start: 0, step: 60, turned: false, chord: 0, from: camera) == nil)
    }
}
