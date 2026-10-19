import Foundation
import SatvisCore
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "data")

/// When the app asks for the group index and the groups, over a `GroupRepository`:
/// never waiting on the worker for what a kept copy can show, the worker's answer
/// following it. What it loads it hands over; what is shown is the app's.
public actor GroupLoader {
    /// Takes a group's records: from the kept copy, if there is one, and again
    /// with each answer from the worker.
    public typealias Deliver = @Sendable (_ group: String, _ records: [GPRecord]) async -> Void

    /// Where the index and the groups come from, and their kept copies.
    public nonisolated let repository: GroupRepository
    /// How long to wait between asks for an index while there is none.
    private let retry: Duration
    /// What waits out `retry`.
    private let sleep: @Sendable (Duration) async throws -> Void
    /// Groups handed over at least once.
    private var loaded: Set<String> = []
    /// One load per group at a time, which every caller asking for it awaits.
    private var loading: [String: Task<Void, Never>] = [:]

    /// `sleep` waits out `retry` between asking for an index while there is none.
    public init(
        repository: GroupRepository,
        retry: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.repository = repository
        self.retry = retry
        self.sleep = sleep
    }

    /// The index to start on: the kept copy, so nothing waits on the network that a
    /// copy on disk can show, else the worker's. The app ships no catalog, so a
    /// first launch offline has none until the worker answers once: until then it
    /// asks again every `retry`, calling `waiting` before each wait. Nil only when
    /// cancelled.
    public func firstIndex(waiting: @Sendable () async -> Void) async -> GroupIndex? {
        if let kept = await repository.keptIndex() {
            return kept.value
        }
        var index = await refreshIndex()
        while index == nil, !Task.isCancelled {
            await waiting()
            try? await sleep(retry)
            index = await refreshIndex()
        }
        return index
    }

    /// The worker's index: a 304 when nothing changed, the kept copy when it cannot
    /// be asked. Nil when there is neither.
    public func refreshIndex() async -> GroupIndex? {
        do {
            return try await repository.index().value
        } catch {
            log.error("Group index unavailable: \(error, privacy: .public)")
            return nil
        }
    }

    /// Loads the groups not loaded yet, side by side. Returns once each has been
    /// handed to `deliver`, from the kept copy where there is one; the worker's
    /// answer follows by itself. A group asked for again while it loads is not
    /// loaded twice: the second ask awaits the first, whose `deliver` takes it.
    public func load(_ groups: [String], deliver: @escaping Deliver) async {
        await withTaskGroup(of: Void.self) { tasks in
            for group in groups where !loaded.contains(group) {
                tasks.addTask { await self.load(group, deliver: deliver) }
            }
        }
    }

    /// Asks the worker again for each of `groups` loaded so far, side by side,
    /// which costs a 304 for each that has not changed, and hands over what it
    /// answers.
    public func revalidate(_ groups: [String], deliver: @escaping Deliver) async {
        await withTaskGroup(of: Void.self) { tasks in
            for group in groups where loaded.contains(group) {
                tasks.addTask { await self.fetch(group, deliver: deliver) }
            }
        }
    }

    /// The records of `groups` as the worker has them now, or as kept where it
    /// cannot be asked, in one catalog without tags; a group with neither is left
    /// out. For predicting from the newest element sets with no catalog about.
    public func catalog(of groups: Set<String>) async -> Catalog {
        // All at once: one after another, each with the worker's 15 s timeout, a
        // network that hangs rather than fails would outlast the 30 s or so iOS
        // gives a background refresh, every time.
        let loaded = await withTaskGroup(of: (String, [GPRecord]?).self) { tasks in
            for group in groups {
                tasks.addTask { (group, await self.records(of: group)) }
            }
            var loaded: [(group: String, records: [GPRecord])] = []
            for await (group, records) in tasks {
                if let records {
                    loaded.append((group, records))
                }
            }
            return loaded
        }
        var catalog = Catalog()
        for (group, records) in loaded.sorted(by: { $0.group < $1.group }) {
            catalog.add(records, tags: [], group: group)
        }
        return catalog
    }

    /// Loads one group, or awaits its load under way: the kept copy first, the
    /// worker's answer following, or the worker's alone where none is kept.
    private func load(_ group: String, deliver: @escaping Deliver) async {
        if let pending = loading[group] {
            return await pending.value
        }
        let task = Task {
            if let kept = await repository.keptRecords(of: group) {
                await hand(kept.value, of: group, to: deliver)
                Task { await self.fetch(group, deliver: deliver) }
            } else {
                await fetch(group, deliver: deliver)
            }
        }
        loading[group] = task
        await task.value
        loading[group] = nil
    }

    /// Asks the worker for a group and hands over what it answers.
    private func fetch(_ group: String, deliver: Deliver) async {
        if let records = await records(of: group) {
            await hand(records, of: group, to: deliver)
        }
    }

    /// A group's records as the repository answers, nil, and logged, where it has
    /// none.
    private nonisolated func records(of group: String) async -> [GPRecord]? {
        do {
            return try await repository.records(of: group).value
        } catch {
            log.error("Group \(group, privacy: .public) unavailable: \(error, privacy: .public)")
            return nil
        }
    }

    /// Loaded only once handed over, so that an ask for it returns with it taken.
    private func hand(_ records: [GPRecord], of group: String, to deliver: Deliver) async {
        await deliver(group, records)
        loaded.insert(group)
    }
}
