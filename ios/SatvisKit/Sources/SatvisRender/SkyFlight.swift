import Foundation
import simd

/// The flight between the globe and the sky view (src/modules/skyFlight.ts, ADR
/// 0003): not a cut, because the two share too few pixels for the eye to connect
/// them. One clock drives three legs: the view locks on to the observer, the
/// camera descends to straight overhead looking down, then lands and the view
/// rises off the ground to the aim. Underneath all three the heading turns from
/// the globe's to the aim's, about the observer's vertical. Leaving is the same
/// flight played backwards.
struct SkyFlight {
    static let duration = 2.2
    /// Where the view has locked on to the observer, the camera stands overhead,
    /// and it lands, as fractions of the flight.
    static let lockOn = 0.3
    static let overhead = 0.55
    static let touchdown = 0.8

    /// The start's offset from the aim, split once: recomputed, a half turn
    /// could flip sign as the ground height arrives.
    struct Offset {
        /// Radians about the observer's vertical, from the aim's heading to the
        /// one the globe shows as up.
        var turn: Double
        /// The globe's attitude in the frame of the aim at the start, less
        /// `turn`: what the lock-on eases away.
        var swing: simd_quatd
    }

    /// The pose the camera left the globe from, or comes back to.
    let globe: CameraPose
    /// Seconds of system uptime when the flight would have begun, had it run
    /// from its start: a turnaround resumes rather than restarting.
    var start: Double
    /// Towards the ground, or back up.
    var entering: Bool
    /// Set on the first frame, once the sky pose it is measured against is known.
    var offset: Offset?

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

    /// Splits the turn from `from`'s attitude to the aim at `to` into a twist
    /// about the view axis, which is straight down at the aim and so a turn about
    /// the vertical, and the swing left over. Without the split, an aim facing the
    /// equator from the northern hemisphere rolled the view 180° in the lock-on.
    static func offset(from: CameraPose, to: CameraPose, over: CameraPose) -> Offset {
        let aimed = sightTurn(down: -over.back, target: to.position, eye: from.position) * attitude(over)
        let offset = aimed.conjugate * attitude(from)
        // The short way round: `offset` and its negation are the same rotation.
        let sign: Double = offset.real < 0 ? -1 : 1
        let turn = 2 * atan2(sign * offset.imag.z, sign * offset.real)
        let twist = simd_quatd(angle: turn, axis: SIMD3(0, 0, 1))
        return Offset(turn: turn, swing: (twist.conjugate * offset).normalized)
    }

    /// The camera at `t` of the way from the globe's pose to the sky's. `over` is
    /// the sky pose's position and azimuth looking straight down.
    static func pose(from: CameraPose, to: CameraPose, over: CameraPose, offset: Offset, t: Double) -> CameraPose {
        // The camera is overhead exactly when the rise starts, so the aim is
        // already straight down and the rise changes no roll.
        let arrival = ease(t / touchdown)
        let eye = position(from: from.position, to: to.position, overhead: ease(t / overhead), drop: arrival)

        // The heading still to turn, about the vertical in world space so it never
        // tilts the horizon. Spread over the whole flight, the slowest a half turn
        // can go.
        let yaw = simd_quatd(angle: offset.turn * (1 - ease(t)), axis: over.back)
        let nadir = yaw * attitude(over)

        // The swing ends long before the rise starts, so the aim alone holds the
        // destination at screen centre during the descent.
        let aimed = sightTurn(down: -over.back, target: to.position, eye: eye) * nadir

        // Eased in the camera's own frame, so the destination's place on screen
        // depends on the lock-on alone. Blending towards the moving aim overshot it
        // by 6° as the camera swept round.
        let locked = aimed * simd_slerp(offset.swing, identity, ease(t / lockOn))
        let arriving = yaw * attitude(to)
        let blended = simd_slerp(locked, arriving, ease((t - overhead) / (1 - overhead))).normalized
        let basis = simd_double3x3(blended)
        return CameraPose(
            position: eye, right: basis.columns.0, up: basis.columns.1, back: basis.columns.2,
            verticalFieldOfView: mix(from.verticalFieldOfView ?? to.verticalFieldOfView ?? 1, to.verticalFieldOfView ?? 1, t: arrival),
            near: arrival < 1 ? 1 : to.near)
    }

    /// Along the great circle rather than through the planet. The camera is
    /// overhead once `overhead` reaches 1 and down once `drop` does, so it comes to
    /// rest overhead before landing instead of reaching the ground sideways.
    static func position(from: SIMD3<Double>, to: SIMD3<Double>, overhead: Double, drop: Double) -> SIMD3<Double> {
        let fromRadius = length(from)
        let toRadius = length(to)
        let height = fromRadius - toRadius
        let left = heightLeft(height, drop: drop)
        let radius = toRadius + left * height
        // The way left round shrinks with the height left too, so the camera closes
        // in along the line of sight. Otherwise the geometric descent is low while
        // still far off, and the aim whips round to hold the destination (700°/s).
        let sweep = 1 - (1 - overhead) * left
        let a = from / fromRadius
        let b = to / toRadius
        let angle = atan2(length(cross(a, b)), dot(a, b))
        guard angle > 1e-7 else {
            return a * radius
        }
        return simd_quatd(angle: angle * sweep, axis: turnAxis(a, b)).act(a) * radius
    }

    /// The descent is geometric in the height, so the ground grows on screen at a
    /// steady rate instead of rushing up at the end, and within about this many
    /// metres it turns linear. Lower is steadier still, but then the camera spends
    /// the rise skimming ground the base map has no detail for.
    private static let landingMetres = 3000.0

    /// The fraction of `height` still to come down, in [0, 1], so never underground.
    private static func heightLeft(_ height: Double, drop: Double) -> Double {
        guard height > 0 else {
            // Leaving for a globe camera lower than the eye: no zoom to pace.
            return 1 - drop
        }
        return (pow(height + landingMetres, 1 - drop) * pow(landingMetres, drop) - landingMetres) / height
    }

    /// The world-space turn that swings `down` onto the line of sight from `eye`
    /// to `target`: the identity once the camera stands on the very point it aims
    /// at, where a look-at has no answer.
    private static func sightTurn(down: SIMD3<Double>, target: SIMD3<Double>, eye: SIMD3<Double>) -> simd_quatd {
        let line = target - eye
        guard length(line) > 1 else {
            return identity
        }
        let sight = normalize(line)
        let angle = atan2(length(cross(down, sight)), dot(down, sight))
        guard angle > 1e-7 else {
            return identity
        }
        return simd_quatd(angle: angle, axis: turnAxis(down, sight))
    }

    /// Antipodal inputs have no unique axis, so any perpendicular is used.
    private static func turnAxis(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> SIMD3<Double> {
        let axis = cross(a, b)
        if length_squared(axis) < 1e-14 {
            return normalize(abs(a.x) < 0.9 ? cross(a, SIMD3(1, 0, 0)) : cross(a, SIMD3(0, 1, 0)))
        }
        return normalize(axis)
    }

    /// Smootherstep, clamped to [0, 1], as the web app's `easeFlight`: zero rate and
    /// acceleration at both ends, peaking at 1.9 times the mean rate. CesiumJS's
    /// QUINTIC_IN_OUT peaks at 5 times, a whip after a long standstill.
    static func ease(_ t: Double) -> Double {
        let t = min(max(t, 0), 1)
        return t * t * t * (t * (t * 6 - 15) + 10)
    }

    /// No turn.
    private static let identity = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)

    static func attitude(_ pose: CameraPose) -> simd_quatd {
        simd_quatd(simd_double3x3(columns: (pose.right, pose.up, pose.back))).normalized
    }

    private static func mix(_ a: Double, _ b: Double, t: Double) -> Double {
        a + (b - a) * t
    }
}
