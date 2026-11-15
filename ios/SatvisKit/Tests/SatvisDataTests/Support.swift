import Foundation
import Synchronization

@testable import SatvisData

/// A group of one weather satellite, named `name`, as the worker sends it.
func weather(_ name: String) -> String {
    #"""
    [{"OBJECT_NAME": "\#(name)", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": 1, "MEAN_MOTION": 14.2,
      "ECCENTRICITY": 0.001, "INCLINATION": 98, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0}]
    """#
}

/// A store in a directory of its own, so that no test reads another's.
func temporaryStore() -> PayloadStore {
    PayloadStore(directory: FileManager.default.temporaryDirectory.appending(path: "SatvisDataTests-\(UUID().uuidString)"))
}

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
