import simd

/// How far from the Earth's centre a satellite runs, and how fast it, or anything
/// drawn along its orbit, can move in the fixed frame: what bounds how fast it
/// crosses the view (`RenderPacing`).
struct OrbitMotion: Equatable {
    /// Metres from the Earth's centre to the lowest sample, less `shellMargin`.
    var inner: Double
    /// Metres from the Earth's centre to the highest sample, and `shellMargin`.
    var outer: Double
    /// Metres a second.
    var speed: Double
    /// Metres between the farthest two neighbouring samples.
    var chord: Double
    /// Whether it draws a sensor cone.
    var hasCone: Bool

    /// The Earth's rotation, in radians a second.
    static let earthRotationRate = 7.2921158553e-5
    /// The Earth's gravitational parameter, in m³/s².
    static let gravitationalParameter = 3.986004418e14
    /// Metres the interpolation may run outside the samples' radii.
    static let shellMargin = 50_000.0

    /// From its samples' radii and the farthest two neighbouring samples lie apart,
    /// `step` seconds: the satellite's own speed, and the Earth's rotation at the
    /// outer radius, at which an orbit's line, held still in inertial space,
    /// turns in the fixed frame. A tenth on top, as the web app adds for SGP4's
    /// perturbations. Nil for a satellite with no sample, which is not drawn.
    init?(lowest: Double, highest: Double, farthestStep: Double, step: Double, hasCone: Bool) {
        guard lowest.isFinite, highest.isFinite, farthestStep.isFinite, step > 0 else {
            return nil
        }
        inner = max(0, lowest - Self.shellMargin)
        outer = highest + Self.shellMargin
        speed = 1.1 * (farthestStep / step + Self.earthRotationRate * outer)
        chord = farthestStep
        self.hasCone = hasCone
    }

    /// Metres a second at most `radius` from the Earth's centre: vis-viva on the
    /// samples' semi-major axis and the Earth's rotation, a tenth on top; with
    /// `turning`, at least an orbit's line's. Never more than `speed`, which far
    /// from perigee an eccentric orbit is well under.
    func speed(atRadius radius: Double, turning: Bool) -> Double {
        let r = max(radius - Self.shellMargin, inner, 1)
        let inertial = (Self.gravitationalParameter * max(2 / r - 2 / (inner + outer), 0)).squareRoot()
        var bound = 1.1 * (inertial + Self.earthRotationRate * radius)
        if turning {
            bound = max(bound, 1.1 * Self.earthRotationRate * outer)
        }
        return min(bound, speed)
    }

    /// The shell widened to what else the satellite draws: an orbit's line, inside
    /// its samples by half a chord and off them by `RenderPacing.lineDrift`, and a
    /// ground station link, down to the ground.
    func shell(lines: Bool, linked: Bool) -> (inner: Double, outer: Double) {
        var (inner, outer) = (self.inner, self.outer)
        if lines {
            inner -= chord / 2 + RenderPacing.lineDrift
            outer += RenderPacing.lineDrift
        }
        if linked {
            inner = min(inner, RenderPacing.lowestGround)
        }
        return (max(0, inner), outer)
    }
}

/// When a frame need not be drawn, as the web app paces CesiumJS's render on
/// demand (src/modules/renderPacing.ts): while nothing drawn can have moved half
/// a device pixel since the last frame. A satellite is held to the nearest its
/// shell (`OrbitMotion.shell`) comes to the camera; those that bound the rate most
/// are taken where they draw when a frame is drawn, less as far as they can come
/// in `ceiling`.
enum RenderPacing {
    /// Device pixels anything may move between two frames.
    static let pixels = 0.5
    /// Simulation seconds: the longest a frame stands, for what no bound covers,
    /// such as the Sun's light and the stars turning.
    static let ceiling = 1.0
    /// Metres from a satellite to the far end of its sensor cone
    /// (`coneLength` in Shaders/Footprints.msl).
    static let coneLength = 1e6
    /// Metres an orbit's line may lie off its samples, for the drift ramped in to
    /// close the loop (Shaders/Lines.msl): 31 km for the ISS.
    static let lineDrift = 100_000.0
    /// Metres from the Earth's centre, under the lowest ground a link ends on.
    static let lowestGround = 6_340_000.0
    /// How many of the satellites whose shells bound the rate most are taken where
    /// they are; all 16,762 active ones took an iPad mini 15 ms a frame.
    static let placed = 32
    /// Frames a second: past half a pixel in one of these, every frame is drawn
    /// whatever else moves, so nothing more is placed.
    static let fastestDisplay = 120.0

    /// The most device pixels a simulation second that anything drawn of the
    /// satellites in `motions` can cross the view from `camera` within `ceiling`
    /// of the instant `nearest` is asked for: the metres from the camera to the
    /// nearest of what a satellite draws then, and the most metres a second that
    /// moves; nil where it draws nothing.
    /// Infinite where something could reach the camera, or crosses half a pixel by
    /// the next frame anyway. `lines` draws each orbit's line, `linked` holds the
    /// satellites with a ground station link, and `cones` draws a sensor cone under
    /// those that have one.
    static func pixelRate(
        _ motions: [OrbitMotion?], nearest: (Int) -> (distance: Double, speed: Double)?, lines: Bool, linked: Set<Int>, cones: Bool, camera: SIMD3<Double>,
        pixelsPerRadian: Double
    ) -> Double {
        let cameraRadius = length(camera)
        // Radians a second.
        let enough = pixels * fastestDisplay / pixelsPerRadian
        func rate(_ motion: OrbitMotion, distance: Double, speed: Double? = nil) -> Double {
            let reach = cones && motion.hasCone ? coneLength : 0
            guard distance > reach, motion.inner > 0 else {
                return .infinity
            }
            // A cone turns with its nadir, at most at the speed over the inner radius.
            return (speed ?? motion.speed) * (1 + reach / motion.inner) / (distance - reach)
        }
        func placedRate(_ index: Int, _ motion: OrbitMotion) -> Double? {
            nearest(index).map { rate(motion, distance: $0.distance - $0.speed * ceiling, speed: $0.speed) }
        }
        // The highest bound of those held to their shells, and those to place, the
        // lowest bound first.
        var fastest = 0.0
        var toPlace: [(rate: Double, index: Int)] = []
        for (index, motion) in motions.enumerated() {
            guard let motion else {
                continue
            }
            let (inner, outer) = motion.shell(lines: lines, linked: linked.contains(index))
            let shell = rate(motion, distance: distanceToShell(cameraRadius, inner: inner, outer: outer))
            if shell >= enough {
                fastest = max(fastest, placedRate(index, motion) ?? 0)
                if fastest >= enough {
                    return .infinity
                }
            } else if toPlace.count == placed && shell <= toPlace[0].rate {
                fastest = max(fastest, shell)
            } else {
                toPlace.insert((shell, index), at: toPlace.firstIndex { $0.rate > shell } ?? toPlace.endIndex)
                if toPlace.count > placed {
                    fastest = max(fastest, toPlace.removeFirst().rate)
                }
            }
        }
        for (shell, index) in toPlace {
            if let motion = motions[index], let atPlace = placedRate(index, motion) {
                fastest = max(fastest, min(shell, atPlace))
            }
        }
        return fastest * pixelsPerRadian
    }

    /// The nearest an orbit's line through `samples` comes to `camera`, now: the
    /// first sample `start` seconds from now, the rest `step` apart. An orbit
    /// (`turned`) is held still in inertial space, each sample turned with the
    /// Earth to now as Shaders/Lines.msl turns it; an orbit track is not. Less half
    /// the longest `chord` between two samples, for the line between them, and
    /// `lineDrift`. Nil without a sample.
    static func lineDistance(
        _ samples: some Sequence<SIMD3<Double>>, start: Double, step: Double, turned: Bool, chord: Double, from camera: SIMD3<Double>
    ) -> Double? {
        var nearest = Double.infinity
        // The turn to now, sample by sample, as a unit complex number.
        let first = turned ? OrbitMotion.earthRotationRate * start : 0
        let increment = turned ? OrbitMotion.earthRotationRate * step : 0
        var turn = SIMD2(cos(first), sin(first))
        let stepTurn = SIMD2(cos(increment), sin(increment))
        for sample in samples {
            let node = SIMD3(turn.x * sample.x - turn.y * sample.y, turn.y * sample.x + turn.x * sample.y, sample.z)
            // NaN, where SGP4 refused the node, is passed over by `min`.
            nearest = min(nearest, distance(node, camera))
            turn = SIMD2(turn.x * stepTurn.x - turn.y * stepTurn.y, turn.y * stepTurn.x + turn.x * stepTurn.y)
        }
        return nearest.isFinite ? max(0, nearest - chord / 2 - lineDrift) : nil
    }

    /// Whether a frame drawn `elapsed` simulation seconds ago, while nothing on it
    /// moves faster than `pixelRate` device pixels a simulation second, still stands.
    static func stands(_ elapsed: Double, pixelRate: Double) -> Bool {
        elapsed < ceiling && elapsed * pixelRate <= pixels
    }

    /// Metres from a point `radius` from the centre to the shell between `inner`
    /// and `outer`.
    static func distanceToShell(_ radius: Double, inner: Double, outer: Double) -> Double {
        max(0, inner - radius, radius - outer)
    }

    /// The most device pixels per radian anywhere in a perspective view, at its
    /// corners: f(1 + tan²θ).
    static func pixelsPerRadian(width: Double, height: Double, verticalFieldOfView: Double) -> Double {
        let focal = height / 2 / tan(verticalFieldOfView / 2)
        let corner = (width * width + height * height).squareRoot() / 2 / focal
        return focal * (1 + corner * corner)
    }
}
