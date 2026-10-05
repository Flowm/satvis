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

    /// A satellite's passes, kept per station: a station added is predicted
    /// alone, over the window the others hold for, and one removed drops out.
    private struct Predicted {
        var record: GPRecord
        var window: PassWindow
        var passes: [GroundStation: [Pass]]
    }

    public private(set) var settings = Settings()
    private var predicted: [String: Predicted] = [:]
    /// Bumped by every change of settings, so that a prediction made under the old
    /// ones is dropped when it lands.
    private var generation = 0

    public init() {}

    /// Takes up new stations or a new mode. Another mode is other passes: every
    /// prediction goes. Other stations keep what was predicted for the stations
    /// still there, and the rest is predicted as it is asked for.
    public func configure(_ settings: Settings) {
        guard settings != self.settings else {
            return
        }
        if settings.mode != self.settings.mode {
            predicted = [:]
        } else {
            let kept = Set(settings.stations)
            predicted = predicted.mapValues { known in
                var known = known
                known.passes = known.passes.filter { kept.contains($0.key) }
                return known
            }
        }
        self.settings = settings
        generation += 1
    }

    /// Forgets every prediction, whatever the settings: for a caller that
    /// dropped its own while the settings went away and came back.
    public func reset() {
        predicted = [:]
        generation += 1
    }

    /// One satellite's passes, and the span they hold for.
    public struct Prediction: Sendable, Equatable {
        public var window: PassWindow
        public var passes: [Pass]
    }

    /// Predicts what is missing for these satellites at `time`, in parallel, and
    /// returns those it predicted, by catalog id, with all their passes: a caller
    /// that keeps the rest has nothing to redo. A satellite whose passes no longer
    /// cover `time`, or whose element set changed, is predicted over every station;
    /// one only missing a station, over that one. A satellite that cannot be
    /// propagated, or circles too slowly for passes, has none. Empty with no
    /// ground station.
    public func predict(_ satellites: [CatalogEntry], at time: Double) async -> [String: Prediction] {
        let stations = settings.stations
        guard !stations.isEmpty else {
            return [:]
        }
        let window = PassWindow(around: time)
        let jobs = satellites.compactMap { entry -> (entry: CatalogEntry, window: PassWindow, stations: [GroundStation], whole: Bool)? in
            guard let known = predicted[entry.id], known.window.covers(time), known.record == entry.record else {
                return (entry, window, stations, true)
            }
            let missing = stations.filter { known.passes[$0] == nil }
            return missing.isEmpty ? nil : (entry, known.window, missing, false)
        }
        guard !jobs.isEmpty else {
            return [:]
        }
        let generation = generation
        let mode = settings.mode
        let results = await withTaskGroup(of: (String, PassWindow, [GroundStation: [Pass]], Bool).self) { group in
            for job in jobs {
                group.addTask {
                    (job.entry.id, job.window, Self.predict(job.entry, over: job.stations, mode: mode, window: job.window), job.whole)
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }
        guard generation == self.generation else {
            return [:]
        }
        let records = Dictionary(jobs.map { ($0.entry.id, $0.entry.record) }, uniquingKeysWith: { first, _ in first })
        var answer: [String: Prediction] = [:]
        for (id, window, passes, whole) in results {
            guard let record = records[id] else {
                continue
            }
            if whole || predicted[id] == nil {
                predicted[id] = Predicted(record: record, window: window, passes: passes)
            } else {
                predicted[id]?.passes.merge(passes) { _, new in new }
            }
            if let known = predicted[id] {
                answer[id] = Prediction(window: known.window, passes: Self.merged(known.passes, in: stations))
            }
        }
        return answer
    }

    /// One satellite's passes over the stations, in their order, by start: as
    /// `PassFinder.passes` lists them.
    private static func merged(_ passes: [GroundStation: [Pass]], in stations: [GroundStation]) -> [Pass] {
        stations.flatMap { passes[$0] ?? [] }.sorted { $0.start < $1.start }
    }

    /// The passes of each satellite whose window covers `time`, predicting first
    /// where needed.
    public func passes(of satellites: [CatalogEntry], at time: Double) async -> [String: [Pass]] {
        _ = await predict(satellites, at: time)
        var answer: [String: [Pass]] = [:]
        for entry in satellites {
            if let known = predicted[entry.id], known.window.covers(time) {
                answer[entry.id] = Self.merged(known.passes, in: settings.stations)
            }
        }
        return answer
    }

    /// Forgets the satellites not among these, so that browsing group after group
    /// with a station selected does not keep every prediction ever made.
    public func keep(only ids: Set<String>) {
        predicted = predicted.filter { ids.contains($0.key) }
    }

    /// Every pass of one satellite over the stations inside the window, by start.
    public static func predict(_ entry: CatalogEntry, settings: Settings, window: PassWindow) -> [Pass] {
        merged(predict(entry, over: settings.stations, mode: settings.mode, window: window), in: settings.stations)
    }

    /// Every pass of one satellite over these stations inside the window, by
    /// station: each asked for has its list, empty where it sees none.
    public static func predict(_ entry: CatalogEntry, over stations: [GroundStation], mode: OverpassMode, window: PassWindow) -> [GroundStation: [Pass]] {
        var byStation = Dictionary(uniqueKeysWithValues: stations.map { ($0, [Pass]()) })
        guard let propagator = try? SGP4Propagator(entry.record.meanElements) else {
            return byStation
        }
        let finder = PassFinder(propagator)
        guard finder.predictsPasses else {
            return byStation
        }
        let swath = SwathExtents(metadata: entry.record.metadata) ?? .default
        for station in stations {
            byStation[station] = finder.passes(
                satellite: entry.id, name: entry.name, over: [station], mode: mode, swath: swath, from: window.start, to: window.predictionEnd)
        }
        return byStation
    }
}
