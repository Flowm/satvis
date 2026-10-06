import Foundation
import simd

/// The flight into tracking, back out of it, and home from it, as the web app's
/// `camera.flyTo` makes them (src/modules/trackFlight.ts): from the pose the camera
/// was in to one it is heading for, which is worked out afresh every frame. So it
/// lands on a satellite that moved on the way, and the web app's pause of the
/// clock for the flight is not needed.
struct PoseFlight {
    static let duration = 2.0

    /// The pose the camera set off from.
    let from: CameraPose
    /// Seconds of system uptime when it set off.
    let start: Double

    func progress(at time: Double) -> Double {
        min(max((time - start) / Self.duration, 0), 1)
    }

    func isOver(at time: Double) -> Bool {
        time - start >= Self.duration
    }

    /// The camera `t` of the way, eased: along the great circle between the two
    /// positions, the distance from the Earth's centre evenly in its logarithm,
    /// the attitude turned the shortest way.
    static func pose(from: CameraPose, to: CameraPose, t: Double) -> CameraPose {
        let eased = SkyFlight.ease(t)
        let a = normalize(from.position)
        let b = normalize(to.position)
        let angle = acos(min(max(dot(a, b), -1), 1))
        var direction = b
        if angle > 1e-9, eased < 1 {
            var axis = cross(a, b)
            if length(axis) < 1e-12 {
                axis = abs(a.x) < 0.9 ? cross(a, SIMD3(1, 0, 0)) : cross(a, SIMD3(0, 1, 0))
            }
            direction = simd_quatd(angle: angle * eased, axis: normalize(axis)).act(a)
        }
        let radius = exp(log(length(from.position)) + (log(length(to.position)) - log(length(from.position))) * eased)
        let basis = simd_double3x3(simd_slerp(SkyFlight.attitude(from), SkyFlight.attitude(to), eased).normalized)
        let fieldOfView: Double? =
            if let start = from.verticalFieldOfView, let end = to.verticalFieldOfView { start + (end - start) * eased } else { to.verticalFieldOfView }
        return CameraPose(
            position: direction * radius, right: basis.columns.0, up: basis.columns.1, back: basis.columns.2, verticalFieldOfView: fieldOfView,
            near: min(from.near, to.near))
    }
}
