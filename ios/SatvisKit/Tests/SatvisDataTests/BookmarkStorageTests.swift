import Foundation
import SatvisCore
import Testing

@testable import SatvisData

@Suite struct BookmarkStorageTests {
    @Test func keepsTheListsAndTheirPictures() throws {
        let storage = BookmarkStorage(directory: URL.temporaryDirectory.appending(path: "bookmarks-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: storage.directory) }
        #expect(storage.lists() == BookmarkLists())

        var lists = BookmarkLists()
        lists.save(name: "Home", path: "/", query: ["tags": "GNSS", "scene": "Sky"], id: "saved-1", at: 1)
        lists.recordOpened(name: "OT satellites", path: "/ot", query: ["tags": "OT"], id: "opened-1", at: 2)
        storage.keep(lists)
        storage.keepPicture(Data([1, 2, 3]), for: "saved-1")
        storage.keepPicture(Data([4]), for: "opened-1")
        #expect(storage.lists() == lists)
        #expect(storage.picture("saved-1") == Data([1, 2, 3]))

        lists.forget("opened-1")
        storage.keep(lists)
        #expect(storage.picture("opened-1") == nil)
        #expect(storage.picture("saved-1") != nil)
    }

    @Test func startsEmptyOnAFileItCannotRead() throws {
        let storage = BookmarkStorage(directory: URL.temporaryDirectory.appending(path: "bookmarks-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: storage.directory) }
        try FileManager.default.createDirectory(at: storage.directory, withIntermediateDirectories: true)
        try Data("{".utf8).write(to: storage.directory.appending(path: "bookmarks.json"))
        #expect(storage.lists() == BookmarkLists())
    }
}
