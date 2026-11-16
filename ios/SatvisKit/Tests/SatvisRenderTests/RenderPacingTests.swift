import Foundation
import SatvisCore
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
    /// satellite draws `nearest` metres from the camera, at its orbit's top speed.
    static func pixelRate(_ motions: [OrbitMotion?], at camera: SIMD3<Double> = home, cones: Bool = false, nearest: Double? = 30_000_000) -> Double {
        RenderPacing.pixelRate(
            motions, nearest: { index in nearest.map { [($0, motions[index]!.speed)] } ?? [] }, lines: false, linked: [], cones: cones, camera: camera,
            pixelsPerRadian: pixelsPerRadian)
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
                return [(40_000_000, 10_000)]
            }, lines: false, linked: [], cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
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
                return [(100_000, 10_000)]
            }, lines: false, linked: [], cones: false, camera: Self.home, pixelsPerRadian: Self.pixelsPerRadian)
        #expect(rate == .infinity)
        #expect(placed == 1)
    }

    @Test func aLineOrALinkWidensTheShell() {
        let (inner, outer) = (Self.leo.inner, Self.leo.outer)
        #expect(Self.leo.shell(lines: false, linked: false) == (inner, outer))
        #expect(Self.leo.shell(lines: true, linked: false) == (inner - Self.leo.chord / 2 - RenderPacing.lineDrift, outer + RenderPacing.lineDrift))
        #expect(Self.leo.shell(lines: false, linked: true) == (RenderPacing.lowestGround, outer))
    }

    @Test func aLinkedSatelliteIsTakenWhereItsLinkIsUnderItsShell() {
        // A geostationary satellite, its shell far above a camera 1,000 km up.
        let geo = OrbitMotion(lowest: 42_164_000, highest: 42_164_000, farthestStep: 0, step: 300, hasCone: false)!
        let camera = SIMD3(Self.earthRadius + 1_000_000, 0, 0)
        func rate(linked: Set<Int>) -> Double {
            RenderPacing.pixelRate(
                [geo], nearest: { _ in [(50_000, geo.speed)] }, lines: false, linked: linked, cones: false, camera: camera, pixelsPerRadian: Self.pixelsPerRadian)
        }
        #expect(rate(linked: []) < RenderPacing.pixels)
        #expect(rate(linked: [0]) == .infinity)
    }

    @Test func anEccentricOrbitIsSlowFarFromPerigee() {
        // At apogee, 46,000 km out, a Molniya satellite moves at about 1.5 km/s.
        let apogee = Self.molniya.speed(atRadius: 46_000_000)
        #expect(apogee < 0.4 * Self.molniya.speed)
        #expect(apogee > 1.5e3)
        // At perigee, 7,000 km out, about 10 km/s, a tenth on top; on a circle, its
        // own speed.
        #expect(Self.molniya.speed(atRadius: 7_000_000) > 1.1 * 9_900)
        let leo = Self.leo.speed(atRadius: Self.earthRadius + 410_000)
        #expect(leo > 1.1 * 7_660 && leo <= Self.leo.speed)
        // An orbit's line turns with the Earth, at its outer radius at most.
        #expect(Self.molniya.turningSpeed(within: 1e9) == 1.1 * OrbitMotion.earthRotationRate * (Self.molniya.outer + RenderPacing.lineDrift))
        #expect(Self.molniya.turningSpeed(within: 20_000_000) == 1.1 * OrbitMotion.earthRotationRate * 20_000_000)
    }

    @Test func aConeReachesTowardTheCamera() {
        #expect(RenderPacing.stands(0.1, pixelRate: Self.pixelRate([Self.leo], cones: true)))
        // 500 km over the satellite, the cone could reach the camera.
        let camera = SIMD3(Self.earthRadius + 920_000, 0, 0)
        #expect(Self.pixelRate([Self.leo], at: camera, nearest: 500_000) < .infinity)
        #expect(Self.pixelRate([Self.leo], at: camera, cones: true, nearest: 500_000) == .infinity)
    }

    @Test func aLinesNodesAreWhereTheyAreNow() {
        // An orbit track stays in the fixed frame; an orbit's node a quarter turn of
        // the Earth ahead is turned onto the y axis, and the next a step further.
        let quarter = Double.pi / 2 / OrbitMotion.earthRotationRate
        #expect(RenderPacing.lineNodes([SIMD3(7e6, 0, 0)], start: quarter, step: 60, turned: false) == [SIMD3(7e6, 0, 0)])
        let orbit = RenderPacing.lineNodes([SIMD3(1e9, 0, 0), SIMD3(7e6, 0, 0)], start: quarter - 60, step: 60, turned: true)
        #expect(distance(orbit[1], SIMD3(0, 7e6, 0)) < 1e-3)
    }

    @Test func aLineIsTakenWhereItsSegmentsPassNearest() {
        let nodes = [SIMD3(1e7, 0, 0), SIMD3(1e7, 4e5, 0), SIMD3(1e7, 6e5, 0)]
        // Beside a segment, at its foot; beyond the line, at its end.
        #expect(abs(RenderPacing.lineDistance(nodes, strides: [1], from: SIMD3(1.2e7, 2e5, 0))! - (2e6 - RenderPacing.lineDrift)) < 1e-6)
        #expect(abs(RenderPacing.lineDistance(nodes, strides: [1], from: SIMD3(3e7, 9e5, 0))! - ((4e14 + 9e10).squareRoot() - RenderPacing.lineDrift)) < 1e-6)
        // A segment stepping over a node cuts the corner.
        let corner = [SIMD3(1e7, 0, 0), SIMD3(2e7, 1e7, 0), SIMD3(3e7, 0, 0)]
        let camera = SIMD3(2e7, -1e6, 0)
        #expect(RenderPacing.lineDistance(corner, strides: [1, 2], from: camera)! < RenderPacing.lineDistance(corner, strides: [1], from: camera)!)
        // A segment to a refused node is not drawn; with none left, nothing is.
        let refused = [nodes[0], SIMD3(repeating: .nan), nodes[2]]
        #expect(RenderPacing.lineDistance(refused, strides: [1], from: SIMD3(1.2e7, 2e5, 0)) == nil)
        #expect(RenderPacing.lineDistance([nodes[0]], strides: [1], from: SIMD3(1.2e7, 2e5, 0)) == nil)
    }
}

/// The speed bounds held to SGP4's own motion.
@Suite struct OrbitMotionTests {
    /// A Molniya orbit and the ISS, as OMM.
    static let records = try! GPRecord.decodePayload(
        Data(
            """
            [{"OBJECT_NAME": "MOLNIYA", "NORAD_CAT_ID": 99001, "EPOCH": "2026-10-01T00:00:00", "MEAN_MOTION": 2.00609, "ECCENTRICITY": 0.72,
              "INCLINATION": 63.4, "RA_OF_ASC_NODE": 10, "ARG_OF_PERICENTER": 270, "MEAN_ANOMALY": 30, "BSTAR": 0,
              "MEAN_MOTION_DOT": 0, "MEAN_MOTION_DDOT": 0},
             {"OBJECT_NAME": "ISS", "NORAD_CAT_ID": 99002, "EPOCH": "2026-10-01T00:00:00", "MEAN_MOTION": 15.5, "ECCENTRICITY": 0.0005,
              "INCLINATION": 51.6, "RA_OF_ASC_NODE": 10, "ARG_OF_PERICENTER": 20, "MEAN_ANOMALY": 30, "BSTAR": 0.0001,
              "MEAN_MOTION_DOT": 0.0001, "MEAN_MOTION_DDOT": 0}]
            """.utf8))

    // The fixed-frame speed by finite differences, along the whole window,
    // never past the bound where the satellite is, nor past the orbit's.
    @Test(arguments: [0, 1]) func holdsSGP4sSpeedWhereverTheSatelliteIs(record: Int) throws {
        let (trajectory, motion) = try Self.orbit(record)
        let start = trajectory.startMilliseconds + 3 * trajectory.stepMilliseconds
        let end = trajectory.startMilliseconds + Double(trajectory.positions.count - 4) * trajectory.stepMilliseconds
        for time in stride(from: start, to: end, by: trajectory.stepMilliseconds / 7) {
            guard let here = trajectory.position(at: time), let later = trajectory.position(at: time + 500) else {
                continue
            }
            let speed = distance(here, later) / 0.5
            #expect(speed <= motion.speed(atRadius: length(here)))
            #expect(speed <= motion.speed)
        }
    }

    /// Record `record`'s samples around 06:00 on its epoch day, and their motion.
    static func orbit(_ record: Int) throws -> (SampledTrajectory, OrbitMotion) {
        let epoch = try #require(ISO8601DateFormatter().date(from: "2026-10-01T06:00:00Z")).timeIntervalSince1970 * 1000
        let trajectory = try #require(SampledTrajectory(try SGP4Propagator(Self.records[record].meanElements), around: epoch))
        let radii = trajectory.positions.map { length($0) }
        let farthestStep = zip(trajectory.positions, trajectory.positions.dropFirst()).map { distance($0, $1) }.max() ?? 0
        let motion = try #require(
            OrbitMotion(
                lowest: radii.min()!, highest: radii.max()!, farthestStep: farthestStep, step: trajectory.stepMilliseconds / 1000, hasCone: false))
        return (trajectory, motion)
    }

    // Every node of an orbit's line, turned with the Earth as it is drawn, crosses
    // the view from cameras around and inside the orbit no faster than the Earth's
    // turn within the camera's radius and the line's distance allows, there.
    @Test(arguments: [0, 1]) func boundsAnOrbitsLineTurningWithTheEarth(record: Int) throws {
        let (trajectory, motion) = try Self.orbit(record)
        let time = trajectory.startMilliseconds + Double(trajectory.positions.count / 2) * trajectory.stepMilliseconds
        let (start, step) = ((trajectory.startMilliseconds - time) / 1000, trajectory.stepMilliseconds / 1000)
        // The line as drawn: its nodes turned to the instant, and the chords between them.
        func line(after seconds: Double) -> [SIMD3<Double>] {
            let nodes = trajectory.positions.enumerated().map {
                RenderPacing.turned($1, by: OrbitMotion.earthRotationRate * (start + Double($0) * step - seconds))
            }
            return zip(nodes, nodes.dropFirst()).flatMap { a, b in [0, 0.25, 0.5, 0.75].map { a + $0 * (b - a) } }
        }
        let (now, later) = (line(after: 0), line(after: 0.5))
        // Along every direction, and off every 40th point by more than the line's margin.
        let directions: [SIMD3<Double>] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], simd_normalize(SIMD3(-1, 1, 1)), simd_normalize(SIMD3(1, -1, 0.3))]
        let around: [SIMD3<Double>] = directions.flatMap { [$0 * 2.5e7, $0 * 6e7] }
        let offNodes: [SIMD3<Double>] = stride(from: 0, to: now.count, by: 40).map {
            now[$0] + simd_normalize(now[$0]) * (motion.chord + RenderPacing.lineDrift + 1_000_000)
        }
        for camera in around + offNodes {
            let nodes = RenderPacing.lineNodes(trajectory.positions, start: start, step: step, turned: true)
            let distanceToLine = try #require(RenderPacing.lineDistance(nodes, strides: [1], from: camera))
            // Within the margin the bound is infinite, which proves nothing.
            try #require(distanceToLine > 0, "camera \(camera)")
            let bound = motion.turningSpeed(within: length(camera) + distanceToLine) / distanceToLine
            for (here, there) in zip(now, later) {
                #expect(distance(here, there) / 0.5 / distance(here, camera) <= bound)
            }
        }
        // By the Molniya orbit's perigee, far under its apogee's turn.
        if record == 0, let perigee = now.min(by: { length($0) < length($1) }) {
            let camera = perigee * 1.05
            #expect(motion.turningSpeed(within: length(camera) + 2e6) < 0.5 * 1.1 * OrbitMotion.earthRotationRate * motion.outer)
        }
    }

    // From 15,000 km inside an apogee in the equator's plane the bound is nearly met,
    // as renderPacing.test.ts has it: a fifth under, it fails.
    @Test func nearlyMeetsTheBoundInsideAnEquatorialApogee() throws {
        let tilt = 63.4 * Double.pi / 180
        let nodes = (0..<120).map { index in
            let anomaly = 2 * Double.pi * Double(index) / 120
            let radius = 26_500_000 * (1 - 0.736 * 0.736) / (1 + 0.736 * cos(anomaly))
            return SIMD3(radius * cos(anomaly), radius * sin(anomaly) * cos(tilt), radius * sin(anomaly) * sin(tilt))
        }
        let radii = nodes.map { length($0) }
        let chord = zip(nodes, nodes.dropFirst()).map { distance($0, $1) }.max()!
        let motion = try #require(OrbitMotion(lowest: radii.min()!, highest: radii.max()!, farthestStep: chord, step: 1, hasCone: false))
        let camera = SIMD3(-31_000_000.0, 0, 0)
        let line = try #require(RenderPacing.lineDistance(nodes, strides: [1], from: camera))
        let fastest = nodes.map { OrbitMotion.earthRotationRate * hypot($0.x, $0.y) / distance($0, camera) }.max()!
        let bound = motion.turningSpeed(within: length(camera) + line) / line
        #expect(fastest <= bound)
        #expect(fastest > 0.8 * bound)
    }
}
