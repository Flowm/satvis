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

    /// Height above the WGS84 ellipsoid, near enough: CesiumJS's eye height.
    var eyeHeight: Double {
        let p = position
        let ellipsoidRadius = 1 / sqrt((p.x * p.x + p.y * p.y) / (ellipsoidRadii.x * ellipsoidRadii.x) + p.z * p.z / (ellipsoidRadii.z * ellipsoidRadii.z))
        return length(p) * (1 - ellipsoidRadius)
    }

    /// The screen's up and right on the globe, as unit vectors in the fixed frame.
    private var screenAxes: (up: SIMD3<Double>, right: SIMD3<Double>) {
        let north = SIMD3(-sin(latitude) * cos(longitude), -sin(latitude) * sin(longitude), cos(latitude))
        let east = SIMD3(-sin(longitude), cos(longitude), 0.0)
        let screenUp = cos(heading) * north - sin(heading) * east
        let screenRight = sin(heading) * north + cos(heading) * east
        return (screenUp, screenRight)
    }

    /// A rotation from the fixed frame into the camera's, looking down -Z.
    func view() -> simd_double4x4 {
        let (screenUp, screenRight) = screenAxes
        let back = up
        return simd_double4x4(rows: [
            SIMD4(screenRight, 0), SIMD4(screenUp, 0), SIMD4(back, 0), SIMD4(0, 0, 0, 1),
        ])
    }

    /// Reversed-Z with no far plane: depth runs from 1 at the near plane to 0 at
    /// infinity, which a float spreads evenly enough to hold a metre at the near
    /// plane and the stars behind everything.
    func projection(aspectRatio: Double, near: Double = 1) -> simd_double4x4 {
        let verticalFieldOfView = aspectRatio > 1 ? 2 * atan(tan(Self.fieldOfView / 2) / aspectRatio) : Self.fieldOfView
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

    public mutating func rotate(by radians: Double) {
        heading -= radians
    }
}
