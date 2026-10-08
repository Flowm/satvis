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
    /// Kilometres from the eye, and above the ellipsoid.
    public let range: Double
    public let altitude: Double
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
    /// How far from the middle of the screen the crosshair takes a satellite, in
    /// points: its reach in degrees falls with the zoom, which is how two
    /// satellites close together are told apart (ADR 0003).
    public static let captureRadius = 60.0

    /// The satellites above the horizon and on screen, as the last frame drew them,
    /// within `radius` points of the middle: only they are judged for visibility.
    public func skyTargets(viewSize: CGSize, within radius: Double = .infinity) -> [SkyTarget] {
        guard isSkySettled, let camera = skyCamera, let lastFrame else {
            return []
        }
        let eye = lastFrame.position
        let (east, north, up) = camera.frame
        let judgement = SkyJudgement(camera: camera, at: lastFrame.time, unseen: unseen)
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        return points.satellites.compactMap { satellite in
            guard let position = satellite.trajectory.position(at: lastFrame.time) else {
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
                id: satellite.id, name: satellite.name, azimuth: azimuth, elevation: elevation, range: range / 1000, altitude: heightAboveEllipsoid(position) / 1000,
                screen: screen, visibility: judgement.visibility(of: position, from: eye))
        }
    }

    /// What the crosshair holds: the satellite nearest the middle of the screen,
    /// within reach, that the ground does not hide, and that is drawn: one hidden
    /// for its visibility is passed over. The ground is asked nearest
    /// first, and only until one is in sight. Worked out fifteen times a second,
    /// not every frame: it places every satellite drawn, which with thousands of
    /// them cost the main thread more than drawing the frame did.
    public func skyLock(viewSize: CGSize) -> SkyTarget? {
        guard isSkySettled else {
            skyCache.lock = nil
            skyCache.lockAt = -.infinity
            return nil
        }
        let now = ProcessInfo.processInfo.systemUptime
        if now - skyCache.lockAt < SkyCache.lockInterval, skyCache.lockSize == viewSize {
            return skyCache.lock
        }
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        let reachable = skyTargets(viewSize: viewSize, within: Self.captureRadius)
            .filter { unseen != .hide || $0.visibility == .visible }
            .map { (target: $0, distance: hypot($0.screen.x - centre.x, $0.screen.y - centre.y)) }
            .sorted { $0.distance < $1.distance }
        let lock = reachable.first { candidate in
            points.position(of: candidate.target.id, at: lastFrame?.time ?? 0).map { !groundHides(candidate.target.id, at: $0) } ?? false
        }?.target
        skyCache.lock = lock
        skyCache.lockAt = now
        skyCache.lockSize = viewSize
        return lock
    }

    /// Where a direction in the sky is drawn, in points; nil behind the camera.
    public func skyPoint(azimuth: Double, elevation: Double, viewSize: CGSize) -> CGPoint? {
        guard let camera = skyCamera, let lastFrame else {
            return nil
        }
        let (east, north, up) = camera.frame
        let a = azimuth * .pi / 180
        let e = elevation * .pi / 180
        let direction = cos(e) * (sin(a) * east + cos(a) * north) + sin(e) * up
        return screenPoint(lastFrame.position + 1e7 * direction, viewSize: viewSize)
    }

    /// A satellite's path across the sky from four minutes back to eight ahead,
    /// every 30 s, in the runs that are above the horizon and not behind the
    /// ground (useSkyHud.ts). On a 30 s grid of the clock, so that where it runs
    /// and what hides it is worked out once a step rather than every frame, and
    /// only placed on the screen anew as the view turns.
    public func skyTrace(of id: String, viewSize: CGSize) -> [[CGPoint]] {
        guard let camera = skyCamera, let lastFrame else {
            return []
        }
        let step = 30_000.0
        let grid = (lastFrame.time / step).rounded(.down) * step
        let key = SkyCache.TraceKey(id: id, grid: grid, eye: lastFrame.position, terrain: surface.terrainRevision)
        if skyCache.trace?.key != key {
            let up = camera.frame.up
            let samples = (-8...16).map { index -> SIMD3<Double>? in
                guard let position = points.position(of: id, at: grid + Double(index) * step), dot(position - lastFrame.position, up) > 0,
                    !groundHides(position)
                else {
                    return nil
                }
                return position
            }
            skyCache.trace = (key, samples)
        }
        var runs: [[CGPoint]] = [[]]
        for sample in skyCache.trace?.samples ?? [] {
            guard let sample, let screen = screenPoint(sample, viewSize: viewSize) else {
                if !(runs.last?.isEmpty ?? true) {
                    runs.append([])
                }
                continue
            }
            runs[runs.count - 1].append(screen)
        }
        return runs.filter { $0.count > 1 }
    }

    /// `groundHides`, kept for a satellite until the eye moves, the clock moves
    /// on a second or more terrain comes in.
    private func groundHides(_ id: String, at position: SIMD3<Double>) -> Bool {
        guard let lastFrame else {
            return groundHides(position)
        }
        let key = SkyCache.HiddenKey(eye: lastFrame.position, second: (lastFrame.time / 1000).rounded(.down), terrain: surface.terrainRevision)
        if skyCache.hiddenKey != key {
            skyCache.hiddenKey = key
            skyCache.hidden = [:]
        }
        if let known = skyCache.hidden[id] {
            return known
        }
        let hidden = groundHides(position)
        skyCache.hidden[id] = hidden
        return hidden
    }

    /// Whether the terrain stands between the eye and a point: the line of sight
    /// is walked out, in steps growing with the distance, until it is higher than
    /// any mountain.
    func groundHides(_ position: SIMD3<Double>) -> Bool {
        guard let lastFrame else {
            return false
        }
        let eye = lastFrame.position
        let range = simd.distance(position, eye)
        let direction = (position - eye) / range
        var distance = 5.0
        while distance < range {
            let point = eye + distance * direction
            let height = heightAboveEllipsoid(point)
            if height > 9_000 {
                return false
            }
            let place = geodetic(point)
            if height < surface.groundHeight(latitude: place.latitude, longitude: place.longitude) ?? 0 {
                return true
            }
            distance += max(10, distance * 0.01)
        }
        return false
    }

    /// Where the last frame drew a point, in points; nil behind the camera.
    private func screenPoint(_ position: SIMD3<Double>, viewSize: CGSize) -> CGPoint? {
        guard let lastFrame else {
            return nil
        }
        let clip = lastFrame.viewProjection * SIMD4(position - lastFrame.position, 1)
        guard clip.w > 0 else {
            return nil
        }
        return CGPoint(x: (clip.x / clip.w + 1) / 2 * viewSize.width, y: (1 - clip.y / clip.w) / 2 * viewSize.height)
    }
}

/// Metres above the WGS84 ellipsoid along the radius, near enough for a horizon.
func heightAboveEllipsoid(_ p: SIMD3<Double>) -> Double {
    let ellipsoid = 1 / sqrt((p.x * p.x + p.y * p.y) / (ellipsoidRadii.x * ellipsoidRadii.x) + p.z * p.z / (ellipsoidRadii.z * ellipsoidRadii.z))
    return length(p) * (1 - ellipsoid)
}

/// What the sky view's instruments worked out, kept between frames
/// (`GlobeRenderer.skyCache`).
struct SkyCache {
    /// How often the lock is worked out again.
    static let lockInterval = 1.0 / 15

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
}
