import Foundation
import Observation
import SatvisCore

/// How a replay's camera watches the overpass (ADR 0023): tracking the satellite chases its swath.
enum ReplayCamera: String, CaseIterable, Identifiable {
    case nadir, tracking, broadcast

    var id: Self { self }

    var label: String {
        switch self {
        case .nadir: "Nadir"
        case .tracking: "Tracking"
        case .broadcast: "Broadcast"
        }
    }

    /// What it does, as the replay bar's tooltip says it.
    var title: String {
        switch self {
        case .nadir: "Straight down on the station, north up"
        case .tracking: "Tracking the satellite from behind, over the swath it records"
        case .broadcast: "From beyond the station, turning with the satellite"
        }
    }

    var symbol: String {
        switch self {
        case .nadir: "scope"
        case .tracking: "satellite"
        case .broadcast: "video"
        }
    }
}

/// Overpass replay (ADR 0023): the satellite on, its granule layer on, the station in the
/// link, and the clock and camera as a plan says, so a replay is a link. It lasts while its
/// layer is on, wherever the layer is taken off. The web app's `useOverpassReplay`.
@MainActor
@Observable
final class OverpassReplayModel {
    /// A granule layer on the globe, and the satellite and instrument whose it is.
    struct LayerOn: Equatable {
        var layer: SatelliteDetails.GranuleLayer
        var satellite: String
        var instrument: String
    }

    /// A replay over a station, and the overpasses its bar steps through.
    struct Active {
        var on: LayerOn
        var station: String
        var point: GroundPoint
        /// By start: the recorded overpasses by day of the Passes table the replay was
        /// started from, or, opened from a link, its layer's over its station.
        var steps: [RecordedOverpass]
    }

    /// The station the replay is over, by its label, as a link carries it as `replay`;
    /// empty with none on.
    var station = ""
    /// A station whose newest overpass imaged by day the globe menu asked to replay: its
    /// panel replays it once its Passes table has listed what it records.
    var latestRequest: UUID?
    /// How the camera watches this replay and any after.
    private(set) var camera = ReplayCamera.nadir
    /// The steps a replay was started with from a Passes table.
    private var steps: [RecordedOverpass]?
    /// A layer's overpasses by day over a station, as fetched for a replay opened from a link.
    private var listed: (key: String, steps: [RecordedOverpass])?
    @ObservationIgnored private var asking: Task<Void, Never>?
    @ObservationIgnored private unowned let session: Session

    init(session: Session) {
        self.session = session
    }

    /// The newest granule layer on that is a satellite's own.
    var layerOn: LayerOn? {
        session.instrumentImagery.granuleLayers.reversed().lazy.compactMap { drawn in
            drawn.satellite.flatMap { satellite in drawn.instrument.map { LayerOn(layer: drawn.layer, satellite: satellite, instrument: $0) } }
        }.first
    }

    private var point: GroundPoint? {
        session.passes.stations.first { $0.displayName == station }.map { GroundPoint(latitude: $0.latitude, longitude: $0.longitude) }
    }

    /// Whether the steps a replay was started with hold the layer and station on.
    private var isStepped: Bool {
        steps?.contains { $0.layer.token == layerOn?.layer.token && $0.station == station } ?? false
    }

    private var key: String? {
        guard let on = layerOn, let point else {
            return nil
        }
        return "\(on.layer.token)|\(station)|\(point.latitude)|\(point.longitude)"
    }

    /// The replay on, once its steps are known.
    var active: Active? {
        guard let on = layerOn, let point, !station.isEmpty else {
            return nil
        }
        if isStepped, let steps {
            return Active(on: on, station: station, point: point, steps: steps)
        }
        if let listed, listed.key == key {
            return Active(on: on, station: station, point: point, steps: listed.steps)
        }
        return nil
    }

    /// Keeps a replay opened from a link listed, and ends one whose layer went off, until cancelled.
    func watch() async {
        for await (key, on) in Observations({ (self.key, self.layerOn) }) {
            if on == nil, !station.isEmpty {
                station = ""
                steps = nil
                // Ended elsewhere, not by Exit: the camera stays where it is.
                session.endReplayCamera(returnView: false)
            }
            asking?.cancel()
            guard let key, let on, let point, !isStepped, listed?.key != key else {
                continue
            }
            let station = station
            asking = Task {
                let overpasses = await GranuleService.shared.stationOverpasses(on.layer, point: point, now: Date().timeIntervalSince1970 * 1000)
                guard !Task.isCancelled else {
                    return
                }
                let steps = (overpasses ?? []).filter(\.isDay).map {
                    RecordedOverpass(pair: key, satellite: on.satellite, station: station, layer: on.layer, overpass: $0)
                }
                listed = (key, steps)
            }
        }
    }

    /// When the granule layer on has granules by day, a day either side of the clock, which
    /// the timeline shades: the clock outside them shows nothing new.
    private(set) var sensed: [Overpass] = []

    /// How often the spans are listed afresh as the clock moves: a quarter of the day.
    private static let sensedBucketMs = 6 * 3_600_000.0
    /// How soon spans the catalogue did not answer for are asked again.
    private static let sensedRetry: TimeInterval = 60

    /// Keeps `sensed` listed around the clock, until cancelled.
    func watchSensed() async {
        var asked: (token: String, bucket: Double)?
        var failedAt: Date?
        while !Task.isCancelled {
            let token = layerOn?.layer.token
            let bucket = (session.clock.now() / Self.sensedBucketMs).rounded(.down)
            if token != asked?.token {
                // The clock moving on keeps the spans until the new ones come; another layer does not.
                sensed = []
            }
            let due = failedAt.map { Date().timeIntervalSince($0) >= Self.sensedRetry } ?? true
            if let token, let layer = layerOn?.layer, token != asked?.token || bucket != asked?.bucket || (failedAt != nil && due) {
                asked = (token, bucket)
                let overpasses = await GranuleService.shared.orbitOverpasses(
                    layer, around: (bucket + 0.5) * Self.sensedBucketMs, now: Date().timeIntervalSince1970 * 1000)
                if layerOn?.layer.token == token {
                    failedAt = overpasses == nil ? Date() : nil
                    if let overpasses {
                        sensed = overpasses
                    }
                }
            } else if token == nil {
                asked = nil
                failedAt = nil
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// Starts a replay of `first`, in place of the one on, its bar stepping through `steps`.
    func start(_ first: RecordedOverpass, steps: [RecordedOverpass]) {
        session.keepViewBeforeReplay()
        self.steps = steps
        replayStep(first, multiplier: 30)
    }

    /// Goes to another of the replay's steps, at the speed the clock runs.
    func step(to: RecordedOverpass) {
        replayStep(to, multiplier: session.clock.clock.multiplier)
    }

    /// Turns `to`'s satellite and layer on in place of the replay's, and replays it at `multiplier`.
    private func replayStep(_ to: RecordedOverpass, multiplier: Double) {
        if !station.isEmpty, let before = layerOn?.layer.token, before != to.layer.token {
            session.instrumentImagery.show(before, false)
        }
        if let entry = session.catalog.catalog.entries.values.first(where: { $0.name == to.satellite }) {
            session.catalog.activate(entry)
        }
        session.instrumentImagery.show(to.layer.token, true)
        station = to.station
        if let station = session.passes.stations.first(where: { $0.displayName == to.station }) {
            var plan = OverpassReplay.stationReplay(
                start: to.overpass.start, station: GroundPoint(latitude: station.latitude, longitude: station.longitude), satellite: to.satellite)
            plan.multiplier = multiplier
            session.replay(plan, camera: camera)
        }
    }

    /// Watches the replay on from `camera`, and any replay after.
    func watch(from camera: ReplayCamera) {
        self.camera = camera
        if let active {
            session.aimReplay(satellite: active.on.satellite, centre: active.point, camera: camera)
        }
    }

    /// Takes the replay's layer off, and no other; with `returnView` the camera flies back
    /// to where it was when the replay started, else it stays. The clock is the caller's.
    func stop(returnView: Bool) {
        if let token = active?.on.layer.token {
            session.instrumentImagery.show(token, false)
        }
        station = ""
        steps = nil
        session.endReplayCamera(returnView: returnView)
    }

    /// Replays a pass over its station: a pass recorded by day also shows its granules, and
    /// the replay bar steps through the table's other recorded overpasses; any other pass
    /// stops the replay, whose granules are of another pass.
    func replay(start: Double, station stationName: String, satellite: String, recorded entry: RecordedOverpass?, all: [RecordedOverpass]) {
        if let entry, entry.isDay {
            self.start(entry, steps: RecordedOverpass.replaySteps(all, started: entry))
            return
        }
        guard let station = session.passes.stations.first(where: { $0.displayName == stationName }) else {
            return
        }
        stop(returnView: false)
        session.replay(
            OverpassReplay.stationReplay(start: start, station: GroundPoint(latitude: station.latitude, longitude: station.longitude), satellite: satellite),
            camera: camera)
    }
}
