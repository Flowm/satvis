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
        let loader = GroupLoader(repository: Self.repository(site: site))
        _session = State(initialValue: Session(loader: loader, site: site, alerts: PassAlerts(loader: loader)))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(session: session)
                .preferredColorScheme(.dark)
                .tint(Color.panelAccent)
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
    @State private var showsBookmarks = false
    @State private var showsBrowser = false
    @State private var showsAcknowledgements = false
    @State private var showsAbout = false
    @State private var showsTools = false
    /// The corner's eye, as the web app's Hide UI: off, the menu column, its panel,
    /// the clock deck and the corner's other buttons hide, for a picture of the globe.
    @State private var showsUI = true
    /// What was selected when a sheet folded the column on a phone, to unfold it
    /// again when the sheet closes; nil while no sheet folded it.
    @State private var foldedFor: Selection??
    /// What was selected when picking a spot started from the Locations panel,
    /// which opens again if the pick is cancelled; a placed station opens its own
    /// panel instead. Nil while no pick started there.
    @State private var pickingFromLocations: Selection??
    /// The panel open beside the menu column, if any.
    @State private var panel: ToolPanel?
    /// Where the menu column and the top corner's buttons are, in the window.
    @State private var menuFrame: CGRect?
    @State private var cornerFrame: CGRect?
    /// The room the menu column and its panel are laid out in, in the window.
    @State private var toolsFrame: CGRect?
    /// Where the clock deck is, in the window, for the info card to stop above it.
    @State private var deckFrame: CGRect?
    /// How tall the info card's list is laid out, its bar included; nil until
    /// measured, when the card takes all the height it may.
    @State private var infoHeight: CGFloat?
    /// Where the info card is, in the window, for the sky view's lock card.
    @State private var cardFrame: CGRect?
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
            mayDrag: session.aim.mayDrag(_:fingers:),
            takePinch: session.aim.takePinch,
            isTransparent: session.aim.passthrough.isShowing,
            pixelRatio: Double(session.pixelRatio),
            frameRate: session.frameRate
        )
        .ignoresSafeArea()
        .background {
            // Hidden by the opaque globe but while the sky view shows it.
            CameraPreview(layer: session.aim.passthrough.previewLayer)
                .background(.black)
                .ignoresSafeArea()
        }
        .overlay {
            if session.observer != nil, let renderer = session.renderer {
                // In the renderer's frame, the whole screen, since it projects into it.
                SkyHUD(renderer: renderer, controls: topControls, infoCard: showsCard ? cardFrame : nil, notice: session.notice ?? session.aim.cameraWarning)
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .top) {
            // Between the menu and the corner's buttons, level with them where there
            // is room for it; on a phone under them, the "Menu" pill reaching into
            // the middle. Under the menu panel too, which covers it while open. The
            // benchmark panel shows its own measurements in its place.
            if session.showsPerformance, !session.showsBenchmark, let renderer = session.renderer {
                PerformanceOverlay(renderer: renderer)
                    .padding(.top, sizeClass == .regular ? PanelMetrics.edge : PanelMetrics.underTopRow)
            }
        }
        .overlay(alignment: .topTrailing) {
            // The web app's order: the eye first, so it stays put as the others come and go.
            VStack(spacing: PanelMetrics.gap) {
                Button(showsUI ? "Hide UI" : "Show UI", systemImage: showsUI ? "eye" : "eye.slash") { showsUI.toggle() }
                if showsUI {
                    Button(session.observer != nil ? "Leave the sky view" : "Home view", systemImage: "globe") { session.goHome() }
                    if session.observer != nil {
                        Button(
                            session.aim.compass.isAiming ? "Stop aiming by compass" : "Aim by compass",
                            systemImage: session.aim.compass.isAiming ? "location.north.circle.fill" : "location.north.circle"
                        ) { session.aim.toggleCompass() }
                        Button(
                            session.aim.passthrough.isShowing ? "Hide the camera" : "Show the camera",
                            systemImage: session.aim.passthrough.isShowing ? "camera.fill" : "camera"
                        ) { session.aim.togglePassthrough() }
                        .disabled(session.aim.isStartingCamera)
                    }
                    // The way out of following something once its panel is closed.
                    if session.tracked != nil {
                        Button("Stop tracking", systemImage: "video.slash") { session.stopTracking(animated: true) }
                    }
                }
            }
            .labelStyle(.iconOnly)
            // The menu toggle's name's weight, for strokes as heavy as its icon's.
            .font(.body.weight(.medium))
            .buttonStyle(PanelButtonStyle(square: true))
            .onGeometryChange(for: CGRect.self) {
                $0.frame(in: .global)
            } action: {
                cornerFrame = $0
            }
            .padding(PanelMetrics.edge)
            // Under the info card, which has its own Track and close.
            .opacity(showsCard ? 0 : 1)
            .accessibilityHidden(showsCard)
            .animation(.snappy(duration: 0.2), value: showsCard)
        }
        // Where there is room, a card in the top-right corner, as the web app's panel;
        // else a sheet (below). Not an inspector column: narrowing the globe's view
        // made iPadOS present frames late, 40 fps tracking the ISS on an iPad mini
        // against the card's 60.
        .overlay(alignment: .topTrailing) {
            GeometryReader { proxy in
                if showsCard, let frame = cardPlacement(in: proxy) {
                    let room = proxy.frame(in: .global)
                    infoPanel
                        .onScrollGeometryChange(for: CGFloat.self) {
                            $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
                        } action: { _, height in
                            infoHeight = height
                        }
                        .frame(width: frame.width, height: frame.height)
                        .clipShape(.rect(cornerRadius: PanelMetrics.radius))
                        // The panels' surface, dense as the tool panels', but not
                        // their ink, which would light the lists' section headers.
                        .background {
                            Color.clear.panel()
                                .environment(\.panelDensity, .dense)
                        }
                        .onGeometryChange(for: CGRect.self) {
                            $0.frame(in: .global)
                        } action: {
                            cardFrame = $0
                        }
                        .padding(.top, frame.minY - room.minY)
                        .padding(.trailing, room.maxX - frame.maxX)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .animation(.snappy(duration: 0.2), value: frame)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topTrailing)))
                }
            }
            .animation(.smooth, value: showsCard)
        }
        .onChange(of: session.selection) {
            infoHeight = nil
        }
        .overlay(alignment: .topLeading) {
            GeometryReader { _ in
                HStack(alignment: .top, spacing: PanelMetrics.gap) {
                    ToolMenu(isOpen: $showsTools) {
                        // The web app's menu column: its entries, icons, order and hints.
                        ToolEntry(
                            title: "Bookmarks", image: .lucideBookmark, hint: "Demos, saved views and links you opened, and the way back to the default view"
                        ) {
                            showsBookmarks = true
                        }
                        ToolEntry(title: "Satellites", image: .lucideOrbit, hint: "Search and pick which satellites to show") {
                            showsBrowser = true
                        }
                        entry(.components, image: .lucideSatellite, hint: "Orbits, ground tracks, labels and sensor cones")
                        entry(.map, image: .lucideLayers, hint: "Basemap and terrain")
                        entry(.locations, image: .lucideMapPin, hint: "Ground stations, for pass predictions and the sky view")
                        entry(.globe, image: .lucideGlobe, hint: "The globe's projection, and the camera")
                        entry(.sky, image: .lucideTelescope, hint: "Look up from a ground station and see what passes over")
                        entry(.graphics, image: .lucideGauge, hint: "Quality and performance")
                        // The web app's About button, kept off the corner, which holds
                        // the ways back alone.
                        ToolEntry(title: "About", image: .lucideInfo, hint: "What Satvis is, what it does, where its data comes from, and its credits") {
                            showsAbout = true
                        }
                    }
                    .environment(\.toolNamesFolded, !roomy && panel != nil)
                    .onGeometryChange(for: CGRect.self) {
                        $0.frame(in: .global)
                    } action: {
                        menuFrame = $0
                    }
                    if let panel {
                        ToolPanelView(title: panel.title, width: panel.cardWidth, onClose: { self.panel = nil }) {
                            switch panel {
                            case .components: ComponentsPanel(catalog: session.catalog)
                            case .map: MapPanel(session: session)
                            case .locations:
                                LocationsPanel(passes: session.passes, onPick: pickFromLocations) {
                                    session.select(.station($0))
                                    clearTheGlobe()
                                }
                            case .globe: GlobePanel(session: session)
                            case .sky: SkyPanel(session: session)
                            case .graphics: GraphicsPanel(session: session)
                            }
                        }
                        .id(panel)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topLeading)))
                    }
                }
                .animation(.snappy(duration: 0.2), value: panel)
                .frame(maxWidth: panelReach, alignment: .topLeading)
                .padding(PanelMetrics.edge)
            }
            .onGeometryChange(for: CGRect.self) {
                $0.frame(in: .global)
            } action: {
                toolsFrame = $0
            }
            .shown(showsUI)
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
        // Out of the way of the sky the compass now aims, as on the web.
        .onChange(of: session.aim.compass.isAiming && !session.aim.compass.isProbing) { _, aiming in
            if aiming, panel == .sky {
                panel = nil
            }
        }
        .overlay(alignment: .top) {
            if session.isPicking {
                HStack {
                    Text("Tap the globe to place a ground station")
                        .font(.subheadline)
                    Button("Cancel") { session.setPicking(false) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .panel()
                .padding(.top, PanelMetrics.underTopRow)
            }
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 12) {
                // Down here, as the web app's toasts are: the top holds the menu,
                // its panels, the corner's buttons and the sky view's tape. The sky
                // view shows it over the lock's card instead.
                if let notice = session.notice, session.observer == nil {
                    NoticeBanner(text: notice)
                }
                // Above the clock, clear of the buttons down either side.
                if session.showsBenchmark, let renderer = session.renderer {
                    BenchmarkPanel(session: session, renderer: renderer)
                        .padding(.horizontal, 16)
                }
                // Flush with the bottom edge, as on the web.
                ClockDeck(clock: session.clock, passes: session.passes, satellite: session.selectedSatellite) {
                    // Where the web app has its credit line.
                    OpenStreetMapCredit(isOwed: session.mapCredits.contains(.openStreetMap)) { showsAcknowledgements = true }
                }
                .frame(maxWidth: .infinity)
                .onGeometryChange(for: CGRect.self) {
                    $0.frame(in: .global)
                } action: {
                    deckFrame = $0
                }
                .shown(showsUI)
            }
        }
        .onChange(of: session.isPicking) { _, picking in
            if !picking, let selection = pickingFromLocations {
                pickingFromLocations = nil
                if session.selection == selection {
                    showsTools = true
                    panel = .locations
                }
            }
        }
        // A sheet folds the column on a phone and unfolds it again as it closes,
        // unless what was done in it is on the globe now: a panel opened there
        // would be under the column.
        .onChange(of: showsBookmarks || showsBrowser || showsAbout) { _, presenting in
            if presenting {
                panel = nil
                if sizeClass != .regular, showsTools {
                    showsTools = false
                    foldedFor = .some(session.selection)
                }
            } else if let selection = foldedFor {
                foldedFor = nil
                if session.selection == selection {
                    showsTools = true
                }
            }
        }
        .sheet(isPresented: $showsBookmarks) {
            BookmarksView(session: session)
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: session.catalog) { session.select(.satellite($0.id)) }
        }
        .sheet(isPresented: $showsAbout) {
            AboutView(session: session)
        }
        .sheet(isPresented: $showsAcknowledgements) {
            NavigationStack {
                AcknowledgementsView(map: session.mapCredits)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showsAcknowledgements = false }
                        }
                    }
            }
        }
        .sheet(
            isPresented: Binding {
                sizeClass != .regular && session.selection != nil
            } set: {
                if !$0 { session.select(nil) }
            }
        ) {
            // Dense, as the card: Liquid Glass showed the globe behind it
            // magnified and blurred, under the name and the first rows.
            infoPanel
                .presentationBackground(Color.panelSurface.opacity(PanelDensity.dense.opacity))
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .task {
            await session.run()
        }
        // A satvis.space link the system hands over, universal link or not.
        .onOpenURL { session.open(Link($0.absoluteString), records: true) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            session.renderer?.trimMemory()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: session.becameActive()
            case .background: session.enteredBackground()
            default: break
            }
        }
        // The keyboard rose under the clock deck into a panel being edited, and
        // shortened the panel past fitting, swapping in a scrolling one: a new
        // view, which dropped the field's focus. The sheets keep their own room.
        .ignoresSafeArea(.keyboard)
    }

    /// Starts picking a spot from the Locations panel, out of the globe's way.
    private func pickFromLocations() {
        pickingFromLocations = .some(session.selection)
        clearTheGlobe()
        session.setPicking(true)
    }

    /// Closes the panel, and on a phone folds the column, for what happens next on
    /// the globe: a panel opened there would be under the column.
    private func clearTheGlobe() {
        panel = nil
        if sizeClass != .regular {
            showsTools = false
        }
    }

    /// An entry that opens its panel, or closes it if it is open.
    private func entry(_ which: ToolPanel, image: ImageResource, hint: LocalizedStringKey) -> some View {
        ToolEntry(title: which.title, image: image, hint: hint, isSelected: panel == which) {
            panel = panel == which ? nil : which
        }
    }

    /// For the sky view's tapes. The HUD fills the window, so their frames are
    /// the window's.
    private var topControls: TopControls? {
        guard let menuFrame, let cornerFrame else {
            return nil
        }
        // The card covers the buttons, and the tapes run round it instead.
        return TopControls(menu: menuFrame, buttons: showsCard ? cardFrame ?? cornerFrame : cornerFrame)
    }

    /// Whether the info panel is a card over the globe rather than a sheet.
    private var showsCard: Bool {
        sizeClass == .regular && session.selection != nil
    }

    /// The info card's frame in the window: in the corner's buttons' place, clear of
    /// the menu column and the clock deck, and clear of the screen's middle while
    /// the camera holds something there. Nil until the corner is laid out.
    private func cardPlacement(in proxy: GeometryProxy) -> CGRect? {
        guard let cornerFrame else {
            return nil
        }
        let room = proxy.frame(in: .global)
        var width = max(min(Self.cardMaxWidth, cornerFrame.maxX - (menuFrame?.maxX ?? room.minX) - PanelMetrics.gap), Self.cardMinWidth)
        let top = cornerFrame.minY
        var bottom = min(deckFrame?.minY ?? room.maxY, room.maxY) - PanelMetrics.gap
        if session.tracked != nil || session.observer != nil {
            // The globe's view fills the window, safe area and all. Narrower where
            // that leaves the card its width, as in landscape; else shorter.
            let middle = CGPoint(x: (room.maxX + proxy.safeAreaInsets.trailing) / 2, y: (room.maxY + proxy.safeAreaInsets.bottom) / 2)
            let besideMiddle = cornerFrame.maxX - middle.x - Self.labelClearance
            if besideMiddle >= Self.cardMinWidth {
                width = min(width, besideMiddle)
            } else {
                bottom = min(bottom, middle.y - Self.focusClearance)
            }
        }
        let height = max(min(infoHeight ?? .infinity, Self.cardMaxHeight, bottom - top), Self.cardMinHeight)
        return CGRect(x: cornerFrame.maxX - width, y: top, width: width, height: height)
    }

    /// The web app's 540 px. 400 pt fitted the tab row and the facts.
    private static let cardMaxWidth: CGFloat = 540
    private static let cardMinWidth: CGFloat = 400
    /// The web app's 520 px of rows and its header, with the app's larger rows.
    private static let cardMaxHeight: CGFloat = 680
    /// The bar, the tabs and a row.
    private static let cardMinHeight: CGFloat = 200
    /// Points kept clear over the middle of the screen: the crosshair's 26, a
    /// tracked satellite's point, and a margin.
    private static let focusClearance: CGFloat = 60
    /// Points kept clear right of the middle, for a tracked satellite's label:
    /// "ISS (ZARYA)" reaches about 100 past its point.
    private static let labelClearance: CGFloat = 130
    /// The menu column with its names, a gap and a 260 pt panel, and the margins.
    private static let roomForNames: CGFloat = 500

    /// Whether the column keeps its names beside a panel: only where both fit,
    /// which a phone's width does not.
    private var roomy: Bool {
        (toolsFrame?.width ?? 0) >= Self.roomForNames
    }

    /// How wide the column and a card beside it may be: short of the corner's
    /// buttons, which leave a card 282 pt on a 402 pt phone. Less the margin and a
    /// gap.
    private var panelReach: CGFloat? {
        guard let toolsFrame, let cornerFrame else {
            return nil
        }
        return max(cornerFrame.minX - toolsFrame.minX - PanelMetrics.edge - PanelMetrics.gap, 0)
    }

    @ViewBuilder private var infoPanel: some View {
        switch session.selection {
        case .satellite(let id):
            if let entry = session.catalog.catalog.entries[id] {
                InfoPanel(
                    entry: entry, clock: session.clock, passes: session.passes, alerts: session.alerts, closeUp: session.closeUpContext,
                    isTracked: session.tracked == .satellite(id), onTrack: session.observer != nil ? nil : { track(.satellite(id), on: $0) },
                    onClose: { session.select(nil) }
                )
            }
        case .station(let stationID):
            if let station = session.passes.station(stationID) {
                StationPanel(
                    station: station, clock: session.clock, passes: session.passes, alerts: session.alerts, catalog: session.catalog,
                    isTracked: session.tracked == .station(stationID), onTrack: session.observer != nil ? nil : { track(.station(stationID), on: $0) },
                    onSky: { session.enterSky(at: stationID) },
                    onClose: { session.select(nil) }
                )
            }
        case nil:
            EmptyView()
        }
    }

    /// A panel's Track button: the camera flies there, or back.
    private func track(_ target: Selection, on: Bool) {
        if on {
            session.follow(target, animated: true)
        } else {
            session.stopTracking(animated: true)
        }
    }
}

extension View {
    /// The view, or nothing while `isShown` is false. Taken away rather than faded:
    /// faded and hidden from accessibility, the menu and the clock stayed in the
    /// accessibility tree.
    @ViewBuilder fileprivate func shown(_ isShown: Bool) -> some View {
        if isShown {
            self
        }
    }
}

/// OpenStreetMap's name in sight of the map, as the OpenStreetMap Foundation's
/// attribution guidelines ask, while the map draws its data: shown as that starts,
/// at launch or later, and faded after five seconds, as they allow. After that,
/// About's Acknowledgements has it, as they also allow. A tap opens them now.
private struct OpenStreetMapCredit: View {
    /// Whether the terrain, which uses OpenStreetMap's data, is drawn.
    let isOwed: Bool
    /// Opens the Acknowledgements.
    let onOpen: () -> Void
    /// Until five seconds after it became owed.
    @State private var isShown = false

    var body: some View {
        Group {
            if isShown {
                Button(action: onOpen) {
                    // Tappable over the row's height, not just the small text's.
                    Text("© OpenStreetMap")
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
                .transition(.opacity)
            }
        }
        .task(id: isOwed) {
            withAnimation { isShown = isOwed }
            guard isOwed else {
                return
            }
            // Cancelled when it stops being owed, which hides it anyway.
            guard (try? await Task.sleep(for: .seconds(5))) != nil else {
                return
            }
            withAnimation { isShown = false }
        }
    }
}

/// A word for the user that goes by itself, on a panel.
struct NoticeBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .panel()
            .padding(.horizontal, 16)
            .transition(.opacity)
    }
}
