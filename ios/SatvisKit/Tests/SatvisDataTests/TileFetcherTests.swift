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

    private static func answer(_ request: URLRequest, type: String, status: Int = 200) -> (Data, URLResponse) {
        (Data([1, 2, 3]), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!)
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
}
