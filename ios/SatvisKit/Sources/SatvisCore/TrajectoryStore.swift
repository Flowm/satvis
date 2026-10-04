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

    /// Replaces the set. A satellite carried by several groups is drawn once, as
    /// the web app's catalog keeps it once, and one already in the set keeps its
    /// window, so that switching a group on does not resample every other one.
    public func replace(with records: [GPRecord]) {
        var kept: [String: (propagator: SGP4Propagator, trajectory: SampledTrajectory?, failedAt: Double?)] = [:]
        for (index, entry) in propagators.enumerated() {
            kept[Self.key(entry.record)] = (entry.propagator, trajectories[index], failedAt[index])
        }
        var seen = Set<String>()
        var nextPropagators: [(record: GPRecord, propagator: SGP4Propagator)] = []
        var nextTrajectories: [SampledTrajectory?] = []
        var nextFailedAt: [Int: Double] = [:]
        for record in records where seen.insert(record.satnum).inserted {
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

    /// The same satellite with the same element set.
    private static func key(_ record: GPRecord) -> String {
        "\(record.satnum)|\(record.meanElements.epoch.year)|\(record.meanElements.epoch.dayOfYear)"
    }

    /// Resamples every window that no longer covers the instant. Returns the whole
    /// set when anything changed, nil when nothing did.
    public func refresh(at epochMilliseconds: Double) -> [Entry]? {
        var changed = changedSinceRefresh
        changedSinceRefresh = false
        for index in propagators.indices where !(trajectories[index]?.isFresh(at: epochMilliseconds) ?? false) {
            let propagator = propagators[index].propagator
            if let failed = failedAt[index], abs(epochMilliseconds - failed) < SampledTrajectory.periodMilliseconds(propagator) {
                continue
            }
            let trajectory = SampledTrajectory(propagator, around: epochMilliseconds)
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
