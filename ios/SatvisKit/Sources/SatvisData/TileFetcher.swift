import Foundation

/// Map tiles from the web: imagery and, later, terrain. Kept in a size-limited
/// cache in Caches, which the system may purge, unlike the GP data: a tile can
/// always be fetched again, and the globe has the shipped imagery to show
/// meanwhile. A tile is served from the cache whatever its age, since imagery
/// changes rarely and a stale tile beats a missing one offline. A few requests
/// run at once, newest first, and a request nobody waits for any more is dropped
/// before it is sent.
public actor TileFetcher {
    /// Sends one request. A seam for tests; the app uses its own URLSession.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public static let cacheBytes = 500 * 1024 * 1024
    private let transport: Transport
    private let maximumRequests: Int
    private var running = 0
    /// Requests waiting their turn, newest last: taken from the end.
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init(transport: @escaping Transport, maximumRequests: Int = 8) {
        self.transport = transport
        self.maximumRequests = maximumRequests
    }

    /// The fetcher the app uses: its own URLSession with a disk cache in Caches.
    public static func shared() -> TileFetcher {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appending(path: "Tiles", directoryHint: .isDirectory)
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: cacheBytes, directory: directory)
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration)
        return TileFetcher { try await session.data(for: $0) }
    }

    /// A tile's bytes. Throws when the answer is not a tile of the type asked for,
    /// e.g. a host's index.html, and when cancelled while waiting its turn.
    public func tile(_ url: URL, contentType: String, headers: [String: String] = [:]) async throws -> Data {
        try await turn()
        defer { finished() }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else {
            throw WorkerError.notHTTP
        }
        guard http.statusCode == 200 else {
            throw WorkerError.status(http.statusCode, url.path())
        }
        guard http.value(forHTTPHeaderField: "Content-Type")?.contains(contentType) == true else {
            throw WorkerError.unexpectedContent(url.path())
        }
        return data
    }

    private func turn() async throws {
        if running < maximumRequests {
            running += 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    private func finished() {
        if let next = waiting.popLast() {
            next.resume()
        } else {
            running -= 1
        }
    }
}
