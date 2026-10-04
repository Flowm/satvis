import SatvisData
import SatvisRender
import SwiftUI

@main
struct SatvisApp: App {
    @State private var source = GPSource(repository: Self.repository())

    var body: some Scene {
        WindowGroup {
            ContentView(source: source)
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

/// The globe with the satellites on it, and the groups behind a button until the
/// satellite browser arrives (M2).
struct ContentView: View {
    let source: GPSource
    @State private var satellites = SatelliteLayer()
    @State private var starMap = StarMap()
    @State private var showsGroups = false
    @Environment(\.scenePhase) private var scenePhase

    /// `SATVIS_TIME` in the launch environment (ISO 8601, UTC) stops the clock at
    /// that instant, for screenshots and tests.
    static let pinnedTime: Double? = ProcessInfo.processInfo.environment["SATVIS_TIME"]
        .flatMap { try? Date($0, strategy: .iso8601) }
        .map { ($0.timeIntervalSince1970 * 1000).rounded(.down) }

    var body: some View {
        GlobeView { renderer in
            satellites.attach(renderer)
            starMap.attach(renderer)
            if let pinned = Self.pinnedTime {
                renderer.clock = { pinned }
            }
        }
        .ignoresSafeArea()
        .background(.black)
        .overlay(alignment: .topTrailing) {
            Button("Groups", systemImage: "list.bullet") {
                showsGroups = true
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.glass)
            .controlSize(.large)
            .padding()
        }
        .sheet(isPresented: $showsGroups) {
            StatusView(source: source)
        }
        .task {
            await source.refresh()
            await satellites.load(from: source)
            await satellites.run()
        }
        .task {
            await starMap.load(from: source)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await source.refresh() }
            }
        }
    }
}
