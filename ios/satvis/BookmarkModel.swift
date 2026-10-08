import Foundation
import Observation
import SatvisCore
import SatvisData

/// The saved bookmarks and the opened links, and their pictures, kept on the
/// device (src/stores/bookmarks.ts, ADR 0011). The demos are the web app's and
/// ship with it. Each edit is `BookmarkLists`', kept at once.
@Observable
final class BookmarkModel {
    private(set) var lists: BookmarkLists
    /// By bookmark id, as JPEG; a demo's is the site's (`Session.demoPictures`).
    private(set) var pictures: [String: Data] = [:]
    /// Deleted bookmarks whose pictures stay while the delete can be undone.
    @ObservationIgnored private var undoable: Set<String> = []
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

    /// With its picture, taken before.
    func save(name: String, scene: SceneLink, picture: Data?) -> Bookmark {
        let bookmark = lists.save(name: name, scene: scene, id: newID(.saved), at: Self.now())
        if let picture {
            setPicture(bookmark.id, picture)
        }
        persist()
        return bookmark
    }

    /// Its picture comes later, by `setPicture`.
    func recordOpened(name: String, scene: SceneLink) -> Bookmark {
        defer { persist() }
        return lists.recordOpened(name: name, scene: scene, id: newID(.opened), at: Self.now())
    }

    func keep(_ id: String, name: String) -> Bookmark? {
        defer { persist() }
        return lists.keep(id, name: name, at: Self.now())
    }

    func rename(_ id: String, to name: String) {
        lists.rename(id, to: name)
        persist()
    }

    /// Its picture stays until `release`, for `restore` to bring back.
    func remove(_ id: String) {
        lists.remove(id)
        undoable.insert(id)
        persist()
    }

    func restore(_ bookmark: Bookmark) {
        lists.restore(bookmark)
        undoable.remove(bookmark.id)
        persist()
    }

    /// The delete can no longer be undone: its picture goes.
    func release(_ id: String) {
        guard undoable.remove(id) != nil else {
            return
        }
        persist()
    }

    func forget(_ id: String) {
        lists.forget(id)
        persist()
    }

    /// An opened link's picture arrives after it.
    func setPicture(_ id: String, _ data: Data) {
        guard lists.ids.contains(id) else {
            return
        }
        pictures[id] = data
        storage.keepPicture(data, for: id)
    }

    private func persist() {
        let kept = lists.ids.union(undoable)
        pictures = pictures.filter { kept.contains($0.key) }
        storage.keep(lists, keepingPictures: kept)
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
