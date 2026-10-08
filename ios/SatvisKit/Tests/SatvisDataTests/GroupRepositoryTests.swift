import Foundation
import SatvisCore
import Synchronization
import Testing

@testable import SatvisData

/// A worker that answers from a script, and remembers what it was asked.
final class StubWorker: Sendable {
    enum Reply: Sendable {
        case json(String, etag: String?)
        case image(Data, etag: String?)
        case notModified
        case html
        case status(Int)
        case offline
    }

    private let replies: Mutex<[Reply]>
    let requests = Mutex<[URLRequest]>([])

    init(_ replies: [Reply]) {
        self.replies = Mutex(replies)
    }

    var client: WorkerClient {
        WorkerClient(baseURL: URL(string: "https://satvis.test/")!) { request in
            self.requests.withLock { $0.append(request) }
            let reply = self.replies.withLock { $0.isEmpty ? .offline : $0.removeFirst() }
            func response(_ status: Int, _ headers: [String: String]) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            }
            switch reply {
            case .json(let body, let etag):
                var headers = ["Content-Type": "application/json"]
                headers["ETag"] = etag
                return (Data(body.utf8), response(200, headers))
            case .image(let data, let etag):
                var headers = ["Content-Type": "image/webp"]
                headers["ETag"] = etag
                return (data, response(200, headers))
            case .notModified:
                return (Data(), response(304, [:]))
            case .html:
                return (Data("<!doctype html>".utf8), response(200, ["Content-Type": "text/html"]))
            case .status(let code):
                return (Data(), response(code, [:]))
            case .offline:
                throw URLError(.notConnectedToInternet)
            }
        }
    }
}

private let weather = #"""
    [{"OBJECT_NAME": "METEOR", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": 1, "MEAN_MOTION": 14.2,
      "ECCENTRICITY": 0.001, "INCLINATION": 98, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0}]
    """#

private func temporaryStore() -> PayloadStore {
    PayloadStore(directory: FileManager.default.temporaryDirectory.appending(path: "SatvisDataTests-\(UUID().uuidString)"))
}

private let fixedNow = Date(timeIntervalSince1970: 1_790_000_000)

@Suite struct GroupRepositoryTests {
    @Test func keepsWhatTheWorkerSendsAndRevalidatesItWithTheETag() async throws {
        let worker = StubWorker([.json(weather, etag: #"W/"weather-1""#), .notModified])
        let repository = GroupRepository(client: worker.client, store: temporaryStore(), snapshot: nil, now: { fixedNow })

        let first = try await repository.records(of: "weather")
        #expect(first.source == .worker)
        #expect(first.value.map(\.name) == ["METEOR"])

        let second = try await repository.records(of: "weather")
        #expect(second.source == .worker)
        #expect(second.value.map(\.name) == ["METEOR"])
        #expect(second.confirmed == fixedNow)

        let sent = worker.requests.withLock { $0.map { $0.value(forHTTPHeaderField: "If-None-Match") } }
        #expect(sent == [nil, #"W/"weather-1""#])
        #expect(worker.requests.withLock { $0.first?.url?.absoluteString } == "https://satvis.test/api/gp/weather.json")
    }

    @Test func fallsBackToTheKeptCopyWhenTheWorkerCannotBeAsked() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a", confirmed: fixedNow)
        let repository = GroupRepository(client: StubWorker([.status(503)]).client, store: store, snapshot: nil)

        let loaded = try await repository.records(of: "weather")
        #expect(loaded.source == .cache)
        #expect(loaded.confirmed == fixedNow)
    }

    // A host without the worker answers every path with its index.html.
    @Test func doesNotTakeAnHTMLAnswerForData() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a", confirmed: fixedNow)
        let repository = GroupRepository(client: StubWorker([.html]).client, store: store, snapshot: nil)

        #expect(try await repository.records(of: "weather").source == .cache)
        #expect(store.read(.group("weather"))?.data == Data(weather.utf8))
    }

    @Test func startsFromTheSnapshotBeforeAnythingIsKept() async throws {
        let snapshot = temporaryStore()
        try snapshot.write(.index, data: Data(#"{"updated": "", "groups": [{"name": "weather", "tags": ["Weather"]}]}"#.utf8), etag: nil, confirmed: fixedNow)
        let repository = GroupRepository(client: StubWorker([.offline]).client, store: temporaryStore(), snapshot: snapshot)

        let loaded = try await repository.index()
        #expect(loaded.source == .snapshot)
        #expect(loaded.confirmed == nil)
        #expect(loaded.value.groups.map(\.tags) == [["Weather"]])
    }

    @Test func failsWithNothingToFallBackOn() async throws {
        let repository = GroupRepository(client: StubWorker([.offline]).client, store: temporaryStore(), snapshot: nil)
        await #expect(throws: URLError.self) {
            try await repository.index()
        }
    }

    // A malformed answer must not replace a good copy.
    @Test func keepsTheOldCopyWhenTheNewOneDoesNotDecode() async throws {
        let store = temporaryStore()
        try store.write(.index, data: Data(#"{"updated": "", "groups": []}"#.utf8), etag: "a", confirmed: fixedNow)
        let repository = GroupRepository(client: StubWorker([.json(#"{"nope": 1}"#, etag: "b")]).client, store: store, snapshot: nil)

        #expect(try await repository.index().source == .cache)
        #expect(store.read(.index)?.etag == "a")
    }

    // An answer whose every record fails to decode, from a format the app does not
    // read yet, is no group: it must not replace the copy that still shows it.
    @Test func keepsTheOldGroupWhenNoRecordOfTheNewOneDecodes() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a", confirmed: fixedNow)
        let unreadable = #"[{"OBJECT_NAME": "METEOR", "EPOCH": "2026-10-02T00:00:00+00:00", "NORAD_CAT_ID": 1}]"#
        let repository = GroupRepository(client: StubWorker([.json(unreadable, etag: "b")]).client, store: store, snapshot: nil)

        let records = try await repository.records(of: "weather")
        #expect(records.source == .cache)
        #expect(records.value.map(\.name) == ["METEOR"])
        #expect(store.read(.group("weather"))?.etag == "a")
    }

    // An empty group is a group.
    @Test func keepsAnEmptyGroup() async throws {
        let repository = GroupRepository(client: StubWorker([.json("[]", etag: "b")]).client, store: temporaryStore(), snapshot: nil)
        #expect(try await repository.records(of: "weather").value.isEmpty)
    }
}

@Suite struct SiteImageTests {
    @Test func keepsAnImageAndRevalidatesIt() async throws {
        let worker = StubWorker([.image(Data([1, 2, 3]), etag: "a"), .notModified, .offline])
        let store = temporaryStore()
        let repository = GroupRepository(client: worker.client, store: store, snapshot: nil)

        #expect(try await repository.image("data/starmap/x.webp").value == Data([1, 2, 3]))
        #expect(try await repository.image("data/starmap/x.webp").source == .worker)
        #expect(try await repository.image("data/starmap/x.webp").source == .cache)
        #expect(worker.requests.withLock { $0.first?.url?.absoluteString } == "https://satvis.test/data/starmap/x.webp")
    }

    // A demo bookmark's picture, offline after the first launch that fetched it.
    @Test func keepsAPictureForOfflineLaunches() async throws {
        let store = temporaryStore()
        let online = GroupRepository(client: StubWorker([.image(Data([9]), etag: "b")]).client, store: store, snapshot: nil)
        #expect(await online.keptImage("showcase/globe-card.jpg") == nil)
        _ = try await online.image("showcase/globe-card.jpg")
        let offline = GroupRepository(client: StubWorker([.offline]).client, store: store, snapshot: nil)
        #expect(await offline.keptImage("showcase/globe-card.jpg") == Data([9]))
    }

    // `pnpm dev`, and a deploy that never ran the generator, answer with index.html.
    @Test func doesNotTakeAPageForAnImage() async throws {
        let repository = GroupRepository(client: StubWorker([.html]).client, store: temporaryStore(), snapshot: nil)
        await #expect(throws: WorkerError.unexpectedContent("data/starmap/x.webp")) {
            try await repository.image("data/starmap/x.webp")
        }
    }
}
