import Foundation
import SatvisCore
import Synchronization
import Testing

@testable import SatvisData

private let index = #"{"updated": "", "groups": [{"name": "weather", "tags": ["Weather"]}]}"#

private func weather(_ name: String) -> String {
    #"""
    [{"OBJECT_NAME": "\#(name)", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": 1, "MEAN_MOTION": 14.2,
      "ECCENTRICITY": 0.001, "INCLINATION": 98, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0}]
    """#
}

private func temporaryStore() -> PayloadStore {
    PayloadStore(directory: FileManager.default.temporaryDirectory.appending(path: "SatvisDataTests-\(UUID().uuidString)"))
}

/// What a loader handed over, in order: each group's record names.
private final class Delivered: Sendable {
    let groups = Mutex<[(group: String, names: [String])]>([])

    var deliver: GroupLoader.Deliver {
        { group, records in self.groups.withLock { $0.append((group, records.map(\.name))) } }
    }

    var names: [[String]] { groups.withLock { $0.map(\.names) } }
}

@Suite struct GroupLoaderTests {
    // The app ships no catalog: offline, nothing until the worker answers once.
    @Test func asksAgainForAnIndexUntilTheWorkerAnswersOnAFirstLaunchOffline() async throws {
        let worker = StubWorker([.offline, .offline, .json(index, etag: "a")])
        let waits = Mutex<[Duration]>([])
        let notices = Mutex(0)
        let loader = GroupLoader(
            repository: GroupRepository(client: worker.client, store: temporaryStore(), snapshot: nil),
            sleep: { duration in waits.withLock { $0.append(duration) } }
        )

        let first = await loader.firstIndex { notices.withLock { $0 += 1 } }
        #expect(first?.groups.map(\.name) == ["weather"])
        #expect(waits.withLock { $0 } == [.seconds(10), .seconds(10)])
        #expect(notices.withLock { $0 } == 2)
        #expect(worker.requests.withLock { $0.count } == 3)
    }

    @Test func startsFromTheKeptIndexWithoutAskingTheWorker() async throws {
        let store = temporaryStore()
        try store.write(.index, data: Data(index.utf8), etag: "a", confirmed: .distantPast)
        let worker = StubWorker([])
        let loader = GroupLoader(repository: GroupRepository(client: worker.client, store: store, snapshot: nil))

        #expect(await loader.firstIndex {}?.groups.map(\.name) == ["weather"])
        #expect(worker.requests.withLock { $0.isEmpty })
    }

    @Test func loadsAGroupAskedForTwiceWhileItLoadsOnce() async throws {
        let gate = Gate()
        let requests = Mutex(0)
        let client = WorkerClient(baseURL: URL(string: "https://satvis.test/")!) { request in
            requests.withLock { $0 += 1 }
            await gate.pass()
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            return (Data(weather("METEOR").utf8), response)
        }
        let loader = GroupLoader(repository: GroupRepository(client: client, store: temporaryStore(), snapshot: nil))
        let first = Delivered()
        let second = Delivered()

        let asking = Task { await loader.load(["weather"], deliver: first.deliver) }
        while requests.withLock({ $0 }) == 0 {
            await Task.yield()
        }
        let joining = Task {
            await loader.load(["weather"], deliver: second.deliver)
            // It returns with the group taken, by the first ask's deliver.
            return first.names
        }
        try await Task.sleep(for: .milliseconds(50))
        gate.open()
        await asking.value

        #expect(await joining.value == [["METEOR"]])
        #expect(requests.withLock { $0 } == 1)
        #expect(second.names.isEmpty)
    }

    @Test func handsOverTheKeptCopyThenReplacesAStaleOneWithTheWorkers() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather("OLD").utf8), etag: "a", confirmed: .distantPast)
        let gate = Gate()
        let worker = StubWorker([.json(weather("NEW"), etag: "b")], gate: gate)
        let loader = GroupLoader(repository: GroupRepository(client: worker.client, store: store, snapshot: nil))
        let delivered = Delivered()

        // An answer the worker has ready could be handed over before `load` returns.
        await loader.load(["weather"], deliver: delivered.deliver)
        #expect(delivered.names == [["OLD"]])
        gate.open()
        while delivered.names.count < 2 {
            await Task.yield()
        }
        #expect(delivered.names == [["OLD"], ["NEW"]])
        #expect(worker.requests.withLock { $0.map { $0.value(forHTTPHeaderField: "If-None-Match") } } == ["a"])
        #expect(store.read(.group("weather"))?.etag == "b")
    }

    // Revalidating asks only about groups loaded, and a 304 hands the same records over again.
    @Test func keepsTheRecordsWhenRevalidationIsAnsweredUnchanged() async throws {
        let worker = StubWorker([.json(weather("METEOR"), etag: "a"), .notModified])
        let loader = GroupLoader(repository: GroupRepository(client: worker.client, store: temporaryStore(), snapshot: nil))
        let delivered = Delivered()

        await loader.load(["weather"], deliver: delivered.deliver)
        await loader.revalidate(["weather", "gps"], deliver: delivered.deliver)

        #expect(delivered.names == [["METEOR"], ["METEOR"]])
        #expect(worker.requests.withLock { $0.map { $0.url!.path } } == ["/api/gp/weather.json", "/api/gp/weather.json"])
        #expect(worker.requests.withLock { $0.last?.value(forHTTPHeaderField: "If-None-Match") } == "a")
    }

    // A group that failed to load is asked for again, not counted as loaded.
    @Test func asksAgainForAGroupThatDidNotLoad() async throws {
        let worker = StubWorker([.offline, .json(weather("METEOR"), etag: "a")])
        let loader = GroupLoader(repository: GroupRepository(client: worker.client, store: temporaryStore(), snapshot: nil))
        let delivered = Delivered()

        await loader.load(["weather"], deliver: delivered.deliver)
        await loader.revalidate(["weather"], deliver: delivered.deliver)
        #expect(delivered.names.isEmpty)
        await loader.load(["weather"], deliver: delivered.deliver)
        #expect(delivered.names == [["METEOR"]])
    }

    // A background refresh wants the newest element sets, but predicts from the kept
    // ones rather than none.
    @Test func readsTheKeptCopyWhenTheWorkerFails() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather("METEOR").utf8), etag: "a", confirmed: .distantPast)
        let worker = StubWorker([.status(503), .offline])
        let loader = GroupLoader(repository: GroupRepository(client: worker.client, store: store, snapshot: nil))

        let catalog = await loader.catalog(of: ["weather", "gps"])
        #expect(catalog.entries.values.map(\.name) == ["METEOR"])
        #expect(catalog.entries.values.map(\.groups) == [["weather"]])
        #expect(worker.requests.withLock { $0.count } == 2)
    }
}
