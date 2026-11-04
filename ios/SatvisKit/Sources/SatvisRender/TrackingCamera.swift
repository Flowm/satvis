import Foundation
import simd

/// Where the camera is and which way it faces, in the Earth-fixed frame: what one
/// frame is drawn from, whichever camera produced it.
struct CameraPose: Equatable {
    var position: SIMD3<Double>
    var right: SIMD3<Double>
    var up: SIMD3<Double>
    /// Away from where the camera looks.
    var back: SIMD3<Double>
    /// Radians up the screen; nil for CesiumJS's 60° across the longer side.
    var verticalFieldOfView: Double? = nil
    /// Metres to the near plane.
    var near = 1.0
    /// In 2D, the map camera the frame is drawn from; the rest of the pose is
    /// then the globe camera over the same place, which a flight into the sky
    /// view sets off from.
    var mapCamera: MapCamera? = nil

    /// The projection for a viewport of this shape.
    func projection(aspectRatio: Double) -> simd_double4x4 {
        OrbitCamera.projection(verticalFieldOfView: verticalFieldOfView(aspectRatio: aspectRatio), aspectRatio: aspectRatio, near: near)
    }

    /// Whether no coordinate is NaN or infinite.
    var isFinite: Bool {
        [position, right, up, back].allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }
            && mapCamera.map { [$0.latitude, $0.longitude, $0.span, $0.heading].allSatisfy(\.isFinite) } ?? true
    }

    func verticalFieldOfView(aspectRatio: Double) -> Double {
        verticalFieldOfView ?? OrbitCamera.verticalFieldOfView(aspectRatio: aspectRatio)
    }

    /// A rotation from the fixed frame into the camera's, looking down -Z.
    func view() -> simd_double4x4 {
        simd_double4x4(rows: [SIMD4(right, 0), SIMD4(up, 0), SIMD4(back, 0), SIMD4(0, 0, 0, 1)])
    }
}

/// A camera that follows a satellite, looking at it from an offset it holds in the
/// frame the web app's tracking view does (`axes`). It opens where that view does
/// (`viewFrom` 0, −3600 km, 4200 km: behind it on the y axis and above); dragging
/// circles it, pinching closes in.
public struct TrackingCamera: Sendable, Equatable {
    /// Radians from the frame's y axis towards its x: from north towards east, for
    /// what holds still.
    public var heading = Double.pi
    /// Radians above the satellite's horizon.
    public var pitch = atan2(4200.0, 3600.0)
    /// Metres from the satellite.
    public var range = (3600.0 * 3600 + 4200 * 4200).squareRoot() * 1000

    public init() {}

    /// Close up on a 3D model, as the web app tracks one while its model is on:
    /// along (9, −10, 9) in `axes`, six model radii away, so a cubesat and the ISS
    /// fill the screen alike. 34° up, past the 20–23° a low orbit's horizon dips,
    /// so the model is seen against the ground.
    static func framing(modelRadius radius: Double) -> TrackingCamera {
        var camera = TrackingCamera()
        camera.heading = atan2(9, -10)
        camera.pitch = atan2(9, (81.0 + 100).squareRoot())
        camera.range = 6 * radius
        return camera
    }

    /// Where Earth's surface is at rest, radians per second.
    private static let earthRotation = SIMD3(0, 0, 7.292_115e-5)
    /// Past this semi-major axis, in metres, the frame turns north-up: 1.25 times
    /// WGS84's equatorial radius, as CesiumJS has it.
    private static let northUpSemiMajorAxis = 1.25 * 6_378_137.0

    /// The axes CesiumJS's `EntityView` holds a tracked entity's `viewFrom` in, in 3D
    /// (`updateTransform`), for one at `target` moving at `velocity` m/s in the
    /// fixed frame. In a low orbit: x along its motion through inertial space,
    /// level, y along the orbit's normal, z up. In a higher one or an escape: x
    /// down, y west, z north. Still: east, north, up.
    static func axes(target: SIMD3<Double>, velocity: SIMD3<Double>) -> (x: SIMD3<Double>, y: SIMD3<Double>, z: SIMD3<Double>) {
        let up = normalize(target)
        let inertialVelocity = velocity + cross(earthRotation, target)
        let speed = length(inertialVelocity)
        let semiMajorAxis = -OrbitMotion.gravitationalParameter / (speed * speed - 2 * OrbitMotion.gravitationalParameter / length(target))
        if semiMajorAxis < 0 || semiMajorAxis > northUpSemiMajorAxis {
            let west = cross(SIMD3(0, 0, 1), -up)
            if length(west) > 1e-7 {
                let y = normalize(west)
                return (-up, y, normalize(cross(-up, y)))
            }
        } else if length(velocity) * 0.001 > 1e-7 * length(target) {
            // Cesium tells it by where it is a millisecond on.
            let normal = cross(up, inertialVelocity)
            if length(normal) * 0.001 > 1e-7 * length(target) {
                let y = normalize(normal)
                return (cross(y, up), y, up)
            }
        }
        let east = normalize(cross(SIMD3(0, 0, 1), up))
        return (east, cross(up, east), up)
    }

    /// Seen from here, around what is at `target` moving at `velocity` m/s in the
    /// fixed frame.
    func pose(target: SIMD3<Double>, velocity: SIMD3<Double> = .zero) -> CameraPose {
        let (x, y, up) = Self.axes(target: target, velocity: velocity)
        let back = cos(pitch) * (sin(heading) * x + cos(heading) * y) + sin(pitch) * up
        let right = normalize(cross(up, back))
        // Nearer than a metre to a cubesat's model: the near plane comes in with it.
        return CameraPose(position: target + range * back, right: right, up: cross(back, right), back: back, near: min(1, range / 10))
    }

    /// Circles the satellite: across turns the heading, up and down the pitch.
    /// Ignores a gesture that is not finite, as `OrbitCamera.rotate` says why.
    public mutating func orbit(by points: SIMD2<Double>, longerSide: Double) {
        guard points.isFinite, longerSide > 0 else {
            return
        }
        let radiansPerPoint = Double.pi / longerSide
        heading -= points.x * radiansPerPoint
        pitch = min(max(pitch + points.y * radiansPerPoint, 5 * .pi / 180), 89 * .pi / 180)
    }

    public mutating func zoom(by scale: Double) {
        guard scale.isFinite, scale > 0 else {
            return
        }
        // CesiumJS's minimumZoomDistance: a metre, near enough for a 3D model.
        range = min(max(range / scale, 1), 100_000_000)
    }

    public mutating func rotate(by radians: Double) {
        guard radians.isFinite else {
            return
        }
        heading -= radians
    }
}
