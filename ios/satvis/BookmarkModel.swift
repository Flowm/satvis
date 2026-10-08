import Foundation
import Observation
import SatvisCore
import SatvisData

/// The saved bookmarks and the opened links, and their pictures, kept on the
/// device (src/stores/bookmarks.ts, ADR 0011). The demos are the web app's and
/// ship with it.
@Observable
final class BookmarkModel {
    private(set) var lists: BookmarkLists
    /// By bookmark id, as JPEG; a demo's is on the site instead.
    private(set) var pictures: [String: Data] = [:]
    @ObservationIgnored private let storage: BookmarkStorage
    /// Tells apart two bookmarks made in the same millisecond.
    @ObservationIgnored private var nextID = 0

    init(storage: BookmarkStorage = .applicationSupport()) {
        self.storage = storage
        lists = storage.lists()
        for id in lists.ids {
            pictures[id] = storage.picture(id)
        }
    }

    var saved: [Bookmark] { lists.saved }
    var opened: [Bookmark] { lists.opened }

    /// Saves a scene under `name`, and takes its link off the opened ones.
    func save(name: String, path: String, query: [String: String], picture: Data?) -> Bookmark {
        let bookmark = lists.save(name: name, path: path, query: query, id: newID(.saved), at: Self.now())
        if let picture {
            setPicture(bookmark.id, picture)
        }
        persist()
        return bookmark
    }

    /// Records the link a visit started with.
    func recordOpened(name: String, path: String, query: [String: String]) -> Bookmark {
        defer { persist() }
        return lists.recordOpened(name: name, path: path, query: query, id: newID(.opened), at: Self.now())
    }

    /// Saves an opened link under `name`, keeping its id and picture.
    func keep(_ id: String, name: String) -> Bookmark? {
        defer { persist() }
        return lists.keep(id, name: name, at: Self.now())
    }

    func rename(_ id: String, to name: String) {
        lists.rename(id, to: name)
        persist()
    }

    /// Deletes a saved bookmark, its picture kept until the panel lets the undo go.
    func remove(_ id: String) {
        lists.remove(id)
        persist(prunes: false)
    }

    func restore(_ bookmark: Bookmark) {
        lists.restore(bookmark)
        persist()
    }

    func forget(_ id: String) {
        lists.forget(id)
        persist()
    }

    /// Gives a bookmark its picture, which an opened link's arrives after it.
    func setPicture(_ id: String, _ data: Data) {
        guard lists.ids.contains(id) else {
            return
        }
        pictures[id] = data
        storage.keepPicture(data, for: id)
    }

    private func persist(prunes: Bool = true) {
        if prunes {
            pictures = pictures.filter { lists.ids.contains($0.key) }
        }
        storage.keep(lists, keepingPictures: prunes ? lists.ids : Set(pictures.keys))
    }

    /// Unique within the device's lists, which are all it is compared against.
    private func newID(_ kind: Bookmark.Kind) -> String {
        nextID += 1
        return "\(kind.rawValue)-\(String(Int(Self.now()), radix: 36))-\(String(nextID, radix: 36))"
    }

    private static func now() -> Double {
        (Date().timeIntervalSince1970 * 1000).rounded(.down)
    }
}
