import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct SkyFlightTests {
    private static let observer = SkyCamera(latitude: 46.5935, longitude: 7.9091)
    private static let globe = OrbitCamera.home(aspectRatio: 390.0 / 844).pose()

    private static let over = {
        var over = SkyCamera(latitude: observer.latitude, longitude: observer.longitude, azimuth: observer.azimuth, pitch: -.pi / 2)
        over.groundHeight = observer.groundHeight
        return over.pose()
    }()
    private static let offset = SkyFlight.offset(from: globe, to: observer.pose(), over: over)

    private static func pose(_ t: Double) -> CameraPose {
        SkyFlight.pose(from: globe, to: observer.pose(), over: over, offset: offset, t: t)
    }

    /// Radians between two attitudes, the short way round.
    private static func turn(_ a: CameraPose, _ b: CameraPose) -> Double {
        let delta = SkyFlight.attitude(b) * SkyFlight.attitude(a).conjugate
        return 2 * acos(min(1, abs(delta.real)))
    }

    @Test func leavesTheGlobeAndLandsOnTheAim() {
        let start = Self.pose(0)
        #expect(simd.distance(start.position, Self.globe.position) < 1e-3)
        #expect(simd.distance(start.back, Self.globe.back) < 1e-9)
        let end = Self.pose(1)
        let sky = Self.observer.pose()
        #expect(simd.distance(end.position, sky.position) < 1e-6)
        #expect(simd.distance(end.back, sky.back) < 1e-9 && simd.distance(end.up, sky.up) < 1e-9)
    }

    // The rise starts from straight overhead, looking straight down: the aim
    // reaches the nadir smoothly and the rise is a change of pitch alone.
    @Test func standsOverheadLookingDownWhenTheRiseBegins() {
        let pose = Self.pose(SkyFlight.overhead)
        let up = normalize(Self.observer.position)
        #expect(simd.distance(normalize(pose.position), up) < 1e-6)
        #expect(dot(pose.back, normalize(pose.position)) > 0.999)
    }

    @Test func staysARotationAllTheWay() {
        for step in 0...40 {
            let pose = Self.pose(Double(step) / 40)
            #expect(abs(dot(pose.right, pose.up)) < 1e-9 && abs(dot(pose.up, pose.back)) < 1e-9 && abs(dot(pose.right, pose.back)) < 1e-9)
            #expect(abs(dot(cross(pose.right, pose.up), pose.back) - 1) < 1e-9)
        }
    }

    // Turned around half way, it goes back from where it is rather than jumping.
    @Test func turnsAroundWhereItIs() {
        var flight = SkyFlight(globe: Self.globe, start: 100, entering: true)
        let before = flight.progress(at: 100 + SkyFlight.duration * 0.4)
        flight.reverse(at: 100 + SkyFlight.duration * 0.4)
        #expect(abs(flight.progress(at: 100 + SkyFlight.duration * 0.4) - before) < 1e-12)
        #expect(flight.progress(at: 100 + SkyFlight.duration * 0.8) < before)
    }

    // The globe is north up and the aim faces south: turning round in the lock-on
    // rolled the view at 1,300°/s, and the quintic easing whipped it at 600°/s.
    @Test func neverTurnsFasterThanASteadyPan() {
        let dt = 0.002
        var previous = Self.pose(0)
        for step in 1...Int(1 / dt) {
            let next = Self.pose(Double(step) * dt)
            let degreesPerSecond = Self.turn(previous, next) * 180 / .pi / (dt * SkyFlight.duration)
            #expect(degreesPerSecond < 300, "t=\(Double(step) * dt)")
            previous = next
        }
    }

    // A turn about the vertical alone: the horizon stays level through the rise,
    // but for the 0.19° between the geocentric radial the camera comes down along
    // and the geodetic vertical the view turns about, here at 46.6°.
    @Test func keepsTheHorizonLevelWhileItTurnsRound() {
        let up = Self.over.back
        let tilt = acos(dot(normalize(Self.observer.position), up))
        for step in 0...20 {
            let t = SkyFlight.overhead + (1 - SkyFlight.overhead) * Double(step) / 20
            #expect(abs(dot(Self.pose(t).right, up)) < sin(tilt) * 1.01, "t=\(t)")
        }
        #expect(abs(dot(Self.pose(1).right, up)) < 1e-9)
    }

    @Test func holdsTheObserverAtTheCentreForTheDescent() {
        for step in 0...20 {
            let t = SkyFlight.lockOn + (SkyFlight.overhead - SkyFlight.lockOn) * Double(step) / 20
            let pose = Self.pose(t)
            let sight = normalize(Self.observer.position - pose.position)
            #expect(acos(min(1, dot(-pose.back, sight))) < 1e-5, "t=\(t)")
        }
    }

    // In e-folds of the height a second, down to the last 100 m: a lerp of the
    // radius rushed the ground at 54.
    @Test func zoomsInAtASteadyRate() {
        let ground = length(Self.observer.position)
        let dt = 0.002
        var previous = length(Self.pose(0).position) - ground
        var t = dt
        while previous > 100 {
            let height = length(Self.pose(t).position) - ground
            #expect(log(previous / height) / (dt * SkyFlight.duration) < 25, "t=\(t)")
            previous = height
            t += dt
        }
    }

    @Test func easesWithSmootherstep() {
        #expect(SkyFlight.ease(0) == 0 && SkyFlight.ease(1) == 1)
        #expect(SkyFlight.ease(-0.5) == 0 && SkyFlight.ease(1.7) == 1)
        #expect(abs(SkyFlight.ease(0.5) - 0.5) < 1e-12)
        #expect(abs((SkyFlight.ease(0.5 + 1e-6) - SkyFlight.ease(0.5 - 1e-6)) / 2e-6 - 1.875) < 1e-6)
    }
}
