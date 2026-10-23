import Foundation

/// The satellites being drawn, each with its sampled trajectory kept around the
/// current instant. Sampling is the expensive part, so it happens here, off the
/// main thread, and only for windows that have gone stale.
public actor TrajectoryStore {
    public struct Entry: Sendable {
        public var record: GPRecord
        public var trajectory: SampledTrajectory
    }

    private var propagators: [(record: GPRecord, propagator: SGP4Propagator)] = []
    private var trajectories: [SampledTrajectory?] = []
    /// When SGP4 refused a satellite's whole window, e.g. long after it decayed.
    /// Not drawn, and sampled again only once the clock is an orbit away from
    /// there, so a clock scrubbed past a decay and back brings it back.
    private var failedAt: [Int: Double] = [:]
    /// A replacement that resampled nothing still changes what is drawn.
    private var changedSinceRefresh = false

    public init() {}

    /// Replaces the set. A satellite is drawn once, by the catalog's identity
    /// (`satnum|name`), so that two entries sharing a catalog number are both
    /// drawn, as the web app draws them; one already in the set keeps its window,
    /// so that switching a group on does not resample every other one.
    public func replace(with records: [GPRecord]) {
        var kept: [String: (propagator: SGP4Propagator, trajectory: SampledTrajectory?, failedAt: Double?)] = [:]
        for (index, entry) in propagators.enumerated() {
            kept[Self.key(entry.record)] = (entry.propagator, trajectories[index], failedAt[index])
        }
        var seen = Set<String>()
        var nextPropagators: [(record: GPRecord, propagator: SGP4Propagator)] = []
        var nextTrajectories: [SampledTrajectory?] = []
        var nextFailedAt: [Int: Double] = [:]
        for record in records where seen.insert(Catalog.id(of: record)).inserted {
            if let old = kept[Self.key(record)] {
                if let failed = old.failedAt {
                    nextFailedAt[nextPropagators.count] = failed
                }
                nextPropagators.append((record, old.propagator))
                nextTrajectories.append(old.trajectory)
            } else if let propagator = try? SGP4Propagator(record.meanElements) {
                nextPropagators.append((record, propagator))
                nextTrajectories.append(nil)
            }
        }
        propagators = nextPropagators
        trajectories = nextTrajectories
        failedAt = nextFailedAt
        changedSinceRefresh = true
    }

    /// Samples the windows on every core: the web app fills them in a worker
    /// pool, and one at a time a constellation switched on took seconds. Within
    /// the actor's turn, so nothing can replace the set while they are sampled.
    private static func sample(_ propagators: [SGP4Propagator], around epochMilliseconds: Double) -> [SampledTrajectory?] {
        var results = [SampledTrajectory?](repeating: nil, count: propagators.count)
        results.withUnsafeMutableBufferPointer { buffer in
            // Each part writes only its own indices, and the buffer outlives them all.
            nonisolated(unsafe) let output = buffer
            // A chunk of satellites a task, so the scheduling costs little next to SGP4.
            let chunk = 64
            DispatchQueue.concurrentPerform(iterations: (propagators.count + chunk - 1) / chunk) { part in
                for index in (part * chunk)..<min((part + 1) * chunk, propagators.count) {
                    output[index] = SampledTrajectory(propagators[index], around: epochMilliseconds)
                }
            }
        }
        return results
    }

    /// The same satellite with the same element set.
    private static func key(_ record: GPRecord) -> String {
        "\(Catalog.id(of: record))|\(record.meanElements.epoch.year)|\(record.meanElements.epoch.dayOfYear)"
    }

    /// Simulation milliseconds either side of the instant: once a window has gone
    /// stale, every window that would go stale within this is resampled with it,
    /// as each resample hands the whole set over again. One at a time, an iPad mini
    /// repacked all 16,762 active satellites every second or two.
    static let batchMilliseconds = 600_000.0

    /// `refresh(at:)`, each entry made into what the caller draws, still off the
    /// main thread: for 16,762 satellites that held an iPad mini's main thread for
    /// up to 32 ms.
    public func refresh<Drawn: Sendable>(at epochMilliseconds: Double, as drawn: @Sendable (Entry) -> Drawn) -> [Drawn]? {
        refresh(at: epochMilliseconds)?.map(drawn)
    }

    /// Resamples every window that no longer covers the instant, and with them
    /// those about to stop (`batchMilliseconds`). Returns the whole set when
    /// anything changed, nil when nothing did.
    public func refresh(at epochMilliseconds: Double) -> [Entry]? {
        var changed = changedSinceRefresh
        changedSinceRefresh = false
        func isStale(_ index: Int, at time: Double) -> Bool {
            guard !(trajectories[index]?.isFresh(at: time) ?? false) else {
                return false
            }
            if let failed = failedAt[index], abs(time - failed) < SampledTrajectory.periodMilliseconds(propagators[index].propagator) {
                return false
            }
            return true
        }
        var stale = propagators.indices.filter { isStale($0, at: epochMilliseconds) }
        if !stale.isEmpty {
            stale = propagators.indices.filter { index in
                isStale(index, at: epochMilliseconds) || isStale(index, at: epochMilliseconds - Self.batchMilliseconds)
                    || isStale(index, at: epochMilliseconds + Self.batchMilliseconds)
            }
        }
        let sampled = Self.sample(stale.map { propagators[$0].propagator }, around: epochMilliseconds)
        for (index, trajectory) in zip(stale, sampled) {
            failedAt[index] = trajectory == nil ? epochMilliseconds : nil
            // A satellite that stays refused changes nothing that is drawn.
            if trajectory != nil || trajectories[index] != nil {
                changed = true
            }
            trajectories[index] = trajectory
        }
        guard changed else {
            return nil
        }
        return zip(propagators, trajectories).compactMap { satellite, trajectory in
            trajectory.map { Entry(record: satellite.record, trajectory: $0) }
        }
    }
}
