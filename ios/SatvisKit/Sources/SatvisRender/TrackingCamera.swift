import Foundation
import SatvisCore
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
struct TrackingCamera: Sendable, Equatable {
    /// Radians from the frame's y axis towards its x: from north towards east, for
    /// what holds still.
    var heading = Double.pi
    /// Radians above the satellite's horizon.
    var pitch = atan2(4200.0, 3600.0)
    /// Metres from the satellite.
    var range = (3600.0 * 3600 + 4200 * 4200).squareRoot() * 1000
    /// Radians the view looks down past what it follows: the chase's (`Chase.tilt`).
    var tilt = 0.0

    init() {}

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
        var pose = CameraPose(position: target + range * back, right: right, up: cross(back, right), back: back, near: min(1, range / 10))
        if tilt != 0 {
            // Turned about its right axis, as CesiumJS's `lookDown`.
            (pose.back, pose.up) = (cos(tilt) * back + sin(tilt) * pose.up, cos(tilt) * pose.up - sin(tilt) * back)
        }
        return pose
    }

    /// The steepest the camera looks down on what it follows.
    private static let maximumPitch = 89 * Double.pi / 180
    /// Metres the eye keeps over the ground: the sky view's eye height.
    static let groundClearance = SkyCamera.eyeHeight

    /// Lifts the eye up out of the ground, as CesiumJS's collision detection
    /// does, by a steeper pitch and a longer range, so a pinch carries on from
    /// the view drawn. A ground station stands on the ellipsoid, thousands of
    /// metres inside a mountain, and its range is measured from there.
    /// `groundHeight` is the ground's in metres at a place, nil where no terrain
    /// has loaded.
    mutating func keepAboveGround(target: SIMD3<Double>, velocity: SIMD3<Double> = .zero, groundHeight: (GeoCoordinate) -> Double?) {
        let eye = pose(target: target, velocity: velocity).position
        let place = geodeticPosition(eye)
        let floor = (groundHeight(GeoCoordinate(latitude: place.latitude * 180 / .pi, longitude: place.longitude * 180 / .pi)) ?? 0) + Self.groundClearance
        guard place.height < floor else {
            return
        }
        // Up the frame's z, which is geocentric: off the ground's normal by 0.19°
        // at 47° N, enough to move a lifted eye by metres a frame.
        let normal = eastNorthUp(latitude: place.latitude, longitude: place.longitude).up
        let up = Self.axes(target: target, velocity: velocity).z
        let offset = eye - target
        let level = length(offset - dot(offset, up) * up)
        let rise = dot(offset, up) + (floor - place.height) / dot(up, normal)
        if atan2(rise, level) < Self.maximumPitch {
            pitch = atan2(rise, level)
            range = (rise * rise + level * level).squareRoot()
        } else {
            pitch = Self.maximumPitch
            range = (floor - geodeticPosition(target).height) / dot(normalize(pose(target: target, velocity: velocity).position - target), normal)
        }
    }

    /// Circles the satellite: across turns the heading, up and down the pitch.
    /// Ignores a gesture that is not finite, as `OrbitCamera.rotate` says why.
    mutating func orbit(by points: SIMD2<Double>, longerSide: Double) {
        guard points.isFinite, longerSide > 0 else {
            return
        }
        let radiansPerPoint = Double.pi / longerSide
        heading -= points.x * radiansPerPoint
        pitch = min(max(pitch + points.y * radiansPerPoint, 5 * .pi / 180), Self.maximumPitch)
    }

    mutating func zoom(by scale: Double) {
        guard scale.isFinite, scale > 0 else {
            return
        }
        // CesiumJS's minimumZoomDistance: a metre, near enough for a 3D model.
        range = min(max(range / scale, 1), 100_000_000)
    }

    mutating func rotate(by radians: Double) {
        guard radians.isFinite else {
            return
        }
        heading -= radians
    }
}
