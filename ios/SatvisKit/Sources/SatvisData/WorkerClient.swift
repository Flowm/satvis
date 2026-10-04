import Foundation

/// The satvis worker's read API: the group index and each group's element sets,
/// and the static files the site serves beside it.
public struct WorkerClient: Sendable {
    public static let production = URL(string: "https://satvis.space/")!

    /// Sends one request. A seam for tests; the app uses URLSession.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public enum Answer: Sendable, Equatable {
        case fresh(Data, etag: String?)
        /// The `If-None-Match` matched: what the caller holds is current.
        case unchanged
    }

    public let baseURL: URL
    private let transport: Transport

    public init(baseURL: URL = production, transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }) {
        self.baseURL = baseURL
        self.transport = transport
    }

    public func index(ifNoneMatch etag: String? = nil) async throws -> Answer {
        try await get("api/groups.json", ifNoneMatch: etag)
    }

    public func group(_ name: String, ifNoneMatch etag: String? = nil) async throws -> Answer {
        try await get("api/gp/\(name).json", ifNoneMatch: etag)
    }

    /// An image the site serves, e.g. `data/starmap/deepstar_2020_1024_px.webp`.
    public func image(_ path: String, ifNoneMatch etag: String? = nil) async throws -> Answer {
        try await get(path, ifNoneMatch: etag, contentType: "image/")
    }

    private func get(_ path: String, ifNoneMatch etag: String?, contentType: String = "json") async throws -> Answer {
        var request = URLRequest(url: baseURL.appending(path: path))
        // The validator is ours to send. URLSession's own cache would otherwise
        // answer from a copy for max-age and never let the worker say 304.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let etag {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else {
            throw WorkerError.notHTTP
        }
        switch http.statusCode {
        case 304:
            return .unchanged
        case 200:
            // A host without the worker, or without the file, can answer any path
            // with its index.html and a 200, so the answer is read, not just the
            // status.
            guard http.value(forHTTPHeaderField: "Content-Type")?.contains(contentType) == true else {
                throw WorkerError.unexpectedContent(path)
            }
            return .fresh(data, etag: http.value(forHTTPHeaderField: "ETag"))
        default:
            throw WorkerError.status(http.statusCode, path)
        }
    }
}

public enum WorkerError: Error, Equatable {
    case notHTTP
    case unexpectedContent(String)
    case status(Int, String)
}
