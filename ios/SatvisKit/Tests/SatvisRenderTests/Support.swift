import Foundation
import Testing

/// The files in Fixtures.
enum Fixtures {
    /// The bytes of `name`.`ext`.
    static func data(_ name: String, ext: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }
}

/// Holds the loads back until opened.
actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if !isOpen {
            await withCheckedContinuation { waiting.append($0) }
        }
    }

    func open() {
        isOpen = true
        for continuation in waiting {
            continuation.resume()
        }
        waiting = []
    }
}
