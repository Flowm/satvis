import Foundation

/// Map tiles from the web: imagery and, later, terrain. Kept in a size-limited
/// cache in Caches, which the system may purge, unlike the GP data: a tile can
/// always be fetched again, and the globe has the shipped imagery to show
/// meanwhile. A tile is served from the cache whatever its age, since imagery
/// changes rarely and a stale tile beats a missing one offline; a dated frame's
/// tile is cached even when its service says not to, as GIBS says of every tile,
/// for it never changes. A few requests
/// run at once, newest first, and a request nobody waits for any more is dropped
/// before it is sent. A host that answers 429 or 503 is left alone for as long as
/// it asks, 30 s when it does not say: the free tile servers rate-limit the
/// clients that dominate their traffic.
public actor TileFetcher {
    /// Sends one request. A seam for tests; the app uses its own URLSession.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private static let cacheBytes = 500 * 1024 * 1024
    private static let defaultPause: TimeInterval = 30
    /// What a dated frame's tile is stored with in place of its service's caching headers.
    private static let immutable = "max-age=31536000, immutable"
    private let transport: Transport
    /// Where a dated frame's tiles are stored: the transport's own cache.
    private let cache: URLCache?
    private let maximumRequests: Int
    private var running = 0
    /// Requests waiting their turn, newest last: taken from the end.
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// Hosts that asked to be left alone, and until when.
    private var paused: [String: Date] = [:]

    public init(transport: @escaping Transport, cache: URLCache? = nil, maximumRequests: Int = 8) {
        self.transport = transport
        self.cache = cache
        self.maximumRequests = maximumRequests
    }

    /// The fetcher the app uses: its own URLSession with a disk cache in Caches.
    public static func shared() -> TileFetcher {
        let directory = (try? FileManager.default.appFolder(.cachesDirectory))?.appending(path: "Tiles", directoryHint: .isDirectory)
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: cacheBytes, directory: directory)
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration)
        return TileFetcher(transport: { try await session.data(for: $0) }, cache: configuration.urlCache)
    }

    /// A tile's bytes. Throws when the answer is not a tile of the type asked for,
    /// e.g. a host's index.html, and when cancelled while waiting its turn. One
    /// `isDated` is of a frame that never changes.
    public func tile(_ url: URL, contentType: String, headers: [String: String] = [:], isDated: Bool = false) async throws -> Data {
        try await turn()
        defer { finished() }
        try Task.checkCancellation()
        let host = url.host() ?? ""
        if let until = paused[host], until > Date() {
            throw WorkerError.status(429, url.path())
        }
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
            if http.statusCode == 429 || http.statusCode == 503 {
                let wait = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init) ?? Self.defaultPause
                paused[host] = max(paused[host] ?? .distantPast, Date() + min(max(wait, 1), 600))
            }
            throw WorkerError.status(http.statusCode, url.path())
        }
        guard http.value(forHTTPHeaderField: "Content-Type")?.contains(contentType) == true else {
            throw WorkerError.unexpectedContent(url.path())
        }
        if isDated, let cache, http.value(forHTTPHeaderField: "Cache-Control") != Self.immutable {
            var fields = (http.allHeaderFields as? [String: String] ?? [:]).filter { !["cache-control", "pragma", "expires"].contains($0.key.lowercased()) }
            fields["Cache-Control"] = Self.immutable
            if let stored = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: fields) {
                cache.storeCachedResponse(CachedURLResponse(response: stored, data: data), for: request)
            }
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
