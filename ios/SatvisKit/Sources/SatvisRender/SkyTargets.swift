import CoreGraphics
import Foundation
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
}

extension GlobeRenderer {
    /// How far from the middle of the screen the crosshair takes a satellite, in
    /// points: its reach in degrees falls with the zoom, which is how two
    /// satellites close together are told apart (ADR 0003).
    public static let captureRadius = 60.0

    /// The satellites above the horizon and on screen, as the last frame drew them.
    public func skyTargets(viewSize: CGSize) -> [SkyTarget] {
        guard isSkySettled, let camera = skyCamera, let lastFrame else {
            return []
        }
        let eye = lastFrame.position
        let (east, north, up) = camera.frame
        return points.satellites.compactMap { satellite in
            guard let position = satellite.trajectory.position(at: lastFrame.time) else {
                return nil
            }
            let local = position - eye
            let range = length(local)
            let elevation = asin(dot(local, up) / range) * 180 / .pi
            guard elevation > 0, let screen = screenPoint(position, viewSize: viewSize),
                (0...viewSize.width).contains(screen.x), (0...viewSize.height).contains(screen.y)
            else {
                return nil
            }
            var azimuth = atan2(dot(local, east), dot(local, north)) * 180 / .pi
            if azimuth < 0 {
                azimuth += 360
            }
            return SkyTarget(
                id: satellite.id, name: satellite.name, azimuth: azimuth, elevation: elevation, range: range / 1000, altitude: heightAboveEllipsoid(position) / 1000,
                screen: screen)
        }
    }

    /// What the crosshair holds: the satellite nearest the middle of the screen,
    /// within reach, that the ground does not hide. The ground is asked nearest
    /// first, and only until one is in sight.
    public func skyLock(viewSize: CGSize) -> SkyTarget? {
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        let reachable = skyTargets(viewSize: viewSize)
            .map { (target: $0, distance: hypot($0.screen.x - centre.x, $0.screen.y - centre.y)) }
            .filter { $0.distance <= Self.captureRadius }
            .sorted { $0.distance < $1.distance }
        return reachable.first { candidate in
            points.satellites.first { $0.id == candidate.target.id }?.trajectory.position(at: lastFrame?.time ?? 0).map { !groundHides($0) } ?? false
        }?.target
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
    /// ground (useSkyHud.ts).
    public func skyTrace(of id: String, viewSize: CGSize) -> [[CGPoint]] {
        guard let camera = skyCamera, let lastFrame, let satellite = points.satellites.first(where: { $0.id == id }) else {
            return []
        }
        let up = camera.frame.up
        var runs: [[CGPoint]] = [[]]
        for step in -8...16 {
            guard let position = satellite.trajectory.position(at: lastFrame.time + Double(step) * 30_000),
                dot(position - lastFrame.position, up) > 0, !groundHides(position), let screen = screenPoint(position, viewSize: viewSize)
            else {
                if !(runs.last?.isEmpty ?? true) {
                    runs.append([])
                }
                continue
            }
            runs[runs.count - 1].append(screen)
        }
        return runs.filter { $0.count > 1 }
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
