import Foundation
import Synchronization

/// Each satellite's passes over the ground stations, predicted for a window around
/// the clock and kept while the clock stays inside it: the web app's pass
/// predictor, for every satellite at once. Satellites are predicted in parallel,
/// off the caller's thread. What it holds is `snapshot`, a value to publish and
/// ask on any thread.
public actor PassStore {
    public struct Settings: Sendable, Hashable {
        public var stations: [GroundStation]
        public var mode: OverpassMode

        public init(stations: [GroundStation] = [], mode: OverpassMode = .elevation) {
            self.stations = stations
            self.mode = mode
        }
    }

    /// Everything predicted so far.
    public private(set) var snapshot = Snapshot()
    /// Bumped by every change of settings, so that a prediction made under the old
    /// ones is dropped when it lands.
    private var generation = 0

    public init() {}

    /// Takes up new stations or a new mode. Another mode is other passes: every
    /// prediction goes. Other stations keep what was predicted for the stations
    /// still there, and the rest is predicted as it is asked for.
    public func configure(_ settings: Settings) {
        guard settings != snapshot.settings else {
            return
        }
        snapshot.configure(settings)
        generation += 1
    }

    /// Predicts what is missing for these satellites at `time`, in parallel, and
    /// says which it predicted. A satellite whose passes no longer cover `time`,
    /// or whose element set changed, is predicted over every station; one only
    /// missing a station, over that one. A satellite that cannot be propagated,
    /// or circles too slowly for passes, has none. Nothing with no ground station.
    /// `over` narrows it to some of the stations, as one station's panel needs.
    @discardableResult
    public func predict(_ satellites: [CatalogEntry], at time: Double, over subset: [GroundStation]? = nil) async -> Set<String> {
        let plan = plan(satellites, at: time, over: subset)
        guard !plan.jobs.isEmpty else {
            return []
        }
        return land(await Self.run(plan), of: plan)
    }

    /// Forgets the satellites not among these, so that browsing group after group
    /// with a station selected does not keep every prediction ever made.
    public func keep(only ids: Set<String>) {
        snapshot.keep(only: ids)
    }

    /// What a prediction is to work out, under the settings of one generation.
    struct Plan: Sendable {
        /// One satellite to predict, over some of the stations.
        struct Job: Sendable {
            /// The satellite, under its element set now.
            var entry: CatalogEntry
            /// A new window, or the one its passes already hold for.
            var window: PassWindow
            /// The stations to predict it over.
            var stations: [GroundStation]
            /// Over every station, replacing what was held.
            var whole: Bool
        }

        /// One per satellite with something missing.
        var jobs: [Job]
        /// The mode to predict in.
        var mode: OverpassMode
        /// The generation planned in, which `land` checks.
        var generation: Int
    }

    /// What `predict` works out for these satellites at `time`, over `subset` of the
    /// stations or all of them.
    func plan(_ satellites: [CatalogEntry], at time: Double, over subset: [GroundStation]? = nil) -> Plan {
        let settings = snapshot.settings
        let stations = subset.map { asked in settings.stations.filter(asked.contains) } ?? settings.stations
        guard !stations.isEmpty else {
            return Plan(jobs: [], mode: settings.mode, generation: generation)
        }
        let window = PassWindow(around: time)
        let jobs = satellites.compactMap { entry -> Plan.Job? in
            guard let known = snapshot.predicted[entry.id], known.window.covers(time), known.record == entry.record else {
                return Plan.Job(entry: entry, window: window, stations: stations, whole: true)
            }
            let missing = stations.filter { known.byStation[$0] == nil }
            return missing.isEmpty ? nil : Plan.Job(entry: entry, window: known.window, stations: missing, whole: false)
        }
        return Plan(jobs: jobs, mode: settings.mode, generation: generation)
    }

    /// Works out a plan's jobs side by side, off the actor.
    static func run(_ plan: Plan) async -> [(job: Plan.Job, passes: [GroundStation: [Pass]])] {
        await withTaskGroup(of: (job: Plan.Job, passes: [GroundStation: [Pass]]).self) { group in
            for job in plan.jobs {
                group.addTask {
                    (job, predict(job.entry, over: job.stations, mode: plan.mode, window: job.window))
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }
    }

    /// Keeps what a plan worked out, unless the settings changed meanwhile.
    func land(_ results: [(job: Plan.Job, passes: [GroundStation: [Pass]])], of plan: Plan) -> Set<String> {
        guard plan.generation == generation, !results.isEmpty else {
            return []
        }
        snapshot.land(results)
        return Set(results.map(\.job.entry.id))
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

    /// One satellite's passes over the stations, in their order, by start: as
    /// `PassFinder.passes` lists them.
    fileprivate static func merged(_ passes: [GroundStation: [Pass]], in stations: [GroundStation]) -> [Pass] {
        stations.flatMap { passes[$0] ?? [] }.sorted { $0.start < $1.start }
    }
}

extension PassStore {
    /// What the store held when it was taken. It answers for the settings it is
    /// asked under, which can be newer than those it was predicted under: for
    /// another mode, nothing yet; for other stations, what it has over them.
    public struct Snapshot: Sendable {
        /// What it was predicted under.
        public fileprivate(set) var settings = Settings()
        /// Bumped by every change, so that a copy can tell it is behind.
        public fileprivate(set) var revision = 0
        /// Each satellite's passes, by catalog id.
        fileprivate var predicted: [String: Predicted] = [:]
        /// What is worked out from this revision, shared by its copies.
        private var memo = Memo()

        public init() {}

        /// One satellite's passes over the stations, nil while they are not the
        /// answer for `time`: not predicted yet, or for another mode, or missing
        /// a station. Empty with no station.
        public func passes(of id: String, at time: Double, under settings: Settings) -> [Pass]? {
            guard !settings.stations.isEmpty else {
                return []
            }
            guard let known = predicted[id], isPredicted(known, over: settings.stations, at: time, under: settings) else {
                return nil
            }
            return held(known, over: settings.stations)
        }

        /// One satellite's passes over those of the stations it has, whenever they
        /// were predicted for: what the links draw until the next answer.
        public func heldPasses(of id: String, under settings: Settings) -> [Pass] {
            guard settings.mode == self.settings.mode, let known = predicted[id] else {
                return []
            }
            return held(known, over: settings.stations)
        }

        /// A station's view: its passes over these satellites that start within
        /// two days of `now`, by start, and how many of the satellites have
        /// answered for `now`. The merged list is kept for the next ask: it can
        /// run to hundreds of thousands.
        public func passes(over station: GroundStation, of satellites: [CatalogEntry], from now: Double, under settings: Settings) -> StationPasses {
            guard settings.mode == self.settings.mode else {
                return StationPasses(passes: [], predicted: 0, settled: satellites.isEmpty)
            }
            let predicted = satellites.count { entry in self.predicted[entry.id].map { isPredicted($0, over: [station], at: now, under: settings) } ?? false }
            let key = StationKey(station: station.id, satellites: satellites.map(\.id))
            let all = memo.station.withLock { kept in
                if let kept, kept.key == key {
                    return kept.passes
                }
                let merged = satellites.compactMap { self.predicted[$0.id]?.passes }.flatMap(\.self).filter { $0.stationID == station.id }.sorted { $0.start < $1.start }
                kept = (key, merged)
                return merged
            }
            // Sorted by start, so the two days ahead are a prefix.
            let horizon = all.partitioningIndex { $0.start - now >= 48 * 3_600_000 }
            return StationPasses(passes: Array(all[..<horizon]), predicted: predicted, settled: predicted == satellites.count)
        }

        /// Whether a satellite's passes over these stations are the answer for now.
        private func isPredicted(_ known: Predicted, over stations: [GroundStation], at time: Double, under settings: Settings) -> Bool {
            settings.mode == self.settings.mode && known.window.covers(time) && stations.allSatisfy { known.byStation[$0] != nil }
        }

        /// Over the stations still there, by id, as a station renamed is until its
        /// passes are predicted again.
        private func held(_ known: Predicted, over stations: [GroundStation]) -> [Pass] {
            guard stations != settings.stations else {
                return known.passes
            }
            let ids = Set(stations.map(\.id))
            return known.passes.filter { ids.contains($0.stationID) }
        }

        /// Keeps what still holds under `settings`: nothing in another mode, else what
        /// is over the stations still there.
        fileprivate mutating func configure(_ settings: Settings) {
            if settings.mode != self.settings.mode {
                predicted = [:]
            } else {
                let kept = Set(settings.stations)
                predicted = predicted.mapValues { known in
                    var known = known
                    known.byStation = known.byStation.filter { kept.contains($0.key) }
                    known.passes = PassStore.merged(known.byStation, in: settings.stations)
                    return known
                }
            }
            self.settings = settings
            changed()
        }

        /// Keeps what the jobs worked out: a whole job's replaces what was held, the
        /// others' add their stations to it.
        fileprivate mutating func land(_ results: [(job: Plan.Job, passes: [GroundStation: [Pass]])]) {
            for (job, passes) in results {
                var known =
                    predicted[job.entry.id].flatMap { job.whole ? nil : $0 } ?? Predicted(record: job.entry.record, window: job.window, byStation: [:], passes: [])
                known.byStation.merge(passes) { _, new in new }
                known.passes = PassStore.merged(known.byStation, in: settings.stations)
                predicted[job.entry.id] = known
            }
            changed()
        }

        /// Forgets the satellites not among `ids`.
        fileprivate mutating func keep(only ids: Set<String>) {
            guard predicted.keys.contains(where: { !ids.contains($0) }) else {
                return
            }
            predicted = predicted.filter { ids.contains($0.key) }
            changed()
        }

        /// A new revision, with nothing worked out from it yet.
        private mutating func changed() {
            revision += 1
            memo = Memo()
        }
    }

    /// A station's passes and how far their prediction has got.
    public struct StationPasses: Sendable {
        public var passes: [Pass]
        /// How many of the satellites asked about have answered for now.
        public var predicted: Int
        /// Whether all of them have.
        public var settled: Bool
    }
}

/// A satellite's passes, kept per station: a station added is predicted alone,
/// over the window the others hold for, and one removed drops out.
private struct Predicted: Sendable {
    var record: GPRecord
    var window: PassWindow
    /// By station, each over the window.
    var byStation: [GroundStation: [Pass]]
    /// Over the snapshot's stations, by start.
    var passes: [Pass]
}

/// Which station's view, of which satellites, a merged list is.
private struct StationKey: Equatable, Sendable {
    /// The station's id.
    var station: UUID
    /// Catalog ids, in the order asked.
    var satellites: [String]
}

/// A station's merged passes, worked out once per snapshot, whichever copy of it
/// asks first.
private final class Memo: Sendable {
    /// The station view asked for last, merged.
    let station = Mutex<(key: StationKey, passes: [Pass])?>(nil)
}

extension Array {
    /// The first index whose element satisfies a predicate that, over the array,
    /// is false and then true: a binary search.
    func partitioningIndex(where predicate: (Element) -> Bool) -> Int {
        var low = 0
        var high = count
        while low < high {
            let middle = (low + high) / 2
            if predicate(self[middle]) {
                high = middle
            } else {
                low = middle + 1
            }
        }
        return low
    }
}
