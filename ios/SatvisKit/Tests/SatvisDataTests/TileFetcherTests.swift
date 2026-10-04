import Foundation
import Testing

@testable import SatvisData

@Suite struct TileFetcherTests {
    private actor Gauge {
        var running = 0
        var most = 0
        func enter() {
            running += 1
            most = max(most, running)
        }
        func leave() { running -= 1 }
    }

    private actor Counter {
        var count = 0
        func add() { count += 1 }
    }

    private static func answer(_ request: URLRequest, type: String, status: Int = 200, headers: [String: String] = [:]) -> (Data, URLResponse) {
        (Data([1, 2, 3]), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type].merging(headers) { $1 })!)
    }

    @Test func takesATileAndRefusesAPage() async throws {
        let fetcher = TileFetcher { Self.answer($0, type: $0.url!.lastPathComponent == "page" ? "text/html" : "image/webp") }
        let data = try await fetcher.tile(URL(string: "https://example.org/tile")!, contentType: "image/")
        #expect(data == Data([1, 2, 3]))
        await #expect(throws: WorkerError.unexpectedContent("/page")) {
            try await fetcher.tile(URL(string: "https://example.org/page")!, contentType: "image/")
        }
    }

    @Test func refusesAMissingTile() async {
        let fetcher = TileFetcher { Self.answer($0, type: "image/webp", status: 404) }
        await #expect(throws: WorkerError.status(404, "/tile")) {
            try await fetcher.tile(URL(string: "https://example.org/tile")!, contentType: "image/")
        }
    }

    @Test func runsAFewAtATime() async throws {
        let gauge = Gauge()
        let fetcher = TileFetcher(
            transport: { request in
                await gauge.enter()
                try await Task.sleep(for: .milliseconds(20))
                await gauge.leave()
                return Self.answer(request, type: "image/png")
            }, maximumRequests: 3)
        try await withThrowingTaskGroup(of: Data.self) { group in
            for index in 0..<12 {
                group.addTask { try await fetcher.tile(URL(string: "https://example.org/\(index)")!, contentType: "image/") }
            }
            for try await _ in group {}
        }
        #expect(await gauge.most == 3)
    }

    // Asked to slow down, it sends that host nothing more until the time is up,
    // and carries on with the others.
    @Test func leavesAHostThatAsksToBeLeftAlone() async throws {
        let sent = Counter()
        let fetcher = TileFetcher { request in
            await sent.add()
            return request.url!.host() == "busy.example.org"
                ? Self.answer(request, type: "image/png", status: 429, headers: ["Retry-After": "120"]) : Self.answer(request, type: "image/png")
        }
        for _ in 0..<3 {
            await #expect(throws: WorkerError.status(429, "/tile")) {
                try await fetcher.tile(URL(string: "https://busy.example.org/tile")!, contentType: "image/")
            }
        }
        #expect(await sent.count == 1)
        _ = try await fetcher.tile(URL(string: "https://example.org/tile")!, contentType: "image/")
        #expect(await sent.count == 2)
    }
}
