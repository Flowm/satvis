import Foundation
import simd

/// The flight between the globe and the sky view (src/modules/skyFlight.ts, ADR
/// 0003): not a cut, because the two share too few pixels for the eye to connect
/// them. One clock drives three legs: the view locks on to the observer, the
/// camera descends to straight overhead looking down, then lands and the view
/// rises off the ground to the aim. Leaving is the same flight played backwards.
struct SkyFlight {
    static let duration = 2.2
    /// Where the view has locked on to the observer, the camera stands overhead,
    /// and it lands, as fractions of the flight.
    static let lockOn = 0.3
    static let overhead = 0.55
    static let touchdown = 0.8

    /// The pose the camera left the globe from, or comes back to.
    let globe: CameraPose
    /// Seconds of system uptime when the flight would have begun, had it run
    /// from its start: a turnaround resumes rather than restarting.
    var start: Double
    /// Towards the ground, or back up.
    var entering: Bool

    /// From 0 on the globe to 1 on the ground, at an uptime.
    func progress(at time: Double) -> Double {
        let covered = min(max((time - start) / Self.duration, 0), 1)
        return entering ? covered : 1 - covered
    }

    /// Whether the camera has arrived where it was going.
    func isOver(at time: Double) -> Bool {
        time - start >= Self.duration
    }

    /// Turns the flight around where it is.
    mutating func reverse(at time: Double) {
        let covered = min(max((time - start) / Self.duration, 0), 1)
        start = time - Self.duration * (1 - covered)
        entering.toggle()
    }

    /// The camera at `t` of the way from the globe's pose to the sky's. `over` is
    /// the sky pose's position and azimuth looking straight down.
    static func pose(from: CameraPose, to: CameraPose, over: CameraPose, t: Double) -> CameraPose {
        let overheadT = ease(t / overhead)
        let arrival = ease(t / touchdown)

        // Along the great circle, the height easing in on its own clock.
        let a = normalize(from.position)
        let b = normalize(to.position)
        let angle = acos(min(max(dot(a, b), -1), 1))
        var axis = cross(a, b)
        if length(axis) < 1e-12 {
            axis = abs(a.x) < 0.9 ? cross(a, SIMD3(1, 0, 0)) : cross(a, SIMD3(0, 1, 0))
        }
        let direction = simd_quatd(angle: angle * overheadT, axis: normalize(axis)).act(a)
        let radius = mix(length(from.position), length(to.position), t: arrival)
        let eye = direction * radius

        // Straight down, turned onto the line of sight to the observer: the
        // identity once the camera stands on the very point it aims at.
        let nadir = attitude(over)
        let line = to.position - eye
        var aimed = nadir
        let down = -over.back
        if length(line) > 1 {
            let sight = normalize(line)
            let turn = acos(min(max(dot(down, sight), -1), 1))
            let turnAxis = cross(down, sight)
            if turn > 1e-7, length(turnAxis) > 1e-12 {
                aimed = (simd_quatd(angle: turn, axis: normalize(turnAxis)) * nadir).normalized
            }
        }
        let locked = simd_slerp(attitude(from), aimed, ease(t / lockOn))
        let blended = simd_slerp(locked, attitude(to), ease((t - overhead) / (1 - overhead))).normalized
        let basis = simd_double3x3(blended)
        return CameraPose(
            position: eye, right: basis.columns.0, up: basis.columns.1, back: basis.columns.2,
            verticalFieldOfView: mix(from.verticalFieldOfView ?? to.verticalFieldOfView ?? 1, to.verticalFieldOfView ?? 1, t: arrival),
            near: arrival < 1 ? 1 : to.near)
    }

    /// The quintic in and out CesiumJS's EasingFunction calls QUINTIC_IN_OUT.
    static func ease(_ t: Double) -> Double {
        let t = min(max(t, 0), 1)
        return t < 0.5 ? 16 * pow(t, 5) : 1 + 16 * pow(t - 1, 5)
    }

    static func attitude(_ pose: CameraPose) -> simd_quatd {
        simd_quatd(simd_double3x3(columns: (pose.right, pose.up, pose.back))).normalized
    }

    private static func mix(_ a: Double, _ b: Double, t: Double) -> Double {
        a + (b - a) * t
    }
}
