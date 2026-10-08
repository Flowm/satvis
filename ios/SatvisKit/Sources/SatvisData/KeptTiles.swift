import Foundation

/// Map tiles kept for good once fetched, rather than in `TileFetcher`'s cache,
/// which the system purges when it likes: Natural Earth's finer levels, at most
/// 2,730 tiles and 17 MB, so that a place seen once shows offline. In Application
/// Support by host and path, but out of the user's backups, as anything that can
/// be fetched again.
public struct KeptTiles: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public static func applicationSupport() -> KeptTiles {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? URL.temporaryDirectory
        var directory = base.appending(path: "Tiles", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return KeptTiles(directory: directory)
    }

    /// The tile kept for `url`, if any.
    public func read(_ url: URL) -> Data? {
        try? Data(contentsOf: file(url))
    }

    /// Keeps a tile; best effort, as a tile not kept is fetched again.
    public func keep(_ data: Data, for url: URL) {
        let file = file(url)
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }

    private func file(_ url: URL) -> URL {
        directory.appending(path: (url.host() ?? "local") + url.path(percentEncoded: false))
    }
}
