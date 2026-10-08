import Foundation
import SatvisCore

/// The saved bookmarks and opened links, kept on the device and synced nowhere,
/// as the web app keeps them per browser (ADR 0011): the lists as one file, each
/// picture a JPEG beside it by the bookmark's id. In Application Support, and in
/// the user's backups: a bookmark is the user's own, and cannot be fetched again.
public struct BookmarkStorage: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public static func applicationSupport() -> BookmarkStorage {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? URL.temporaryDirectory
        return BookmarkStorage(directory: base.appending(path: "Bookmarks", directoryHint: .isDirectory))
    }

    private var listsFile: URL { directory.appending(path: "bookmarks.json") }

    /// What was kept, or none for a file this build cannot read.
    public func lists() -> BookmarkLists {
        (try? Data(contentsOf: listsFile)).flatMap { try? JSONDecoder().decode(BookmarkLists.self, from: $0) } ?? BookmarkLists()
    }

    /// Keeps the lists, and drops the pictures but those of `pictures`, by default
    /// the bookmarks on them: a deleted one's waits while it can be undone.
    public func keep(_ lists: BookmarkLists, keepingPictures pictures: Set<String>? = nil) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(lists) else {
            return
        }
        try? data.write(to: listsFile, options: .atomic)
        let ids = pictures ?? lists.ids
        for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        where file.pathExtension == "jpg" && !ids.contains(file.deletingPathExtension().lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// A bookmark's picture, if it has one.
    public func picture(_ id: String) -> Data? {
        try? Data(contentsOf: pictureFile(id))
    }

    /// Best effort: a bookmark without its picture still opens.
    public func keepPicture(_ data: Data, for id: String) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: pictureFile(id), options: .atomic)
    }

    private func pictureFile(_ id: String) -> URL {
        // An id is the app's own, but a file name it must not escape.
        directory.appending(path: id.replacingOccurrences(of: "/", with: "_") + ".jpg")
    }
}
