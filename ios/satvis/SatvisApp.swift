import SatvisCore
import SatvisData
import SatvisRender
import SwiftUI

@main
struct SatvisApp: App {
    @State private var source: GPSource
    @State private var alerts: PassAlerts

    init() {
        let source = GPSource(repository: Self.repository())
        _source = State(initialValue: source)
        _alerts = State(initialValue: PassAlerts(source: source))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(source: source, alerts: alerts)
                .preferredColorScheme(.dark)
        }
        // Element sets drift, and the four days ahead move on: predict the pass
        // notifications again from the newest, then ask to be woken again.
        .backgroundTask(.appRefresh(PassAlerts.refreshTaskID)) {
            await alerts.reschedule()
            await alerts.requestRefresh()
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

/// What the info panel is about.
enum Selection: Hashable {
    /// A catalog id.
    case satellite(String)
    /// A place in the ground station list.
    case station(Int)
}

/// The globe with the ground stations and satellites on it, the browser, the
/// stations and the components behind buttons, the info panel for what is
/// selected, and the clock deck.
struct ContentView: View {
    let source: GPSource
    let alerts: PassAlerts
    @State private var clock = ViewerClock()
    @State private var catalog: CatalogModel
    @State private var satellites = SatelliteLayer()
    @State private var passes = PassModel()
    @State private var starMap = StarMap()
    @State private var renderer: GlobeRenderer?
    @State private var selection: Selection?
    /// What the camera follows: a satellite's catalog id or a station's marker id.
    @State private var tracked: String?
    @State private var showsBrowser = false
    @State private var showsStations = false
    @State private var isPicking = false
    /// What the drawn links were built from.
    @State private var linksKey: LinksKey?
    /// When the data was last asked for again, so that the scene turning active
    /// twice in a row does not ask twice.
    @State private var revalidated = Date.distantPast
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(source: GPSource, alerts: PassAlerts) {
        self.source = source
        self.alerts = alerts
        _catalog = State(initialValue: CatalogModel(source: source))
    }

    var body: some View {
        GlobeView(
            onRenderer: { renderer in
                self.renderer = renderer
                renderer.clock = { [clock] in clock.now() }
                renderer.setStations(passes.markers)
                satellites.attach(renderer)
                starMap.attach(renderer)
            },
            onTap: tap,
            onDoubleTap: { point, size in
                if let id = renderer?.entity(at: point, viewSize: size) {
                    track(id, true)
                }
            }
        )
        .ignoresSafeArea()
        .background(.black)
        .overlay(alignment: .topLeading) {
            GlassEffectContainer {
                HStack {
                    Button("Satellites", systemImage: "list.bullet") { showsBrowser = true }
                    Button("Ground stations", systemImage: "mappin.and.ellipse") { showsStations = true }
                    ComponentsMenu(catalog: catalog)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .controlSize(.large)
            }
            .padding()
        }
        .overlay(alignment: .topTrailing) {
            // The way out of following something once its panel is closed.
            if let tracked {
                Button("Stop tracking", systemImage: "video.slash") { track(tracked, false) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .padding()
            }
        }
        .overlay(alignment: .top) {
            if let message = alerts.message {
                Text(message)
                    .font(.subheadline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .glassEffect()
                    .padding(.top, 72)
                    .transition(.opacity)
            } else if isPicking {
                HStack {
                    Text("Tap the globe to place a ground station")
                        .font(.subheadline)
                    Button("Cancel") { isPicking = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassEffect()
                .padding(.top, 72)
            }
        }
        .overlay(alignment: .bottom) {
            ClockDeck(clock: clock, passes: passes, satellite: selectedSatellite)
                .padding(.horizontal)
                .padding(.bottom, 8)
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: catalog)
        }
        .sheet(isPresented: $showsStations) {
            GroundStationsView(passes: passes, onPick: { isPicking = true }, onSelect: { selection = .station($0) })
        }
        // A column beside the globe where there is room for one, a sheet over the
        // lower half where there is not, leaving the globe to steer either way.
        .inspector(
            isPresented: Binding {
                sizeClass == .regular && selection != nil
            } set: {
                if !$0 { selection = nil }
            }
        ) {
            infoPanel
                // Wide enough for the live strip's four cells and the chips on one line.
                .inspectorColumnWidth(min: 360, ideal: 420, max: 520)
        }
        .sheet(
            isPresented: Binding {
                sizeClass != .regular && selection != nil
            } set: {
                if !$0 { selection = nil }
            }
        ) {
            infoPanel
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .task {
            catalog.onChange = showActive
            passes.onStationsChange = {
                showStations()
                Task { await alerts.reschedule() }
            }
            passes.onModeChange = { Task { await alerts.reschedule() } }
            // The kept copy first, so nothing waits on the network that a copy on
            // disk can show; the worker's answers follow.
            await source.loadKept()
            if source.index == nil {
                await source.refresh()
            }
            await catalog.start()
            Task {
                await source.refresh()
                await catalog.revalidate(refetching: false)
            }
            await satellites.run(clock: clock)
        }
        .task {
            await starMap.load(from: source)
        }
        .task {
            await predictPasses()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                guard Date().timeIntervalSince(revalidated) > 60 else {
                    break
                }
                revalidated = Date()
                Task {
                    await source.refresh()
                    await catalog.revalidate()
                    await alerts.reschedule()
                }
            case .background:
                alerts.requestRefresh()
            default:
                break
            }
        }
    }

    @ViewBuilder private var infoPanel: some View {
        switch selection {
        case .satellite(let id):
            if let entry = catalog.catalog.entries[id] {
                InfoPanel(
                    entry: entry, clock: clock, passes: passes, alerts: alerts, isTracked: tracked == id,
                    onTrack: { track(id, $0) }, onClose: { selection = nil }
                )
            }
        case .station(let index):
            if passes.stations.indices.contains(index) {
                let id = PassModel.markerID(index)
                StationPanel(
                    index: index, station: passes.stations[index], clock: clock, passes: passes, alerts: alerts, catalog: catalog, isTracked: tracked == id,
                    onTrack: { track(id, $0) }, onClose: { selection = nil }
                )
            }
        case nil:
            EmptyView()
        }
    }

    /// The selected satellite, whose passes the clock deck marks.
    private var selectedSatellite: String? {
        if case .satellite(let id) = selection {
            return id
        }
        return nil
    }

    /// A tap places a station while picking, and otherwise selects what it lands
    /// on, or nothing.
    private func tap(_ point: CGPoint, _ size: CGSize) {
        guard let renderer else {
            return
        }
        if isPicking {
            if let place = renderer.groundPoint(at: point, viewSize: size) {
                passes.add(latitude: place.latitude, longitude: place.longitude)
                selection = .station(passes.stations.count - 1)
            }
            isPicking = false
            return
        }
        selection = renderer.entity(at: point, viewSize: size).map { id in
            PassModel.stationIndex(id).map(Selection.station) ?? .satellite(id)
        }
    }

    private func showActive() {
        let entries = catalog.activeEntries
        let components = catalog.components
        let time = clock.now()
        Task { await satellites.show(entries, components: components, at: time) }
    }

    /// Hands the renderer the stations, and lets go of one it may have been
    /// following: the list positions it was known by may now be someone else's.
    private func showStations() {
        renderer?.setStations(passes.markers)
        if let tracked, PassModel.stationIndex(tracked) != nil {
            track(tracked, false)
        }
        if case .station(let index) = selection, !passes.stations.indices.contains(index) {
            selection = nil
        }
    }

    /// Keeps the passes of what is shown predicted around the clock, once a second:
    /// the selected satellite's, and every active one's while a station is selected
    /// or their links are drawn.
    private func predictPasses() async {
        while !Task.isCancelled {
            let active = catalog.activeEntries
            let showsLinks = catalog.components.contains(.groundStationLink) && active.count <= SatelliteComponents.linkBudget
            var wanted: [CatalogEntry] = []
            var showsStation = false
            switch selection {
            case .satellite(let id):
                wanted += catalog.catalog.entries[id].map { [$0] } ?? []
            case .station:
                showsStation = true
            case nil:
                break
            }
            if showsLinks || showsStation {
                let selected = Set(wanted.map(\.id))
                wanted += active.filter { !selected.contains($0.id) }
            }
            if passes.hasStations, !wanted.isEmpty {
                await passes.refresh(wanted, at: clock.now())
            }
            await passes.keep(only: wanted)
            // Rebuilt only when the passes or the satellites changed.
            let links = LinksKey(revision: passes.revision, satellites: showsLinks ? active.map(\.id) : [])
            if links != linksKey {
                linksKey = links
                renderer?.setLinks(showsLinks ? passes.links(for: active) : [])
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// Follows a satellite or a station, or lets it go. Tracking keeps a satellite
    /// active even when its group is switched off, as on the web.
    private func track(_ id: String, _ follow: Bool) {
        let isStation = PassModel.stationIndex(id) != nil
        if follow {
            if !isStation {
                catalog.setTracked(id)
            } else if catalog.tracked != nil {
                catalog.setTracked(nil)
            }
            tracked = id
            selection = PassModel.stationIndex(id).map(Selection.station) ?? .satellite(id)
            renderer?.track(id)
        } else {
            renderer?.stopTracking()
            tracked = nil
            if !isStation {
                catalog.setTracked(nil)
            }
        }
    }
}

private struct LinksKey: Equatable {
    var revision: Int
    var satellites: [String]
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
            if catalog.activeEntries.count > SatelliteComponents.labelBudget {
                Text("Labels show for up to \(SatelliteComponents.labelBudget) satellites")
            }
            if catalog.activeEntries.count > SatelliteComponents.linkBudget {
                Text("Ground station links show for up to \(SatelliteComponents.linkBudget) satellites")
            }
        }
    }
}
