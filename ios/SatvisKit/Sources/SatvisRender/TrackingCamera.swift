import Foundation
import simd

/// Where the camera is and which way it faces, in the Earth-fixed frame: what one
/// frame is drawn from, whichever camera produced it.
struct CameraPose {
    var position: SIMD3<Double>
    var right: SIMD3<Double>
    var up: SIMD3<Double>
    /// Away from where the camera looks.
    var back: SIMD3<Double>
    /// Radians up the screen; nil for CesiumJS's 60° across the longer side.
    var verticalFieldOfView: Double? = nil
    /// Metres to the near plane.
    var near = 1.0

    /// The projection for a viewport of this shape.
    func projection(aspectRatio: Double) -> simd_double4x4 {
        OrbitCamera.projection(
            verticalFieldOfView: verticalFieldOfView ?? OrbitCamera.verticalFieldOfView(aspectRatio: aspectRatio), aspectRatio: aspectRatio, near: near)
    }

    func verticalFieldOfView(aspectRatio: Double) -> Double {
        verticalFieldOfView ?? OrbitCamera.verticalFieldOfView(aspectRatio: aspectRatio)
    }

    /// A rotation from the fixed frame into the camera's, looking down -Z.
    func view() -> simd_double4x4 {
        simd_double4x4(rows: [SIMD4(right, 0), SIMD4(up, 0), SIMD4(back, 0), SIMD4(0, 0, 0, 1)])
    }

    /// Height above the WGS84 ellipsoid, near enough: CesiumJS's eye height.
    var eyeHeight: Double {
        let p = position
        let ellipsoidRadius = 1 / sqrt((p.x * p.x + p.y * p.y) / (ellipsoidRadii.x * ellipsoidRadii.x) + p.z * p.z / (ellipsoidRadii.z * ellipsoidRadii.z))
        return length(p) * (1 - ellipsoidRadius)
    }
}

/// A camera that follows a satellite, looking at it from an offset in its local
/// east-north-up frame. It opens where the web app's tracking view does
/// (`viewFrom` 0, −3600 km, 4200 km: south of it and above); dragging circles it,
/// pinching closes in.
public struct TrackingCamera: Sendable, Equatable {
    /// Radians clockwise from north, of the camera as seen from the satellite.
    public var heading = Double.pi
    /// Radians above the satellite's horizon.
    public var pitch = atan2(4200.0, 3600.0)
    /// Metres from the satellite.
    public var range = (3600.0 * 3600 + 4200 * 4200).squareRoot() * 1000

    public init() {}

    func pose(target: SIMD3<Double>) -> CameraPose {
        let up = normalize(target)
        let east = normalize(cross(SIMD3(0, 0, 1), up))
        let north = cross(up, east)
        let back = cos(pitch) * (sin(heading) * east + cos(heading) * north) + sin(pitch) * up
        let right = normalize(cross(up, back))
        return CameraPose(position: target + range * back, right: right, up: cross(back, right), back: back)
    }

    /// Circles the satellite: across turns the heading, up and down the pitch.
    public mutating func orbit(by points: SIMD2<Double>, longerSide: Double) {
        let radiansPerPoint = Double.pi / longerSide
        heading -= points.x * radiansPerPoint
        pitch = min(max(pitch + points.y * radiansPerPoint, 5 * .pi / 180), 89 * .pi / 180)
    }

    public mutating func zoom(by scale: Double) {
        range = min(max(range / scale, 1_000), 100_000_000)
    }

    public mutating func rotate(by radians: Double) {
        heading -= radians
    }
}
