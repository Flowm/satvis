import Foundation
import Observation
import SatvisCore
import SatvisData
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "data")

/// Where the app gets GP data (see GroupRepository), as the views read it.
@Observable
final class GPSource {
    private(set) var index: GroupRepository.Loaded<GroupIndex>?
    private(set) var failure: String?
    /// The site the worker answers at, whose static files (the finer Natural
    /// Earth levels) the globe streams.
    let site: URL
    private let repository: GroupRepository

    init(repository: GroupRepository, site: URL) {
        self.repository = repository
        self.site = site
    }

    /// The index as last kept, or as shipped, for a start that does not wait on the
    /// network. `refresh` asks the worker.
    func loadKept() async {
        if index == nil {
            index = await repository.keptIndex()
        }
    }

    /// Revalidates the index: a 304 when nothing changed.
    func refresh() async {
        do {
            index = try await repository.index()
            failure = nil
        } catch {
            log.error("Group index unavailable: \(error, privacy: .public)")
            failure = error.localizedDescription
        }
    }

    /// A group, revalidated with the worker.
    func records(of group: String) async throws -> GroupRepository.Loaded<[GPRecord]> {
        try await repository.records(of: group)
    }

    /// A group as last kept, or as shipped, without asking the worker.
    func keptRecords(of group: String) async -> GroupRepository.Loaded<[GPRecord]>? {
        await repository.keptRecords(of: group)
    }

    /// The star map's six faces, nil until it has been fetched once.
    func starMap() async -> [Data]? {
        await repository.starMap()
    }

    func keptStarMap() async -> [Data]? {
        await repository.keptStarMap()
    }
}
