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
        #if DEBUG
            let snapshot = TestCatalog.store()
        #else
            let snapshot: PayloadStore? = nil
        #endif
        return GroupRepository(client: WorkerClient(baseURL: site), store: store, snapshot: snapshot)
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
    @State private var showsAbout = false
    @State private var showsTools = false
    /// The panel open beside the menu column, if any.
    @State private var panel: ToolPanel?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        GlobeView(
            onRenderer: session.attach,
            onTap: { point, size in
                // As the web app's: a tap on the globe puts the menu back as it
                // starts, no panel and on a phone a folded column, and still selects
                // what it hits; a miss that closed the menu keeps the selection.
                // Picking leaves the menu alone.
                let foldsColumn = sizeClass != .regular && showsTools
                let closesMenu = !session.isPicking && (panel != nil || foldsColumn)
                if closesMenu {
                    panel = nil
                    if foldsColumn {
                        showsTools = false
                    }
                }
                session.tap(at: point, viewSize: size, keepingSelection: closesMenu)
            },
            onDoubleTap: { session.doubleTap(at: $0, viewSize: $1) },
            mayDrag: session.mayDrag,
            pixelRatio: Double(session.pixelRatio)
        )
        .ignoresSafeArea()
        .background(.black)
        .overlay {
            if session.observer != nil, let renderer = session.renderer {
                // In the renderer's frame, the whole screen, since it projects into it.
                SkyHUD(renderer: renderer, tapeTop: 132, trailingInset: cardInset)
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .top) {
            // Between the menu and Share, level with them where there is room for
            // it; on a phone under them, the "Menu" pill reaching into the middle.
            // Under the menu panel too, which covers it while open. The benchmark
            // panel shows its own measurements in its place.
            if session.showsPerformance, !session.showsBenchmark, let renderer = session.renderer {
                PerformanceOverlay(renderer: renderer)
                    .padding(.top, sizeClass == .regular ? 16 : 76)
            }
        }
        .overlay(alignment: .topTrailing) {
            VStack {
                // Made when tapped, so that a pinned clock gives its minute then.
                Button("Share", systemImage: "square.and.arrow.up") {
                    ShareSheet.present(session.link(sharing: true).url(site: session.source.site), trailingInset: cardInset)
                }
                // Always there, so the way back is where it always is.
                Button(session.observer != nil ? "Leave the sky view" : "Home view", systemImage: "globe") { session.goHome() }
                // The web app's About button.
                Button("About Satvis", systemImage: "info") { showsAbout = true }
                if session.observer != nil {
                    Button(
                        session.compass.isAiming ? "Stop aiming by compass" : "Aim by compass",
                        systemImage: session.compass.isAiming ? "location.north.circle.fill" : "location.north.circle"
                    ) { session.toggleCompass() }
                }
                // The way out of following something once its panel is closed.
                if let tracked = session.tracked {
                    Button("Stop tracking", systemImage: "video.slash") { session.track(tracked, false, animated: true) }
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.glass)
            .controlSize(.large)
            .padding()
        }
        // Over the top-right buttons: where there is no room beside them an open
        // panel covers them, as on the web.
        .overlay(alignment: .topLeading) {
            // The names stay beside a panel only where both fit: on an iPad mini
            // with the info card open, a panel beside them was 100 pt wide.
            GeometryReader { proxy in
                let roomy = proxy.size.width >= Self.roomForNames
                HStack(alignment: .top, spacing: 8) {
                    ToolMenu(isOpen: $showsTools) {
                        // The web app's menu column: its entries, icons, order and hints.
                        ToolEntry(title: "Satellites", image: .lucideOrbit, hint: "Search and pick which satellites to show") {
                            showsBrowser = true
                        }
                        entry(.components, image: .lucideSatellite, hint: "Orbits, ground tracks, labels and sensor cones")
                        ToolEntry(title: "Ground station", image: .lucideMapPin, hint: "Your location, for pass predictions") {
                            showsStations = true
                        }
                        entry(.map, image: .lucideLayers, hint: "Basemap and terrain")
                        entry(.view, image: .lucideTelescope, hint: "Globe or sky view, and the compass")
                        entry(.graphics, image: .lucideGauge, hint: "Quality and performance")
                    }
                    .environment(\.toolNamesFolded, !roomy && panel != nil)
                    if let panel {
                        ToolPanelView(title: panel.title, fillsWidth: !roomy, onClose: { self.panel = nil }) {
                            switch panel {
                            case .components: ComponentsPanel(catalog: session.catalog)
                            case .map: MapPanel(session: session)
                            case .view: ViewPanel(session: session)
                            case .graphics: GraphicsPanel(session: session)
                            }
                        }
                        .id(panel)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topLeading)))
                    }
                }
                .animation(.snappy(duration: 0.2), value: panel)
                .padding()
            }
        }
        // Open from the start where there is room, as the web app's is on a desktop
        // and folded on a phone.
        .onAppear { showsTools = sizeClass == .regular }
        // A panel goes with the column.
        .onChange(of: showsTools) { _, open in
            if !open {
                panel = nil
            }
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
            VStack(spacing: 12) {
                // Above the clock, clear of the buttons down either side.
                if session.showsBenchmark, let renderer = session.renderer {
                    BenchmarkPanel(session: session, renderer: renderer)
                        .padding(.horizontal, 16)
                }
                // Flush with the bottom edge, as on the web.
                ClockDeck(clock: session.clock, passes: session.passes, satellite: session.selectedSatellite) {
                    // Where the web app has its credit line: the map's sources are owed
                    // a link in sight of the map.
                    Button {
                        showsAttribution = true
                    } label: {
                        // Tappable over the row's height, not just the small text's.
                        Text("Attribution")
                            .frame(maxHeight: .infinity)
                            .contentShape(.rect)
                    }
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.8))
                    .shadow(color: .black, radius: 2)
                    .padding(.leading, 8)
                    .lineLimit(1)
                    // Larger text, up to the room left of the play button.
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .minimumScaleFactor(0.6)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .onChange(of: showsBrowser || showsStations) { _, presenting in
            if presenting {
                panel = nil
                if sizeClass != .regular {
                    showsTools = false
                }
            }
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: session.catalog) { session.selection = .satellite($0.id) }
        }
        .sheet(isPresented: $showsAbout) {
            AboutView(onOpen: { session.open($0) }, privacyPolicy: session.privacyPolicy)
        }
        .sheet(isPresented: $showsAttribution) {
            AttributionView(map: session.mapCredits, privacyPolicy: session.privacyPolicy, analytics: session.analytics)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showsStations) {
            GroundStationsView(passes: session.passes, onPick: { session.isPicking = true }, onSelect: { session.selection = .station($0) })
        }
        // A card over the trailing edge where there is room for one, a sheet over
        // the lower half where there is not, leaving the globe to steer either
        // way. Not an inspector column: one narrows the globe's view, and iPadOS
        // then presents its frames late enough to halve every other one, 40 fps
        // tracking the ISS on an iPad mini where the card leaves it at 60. The
        // controls move aside for the card; the globe, under the safe area, does
        // not.
        .safeAreaInset(edge: .trailing, spacing: 0) {
            if sizeClass == .regular, session.selection != nil {
                infoPanel
                    .frame(width: Self.cardWidth)
                    // Opaque: glass this large, blurring a globe that changes every
                    // frame, costs the compositor as much as the inspector did.
                    .background(Color(uiColor: .systemBackground))
                    .clipShape(.rect(cornerRadius: 28))
                    .padding([.vertical, .trailing], 12)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.smooth, value: sizeClass == .regular && session.selection != nil)
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

    /// An entry that opens its panel, or closes it if it is open.
    private func entry(_ which: ToolPanel, image: ImageResource, hint: LocalizedStringKey) -> some View {
        ToolEntry(title: which.title, image: image, hint: hint, isSelected: panel == which) {
            panel = panel == which ? nil : which
        }
    }

    /// How far the info card reaches in from the trailing edge: its width and its
    /// margin, where it shows.
    private var cardInset: CGFloat {
        sizeClass == .regular && session.selection != nil ? Self.cardWidth + 12 : 0
    }

    /// Wide enough for the live strip's four cells and the chips on one line.
    private static let cardWidth: CGFloat = 400
    /// The menu column with its names, a gap and a 280 pt panel, and the margins.
    private static let roomForNames: CGFloat = 520

    @ViewBuilder private var infoPanel: some View {
        switch session.selection {
        case .satellite(let id):
            if let entry = session.catalog.catalog.entries[id] {
                InfoPanel(
                    entry: entry, clock: session.clock, passes: session.passes, alerts: session.alerts, isTracked: session.tracked == id,
                    onTrack: session.observer != nil ? nil : { session.track(id, $0, animated: true) }, onClose: { session.selection = nil }
                )
            }
        case .station(let stationID):
            if let station = session.passes.station(stationID) {
                let id = PassModel.markerID(stationID)
                StationPanel(
                    station: station, clock: session.clock, passes: session.passes, alerts: session.alerts, catalog: session.catalog,
                    isTracked: session.tracked == id, onTrack: session.observer != nil ? nil : { session.track(id, $0, animated: true) },
                    onSky: { session.enterSky(at: stationID) },
                    onClose: { session.selection = nil }
                )
            }
        case nil:
            EmptyView()
        }
    }
}

/// The system's share sheet, over whatever is presented, so that the info panel
/// stays open beneath it; from the top-right corner, where the button is, as a
/// popover on iPad.
private enum ShareSheet {
    /// `trailingInset` is the info card's, which the Share button moves aside for.
    static func present(_ url: URL, trailingInset: CGFloat) {
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
            popover.sourceRect = CGRect(
                x: window.bounds.maxX - window.safeAreaInsets.right - trailingInset - 44, y: window.safeAreaInsets.top + 44, width: 1, height: 1)
        }
        top.present(sheet, animated: true)
    }
}
