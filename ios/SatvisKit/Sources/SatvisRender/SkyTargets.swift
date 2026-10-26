import CoreGraphics
import Foundation
import SatvisCore
import simd

/// A satellite as the sky view sees it from the eye (src/modules/SkyTargets.ts).
public struct SkyTarget: Sendable, Equatable {
    public let id: String
    public let name: String
    /// Degrees clockwise from north, and above the horizon.
    public let azimuth: Double
    public let elevation: Double
    /// Kilometres from the eye.
    public let range: Double
    /// Where it is drawn, in points.
    public let screen: CGPoint
    /// Whether it could be seen by eye, now, from the observer.
    public let visibility: Visibility
}

/// The sky at the observer at one instant: what judges whether each satellite
/// could be seen (ADR 0010).
struct SkyJudgement {
    /// A unit vector toward the sun, Earth-fixed.
    let sun: SIMD3<Double>
    /// Degrees above the observer's horizon.
    let sunElevation: Double
    let unseen: UnseenMode

    init(camera: SkyCamera, at epochMilliseconds: Double, unseen: UnseenMode) {
        sun = Sun.directionFixed(epochMilliseconds: epochMilliseconds)
        sunElevation = asin(min(max(dot(sun, camera.frame.up), -1), 1)) * 180 / .pi
        self.unseen = unseen
    }

    func visibility(of position: SIMD3<Double>, from eye: SIMD3<Double>) -> Visibility {
        Visibility(sunElevation: sunElevation, sunlit: !Visibility.inEarthShadow(position, sun: sun), range: distance(position, eye) / 1000)
    }

    func opacity(of position: SIMD3<Double>, from eye: SIMD3<Double>) -> Double {
        unseen.opacity(visibility(of: position, from: eye))
    }

    /// The shader's share of the verdict (`skyOpacity` in Shaders/Points.msl):
    /// the opacity of a satellite that cannot be seen, and whether the sky is
    /// dark enough to tell them apart.
    var uniforms: (unseenOpacity: Float, skyIsDark: Float) {
        let dark = sunElevation <= Visibility.darkSkySunElevation
        return (Float(unseen.opacity(dark ? .shadow : .daylight)), dark ? 1 : 0)
    }
}

extension GlobeRenderer {
    /// The satellites above the horizon and on screen, as the last frame drew them,
    /// within `radius` points of the middle: only they are judged for visibility.
    public func skyTargets(viewSize: CGSize, within radius: Double = .infinity) -> [SkyTarget] {
        guard isSkySettled, let camera = skyCamera, let lastFrame else {
            return []
        }
        return skyCache.targets(
            in: lastFrame, camera: camera, unseen: unseen, satellites: points.installed, viewSize: viewSize, within: radius,
            uptime: ProcessInfo.processInfo.systemUptime)
    }

    /// What the crosshair holds (`SkyCache.lock`); nil until the sky view has
    /// landed.
    public func skyLock(viewSize: CGSize) -> SkyTarget? {
        guard isSkySettled, let camera = skyCamera, let lastFrame else {
            skyCache.lock = nil
            skyCache.lockAt = -.infinity
            return nil
        }
        return skyCache.lock(
            in: lastFrame, camera: camera, unseen: unseen, satellites: points.installed, viewSize: viewSize, uptime: ProcessInfo.processInfo.systemUptime,
            terrain: surface.terrainRevision, groundHeight: { self.surface.groundHeight(latitude: $0.latitude, longitude: $0.longitude) })
    }

    /// Where a direction in the sky is drawn, in points; nil behind the camera.
    public func skyPoint(azimuth: Double, elevation: Double, viewSize: CGSize) -> CGPoint? {
        guard let camera = skyCamera, let lastFrame else {
            return nil
        }
        return lastFrame.skyPoint(azimuth: azimuth, elevation: elevation, camera: camera, viewSize: viewSize)
    }

    /// A satellite's path across the sky (`SkyCache.trace`).
    public func skyTrace(of id: String, viewSize: CGSize) -> [[CGPoint]] {
        guard let camera = skyCamera, let lastFrame else {
            return []
        }
        return skyCache.trace(
            of: id, in: lastFrame, camera: camera, satellites: points.installed, viewSize: viewSize, terrain: surface.terrainRevision,
            groundHeight: { self.surface.groundHeight(latitude: $0.latitude, longitude: $0.longitude) })
    }
}

extension DrawnFrame {
    /// The satellites above the horizon of `camera`'s observer and on screen,
    /// within `radius` points of the middle. `directions`, where given, are each
    /// satellite's kept direction from the eye (`SkyCache.directions`): only those
    /// near where `camera` looks are placed.
    func skyTargets(
        viewSize: CGSize, within radius: Double, camera: SkyCamera, unseen: UnseenMode, satellites: some DrawnSatellites, directions: [SIMD3<Float>?]?
    ) -> [SkyTarget] {
        let (east, north, up) = camera.frame
        let judgement = SkyJudgement(camera: camera, at: time, unseen: unseen)
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        func target(_ index: Int) -> SkyTarget? {
            guard let position = satellites.position(at: index, time: time) else {
                return nil
            }
            let local = position - eye
            let range = length(local)
            let elevation = asin(dot(local, up) / range) * 180 / .pi
            guard elevation > 0, let screen = screenPoint(position, viewSize: viewSize),
                (0...viewSize.width).contains(screen.x), (0...viewSize.height).contains(screen.y),
                hypot(screen.x - centre.x, screen.y - centre.y) <= radius
            else {
                return nil
            }
            var azimuth = atan2(dot(local, east), dot(local, north)) * 180 / .pi
            if azimuth < 0 {
                azimuth += 360
            }
            return SkyTarget(
                id: satellites.id(at: index), name: satellites.name(at: index), azimuth: azimuth, elevation: elevation, range: range / 1000,
                screen: screen, visibility: judgement.visibility(of: position, from: eye))
        }
        if radius.isFinite, let directions {
            // Where the camera looks now, not where it looked for this frame: the
            // compass may have turned it since, which `SkyCache.directionsMargin`
            // covers.
            let look = camera.look
            let angle = SkyCache.angle(ofRadius: radius, height: Double(viewSize.height), verticalFieldOfView: camera.verticalFieldOfView)
            return SkyCache.indices(of: directions, within: angle, of: look.x * east + look.y * north + look.z * up).compactMap(target)
        }
        return (0..<satellites.count).compactMap(target)
    }

    /// Where a direction in `camera`'s sky is drawn, in points; nil behind the
    /// camera.
    func skyPoint(azimuth: Double, elevation: Double, camera: SkyCamera, viewSize: CGSize) -> CGPoint? {
        let (east, north, up) = camera.frame
        let a = azimuth * .pi / 180
        let e = elevation * .pi / 180
        let direction = cos(e) * (sin(a) * east + cos(a) * north) + sin(e) * up
        return screenPoint(eye + 1e7 * direction, viewSize: viewSize)
    }
}

/// What the sky view's instruments worked out, kept between frames
/// (`GlobeRenderer.skyCache`).
struct SkyCache {
    /// How often the lock is worked out again.
    static let lockInterval = 1.0 / 15
    /// How far from the middle of the screen the crosshair takes a satellite, in
    /// points: its reach in degrees falls with the zoom, which is how two
    /// satellites close together are told apart (ADR 0003).
    static let captureRadius = 60.0

    var lock: SkyTarget?
    var lockAt = -Double.infinity
    var lockSize = CGSize.zero

    struct HiddenKey: Equatable {
        var eye: SIMD3<Double>
        var second: Double
        var terrain: Int
    }
    var hiddenKey: HiddenKey?
    var hidden: [String: Bool] = [:]

    struct TraceKey: Equatable {
        var id: String
        var grid: Double
        var eye: SIMD3<Double>
        var terrain: Int
    }
    /// The locked satellite's path, where it is in sight, on the grid.
    var trace: (key: TraceKey, samples: [SIMD3<Double>?])?

    /// How long, in milliseconds of the clock's time, each satellite's direction
    /// is kept for the lock.
    static let directionsInterval = 1000.0
    /// How far a kept direction may have drifted, in radians: 5°, where a
    /// satellite in a retrograde orbit 110 km straight up crosses 4.3° in that
    /// second, and the rest covers the aim turning between the lock and the frame
    /// it reads. Anything lower is coming down.
    static let directionsMargin = 5 * Double.pi / 180
    /// Metres the eye may settle onto finer terrain before the directions are
    /// worked out again: 100 m turns a satellite at 400 km by a hundredth of a
    /// degree.
    static let directionsEyeTolerance = 100.0
    /// Each satellite's direction from the eye, what it was worked out for, and
    /// when, in seconds of uptime.
    var directions: (generation: Int, time: Double, eye: SIMD3<Double>, workedOutAt: Double, list: [SIMD3<Float>?])?
}

extension SkyCache {
    /// The angle out from the middle of a view `height` points tall to `radius`
    /// points from it, in radians.
    static func angle(ofRadius radius: Double, height: Double, verticalFieldOfView: Double) -> Double {
        atan(radius * tan(verticalFieldOfView / 2) / (height / 2))
    }

    /// The satellites whose direction lies within `angle`, and the margin a
    /// direction kept for `directionsInterval` may have drifted by, of `look`.
    static func indices(of directions: [SIMD3<Float>?], within angle: Double, of look: SIMD3<Double>) -> [Int] {
        let threshold = Float(cos(min(angle + directionsMargin, .pi)))
        let look = SIMD3<Float>(normalize(look))
        return directions.indices.filter { directions[$0].map { dot($0, look) >= threshold } ?? false }
    }

    /// The satellites `frame` drew within `radius` points of the middle, found by
    /// the directions kept for the lock where the radius is finite.
    mutating func targets(
        in frame: DrawnFrame, camera: SkyCamera, unseen: UnseenMode, satellites: some DrawnSatellites, viewSize: CGSize, within radius: Double, uptime: Double
    ) -> [SkyTarget] {
        let directions = radius.isFinite ? directions(of: satellites, at: frame.time, from: frame.eye, uptime: uptime) : nil
        return frame.skyTargets(viewSize: viewSize, within: radius, camera: camera, unseen: unseen, satellites: satellites, directions: directions)
    }

    /// Each satellite's direction from `eye`, kept for up to a second of the
    /// clock's time: placing every one each time cost the lock 8.6 ms on an iPad
    /// mini with every active satellite, at each of its 15 a second. A direction is
    /// nil where the satellite has no position. Nil for all of them while the clock
    /// runs so fast that a second of its time passes before the next lock: kept,
    /// they would be worked out again every time, on top of the search. `uptime`
    /// is in seconds.
    mutating func directions(of satellites: some DrawnSatellites, at time: Double, from eye: SIMD3<Double>, uptime: Double) -> [SIMD3<Float>?]? {
        if let kept = directions, kept.generation == satellites.generation, distance(kept.eye, eye) < Self.directionsEyeTolerance {
            if abs(time - kept.time) <= Self.directionsInterval {
                return kept.list
            }
            if uptime - kept.workedOutAt < 1 {
                return nil
            }
        }
        let list = (0..<satellites.count).map { index in satellites.position(at: index, time: time).map { SIMD3<Float>(normalize($0 - eye)) } }
        directions = (satellites.generation, time, eye, uptime, list)
        return list
    }

    /// What the crosshair holds: the satellite nearest the middle of the screen,
    /// within reach, that the ground does not hide, and that is drawn: one hidden
    /// for its visibility is passed over. The ground is asked nearest
    /// first, and only until one is in sight. Worked out again only after
    /// `lockInterval` of `uptime` or on a new view size, and only for the
    /// satellites whose kept direction is near the crosshair (`directions`):
    /// placing every one each time cost the main thread more than drawing the
    /// frame did.
    mutating func lock(
        in frame: DrawnFrame, camera: SkyCamera, unseen: UnseenMode, satellites: some DrawnSatellites, viewSize: CGSize, uptime: Double, terrain: Int,
        groundHeight: (GeoCoordinate) -> Double?
    ) -> SkyTarget? {
        if uptime - lockAt < Self.lockInterval, lockSize == viewSize {
            return lock
        }
        var found: SkyTarget?
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        let reachable = targets(
            in: frame, camera: camera, unseen: unseen, satellites: satellites, viewSize: viewSize, within: Self.captureRadius, uptime: uptime
        )
        .filter { unseen != .hide || $0.visibility == .visible }
        .map { (target: $0, distance: hypot($0.screen.x - centre.x, $0.screen.y - centre.y)) }
        .sorted { $0.distance < $1.distance }
        for candidate in reachable {
            guard let index = satellites.index(of: candidate.target.id), let position = satellites.position(at: index, time: frame.time) else {
                continue
            }
            if !groundHides(candidate.target.id, at: position, in: frame, terrain: terrain, groundHeight: groundHeight) {
                found = candidate.target
                break
            }
        }
        lock = found
        lockAt = uptime
        lockSize = viewSize
        return found
    }

    /// A satellite's path across the sky from four minutes back to eight ahead,
    /// every 30 s, in the runs that are above the horizon and not behind the
    /// ground (useSkyHud.ts). On a 30 s grid of the clock, so that where it runs
    /// and what hides it is worked out once a step rather than every frame, and
    /// only placed on the screen anew as the view turns.
    mutating func trace(
        of id: String, in frame: DrawnFrame, camera: SkyCamera, satellites: some DrawnSatellites, viewSize: CGSize, terrain: Int,
        groundHeight: (GeoCoordinate) -> Double?
    ) -> [[CGPoint]] {
        let step = 30_000.0
        let grid = (frame.time / step).rounded(.down) * step
        let key = TraceKey(id: id, grid: grid, eye: frame.eye, terrain: terrain)
        if trace?.key != key {
            let up = camera.frame.up
            let index = satellites.index(of: id)
            let samples = (-8...16).map { offset -> SIMD3<Double>? in
                guard let index, let position = satellites.position(at: index, time: grid + Double(offset) * step), dot(position - frame.eye, up) > 0,
                    !frame.groundHides(position, groundHeight: groundHeight)
                else {
                    return nil
                }
                return position
            }
            trace = (key, samples)
        }
        var runs: [[CGPoint]] = [[]]
        for sample in trace?.samples ?? [] {
            guard let sample, let screen = frame.screenPoint(sample, viewSize: viewSize) else {
                if !(runs.last?.isEmpty ?? true) {
                    runs.append([])
                }
                continue
            }
            runs[runs.count - 1].append(screen)
        }
        return runs.filter { $0.count > 1 }
    }

    /// `DrawnFrame.groundHides`, kept for a satellite until the eye moves, the
    /// clock moves on a second or more terrain comes in.
    mutating func groundHides(
        _ id: String, at position: SIMD3<Double>, in frame: DrawnFrame, terrain: Int, groundHeight: (GeoCoordinate) -> Double?
    ) -> Bool {
        let key = HiddenKey(eye: frame.eye, second: (frame.time / 1000).rounded(.down), terrain: terrain)
        if hiddenKey != key {
            hiddenKey = key
            hidden = [:]
        }
        if let known = hidden[id] {
            return known
        }
        let isHidden = frame.groundHides(position, groundHeight: groundHeight)
        hidden[id] = isHidden
        return isHidden
    }
}
