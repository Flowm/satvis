import Foundation
import SatvisCore

/// Where the app gets GP data, and the site's static files beside it: the worker
/// when it answers, the copy kept on disk when it does not, and a snapshot, if
/// given one, before there is one: the UI tests' fixed catalog. The app ships
/// none, so a first launch offline has nothing until the worker answers. Every request revalidates the kept copy
/// with its ETag, so a current copy costs a 304 and no body.
public actor GroupRepository {
    public enum Source: Sendable, Equatable {
        /// Fetched or confirmed by the worker just now.
        case worker
        /// The kept copy; the worker could not be asked.
        case cache
        /// The snapshot; nothing has been fetched yet.
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
        try await load(.group(group), fetch: { try await self.client.group(group, ifNoneMatch: $0) }, decode: GPRecord.decodeGroup)
    }

    /// The group index as last kept, or the snapshot's, without asking the worker: what
    /// to show while it is asked.
    public func keptIndex() -> Loaded<GroupIndex>? {
        kept(.index) { try JSONDecoder().decode(GroupIndex.self, from: $0) }
    }

    /// A group as last kept, or the snapshot's, without asking the worker.
    public func keptRecords(of group: String) -> Loaded<[GPRecord]>? {
        kept(.group(group), decode: GPRecord.decodeGroup)
    }

    /// The star map as last kept, without asking the worker. Nil while any face
    /// is missing.
    public func keptStarMap() -> [Data]? {
        let faces = Self.starMapFaces.compactMap { store.read(.file($0))?.data }
        return faces.count == Self.starMapFaces.count ? faces : nil
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
        for path in Self.starMapFaces {
            guard let loaded = try? await image(path) else {
                return nil
            }
            faces.append(loaded.value)
        }
        return faces
    }

    private static let starMapFaces = ["px", "mx", "py", "my", "pz", "mz"].map { "data/starmap/deepstar_2020_1024_\($0).webp" }

    private func kept<Value: Sendable>(_ key: PayloadStore.Key, decode: (Data) throws -> Value) -> Loaded<Value>? {
        if let kept = store.read(key), let value = try? decode(kept.data) {
            return Loaded(value: value, source: .cache, confirmed: kept.confirmed)
        }
        if let snapshotted = snapshot?.read(key), let value = try? decode(snapshotted.data) {
            return Loaded(value: value, source: .snapshot, confirmed: nil)
        }
        return nil
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
                // Another load of the same key may have written newer data while
                // this one waited; its ETag must not be overwritten with ours.
                if let current = store.read(key), current.etag != kept.etag {
                    return Loaded(value: try decode(current.data), source: .worker, confirmed: current.confirmed)
                }
                let confirmed = now()
                try? store.confirm(key, etag: kept.etag, at: confirmed)
                return Loaded(value: try decode(kept.data), source: .worker, confirmed: confirmed)
            }
        } catch {
            if let fallback = self.kept(key, decode: decode) {
                return fallback
            }
            throw error
        }
    }
}
