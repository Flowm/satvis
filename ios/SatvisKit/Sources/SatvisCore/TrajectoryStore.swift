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
    /// Satellites SGP4 failed for, e.g. decayed ones: not drawn, and not retried
    /// until the set is replaced.
    private var failed = Set<Int>()

    public init() {}

    /// Replaces the set. A satellite carried by several groups is drawn once, as
    /// the web app's catalog keeps it once.
    public func replace(with records: [GPRecord]) {
        var seen = Set<String>()
        propagators = records.compactMap { record in
            guard seen.insert(record.satnum).inserted, let propagator = try? SGP4Propagator(record.meanElements) else {
                return nil
            }
            return (record, propagator)
        }
        trajectories = Array(repeating: nil, count: propagators.count)
        failed = []
    }

    /// Resamples every window that no longer covers the instant. Returns the whole
    /// set when anything changed, nil when nothing did.
    public func refresh(at epochMilliseconds: Double) -> [Entry]? {
        var changed = false
        for index in propagators.indices where !failed.contains(index) && !(trajectories[index]?.isFresh(at: epochMilliseconds) ?? false) {
            trajectories[index] = SampledTrajectory(propagators[index].propagator, around: epochMilliseconds)
            if trajectories[index] == nil {
                failed.insert(index)
            }
            changed = true
        }
        guard changed else {
            return nil
        }
        return zip(propagators, trajectories).compactMap { satellite, trajectory in
            trajectory.map { Entry(record: satellite.record, trajectory: $0) }
        }
    }
}
