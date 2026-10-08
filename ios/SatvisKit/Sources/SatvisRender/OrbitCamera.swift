import Foundation
import simd

/// A camera above a point on the globe looking straight down at the centre of the
/// Earth, in the Earth-fixed frame. Dragging moves the point, pinching the height,
/// twisting the heading.
public struct OrbitCamera: Sendable, Equatable {
    /// Radians.
    public var latitude: Double
    public var longitude: Double
    /// Metres above a sphere of the equatorial radius.
    public var altitude: Double
    /// Radians clockwise from north at the top of the screen.
    public var heading: Double

    public static let minimumAltitude = 100_000.0
    public static let maximumAltitude = 100_000_000.0
    /// CesiumJS's default: the field of view across the longer side of the screen.
    public static let fieldOfView = 60.0 * Double.pi / 180

    public init(latitude: Double, longitude: Double, altitude: Double, heading: Double = 0) {
        self.latitude = latitude
        self.longitude = longitude
        self.altitude = altitude
        self.heading = heading
    }

    /// Where the web app opens (`CesiumController.setDefaultView`): above 25° N 15° E,
    /// far enough that the globe fills 82 % of the screen's narrow side.
    public static func home(aspectRatio: Double) -> OrbitCamera {
        let halfNarrow = atan(tan(fieldOfView / 2) * min(aspectRatio, 1 / aspectRatio))
        let distance = ellipsoidRadii.x / sin(0.82 * halfNarrow)
        return OrbitCamera(latitude: 25 * .pi / 180, longitude: 15 * .pi / 180, altitude: distance - ellipsoidRadii.x)
    }

    var radius: Double { ellipsoidRadii.x + altitude }

    var up: SIMD3<Double> {
        SIMD3(cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude))
    }

    public var position: SIMD3<Double> { up * radius }

    /// The camera `t` of the way from one to another, eased: along the great
    /// circle between the points below them, the height evenly in its logarithm,
    /// the heading the shorter way round.
    public static func between(_ from: OrbitCamera, _ to: OrbitCamera, t: Double) -> OrbitCamera {
        let eased = SkyFlight.ease(t)
        let a = from.up
        let b = to.up
        let angle = acos(min(max(dot(a, b), -1), 1))
        var unit = b
        if angle > 1e-9, eased < 1 {
            var axis = cross(a, b)
            if length(axis) < 1e-12 {
                axis = abs(a.x) < 0.9 ? cross(a, SIMD3(1, 0, 0)) : cross(a, SIMD3(0, 1, 0))
            }
            unit = simd_quatd(angle: angle * eased, axis: normalize(axis)).act(a)
        }
        let altitude = exp(log(from.altitude) + (log(to.altitude) - log(from.altitude)) * eased)
        let turn = remainder(to.heading - from.heading, 2 * .pi)
        return OrbitCamera(latitude: asin(min(max(unit.z, -1), 1)), longitude: atan2(unit.y, unit.x), altitude: altitude, heading: from.heading + turn * eased)
    }

    /// The screen's up and right on the globe, as unit vectors in the fixed frame.
    private var screenAxes: (up: SIMD3<Double>, right: SIMD3<Double>) {
        let north = SIMD3(-sin(latitude) * cos(longitude), -sin(latitude) * sin(longitude), cos(latitude))
        let east = SIMD3(-sin(longitude), cos(longitude), 0.0)
        let screenUp = cos(heading) * north - sin(heading) * east
        let screenRight = sin(heading) * north + cos(heading) * east
        return (screenUp, screenRight)
    }

    func pose() -> CameraPose {
        let (screenUp, screenRight) = screenAxes
        return CameraPose(position: position, right: screenRight, up: screenUp, back: up)
    }

    /// The field of view up the screen: the 60° spans the longer side.
    static func verticalFieldOfView(aspectRatio: Double) -> Double {
        aspectRatio > 1 ? 2 * atan(tan(fieldOfView / 2) / aspectRatio) : fieldOfView
    }

    /// Reversed-Z with no far plane: depth runs from 1 at the near plane to 0 at
    /// infinity, which a float spreads evenly enough to hold a metre at the near
    /// plane and the stars behind everything.
    static func projection(verticalFieldOfView: Double, aspectRatio: Double, near: Double = 1) -> simd_double4x4 {
        let f = 1 / tan(verticalFieldOfView / 2)
        return simd_double4x4(columns: (SIMD4(f / aspectRatio, 0, 0, 0), SIMD4(0, f, 0, 0), SIMD4(0, 0, 0, -1), SIMD4(0, 0, near, 0)))
    }

    /// Moves the camera so the globe follows a drag of `points`, right and down as
    /// UIKit measures them, on a view whose longer side is `longerSide` points:
    /// the side the field of view spans.
    public mutating func pan(by points: SIMD2<Double>, longerSide: Double) {
        let radiansPerPoint = 2 * tan(Self.fieldOfView / 2) * altitude / (longerSide * ellipsoidRadii.x)
        let (screenUp, screenRight) = screenAxes
        let target = up - (points.x * screenRight - points.y * screenUp) * radiansPerPoint
        let unit = normalize(target)
        latitude = min(max(asin(unit.z), -89.0 * .pi / 180), 89.0 * .pi / 180)
        longitude = atan2(unit.y, unit.x)
    }

    public mutating func zoom(by scale: Double) {
        altitude = min(max(altitude / scale, Self.minimumAltitude), Self.maximumAltitude)
    }

    /// Keeps the camera where it was against the stars while the Earth turns from
    /// one Greenwich hour angle to another: back by as far, whichever way the
    /// clock went.
    public mutating func holdInertial(from last: Double, to angle: Double) {
        longitude = remainder(longitude - remainder(angle - last, 2 * .pi), 2 * .pi)
    }

    /// A twist of `radians` clockwise on the screen turns the globe with the fingers.
    public mutating func rotate(by radians: Double) {
        heading += radians
    }
}
