import Foundation
import Testing
import simd

@testable import SatvisRender

@Suite struct SkyFlightTests {
    private static let observer = SkyCamera(latitude: 46.5935, longitude: 7.9091)
    private static let globe = OrbitCamera.home(aspectRatio: 390.0 / 844).pose()

    private static func pose(_ t: Double) -> CameraPose {
        var over = SkyCamera(latitude: observer.latitude, longitude: observer.longitude, azimuth: observer.azimuth, pitch: -.pi / 2)
        over.groundHeight = observer.groundHeight
        return SkyFlight.pose(from: globe, to: observer.pose(), over: over.pose(), t: t)
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

    @Test func easesAsCesiumDoes() {
        #expect(SkyFlight.ease(0) == 0 && SkyFlight.ease(1) == 1)
        #expect(abs(SkyFlight.ease(0.5) - 0.5) < 1e-12)
        #expect(abs(SkyFlight.ease(0.25) - 16 * pow(0.25, 5)) < 1e-12)
    }
}
