import Foundation
import Testing

@testable import SatvisCore

/// Bookmarks against the web app's own (src/modules/util/bookmarks.ts, through
/// scripts/parity/generate.mjs), then the edits the panel makes.
@Suite struct BookmarkParityTests {
    private struct Fixture: Decodable {
        struct Summary: Decodable {
            let what: String
            let `where`: String
            let time: String?
        }

        struct Case: Decodable {
            let preset: String
            let query: [String: String]
            let summary: Summary
            let name: String
        }

        struct Age: Decodable {
            let ago: Double
            let text: String
        }

        let now: String
        let summaries: [Case]
        let ages: [Age]
        let openedLimit: Int
    }

    private struct Root: Decodable {
        struct Links: Decodable {
            let presets: [String: [String: String]]
        }

        let bookmarks: Fixture
        let links: Links
    }

    private static func root() throws -> Root {
        try JSONDecoder().decode(Root.self, from: Parity.fixture("parity"))
    }

    @Test func describesASceneTheWayTheWebAppDoes() throws {
        let root = try Self.root()
        let now = try Date(root.bookmarks.now, strategy: .iso8601)
        #expect(root.bookmarks.summaries.count > 20)
        for test in root.bookmarks.summaries {
            let summary = Bookmarks.summarize(test.query, presetDefaults: try #require(root.links.presets[test.preset]), now: now)
            let label = "\(test.preset) \(test.query)"
            #expect(summary.what == test.summary.what, "\(label)")
            #expect(summary.where == test.summary.where, "\(label)")
            #expect(summary.time == test.summary.time, "\(label)")
            #expect(Bookmarks.defaultName(summary) == test.name, "\(label)")
        }
    }

    @Test func saysHowLongAgoAsTheWebAppDoes() throws {
        let root = try Self.root()
        let now = try Date(root.bookmarks.now, strategy: .iso8601).timeIntervalSince1970 * 1000
        for age in root.bookmarks.ages {
            #expect(Bookmarks.timeAgo(now - age.ago, now: now) == age.text, "\(age.ago) ms ago")
        }
        #expect(Bookmarks.openedLimit == root.bookmarks.openedLimit)
    }

    @Test func shipsTheWebAppsDemos() {
        #expect(Bookmarks.demos.map(\.id) == ["demo-globe", "demo-iss", "demo-sky"])
        #expect(Bookmarks.demos.allSatisfy { $0.kind == .demo && $0.thumbnail != nil })
        // The first is the default view.
        #expect(Bookmarks.demos.first?.query == [:])
        #expect(Bookmarks.ownedParameters.isSuperset(of: LinkCodec.parameters))
        #expect(Bookmarks.ownedParameters.contains("stars") && !Bookmarks.ownedParameters.contains("framems"))
    }
}

@Suite struct BookmarkListTests {
    private static func opened(_ query: [String: String], path: String = "/") -> Bookmark {
        Bookmark(id: query.description + path, kind: .opened, name: "", scene: SceneLink(path: path, query: query), at: 0)
    }

    @Test func keepsEachOpenedLinkOnceNewestFirst() {
        let a = Self.opened(["tags": "GNSS"])
        let b = Self.opened(["scene": "2D", "tags": "Starlink"])
        var again = Self.opened(["tags": "Starlink", "scene": "2D"])
        again.id = "again"
        #expect(Bookmarks.withOpened(Bookmarks.withOpened([a], b), again).map(\.id) == ["again", a.id])
        #expect(Bookmarks.withOpened([Self.opened(["tags": "GNSS"], path: "/ot")], a).count == 2)
        var links: [Bookmark] = []
        for index in 0..<(Bookmarks.openedLimit + 3) {
            links = Bookmarks.withOpened(links, Self.opened(["sats": "SAT \(index)"]))
        }
        #expect(links.count == Bookmarks.openedLimit)
        #expect(links.first?.query["sats"] == "SAT \(Bookmarks.openedLimit + 2)")
    }

    @Test func savingALinkTakesItOffRecent() {
        var lists = BookmarkLists()
        let link = lists.recordOpened(name: "GNSS satellites", scene: SceneLink(path: "/", query: ["tags": "GNSS"]), id: "o1", at: 1)
        lists.save(name: "Mine", scene: SceneLink(path: "/", query: ["tags": "GNSS"]), id: "s1", at: 2)
        #expect(lists.opened.isEmpty)
        #expect(lists.saved.map(\.id) == ["s1"])
        lists.recordOpened(name: "x", scene: SceneLink(path: "/", query: ["tags": "OT"]), id: "o2", at: 3)
        let kept = lists.keep("o2", name: "Kept", at: 4)
        #expect(kept?.id == "o2" && kept?.kind == .saved)
        #expect(lists.saved.map(\.id) == ["o2", "s1"] && lists.opened.isEmpty)
        #expect(link.kind == .opened)
    }

    @Test func renamesUndeletesAndKeepsABlankNameOut() {
        var lists = BookmarkLists()
        let old = lists.save(name: "Old", scene: SceneLink(path: "/", query: ["tags": "A"]), id: "a", at: 1)
        lists.save(name: "New", scene: SceneLink(path: "/", query: ["tags": "B"]), id: "b", at: 2)
        lists.rename("a", to: "  ")
        lists.rename("b", to: " Home ")
        #expect(lists.saved.map(\.name) == ["Home", "Old"])
        lists.remove("a")
        lists.restore(old)
        lists.restore(old)
        #expect(lists.saved.map(\.id) == ["b", "a"])
    }

    @Test func opensWithTheParametersTheLinkCarriedPastIt() {
        let bookmark = Bookmark(id: "x", kind: .saved, name: "", scene: SceneLink(path: "/ot", query: ["stars": "DeepStar2K", "tags": "OT", "scene": "Sky"]), at: 0)
        let link = bookmark.scene.link(carrying: [LinkQuery.Item(key: "framems", values: ["16"])])
        #expect(link.preset == "ot")
        #expect(link.query.string == "framems=16&tags=OT&scene=Sky&stars=DeepStar2K")
        let query = LinkQuery(parsing: "framems=16&tags=GNSS&tags=OT&utm_source=x&time=2026-10-04T08:52Z")
        #expect(Bookmarks.ownedQuery(of: query) == ["tags": "GNSS", "time": "2026-10-04T08:52Z"])
        #expect(Bookmarks.carriedItems(of: query).map(\.key) == ["framems", "utm_source"])
        #expect(Bookmarks.path(preset: nil) == "/" && Bookmarks.path(preset: "ot") == "/ot")
    }
}
