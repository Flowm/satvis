import Foundation

/// Each satellite's passes over the ground stations, predicted for a window around
/// the clock and kept while the clock stays inside it: the web app's pass
/// predictor, for every satellite at once. Satellites are predicted in parallel,
/// off the caller's thread.
public actor PassStore {
    public struct Settings: Sendable, Hashable {
        public var stations: [GroundStation]
        public var mode: OverpassMode

        public init(stations: [GroundStation] = [], mode: OverpassMode = .elevation) {
            self.stations = stations
            self.mode = mode
        }
    }

    private struct Predicted {
        var record: GPRecord
        var window: PassWindow
        var passes: [Pass]
    }

    public private(set) var settings = Settings()
    private var predicted: [String: Predicted] = [:]
    /// Bumped by every change of settings, so that a prediction made under the old
    /// ones is dropped when it lands.
    private var generation = 0

    public init() {}

    /// Forgets every prediction when the stations or the mode change.
    public func configure(_ settings: Settings) {
        guard settings != self.settings else {
            return
        }
        self.settings = settings
        predicted = [:]
        generation += 1
    }

    /// The passes of each satellite, by catalog id, from a window that covers
    /// `time`; the satellites without one are predicted first. A satellite that
    /// cannot be propagated, or circles too slowly for passes, has none. Empty
    /// with no ground station.
    public func passes(of satellites: [CatalogEntry], at time: Double) async -> [String: [Pass]] {
        guard !settings.stations.isEmpty else {
            return [:]
        }
        let stale = satellites.filter { entry in
            guard let known = predicted[entry.id] else {
                return true
            }
            return !known.window.covers(time) || known.record != entry.record
        }
        if !stale.isEmpty {
            let generation = generation
            let settings = settings
            let window = PassWindow(around: time)
            let results = await withTaskGroup(of: (String, Predicted).self) { group in
                for entry in stale {
                    group.addTask {
                        (entry.id, Predicted(record: entry.record, window: window, passes: Self.predict(entry, settings: settings, window: window)))
                    }
                }
                return await group.reduce(into: [:]) { $0[$1.0] = $1.1 }
            }
            if generation == self.generation {
                predicted.merge(results) { _, new in new }
            }
        }
        var answer: [String: [Pass]] = [:]
        for entry in satellites {
            if let known = predicted[entry.id], known.window.covers(time) {
                answer[entry.id] = known.passes
            }
        }
        return answer
    }

    /// Every pass of one satellite over the stations inside the window.
    public static func predict(_ entry: CatalogEntry, settings: Settings, window: PassWindow) -> [Pass] {
        guard let propagator = try? SGP4Propagator(entry.record.meanElements) else {
            return []
        }
        let finder = PassFinder(propagator)
        guard finder.predictsPasses else {
            return []
        }
        return finder.passes(
            satellite: entry.id, name: entry.name, over: settings.stations, mode: settings.mode,
            swath: SwathExtents(metadata: entry.record.metadata) ?? .default, from: window.start, to: window.predictionEnd)
    }
}
