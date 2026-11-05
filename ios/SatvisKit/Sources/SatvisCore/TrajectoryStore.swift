import Foundation

/// The satellites being drawn, each with its sampled trajectory kept around the
/// current instant. Sampling is the expensive part, so it happens here, off the
/// main thread, and only for windows that have gone stale.
public actor TrajectoryStore {
    public struct Entry: Sendable {
        public var record: GPRecord
        public var trajectory: SampledTrajectory
    }

    /// A satellite in the set, and its window.
    private struct Slot {
        var record: GPRecord
        var propagator: SGP4Propagator
        var trajectory: SampledTrajectory?
        /// When SGP4 refused the whole window, e.g. long after it decayed. Not
        /// drawn, and sampled again only once the clock is an orbit away from
        /// there, so a clock scrubbed past a decay and back brings it back.
        var failedAt: Double?

        /// Whether the window has to be sampled for this instant.
        func isStale(at time: Double) -> Bool {
            guard !(trajectory?.isFresh(at: time) ?? false) else {
                return false
            }
            if let failedAt, abs(time - failedAt) < SampledTrajectory.periodMilliseconds(propagator) {
                return false
            }
            return true
        }
    }

    private var slots: [Slot] = []
    /// A replacement that resampled nothing still changes what is drawn.
    private var changedSinceRefresh = false

    public init() {}

    /// Replaces the set. A satellite is drawn once, by the catalog's identity
    /// (`satnum|name`), so that two entries sharing a catalog number are both
    /// drawn, as the web app draws them; one already in the set keeps its window,
    /// so that switching a group on does not resample every other one.
    public func replace(with records: [GPRecord]) {
        var kept: [String: Slot] = [:]
        for slot in slots {
            kept[Self.key(slot.record)] = slot
        }
        var seen = Set<String>()
        var next: [Slot] = []
        for record in records where seen.insert(Catalog.id(of: record)).inserted {
            if var slot = kept[Self.key(record)] {
                slot.record = record
                next.append(slot)
            } else if let propagator = try? SGP4Propagator(record.meanElements) {
                next.append(Slot(record: record, propagator: propagator))
            }
        }
        slots = next
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
        var stale = slots.indices.filter { slots[$0].isStale(at: epochMilliseconds) }
        if !stale.isEmpty {
            stale = slots.indices.filter { index in
                slots[index].isStale(at: epochMilliseconds) || slots[index].isStale(at: epochMilliseconds - Self.batchMilliseconds)
                    || slots[index].isStale(at: epochMilliseconds + Self.batchMilliseconds)
            }
        }
        let sampled = Self.sample(stale.map { slots[$0].propagator }, around: epochMilliseconds)
        for (index, trajectory) in zip(stale, sampled) {
            slots[index].failedAt = trajectory == nil ? epochMilliseconds : nil
            // A satellite that stays refused changes nothing that is drawn.
            if trajectory != nil || slots[index].trajectory != nil {
                changed = true
            }
            slots[index].trajectory = trajectory
        }
        guard changed else {
            return nil
        }
        return slots.compactMap { slot in
            slot.trajectory.map { Entry(record: slot.record, trajectory: $0) }
        }
    }
}
