import Foundation

/// What the worker serves, kept on disk in its own layout: `groups.json`,
/// `gp/<group>.json` and `site/<path>`, each beside a sidecar with its ETag and
/// when it was confirmed. The same layout read-only is the snapshot shipped in
/// the app.
public struct PayloadStore: Sendable {
    public enum Key: Sendable, Hashable {
        case index
        case group(String)
        /// A static file the site serves, by its path there.
        case file(String)

        var path: String {
            switch self {
            case .index: "groups.json"
            case .group(let name): "gp/\(name).json"
            case .file(let path): "site/\(path)"
            }
        }
    }

    public struct Entry: Sendable, Equatable {
        public var data: Data
        public var etag: String?
        /// When the worker last confirmed this copy. Nil for the snapshot.
        public var confirmed: Date?
    }

    private struct Sidecar: Codable {
        var etag: String?
        var confirmed: Date?
    }

    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// Kept in Application Support rather than Caches: offline launches and pass
    /// notifications depend on it, and the system purges Caches when it likes.
    /// But out of the user's backups, as Apple's storage guidelines ask of what
    /// can be downloaded again: megabytes of element sets, stale by any restore.
    public static func applicationSupport() throws -> PayloadStore {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var directory = base.appending(path: "GP", directoryHint: .isDirectory)
        // Best effort: a copy backed up is better than none kept.
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return PayloadStore(directory: directory)
    }

    /// The snapshot shipped in the app (ios/scripts/snapshot.sh).
    public static var shipped: PayloadStore? {
        Bundle.module.url(forResource: "Snapshot", withExtension: nil).map(PayloadStore.init(directory:))
    }

    public func read(_ key: Key) -> Entry? {
        guard let data = try? Data(contentsOf: url(key)) else {
            return nil
        }
        let sidecar = (try? Data(contentsOf: sidecarURL(key))).flatMap { try? JSONDecoder().decode(Sidecar.self, from: $0) }
        return Entry(data: data, etag: sidecar?.etag, confirmed: sidecar?.confirmed)
    }

    public func write(_ key: Key, data: Data, etag: String?, confirmed: Date) throws {
        let file = url(key)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        try confirm(key, etag: etag, at: confirmed)
    }

    /// Records that the worker answered 304 for the copy already held.
    public func confirm(_ key: Key, etag: String?, at date: Date) throws {
        try JSONEncoder().encode(Sidecar(etag: etag, confirmed: date)).write(to: sidecarURL(key), options: .atomic)
    }

    private func url(_ key: Key) -> URL {
        directory.appending(path: key.path)
    }

    private func sidecarURL(_ key: Key) -> URL {
        directory.appending(path: key.path + ".meta")
    }
}
