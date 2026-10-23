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
    /// Whether it draws a sensor cone.
    var hasCone: Bool

    /// The Earth's rotation, in radians a second.
    static let earthRotationRate = 7.2921158553e-5
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
        self.hasCone = hasCone
    }
}

/// When a frame need not be drawn, as the web app paces CesiumJS's render on
/// demand (src/modules/renderPacing.ts): while nothing drawn can have moved half
/// a device pixel since the last frame. A satellite is held to the nearest its
/// orbit's shell comes to the camera; those that bound the rate most are placed
/// where they are when a frame is drawn, less as far as they can come in
/// `ceiling`. An orbit's line is anywhere on its shell.
enum RenderPacing {
    /// Device pixels anything may move between two frames.
    static let pixels = 0.5
    /// Simulation seconds: the longest a frame stands, for what no bound covers,
    /// such as the Sun's light and the stars turning.
    static let ceiling = 1.0
    /// Metres from a satellite to the far end of its sensor cone
    /// (`coneLength` in Shaders/Footprints.msl).
    static let coneLength = 1e6
    /// How many of the satellites whose shells bound the rate most are taken where
    /// they are; all 16,762 active ones took an iPad mini 15 ms a frame.
    static let placed = 32
    /// Frames a second: past half a pixel in one of these, every frame is drawn
    /// whatever else moves, so nothing more is placed.
    static let fastestDisplay = 120.0

    /// The most device pixels a simulation second that anything drawn of the
    /// satellites in `motions` can cross the view from `camera` within `ceiling`
    /// of the instant `position` places them at; infinite where something could
    /// reach the camera or crosses half a pixel by the next frame anyway. One that
    /// `position` does not place is not drawn. `lines` draws along each orbit, and
    /// `cones` a sensor cone under those that have one.
    static func pixelRate(
        _ motions: [OrbitMotion?], position: (Int) -> SIMD3<Double>?, lines: Bool, cones: Bool, camera: SIMD3<Double>, pixelsPerRadian: Double
    ) -> Double {
        let cameraRadius = length(camera)
        // Radians a second.
        let enough = pixels * fastestDisplay / pixelsPerRadian
        func rate(_ motion: OrbitMotion, distance: Double) -> Double {
            let reach = cones && motion.hasCone ? coneLength : 0
            guard distance > reach, motion.inner > 0 else {
                return .infinity
            }
            // A cone turns with its nadir, at most at the speed over the inner radius.
            return motion.speed * (1 + reach / motion.inner) / (distance - reach)
        }
        func placedRate(_ motion: OrbitMotion, at position: SIMD3<Double>) -> Double {
            rate(motion, distance: simd.distance(position, camera) - motion.speed * ceiling)
        }
        // The highest bound of those held to their shells, and those to place, the
        // lowest bound first.
        var fastest = 0.0
        var toPlace: [(rate: Double, index: Int)] = []
        for (index, motion) in motions.enumerated() {
            guard let motion else {
                continue
            }
            let shell = rate(motion, distance: distanceToShell(cameraRadius, inner: motion.inner, outer: motion.outer))
            if shell >= enough {
                // A line runs anywhere on the shell.
                guard !lines else {
                    return .infinity
                }
                if let position = position(index) {
                    fastest = max(fastest, placedRate(motion, at: position))
                    if fastest >= enough {
                        return .infinity
                    }
                }
            } else if lines || (toPlace.count == placed && shell <= toPlace[0].rate) {
                fastest = max(fastest, shell)
            } else {
                toPlace.insert((shell, index), at: toPlace.firstIndex { $0.rate > shell } ?? toPlace.endIndex)
                if toPlace.count > placed {
                    fastest = max(fastest, toPlace.removeFirst().rate)
                }
            }
        }
        for (shell, index) in toPlace {
            if let motion = motions[index], let position = position(index) {
                fastest = max(fastest, min(shell, placedRate(motion, at: position)))
            }
        }
        return fastest * pixelsPerRadian
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
