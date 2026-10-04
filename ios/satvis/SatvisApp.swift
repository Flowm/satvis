import SatvisCore
import SatvisData
import SatvisRender
import SwiftUI

@main
struct SatvisApp: App {
    @State private var session: Session

    init() {
        let source = GPSource(repository: Self.repository())
        _session = State(initialValue: Session(source: source, alerts: PassAlerts(source: source)))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(session: session)
                .preferredColorScheme(.dark)
        }
        // Element sets drift, and the four days ahead move on: predict the pass
        // notifications again from the newest, then ask to be woken again.
        .backgroundTask(.appRefresh(PassAlerts.refreshTaskID)) {
            await session.alerts.reschedule()
            await session.alerts.requestRefresh()
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

/// The globe with the ground stations and satellites on it, the browser, the
/// stations and the components behind buttons, the info panel for what is
/// selected, and the clock deck. Views only: what they do is the session's.
struct ContentView: View {
    @Bindable var session: Session
    @State private var showsBrowser = false
    @State private var showsStations = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        GlobeView(
            onRenderer: session.attach,
            onTap: { session.tap(at: $0, viewSize: $1) },
            onDoubleTap: { session.doubleTap(at: $0, viewSize: $1) }
        )
        .ignoresSafeArea()
        .background(.black)
        .overlay(alignment: .topLeading) {
            GlassEffectContainer {
                HStack {
                    Button("Satellites", systemImage: "list.bullet") { showsBrowser = true }
                    Button("Ground stations", systemImage: "mappin.and.ellipse") { showsStations = true }
                    ComponentsMenu(catalog: session.catalog)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .controlSize(.large)
            }
            .padding()
        }
        .overlay(alignment: .topTrailing) {
            // The way out of following something once its panel is closed.
            if let tracked = session.tracked {
                Button("Stop tracking", systemImage: "video.slash") { session.track(tracked, false) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .padding()
            }
        }
        .overlay(alignment: .top) {
            if let message = session.alerts.message {
                Text(message)
                    .font(.subheadline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .glassEffect()
                    .padding(.top, 72)
                    .transition(.opacity)
            } else if session.isPicking {
                HStack {
                    Text("Tap the globe to place a ground station")
                        .font(.subheadline)
                    Button("Cancel") { session.isPicking = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassEffect()
                .padding(.top, 72)
            }
        }
        .overlay(alignment: .bottom) {
            ClockDeck(clock: session.clock, passes: session.passes, satellite: session.selectedSatellite)
                .padding(.horizontal)
                .padding(.bottom, 8)
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: session.catalog) { session.selection = .satellite($0.id) }
        }
        .sheet(isPresented: $showsStations) {
            GroundStationsView(passes: session.passes, onPick: { session.isPicking = true }, onSelect: { session.selection = .station($0) })
        }
        // A column beside the globe where there is room for one, a sheet over the
        // lower half where there is not, leaving the globe to steer either way.
        .inspector(
            isPresented: Binding {
                sizeClass == .regular && session.selection != nil
            } set: {
                if !$0 { session.selection = nil }
            }
        ) {
            infoPanel
                // Wide enough for the live strip's four cells and the chips on one line.
                .inspectorColumnWidth(min: 360, ideal: 420, max: 520)
        }
        .sheet(
            isPresented: Binding {
                sizeClass != .regular && session.selection != nil
            } set: {
                if !$0 { session.selection = nil }
            }
        ) {
            infoPanel
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .task {
            await session.run()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: session.becameActive()
            case .background: session.enteredBackground()
            default: break
            }
        }
    }

    @ViewBuilder private var infoPanel: some View {
        switch session.selection {
        case .satellite(let id):
            if let entry = session.catalog.catalog.entries[id] {
                InfoPanel(
                    entry: entry, clock: session.clock, passes: session.passes, alerts: session.alerts, isTracked: session.tracked == id,
                    onTrack: { session.track(id, $0) }, onClose: { session.selection = nil }
                )
            }
        case .station(let stationID):
            if let station = session.passes.station(stationID) {
                let id = PassModel.markerID(stationID)
                StationPanel(
                    station: station, clock: session.clock, passes: session.passes, alerts: session.alerts, catalog: session.catalog,
                    isTracked: session.tracked == id, onTrack: { session.track(id, $0) }, onClose: { session.selection = nil }
                )
            }
        case nil:
            EmptyView()
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
            if catalog.activeEntries.count > SatelliteComponents.labelBudget {
                Text("Labels show for up to \(SatelliteComponents.labelBudget) satellites")
            }
            if catalog.activeEntries.count > SatelliteComponents.linkBudget {
                Text("Ground station links show for up to \(SatelliteComponents.linkBudget) satellites")
            }
        }
    }
}
