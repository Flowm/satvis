import SatvisData
import SwiftUI

@main
struct SatvisApp: App {
    @State private var source = GPSource(repository: Self.repository())

    var body: some Scene {
        WindowGroup {
            StatusView(source: source)
                .preferredColorScheme(.dark)
        }
    }

    /// `SATVIS_API` in the launch environment replaces satvis.space, e.g. a local
    /// worker at http://localhost:8080.
    private static func repository() -> GroupRepository {
        let api = ProcessInfo.processInfo.environment["SATVIS_API"].flatMap(URL.init(string:))
        let store = (try? PayloadStore.applicationSupport()) ?? PayloadStore(directory: URL.temporaryDirectory.appending(path: "GP"))
        return GroupRepository(client: WorkerClient(baseURL: api ?? WorkerClient.production), store: store, snapshot: PayloadStore.shipped)
    }
}
