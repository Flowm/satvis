import Foundation
import SatvisCore
import simd

/// Whether a frame has to be drawn, or the last one still shows what it would
/// (`RenderPacing`), from what the last one was drawn from.
@MainActor
struct FramePacer {
    /// Something drawn has changed since the last frame, which the next has to
    /// show whatever the pacing.
    var needsDraw = true
    /// What the last frame was drawn from, which the next is skipped against.
    private var drawnFrom: (pose: CameraPose, time: Double, content: Int, pixelRate: Double, links: Range<Double>)?
    /// The uptime of the last call to draw a frame, drawn or skipped.
    private var lastDrawCall = -Double.infinity

    /// Whether a frame has to be drawn, or the last one still shows what this one
    /// would to within `RenderPacing.pixels`: nothing set or loaded since, the same
    /// pose, and no satellite able to have moved that far on the clock since.
    /// Only a `paced` frame is ever skipped. `settled` is whether the surface
    /// would draw the same tiles, and `content` counts what came in for it, the
    /// models and the ground tracks. `pixelRate` and `linkSpan` are worked out
    /// only for a frame drawn.
    mutating func mustDraw(
        pose: CameraPose, time: Double, paced: Bool, settled: Bool, content: Int, pixelRate: () -> Double, linkSpan: () -> Range<Double>
    ) -> Bool {
        let uptime = ProcessInfo.processInfo.systemUptime
        // Calls stop while the app is in the background, which may drop the picture.
        let resumed = uptime - lastDrawCall > 0.5
        lastDrawCall = uptime
        if paced, !needsDraw, !resumed, settled, let drawnFrom, drawnFrom.pose == pose, drawnFrom.content == content,
            RenderPacing.stands(abs(time - drawnFrom.time) / 1000, pixelRate: drawnFrom.pixelRate), drawnFrom.links.contains(time)
        {
            return false
        }
        needsDraw = false
        // Once a frame drawn, not every time the display asks.
        drawnFrom = (pose, time, content, paced ? pixelRate() : .infinity, linkSpan())
        return true
    }

    /// The instants around `time` within which none of `links` starts or ends,
    /// while they are `shown`; a link moves no faster than its satellite, which
    /// the pacing bounds. Worked out once a frame drawn: checked at every vsync,
    /// 2,455 links took a quarter of an iPad mini's main thread.
    static func linkSpan(_ links: [StationLink], shown: Bool, around time: Double) -> Range<Double> {
        guard shown else {
            return -Double.infinity..<Double.infinity
        }
        var (from, to) = (-Double.infinity, Double.infinity)
        for link in links {
            // Drawn up to its end inclusive, it is gone from the next instant on.
            for instant in [link.start, link.end.nextUp] {
                if instant <= time {
                    from = max(from, instant)
                } else {
                    to = min(to, instant)
                }
            }
        }
        return from..<to
    }

    /// The most device pixels a simulation second anything on a frame drawn from
    /// `pose` at `time` can move (`RenderPacing.pixelRate`): each satellite where
    /// it is, or its orbit's lines where their nodes are, and its ground station
    /// links, which move no faster than it does, where they pass nearest.
    static func pixelRate(
        _ points: SatellitePoints, components: SatelliteComponents, links: [StationLink], pose: CameraPose, time: Double, size: SIMD2<Double>
    ) -> Double {
        if let map = pose.mapCamera {
            let lines = components.contains(.orbit) || components.contains(.orbitTrack)
            return RenderPacing.mapPixelRate(
                points.prepared?.motions ?? [], lines: lines, pixelsPerMetre: max(size.x, size.y) / map.span,
                latitude: { points.satellites[$0].trajectory.position(at: time).map { geodeticPosition($0).latitude } })
        }
        let (satellites, motions, camera) = (points.satellites, points.prepared?.motions ?? [], pose.position)
        let (orbit, track) = (components.contains(.orbit), components.contains(.orbitTrack))
        var stations: [String: [SIMD3<Double>]] = [:]
        if components.contains(.groundStationLink) {
            for link in links where link.start <= time && time <= link.end {
                stations[link.satellite, default: []].append(link.station)
            }
        }
        func nearest(_ index: Int) -> (distance: Double, speed: Double)? {
            let trajectory = satellites[index].trajectory
            // A line is drawn while the satellite is.
            guard let position = trajectory.position(at: time), let motion = motions[index] else {
                return nil
            }
            var nearest = (stations[satellites[index].id] ?? []).reduce(distance(position, camera)) { nearest, station in
                let along = position - station
                let t = min(max(dot(camera - station, along) / length_squared(along), 0), 1)
                return min(nearest, distance(station + t * along, camera))
            }
            let start = (trajectory.startMilliseconds - time) / 1000
            for turned in [true, false] where turned ? orbit : track {
                let line = RenderPacing.lineDistance(
                    trajectory.positions, start: start, step: trajectory.stepMilliseconds / 1000, turned: turned, chord: motion.chord, from: camera)
                nearest = min(nearest, line ?? .infinity)
            }
            return (nearest, motion.speed(atRadius: length(position), turning: orbit))
        }
        return RenderPacing.pixelRate(
            motions, nearest: nearest, lines: orbit || track, linked: Set(stations.keys.compactMap(points.index(of:))),
            cones: components.contains(.sensorCone), camera: camera,
            pixelsPerRadian: RenderPacing.pixelsPerRadian(width: size.x, height: size.y, verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: size.x / size.y)))
    }
}
