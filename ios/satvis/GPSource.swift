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
    private let repository: GroupRepository

    init(repository: GroupRepository) {
        self.repository = repository
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

    func records(of group: String) async throws -> GroupRepository.Loaded<[GPRecord]> {
        try await repository.records(of: group)
    }
}
