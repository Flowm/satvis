import Foundation
import SatvisCore
import Synchronization
import Testing

@testable import SatvisData

/// A worker that answers from a script, behind `gate` if given, and remembers what
/// it was asked.
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
    private let gate: Gate?
    let requests = Mutex<[URLRequest]>([])

    init(_ replies: [Reply], gate: Gate? = nil) {
        self.replies = Mutex(replies)
        self.gate = gate
    }

    var client: WorkerClient {
        WorkerClient(baseURL: URL(string: "https://satvis.test/")!) { request in
            self.requests.withLock { $0.append(request) }
            await self.gate?.pass()
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

/// Holds every request until opened, so a load can be caught while it is in flight.
final class Gate: Sendable {
    private let state = Mutex<(open: Bool, waiting: [CheckedContinuation<Void, Never>])>((false, []))

    func pass() async {
        await withCheckedContinuation { continuation in
            let open = state.withLock {
                if !$0.open {
                    $0.waiting.append(continuation)
                }
                return $0.open
            }
            if open {
                continuation.resume()
            }
        }
    }

    func open() {
        let waiting = state.withLock {
            $0.open = true
            defer { $0.waiting = [] }
            return $0.waiting
        }
        for continuation in waiting {
            continuation.resume()
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

@Suite struct GroupRepositoryTests {
    // The kept bytes are swapped for ones that do not decode, under the same ETag:
    // a second decode of what the worker confirms unchanged would fail.
    @Test func decodesAGroupTheWorkerConfirmsUnchangedOnce() async throws {
        let worker = StubWorker([.json(weather, etag: #""weather-1""#), .notModified])
        let store = temporaryStore()
        let repository = GroupRepository(client: worker.client, store: store, snapshot: nil)

        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
        try store.write(.group("weather"), data: Data("not json".utf8), etag: #""weather-1""#)
        #expect(await repository.keptRecords(of: "weather")?.map(\.name) == ["METEOR"])
        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
    }

    @Test func keepsWhatTheWorkerSendsAndRevalidatesItWithTheETag() async throws {
        let worker = StubWorker([.json(weather, etag: #"W/"weather-1""#), .notModified])
        let repository = GroupRepository(client: worker.client, store: temporaryStore(), snapshot: nil)

        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])

        let sent = worker.requests.withLock { $0.map { $0.value(forHTTPHeaderField: "If-None-Match") } }
        #expect(sent == [nil, #"W/"weather-1""#])
        #expect(worker.requests.withLock { $0.first?.url?.absoluteString } == "https://satvis.test/api/gp/weather.json")
    }

    @Test func fallsBackToTheKeptCopyWhenTheWorkerCannotBeAsked() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a")
        let repository = GroupRepository(client: StubWorker([.status(503)]).client, store: store, snapshot: nil)

        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
    }

    // A host without the worker answers every path with its index.html.
    @Test func doesNotTakeAnHTMLAnswerForData() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a")
        let repository = GroupRepository(client: StubWorker([.html]).client, store: store, snapshot: nil)

        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
        #expect(store.read(.group("weather"))?.data == Data(weather.utf8))
    }

    @Test func startsFromTheSnapshotBeforeAnythingIsKept() async throws {
        let snapshot = temporaryStore()
        try snapshot.write(.index, data: Data(#"{"updated": "", "groups": [{"name": "weather", "tags": ["Weather"]}]}"#.utf8), etag: nil)
        let repository = GroupRepository(client: StubWorker([.offline]).client, store: temporaryStore(), snapshot: snapshot)

        #expect(try await repository.index().groups.map(\.tags) == [["Weather"]])
    }

    // The UI tests' catalog carries the star maps, kept or not on the device.
    @Test func takesAStarMapFromTheSnapshotWhereNoneIsKept() async throws {
        let snapshot = temporaryStore()
        for (number, path) in GroupRepository.starMapFaces(.deepStar2K).enumerated() {
            try snapshot.write(.file(path), data: Data([UInt8(number)]), etag: nil)
        }
        let repository = GroupRepository(client: StubWorker([.offline]).client, store: temporaryStore(), snapshot: snapshot)
        #expect(await repository.keptStarMap(.deepStar2K) == (0..<6).map { Data([UInt8($0)]) })
        #expect(await repository.keptStarMap(.deepStar1K) == nil)
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
        try store.write(.index, data: Data(#"{"updated": "", "groups": []}"#.utf8), etag: "a")
        let repository = GroupRepository(client: StubWorker([.json(#"{"nope": 1}"#, etag: "b")]).client, store: store, snapshot: nil)

        #expect(try await repository.index().groups.isEmpty)
        #expect(store.read(.index)?.etag == "a")
    }

    // An answer whose every record fails to decode, from a format the app does not
    // read yet, is no group: it must not replace the copy that still shows it.
    @Test func keepsTheOldGroupWhenNoRecordOfTheNewOneDecodes() async throws {
        let store = temporaryStore()
        try store.write(.group("weather"), data: Data(weather.utf8), etag: "a")
        let unreadable = #"[{"OBJECT_NAME": "METEOR", "EPOCH": "2026-10-02T00:00:00+00:00", "NORAD_CAT_ID": 1}]"#
        let repository = GroupRepository(client: StubWorker([.json(unreadable, etag: "b")]).client, store: store, snapshot: nil)

        #expect(try await repository.records(of: "weather").map(\.name) == ["METEOR"])
        #expect(store.read(.group("weather"))?.etag == "a")
    }

    // Sidecars written by earlier versions also hold the date the worker last confirmed the copy.
    @Test func readsTheETagOfAnOlderSidecar() throws {
        let store = temporaryStore()
        try store.write(.index, data: Data("{}".utf8), etag: "b")
        try Data(#"{"etag": "a", "confirmed": 800000000}"#.utf8).write(to: store.directory.appending(path: "groups.json.meta"))
        #expect(store.read(.index)?.etag == "a")
    }

    // An empty group is a group.
    @Test func keepsAnEmptyGroup() async throws {
        let repository = GroupRepository(client: StubWorker([.json("[]", etag: "b")]).client, store: temporaryStore(), snapshot: nil)
        #expect(try await repository.records(of: "weather").isEmpty)
    }
}

@Suite struct SiteImageTests {
    @Test func keepsAnImageAndRevalidatesIt() async throws {
        let worker = StubWorker([.image(Data([1, 2, 3]), etag: "a"), .notModified, .offline])
        let store = temporaryStore()
        let repository = GroupRepository(client: worker.client, store: store, snapshot: nil)

        for _ in 0..<3 {
            #expect(try await repository.image("data/starmap/x.webp") == Data([1, 2, 3]))
        }
        let sent = worker.requests.withLock { $0.map { $0.value(forHTTPHeaderField: "If-None-Match") } }
        #expect(sent == [nil, "a", "a"])
        #expect(worker.requests.withLock { $0.first?.url?.absoluteString } == "https://satvis.test/data/starmap/x.webp")
    }

    // A featured bookmark's picture, offline after the first launch that fetched it.
    @Test func keepsAPictureForOfflineLaunches() async throws {
        let store = temporaryStore()
        let online = GroupRepository(client: StubWorker([.image(Data([9]), etag: "b")]).client, store: store, snapshot: nil)
        #expect(await online.keptImage("showcase/globe.webp") == nil)
        _ = try await online.image("showcase/globe.webp")
        let offline = GroupRepository(client: StubWorker([.offline]).client, store: store, snapshot: nil)
        #expect(await offline.keptImage("showcase/globe.webp") == Data([9]))
    }

    // Each map's faces are kept apart, and the Tycho map a link names is the 1K one.
    @Test func keepsEachStarMapApart() async throws {
        let worker = StubWorker((0..<6).map { .image(Data([UInt8($0)]), etag: "\($0)") })
        let store = temporaryStore()
        let repository = GroupRepository(client: worker.client, store: store, snapshot: nil)
        #expect(await repository.starMap(.deepStar2K) == (0..<6).map { Data([UInt8($0)]) })
        #expect(worker.requests.withLock { $0.first?.url?.lastPathComponent } == "deepstar_2020_2048_px.webp")
        #expect(await repository.keptStarMap(.deepStar2K)?.count == 6)
        #expect(await repository.keptStarMap(.deepStar1K) == nil)
        #expect(await repository.keptStarMap(.tycho1K) == nil)
    }

    // `pnpm dev`, and a deploy that never ran the generator, answer with index.html.
    @Test func doesNotTakeAPageForAnImage() async throws {
        let repository = GroupRepository(client: StubWorker([.html]).client, store: temporaryStore(), snapshot: nil)
        await #expect(throws: WorkerError.unexpectedContent("data/starmap/x.webp")) {
            try await repository.image("data/starmap/x.webp")
        }
    }
}
