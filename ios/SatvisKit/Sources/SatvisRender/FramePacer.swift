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
    /// `pose` at `time` can move (`RenderPacing.pixelRate`): each satellite and its
    /// ground station links, which move no faster than it does, where they pass
    /// nearest, and its orbit's lines where their nodes are, an orbit's at the
    /// Earth's turn there.
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
        /// Metres from the camera to the nearest of the segment from `a` to `b`.
        func nearest(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double {
            let along = b - a
            let t = min(max(dot(camera - a, along) / length_squared(along), 0), 1)
            return distance(a + t * along, camera)
        }
        func nearest(_ index: Int) -> [(distance: Double, speed: Double)] {
            let trajectory = satellites[index].trajectory
            // A line is drawn while the satellite is.
            guard let position = trajectory.position(at: time), let motion = motions[index] else {
                return []
            }
            let own = motion.speed(atRadius: length(position))
            let near = (stations[satellites[index].id] ?? []).reduce(distance(position, camera)) { min($0, nearest($1, position)) }
            var parts = [(near, own)]
            let (start, step) = ((trajectory.startMilliseconds - time) / 1000, trajectory.stepMilliseconds / 1000)
            for turned in [true, false] where turned ? orbit : track {
                guard let line = RenderPacing.lineDistance(trajectory.positions, start: start, step: step, turned: turned, chord: motion.chord, from: camera)
                else {
                    continue
                }
                // An orbit turns with the Earth, no further out than the camera and the
                // line's distance from it; an orbit track grows a period ahead, anywhere
                // along it, at the satellite's speed.
                parts.append(turned ? (line, motion.turningSpeed(within: length(camera) + line)) : (line, own))
                // The two segments from the satellite to its nodes either side move with it.
                let node = Int((-start / step).rounded(.down))
                let sides = [node, node + 1].filter(trajectory.positions.indices.contains).map { node in
                    let sample = trajectory.positions[node]
                    let angle = turned ? OrbitMotion.earthRotationRate * (start + Double(node) * step) : 0
                    return SIMD3(cos(angle) * sample.x - sin(angle) * sample.y, sin(angle) * sample.x + cos(angle) * sample.y, sample.z)
                }
                if let segments = sides.map({ nearest($0, position) }).min() {
                    parts.append((segments, sides.reduce(own) { max($0, turned ? motion.turningSpeed(within: length($1)) : 0) }))
                }
            }
            return parts
        }
        return RenderPacing.pixelRate(
            motions, nearest: nearest, lines: orbit || track, linked: Set(stations.keys.compactMap(points.index(of:))),
            cones: components.contains(.sensorCone), camera: camera,
            pixelsPerRadian: RenderPacing.pixelsPerRadian(width: size.x, height: size.y, verticalFieldOfView: pose.verticalFieldOfView(aspectRatio: size.x / size.y)))
    }
}
