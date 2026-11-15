import Foundation
import Testing

@testable import SatvisRender

@MainActor
@Suite struct TerrainTilesTests {
    /// Answers every request with the fixture's tile, except those of `failing`.
    private static func store(failing: [TileKey] = [], retryInterval: TimeInterval = 60) throws -> (TerrainTiles, Requests) {
        let data = try Fixtures.data("10-1086-781", ext: "terrain")
        let failing = Set(failing.compactMap { Terrain.url($0) })
        let requests = Requests()
        let tiles = TerrainTiles(retryInterval: retryInterval)
        tiles.loader = { request in
            await requests.add(cancelled: Task.isCancelled)
            return failing.contains(request.url) ? nil : data
        }
        return (tiles, requests)
    }

    /// Waits for `done`, five seconds at most.
    private static func waitUntil(_ done: () async -> Bool) async throws {
        for _ in 0..<500 where await !done() {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private static let root = TileKey(level: 0, x: 0, y: 0)

    @Test func asksForATileOnce() async throws {
        let (tiles, requests) = try Self.store()
        #expect(tiles.source(under: Self.root, offset: 0, frame: 1) == nil)
        #expect(tiles.source(under: Self.root, offset: 0, frame: 2) == nil)
        try await Self.waitUntil { tiles.revision == 1 }
        #expect(tiles.source(under: Self.root, offset: 0, frame: 3)?.key == Self.root)
        #expect(await requests.count == 1)
    }

    // A failed tile has its nearest loaded ancestor stand in, and keeps it while
    // asked for again once the retry interval is up.
    @Test func standsInForAFailedTileAndRetriesIt() async throws {
        let child = TileKey(level: 1, x: 0, y: 0)
        let (tiles, requests) = try Self.store(failing: [child], retryInterval: 0.2)
        var changes = 0
        tiles.onChange = { changes += 1 }
        _ = tiles.source(under: Self.root, offset: 0, frame: 1)
        try await Self.waitUntil { tiles.revision == 1 }
        #expect(tiles.source(under: child, offset: 0, frame: 2) == nil)
        try await Self.waitUntil { changes == 2 }
        #expect(tiles.source(under: child, offset: 0, frame: 3)?.key == Self.root)
        #expect(await requests.count == 2)

        // Woken once the interval is up, for a still frame loop to ask again.
        try await Self.waitUntil { changes == 3 }
        #expect(changes == 3)
        let gate = Gate()
        let fetch = try #require(tiles.loader)
        tiles.loader = { request in
            await gate.wait()
            return await fetch(request)
        }
        #expect(tiles.source(under: child, offset: 0, frame: 4)?.key == Self.root)
        #expect(tiles.source(under: child, offset: 0, frame: 5)?.key == Self.root)
        await gate.open()
        try await Self.waitUntil { await requests.count == 3 }
        #expect(await requests.count == 3)
    }

    // A tile nothing wanted for 60 frames is cancelled, what it brings dropped, and
    // asked for anew when wanted again.
    @Test func cancelsATileNoLongerWanted() async throws {
        let (tiles, requests) = try Self.store()
        let gate = Gate()
        let fetch = try #require(tiles.loader)
        tiles.loader = { request in
            await gate.wait()
            return await fetch(request)
        }
        _ = tiles.source(under: Self.root, offset: 0, frame: 1)
        tiles.evict(frame: 61)
        tiles.evict(frame: 62)
        await gate.open()
        try await Self.waitUntil { await requests.count == 1 }
        #expect(await requests.cancelled == 1)
        try await Task.sleep(for: .milliseconds(50))
        #expect(tiles.revision == 0)
        #expect(tiles.source(under: Self.root, offset: 0, frame: 63) == nil)
        try await Self.waitUntil { tiles.revision == 1 }
        #expect(await requests.count == 2)
    }

    // Past the budget, the tiles wanted longest ago go, never one this frame uses.
    @Test func keepsTheTilesThisFrameUses() async throws {
        let (tiles, requests) = try Self.store()
        let keys = (0..<97).map { TileKey(level: 7, x: $0, y: 0) }
        for key in keys {
            _ = tiles.source(under: key, offset: 0, frame: 1)
        }
        try await Self.waitUntil { tiles.revision == 97 }
        for key in keys {
            _ = tiles.source(under: key, offset: 0, frame: 2)
        }
        tiles.evict(frame: 2)
        #expect(keys.allSatisfy { tiles.source(under: $0, offset: 0, frame: 3) != nil })
        #expect(await requests.count == 97)

        tiles.evict(frame: 4)
        let kept = keys.filter { tiles.source(under: $0, offset: 0, frame: 5) != nil }
        #expect(kept.count == 96)
    }
}

/// Counts the loads asked for, and those already cancelled when they ran.
private actor Requests {
    private(set) var count = 0
    private(set) var cancelled = 0

    func add(cancelled: Bool) {
        count += 1
        if cancelled {
            self.cancelled += 1
        }
    }
}
