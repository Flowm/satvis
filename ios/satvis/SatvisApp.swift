import SatvisCore
import SatvisData
import SatvisRender
import SwiftUI

@main
struct SatvisApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var session: Session

    /// `SATVIS_API` in the launch environment replaces satvis.space, e.g. a local
    /// worker at http://localhost:8080.
    static let site = ProcessInfo.processInfo.environment["SATVIS_API"].flatMap(URL.init(string:)) ?? WorkerClient.production

    init() {
        let site = Self.site
        let source = GPSource(repository: Self.repository(site: site), site: site)
        _session = State(initialValue: Session(source: source, alerts: PassAlerts(source: source)))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(session: session)
                .preferredColorScheme(.dark)
        }
        // Element sets drift, and the four days ahead move on: predict the pass
        // notifications again from the newest. The next refresh is asked for
        // first, so that one that runs out of time does not end the chain, and
        // again once the new notifications say when they run out.
        .backgroundTask(.appRefresh(PassAlerts.refreshTaskID)) {
            await session.alerts.requestRefresh()
            await session.alerts.reschedule()
            await session.alerts.requestRefresh()
        }
    }

    private static func repository(site: URL) -> GroupRepository {
        let store = (try? PayloadStore.applicationSupport()) ?? PayloadStore(directory: URL.temporaryDirectory.appending(path: "GP"))
        return GroupRepository(client: WorkerClient(baseURL: site), store: store, snapshot: PayloadStore.shipped)
    }
}

/// The globe with the ground stations and satellites on it, the browser, the
/// stations and the components behind buttons, the info panel for what is
/// selected, and the clock deck. Views only: what they do is the session's.
struct ContentView: View {
    @Bindable var session: Session
    @State private var showsBrowser = false
    @State private var showsStations = false
    @State private var showsAttribution = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        GlobeView(
            onRenderer: session.attach,
            onTap: { session.tap(at: $0, viewSize: $1) },
            onDoubleTap: { session.doubleTap(at: $0, viewSize: $1) },
            mayDrag: session.mayDrag
        )
        .ignoresSafeArea()
        .background(.black)
        .overlay {
            if session.observer != nil, let renderer = session.renderer {
                // In the renderer's frame, the whole screen, since it projects into it.
                SkyHUD(renderer: renderer, tapeTop: 132)
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .topLeading) {
            GlassEffectContainer {
                HStack {
                    Button("Satellites", systemImage: "list.bullet") { showsBrowser = true }
                    Button("Ground stations", systemImage: "mappin.and.ellipse") { showsStations = true }
                    ComponentsMenu(catalog: session.catalog)
                    MapMenu(session: session)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .controlSize(.large)
            }
            .padding()
        }
        .overlay(alignment: .topTrailing) {
            VStack {
                // Made when tapped, so that a pinned clock gives its minute then.
                Button("Share", systemImage: "square.and.arrow.up") {
                    ShareSheet.present(session.link(sharing: true).url(site: session.source.site))
                }
                if session.observer != nil {
                    Button("Leave the sky view", systemImage: "globe") { session.leaveSky() }
                    Button(
                        session.compass.isAiming ? "Stop aiming by compass" : "Aim by compass",
                        systemImage: session.compass.isAiming ? "location.north.circle.fill" : "location.north.circle"
                    ) { session.toggleCompass() }
                }
                // The way out of following something once its panel is closed.
                if let tracked = session.tracked {
                    Button("Stop tracking", systemImage: "video.slash") { session.track(tracked, false) }
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.glass)
            .controlSize(.large)
            .padding()
        }
        .overlay(alignment: .top) {
            if let message = session.notice ?? session.alerts.message {
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
            VStack(alignment: .leading, spacing: 4) {
                // Where the web app has its credit line: the map's sources are owed
                // a link in sight of the map.
                Button("Attribution") { showsAttribution = true }
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.8))
                    .shadow(color: .black, radius: 2)
                    .padding(.leading, 12)
                ClockDeck(clock: session.clock, passes: session.passes, satellite: session.selectedSatellite)
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: session.catalog) { session.selection = .satellite($0.id) }
        }
        .sheet(isPresented: $showsAttribution) {
            AttributionView(map: session.mapCredits, privacyPolicy: session.privacyPolicy)
                .presentationDetents([.medium, .large])
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
        // A satvis.space link the system hands over, universal link or not.
        .onOpenURL { session.open(Link($0.absoluteString)) }
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
                    isTracked: session.tracked == id, onTrack: { session.track(id, $0) }, onSky: { session.enterSky(at: stationID) },
                    onClose: { session.selection = nil }
                )
            }
        case nil:
            EmptyView()
        }
    }
}

/// What the globe is covered with.
private struct MapMenu: View {
    @Bindable var session: Session

    var body: some View {
        Menu("Map", systemImage: "globe.europe.africa") {
            Picker("Base map", selection: $session.baseLayer) {
                ForEach(BaseLayer.allCases, id: \.self) { Text($0.title) }
            }
            Toggle("Terrain", isOn: $session.terrain)
            Divider()
            Toggle(
                "View the sky",
                isOn: Binding {
                    session.observer != nil
                } set: { on in
                    if on {
                        Task { await session.viewTheSky() }
                    } else {
                        session.leaveSky()
                    }
                })
            Divider()
            Toggle(
                "Share usage data",
                isOn: Binding {
                    session.analytics.isSharing
                } set: {
                    session.analytics.setSharing($0)
                })
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

/// The system's share sheet, over whatever is presented, so that the info panel
/// stays open beneath it; from the top-right corner, where the button is, as a
/// popover on iPad.
private enum ShareSheet {
    static func present(_ url: URL) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard var top = scene?.keyWindow?.rootViewController else {
            return
        }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController, let window = scene?.keyWindow {
            popover.sourceView = window
            popover.sourceRect = CGRect(x: window.bounds.maxX - window.safeAreaInsets.right - 44, y: window.safeAreaInsets.top + 44, width: 1, height: 1)
        }
        top.present(sheet, animated: true)
    }
}
