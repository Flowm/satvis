import Foundation
import simd

/// A pair of eyes on the ground: the sky view's camera (ADR 0003). It stands at
/// an observer, a little above the ground under them, and looks out along an
/// attitude in the observer's east-north-up frame. Dragging aims it by azimuth and
/// pitch, which levels it; only the device's own attitude rolls it. The field of
/// view is the vertical one, whatever the screen's shape.
public struct SkyCamera: Sendable, Equatable {
    /// Degrees.
    public var latitude: Double
    public var longitude: Double
    /// Metres above the ellipsoid of the ground under the observer.
    public var groundHeight: Double = 0
    /// From camera axes (right +X, up +Y, back +Z) into east, north, up.
    public var attitude: simd_quatd
    /// Radians, up the screen.
    public var verticalFieldOfView = defaultFieldOfView

    /// Above the ground, as a person holds a phone.
    public static let eyeHeight = 2.0
    public static let defaultFieldOfView = 75 * Double.pi / 180
    public static let defaultPitch = 30 * Double.pi / 180
    public static let fieldOfViewRange = (10 * Double.pi / 180)...(100 * Double.pi / 180)

    /// Facing the equator, where the geostationary belt is, up from the horizon
    /// by the default pitch: the horizon on screen, since the pitch is under half
    /// the field of view.
    public init(latitude: Double, longitude: Double, azimuth: Double? = nil, pitch: Double = defaultPitch) {
        self.latitude = latitude
        self.longitude = longitude
        attitude = Self.attitude(azimuth: azimuth ?? (latitude >= 0 ? .pi : 0), pitch: pitch)
    }

    /// Level, facing `azimuth` (radians clockwise from north) and `pitch` above
    /// the horizon. Built by turning, not from a cross product with the vertical,
    /// so straight up and straight down are aims like any other.
    public static func attitude(azimuth: Double, pitch: Double) -> simd_quatd {
        // Facing north, level: right is east, up is up, back is south.
        let level = simd_quatd(simd_double3x3(columns: (SIMD3(1, 0, 0), SIMD3(0, 0, 1), SIMD3(0, -1, 0))))
        let tilt = simd_quatd(angle: pitch, axis: SIMD3(1, 0, 0))
        let turn = simd_quatd(angle: -azimuth, axis: SIMD3(0, 0, 1))
        return (turn * tilt * level).normalized
    }

    /// How the interface is turned on the device, as UIKit's
    /// UIInterfaceOrientation names it.
    public enum ScreenOrientation: Sendable {
        case portrait, portraitUpsideDown, landscapeLeft, landscapeRight
    }

    /// The attitude a device held this way gives the camera, which looks out of
    /// its back with the screen's right and up. `device` holds the device's axes
    /// in the reference frame (north, west, up) as its rows: CoreMotion's
    /// rotation matrix, which takes that frame into the device's.
    public static func attitude(device: simd_double3x3, screen: ScreenOrientation) -> simd_quatd {
        // A row of `device`, from north, west, up into east, north, up.
        let axis = { (row: Int) in
            let r = SIMD3(device[0][row], device[1][row], device[2][row])
            return SIMD3(-r.y, r.x, r.z)
        }
        let (x, y, z) = (axis(0), axis(1), axis(2))
        let (right, up): (SIMD3<Double>, SIMD3<Double>) =
            switch screen {
            case .portrait: (x, y)
            case .portraitUpsideDown: (-x, -y)
            // The device's top to the left: the screen's up is its right edge.
            case .landscapeRight: (-y, x)
            case .landscapeLeft: (y, -x)
            }
        return simd_quatd(simd_double3x3(columns: (right, up, z))).normalized
    }

    /// Where the camera looks, in east, north, up.
    public var look: SIMD3<Double> { attitude.act(SIMD3(0, 0, -1)) }

    /// Radians clockwise from north of where the camera looks; straight up and
    /// down, where it has none, by the camera's up instead: tilted past the
    /// zenith from an azimuth, the top of the screen points back across it.
    public var azimuth: Double {
        let look = look
        if abs(look.z) > 1 - 1e-9 {
            let facing = attitude.act(SIMD3(0, 1, 0)) * (look.z > 0 ? -1 : 1)
            return atan2(facing.x, facing.y)
        }
        return atan2(look.x, look.y)
    }

    /// Radians above the horizon of where the camera looks.
    public var pitch: Double { asin(min(max(look.z, -1), 1)) }

    /// Turns the camera so the sky follows a drag of `points`, right and down as
    /// UIKit measures them, on a view `height` points tall: a field of view's
    /// worth of sky per screen height. Levels it.
    public mutating func drag(by points: SIMD2<Double>, height: Double) {
        let radiansPerPoint = verticalFieldOfView / height
        let pitch = min(max(pitch + points.y * radiansPerPoint, -.pi / 2), .pi / 2)
        attitude = Self.attitude(azimuth: azimuth - points.x * radiansPerPoint, pitch: pitch)
    }

    /// A pinch: a narrower field of view for a scale above 1.
    public mutating func zoom(by scale: Double) {
        verticalFieldOfView = min(max(verticalFieldOfView / scale, Self.fieldOfViewRange.lowerBound), Self.fieldOfViewRange.upperBound)
    }

    /// The observer's east, north and up in the fixed frame.
    var frame: (east: SIMD3<Double>, north: SIMD3<Double>, up: SIMD3<Double>) {
        let phi = latitude * .pi / 180
        let lambda = longitude * .pi / 180
        let up = SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
        let east = SIMD3(-sin(lambda), cos(lambda), 0.0)
        return (east, cross(up, east), up)
    }

    public var position: SIMD3<Double> {
        fixedPosition(latitude: latitude, longitude: longitude) + (groundHeight + Self.eyeHeight) * frame.up
    }

    func pose() -> CameraPose {
        let (east, north, up) = frame
        let fixed = { (v: SIMD3<Double>) in v.x * east + v.y * north + v.z * up }
        return CameraPose(
            position: position, right: fixed(attitude.act(SIMD3(1, 0, 0))), up: fixed(attitude.act(SIMD3(0, 1, 0))),
            back: fixed(attitude.act(SIMD3(0, 0, 1))), verticalFieldOfView: verticalFieldOfView, near: 0.25)
    }
}
