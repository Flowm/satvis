import SatvisCore
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

/// The globe with the satellites on it, the browser and components behind
/// buttons, the info panel for the selected satellite, and the clock deck.
struct ContentView: View {
    let source: GPSource
    @State private var clock = ViewerClock()
    @State private var catalog: CatalogModel
    @State private var satellites = SatelliteLayer()
    @State private var starMap = StarMap()
    @State private var renderer: GlobeRenderer?
    @State private var selected: String?
    @State private var showsBrowser = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(source: GPSource) {
        self.source = source
        _catalog = State(initialValue: CatalogModel(source: source))
    }

    var body: some View {
        GlobeView(
            onRenderer: { renderer in
                self.renderer = renderer
                renderer.clock = { [clock] in clock.now() }
                satellites.attach(renderer)
                starMap.attach(renderer)
            },
            onSelect: { selected = $0 },
            onTrack: track
        )
        .ignoresSafeArea()
        .background(.black)
        .overlay(alignment: .topLeading) {
            GlassEffectContainer {
                HStack {
                    Button("Satellites", systemImage: "list.bullet") { showsBrowser = true }
                    ComponentsMenu(catalog: catalog)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .controlSize(.large)
            }
            .padding()
        }
        .overlay(alignment: .topTrailing) {
            // The way out of following a satellite once its panel is closed.
            if let tracked = catalog.tracked {
                Button("Stop tracking", systemImage: "video.slash") { track(tracked, false) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .padding()
            }
        }
        .overlay(alignment: .bottom) {
            ClockDeck(clock: clock)
                .padding(.horizontal)
                .padding(.bottom, 8)
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: catalog)
        }
        // A column beside the globe where there is room for one, a sheet over the
        // lower half where there is not, leaving the globe to steer either way.
        .inspector(
            isPresented: Binding {
                sizeClass == .regular && selected != nil
            } set: {
                if !$0 { selected = nil }
            }
        ) {
            infoPanel
        }
        .sheet(
            isPresented: Binding {
                sizeClass != .regular && selected != nil
            } set: {
                if !$0 { selected = nil }
            }
        ) {
            infoPanel
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .task {
            catalog.onChange = showActive
            await source.refresh()
            await catalog.start()
            await satellites.run(clock: clock)
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

    @ViewBuilder private var infoPanel: some View {
        if let selected, let entry = catalog.catalog.entries[selected] {
            InfoPanel(
                entry: entry, clock: clock, isTracked: catalog.tracked == selected,
                onTrack: { track(selected, $0) }, onClose: { self.selected = nil }
            )
        }
    }

    private func showActive() {
        let entries = catalog.activeEntries
        let components = catalog.components
        let time = clock.now()
        Task { await satellites.show(entries, components: components, at: time) }
    }

    /// Follows a satellite, or lets it go. Tracking keeps it active even when its
    /// group is switched off, as on the web.
    private func track(_ id: String, _ follow: Bool) {
        if follow {
            catalog.setTracked(id)
            selected = id
            renderer?.track(id)
        } else {
            renderer?.stopTracking()
            catalog.setTracked(nil)
        }
    }
}

/// Which satellite components are drawn.
private struct ComponentsMenu: View {
    let catalog: CatalogModel

    var body: some View {
        Menu("Satellite components", systemImage: "circle.dotted.circle") {
            ForEach(SatelliteComponents.named, id: \.0) { name, component in
                Toggle(
                    name,
                    isOn: Binding {
                        catalog.components.contains(component)
                    } set: {
                        catalog.setComponent(component, enabled: $0)
                    })
            }
            if catalog.activeEntries.count > 200 {
                Text("Labels show for up to 200 satellites")
            }
        }
    }
}
