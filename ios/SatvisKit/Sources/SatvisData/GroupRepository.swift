import Foundation
import SatvisCore

/// Where the app gets GP data, and the site's static files beside it: the worker
/// when it answers, the copy kept on disk when it does not, and a snapshot, if
/// given one, before there is one: the UI tests' fixed catalog. The app ships
/// none, so a first launch offline has nothing until the worker answers. Every request revalidates the kept copy
/// with its ETag, so a current copy costs a 304 and no body.
public actor GroupRepository {
    private let client: WorkerClient
    private let store: PayloadStore
    private let snapshot: PayloadStore?
    /// Each group's records with the ETag they were decoded under, so a payload
    /// confirmed unchanged is decoded once: Starlink's took 0.3 s of an iPad mini's
    /// CPU. Kept for the session, as the catalog keeps every group it loads: 152
    /// bytes a record, 2.5 MB for every active satellite, the strings and bags shared.
    private var decodedGroups: [String: (etag: String, records: [GPRecord])] = [:]

    public init(client: WorkerClient, store: PayloadStore, snapshot: PayloadStore?) {
        self.client = client
        self.store = store
        self.snapshot = snapshot
    }

    public func index() async throws -> GroupIndex {
        try await load(.index, fetch: { try await self.client.index(ifNoneMatch: $0) }, decode: { data, _ in try JSONDecoder().decode(GroupIndex.self, from: data) })
    }

    public func records(of group: String) async throws -> [GPRecord] {
        try await load(.group(group), fetch: { try await self.client.group(group, ifNoneMatch: $0) }, decode: decoder(of: group))
    }

    /// The group index as last kept, or the snapshot's, without asking the worker: what
    /// to show while it is asked.
    func keptIndex() -> GroupIndex? {
        kept(.index) { data, _ in try JSONDecoder().decode(GroupIndex.self, from: data) }
    }

    /// A group as last kept, or the snapshot's, without asking the worker.
    func keptRecords(of group: String) -> [GPRecord]? {
        kept(.group(group), decode: decoder(of: group))
    }

    /// Decodes a payload of `group`, or returns the records last decoded from the
    /// payload with the same ETag. A payload without one is always decoded.
    private func decoder(of group: String) -> (Data, String?) throws -> [GPRecord] {
        { data, etag in
            if let etag, let decoded = self.decodedGroups[group], decoded.etag == etag {
                return decoded.records
            }
            let records = try GPRecord.decodeGroup(data)
            if let etag {
                self.decodedGroups[group] = (etag, records)
            }
            return records
        }
    }

    /// A star map as last kept (`map`'s `drawn`), or the snapshot's, without
    /// asking the worker. Nil while any face is missing.
    public func keptStarMap(_ map: StarMapName) -> [Data]? {
        let paths = Self.starMapFaces(map)
        let faces = paths.compactMap { kept(.file($0)) { data, _ in data } }
        return faces.count == paths.count ? faces : nil
    }

    /// An image as last kept, without asking the site.
    public func keptImage(_ path: String) -> Data? {
        store.read(.file(path))?.data
    }

    /// An image the site serves. Never shipped, so absent until fetched once.
    public func image(_ path: String) async throws -> Data {
        try await load(.file(path), fetch: { try await self.client.image(path, ifNoneMatch: $0) }, decode: { data, _ in data })
    }

    /// The six faces of one of satvis's own star maps, `map`'s `drawn` (NASA SVS
    /// Deep Star Maps 2020, built by `pnpm update-starmap`), in the order a cube
    /// texture takes them: +X, −X, +Y, −Y, +Z, −Z. Nil while any is missing.
    public func starMap(_ map: StarMapName) async -> [Data]? {
        var faces: [Data] = []
        for path in Self.starMapFaces(map) {
            guard let face = try? await image(path) else {
                return nil
            }
            faces.append(face)
        }
        return faces
    }

    /// The web app's paths for them (`starMapSources`): faces 1,024 or 2,048 pixels a side.
    public static func starMapFaces(_ map: StarMapName) -> [String] {
        let side = map.drawn == .deepStar2K ? 2048 : 1024
        return ["px", "mx", "py", "my", "pz", "mz"].map { "data/starmap/deepstar_2020_\(side)_\($0).webp" }
    }

    /// `decode` takes the payload and its ETag.
    private func kept<Value: Sendable>(_ key: PayloadStore.Key, decode: (Data, String?) throws -> Value) -> Value? {
        if let kept = store.read(key), let value = try? decode(kept.data, kept.etag) {
            return value
        }
        if let snapshotted = snapshot?.read(key), let value = try? decode(snapshotted.data, nil) {
            return value
        }
        return nil
    }

    private func load<Value: Sendable>(
        _ key: PayloadStore.Key,
        fetch: (String?) async throws -> WorkerClient.Answer,
        decode: (Data, String?) throws -> Value
    ) async throws -> Value {
        let kept = store.read(key)
        do {
            switch try await fetch(kept?.etag) {
            case .fresh(let data, let etag):
                // Decoded before it is kept, so a malformed answer never replaces a good copy.
                let value = try decode(data, etag)
                try? store.write(key, data: data, etag: etag)
                return value
            case .unchanged:
                guard let kept else {
                    throw WorkerError.status(304, key.path)
                }
                // Another load of the same key may have written newer data while
                // this one waited.
                let current = store.read(key) ?? kept
                return try decode(current.data, current.etag)
            }
        } catch {
            if let fallback = self.kept(key, decode: decode) {
                return fallback
            }
            throw error
        }
    }
}
