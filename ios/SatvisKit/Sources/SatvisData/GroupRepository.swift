import Foundation
import SatvisCore

/// Where the app gets GP data, and the site's static files beside it: the worker
/// when it answers, the copy kept on disk when it does not, and the snapshot
/// shipped in the app before there is one. Every request revalidates the kept copy
/// with its ETag, so a current copy costs a 304 and no body.
public actor GroupRepository {
    public enum Source: Sendable, Equatable {
        /// Fetched or confirmed by the worker just now.
        case worker
        /// The kept copy; the worker could not be asked.
        case cache
        /// Shipped in the app; nothing has been fetched yet.
        case snapshot
    }

    public struct Loaded<Value: Sendable>: Sendable {
        public var value: Value
        public var source: Source
        /// When the worker last confirmed it. Nil for the snapshot.
        public var confirmed: Date?
    }

    private let client: WorkerClient
    private let store: PayloadStore
    private let snapshot: PayloadStore?
    private let now: @Sendable () -> Date

    public init(client: WorkerClient, store: PayloadStore, snapshot: PayloadStore?, now: @escaping @Sendable () -> Date = Date.init) {
        self.client = client
        self.store = store
        self.snapshot = snapshot
        self.now = now
    }

    public func index() async throws -> Loaded<GroupIndex> {
        try await load(.index, fetch: { try await self.client.index(ifNoneMatch: $0) }, decode: { try JSONDecoder().decode(GroupIndex.self, from: $0) })
    }

    public func records(of group: String) async throws -> Loaded<[GPRecord]> {
        try await load(.group(group), fetch: { try await self.client.group(group, ifNoneMatch: $0) }, decode: GPRecord.decodePayload)
    }

    /// An image the site serves. Never shipped, so absent until fetched once.
    public func image(_ path: String) async throws -> Loaded<Data> {
        try await load(.file(path), fetch: { try await self.client.image(path, ifNoneMatch: $0) }, decode: { $0 })
    }

    /// The six faces of satvis's own star map, as the web app's `DeepStar1K` (NASA
    /// SVS Deep Star Maps 2020, built by `pnpm update-starmap`), in the order a
    /// cube texture takes them: +X, −X, +Y, −Y, +Z, −Z. Nil while any is missing.
    public func starMap() async -> [Data]? {
        var faces: [Data] = []
        for face in ["px", "mx", "py", "my", "pz", "mz"] {
            guard let loaded = try? await image("data/starmap/deepstar_2020_1024_\(face).webp") else {
                return nil
            }
            faces.append(loaded.value)
        }
        return faces
    }

    private func load<Value: Sendable>(
        _ key: PayloadStore.Key,
        fetch: (String?) async throws -> WorkerClient.Answer,
        decode: (Data) throws -> Value
    ) async throws -> Loaded<Value> {
        let kept = store.read(key)
        do {
            switch try await fetch(kept?.etag) {
            case .fresh(let data, let etag):
                // Decoded before it is kept, so a malformed answer never replaces a good copy.
                let value = try decode(data)
                let confirmed = now()
                try? store.write(key, data: data, etag: etag, confirmed: confirmed)
                return Loaded(value: value, source: .worker, confirmed: confirmed)
            case .unchanged:
                guard let kept else {
                    throw WorkerError.status(304, key.path)
                }
                let confirmed = now()
                try? store.confirm(key, etag: kept.etag, at: confirmed)
                return Loaded(value: try decode(kept.data), source: .worker, confirmed: confirmed)
            }
        } catch {
            if let kept, let value = try? decode(kept.data) {
                return Loaded(value: value, source: .cache, confirmed: kept.confirmed)
            }
            if let shipped = snapshot?.read(key), let value = try? decode(shipped.data) {
                return Loaded(value: value, source: .snapshot, confirmed: nil)
            }
            throw error
        }
    }
}
