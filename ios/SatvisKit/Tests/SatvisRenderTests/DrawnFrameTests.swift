import CoreGraphics
import Foundation
import Testing
import simd

@testable import SatvisRender

/// Satellites standing still where a test puts them.
struct StillSatellites: DrawnSatellites {
    var places: [(id: String, position: SIMD3<Double>?)]
    var generation = 1

    var count: Int { places.count }
    func id(at index: Int) -> String { places[index].id }
    func name(at index: Int) -> String { places[index].id }
    func position(at index: Int, time _: Double) -> SIMD3<Double>? { places[index].position }
    func index(of id: String) -> Int? { places.firstIndex { $0.id == id } }
}

/// Taps and the sky view's instruments, answered from a frame drawn by hand.
@Suite struct DrawnFrameTests {
    static let viewSize = CGSize(width: 390, height: 844)
    static let centre = CGPoint(x: 195, y: 422)
    /// 2026-10-03, in UTC milliseconds.
    static let time = 1_791_000_000_000.0
    static let degree = Double.pi / 180

    /// Drawn at 2 pixels a point, from `pose`.
    static func frame(_ pose: CameraPose) -> DrawnFrame {
        DrawnFrame(pose: pose, size: SIMD2(2 * viewSize.width, 2 * viewSize.height), time: time)
    }

    /// 20,000 km over 0° N 0° E, looking straight down.
    static let overNullIsland = frame(
        CameraPose(
            position: SIMD3(ellipsoidRadii.x + 2e7, 0, 0), right: SIMD3(0, 1, 0), up: SIMD3(0, 0, 1), back: SIMD3(1, 0, 0), verticalFieldOfView: 60 * degree))

    /// The sky view's camera at an observer on the ellipsoid, aimed.
    static func sky(azimuth: Double, pitch: Double) -> SkyCamera {
        SkyCamera(latitude: 46.5935, longitude: 7.9091, azimuth: azimuth * degree, pitch: pitch * degree)
    }

    /// `range` metres from `camera`'s eye, `azimuth` degrees clockwise from north
    /// and `elevation` above the horizon.
    static func place(from camera: SkyCamera, azimuth: Double, elevation: Double, range: Double = 800_000) -> SIMD3<Double> {
        let (east, north, up) = camera.frame
        let (a, e) = (azimuth * degree, elevation * degree)
        return camera.position + range * (cos(e) * (sin(a) * east + cos(a) * north) + sin(e) * up)
    }

    @Test func picksAStationsPinOverASatelliteUnderTheSameTap() {
        let frame = Self.overNullIsland
        let satellites = StillSatellites(places: [("sat", SIMD3(ellipsoidRadii.x + 500_000, 0, 0))])
        let station = StationMarker(id: "station|a", latitude: 0, longitude: 0)
        // On the satellite's point, and within a fingertip of the pin's head.
        #expect(frame.screenPoint(SIMD3(ellipsoidRadii.x + 500_000, 0, 0), viewSize: Self.viewSize).map { hypot($0.x - Self.centre.x, $0.y - Self.centre.y) < 1e-6 } == true)
        let pick = { (stations: [StationMarker]) in
            frame.entity(at: Self.centre, viewSize: Self.viewSize, stations: stations, satellites: satellites, components: [.point, .label], labels: nil)
        }
        #expect(pick([station]) == "station|a")
        #expect(pick([]) == "sat")
    }

    @Test func picksNothingBehindTheEarth() {
        let frame = Self.overNullIsland
        // Straight behind the globe's middle, so on the middle of the screen.
        let satellites = StillSatellites(places: [("behind", SIMD3(-ellipsoidRadii.x - 500_000, 0, 0))])
        let station = StationMarker(id: "station|far", latitude: 0, longitude: 180)
        #expect(frame.screenPoint(SIMD3(-ellipsoidRadii.x - 500_000, 0, 0), viewSize: Self.viewSize) != nil)
        #expect(
            frame.entity(at: Self.centre, viewSize: Self.viewSize, stations: [station], satellites: satellites, components: [.point, .label], labels: nil)
                == nil)
    }

    @Test func findsTheGroundUnderATap() throws {
        let middle = try #require(Self.overNullIsland.groundPoint(at: Self.centre, viewSize: Self.viewSize))
        #expect(abs(middle.latitude) < 1e-9 && abs(middle.longitude) < 1e-9)

        // 10,000 km over 45° N 30° E, looking straight down, north up the screen.
        let (phi, lambda) = (45 * Self.degree, 30 * Self.degree)
        let normal = SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
        let north = SIMD3(-sin(phi) * cos(lambda), -sin(phi) * sin(lambda), cos(phi))
        let frame = Self.frame(
            CameraPose(
                position: fixedPosition(latitude: 45, longitude: 30) + 1e7 * normal, right: cross(north, normal), up: north, back: normal,
                verticalFieldOfView: 60 * Self.degree))
        let place = try #require(frame.groundPoint(at: Self.centre, viewSize: Self.viewSize))
        #expect(abs(place.latitude - 45) < 1e-9 && abs(place.longitude - 30) < 1e-9)
        // Up the screen is north.
        let above = try #require(frame.groundPoint(at: CGPoint(x: Self.centre.x, y: Self.centre.y - 100), viewSize: Self.viewSize))
        #expect(above.latitude > 45 && abs(above.longitude - 30) < 1e-9)
        // The corner looks past the globe's edge, 32° off the middle where the
        // globe spans 23°.
        #expect(frame.groundPoint(at: .zero, viewSize: Self.viewSize) == nil)
    }

    @Test func givesASatellitesDirectionInTheSky() throws {
        let camera = Self.sky(azimuth: 120, pitch: 40)
        let frame = Self.frame(camera.pose())
        let satellites = StillSatellites(places: [
            ("aimed", Self.place(from: camera, azimuth: 120, elevation: 40)),
            ("below", Self.place(from: camera, azimuth: 120, elevation: -5)),
            ("nowhere", nil),
        ])
        let targets = frame.skyTargets(viewSize: Self.viewSize, within: .infinity, camera: camera, unseen: .dim, satellites: satellites, directions: nil)
        #expect(targets.map(\.id) == ["aimed"])
        let target = try #require(targets.first)
        #expect(abs(target.azimuth - 120) < 1e-9 && abs(target.elevation - 40) < 1e-9)
        #expect(abs(target.range - 800) < 1e-6)
        #expect(hypot(target.screen.x - Self.centre.x, target.screen.y - Self.centre.y) < 1e-6)
    }

    @Test func givesASatelliteOverheadAtTheZenith() throws {
        let camera = Self.sky(azimuth: 0, pitch: 90)
        let frame = Self.frame(camera.pose())
        let satellites = StillSatellites(places: [("overhead", Self.place(from: camera, azimuth: 0, elevation: 90, range: 400_000))])
        let target = try #require(
            frame.skyTargets(viewSize: Self.viewSize, within: .infinity, camera: camera, unseen: .dim, satellites: satellites, directions: nil).first)
        #expect(abs(target.elevation - 90) < 1e-5)
        #expect(abs(target.range - 400) < 1e-6)
        #expect(hypot(target.screen.x - Self.centre.x, target.screen.y - Self.centre.y) < 1e-6)
    }
}
