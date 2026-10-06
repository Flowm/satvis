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
    @State private var showsTools = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        GlobeView(
            onRenderer: session.attach,
            onTap: {
                // On a phone a tap on the globe is done with the menu, whatever else
                // it does; on an iPad the menu stays, as the web app's on a desktop.
                if sizeClass != .regular {
                    showsTools = false
                }
                session.tap(at: $0, viewSize: $1)
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
                SkyHUD(renderer: renderer, tapeTop: 132)
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
        .overlay(alignment: .topLeading) {
            ToolMenu(isOpen: $showsTools) {
                // The web app's menu column: its entries, icons, order and hints.
                // The hints are its hover texts, read by VoiceOver.
                Button("Satellites", image: .lucideSatellite) {
                    showsBrowser = true
                }
                .accessibilityHint("Search and pick which satellites to show")
                ComponentsMenu(catalog: session.catalog)
                    .accessibilityHint("Orbits, ground tracks, labels and sensor cones")
                Button("Ground station", image: .lucideMapPin) {
                    showsStations = true
                }
                .accessibilityHint("Your location, for pass predictions")
                MapMenu(session: session)
                    .accessibilityHint("Basemap and terrain")
                ViewMenu(session: session)
                    .accessibilityHint("Globe or sky view, and the compass")
                GraphicsMenu(session: session)
                    .accessibilityHint("Quality and performance")
            }
            .padding()
        }
        // Open from the start where there is room, as the web app's is on a desktop
        // and folded on a phone.
        .onAppear { showsTools = sizeClass == .regular }
        .overlay(alignment: .topTrailing) {
            VStack {
                // Made when tapped, so that a pinned clock gives its minute then.
                Button("Share", systemImage: "square.and.arrow.up") {
                    ShareSheet.present(session.link(sharing: true).url(site: session.source.site))
                }
                // Always there, so the way back is where it always is.
                Button(session.observer != nil ? "Leave the sky view" : "Home view", systemImage: "globe") { session.goHome() }
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
            if presenting, sizeClass != .regular {
                showsTools = false
            }
        }
        .sheet(isPresented: $showsBrowser) {
            BrowserView(catalog: session.catalog) { session.selection = .satellite($0.id) }
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
                    // Wide enough for the live strip's four cells and the chips on one line.
                    .frame(width: 400)
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

    @ViewBuilder private var infoPanel: some View {
        switch session.selection {
        case .satellite(let id):
            if let entry = session.catalog.catalog.entries[id] {
                InfoPanel(
                    entry: entry, clock: session.clock, passes: session.passes, alerts: session.alerts, isTracked: session.tracked == id,
                    onTrack: { session.track(id, $0, animated: true) }, onClose: { session.selection = nil }
                )
            }
        case .station(let stationID):
            if let station = session.passes.station(stationID) {
                let id = PassModel.markerID(stationID)
                StationPanel(
                    station: station, clock: session.clock, passes: session.passes, alerts: session.alerts, catalog: session.catalog,
                    isTracked: session.tracked == id, onTrack: { session.track(id, $0, animated: true) }, onSky: { session.enterSky(at: stationID) },
                    onClose: { session.selection = nil }
                )
            }
        case nil:
            EmptyView()
        }
    }
}

/// The web app's menu column: one panel, the Menu toggle over a rule and the
/// tools under it, each its icon and its name, folding to the toggle alone so
/// that a phone's width is left to the globe.
private struct ToolMenu<Tools: View>: View {
    @Binding var isOpen: Bool
    @ViewBuilder let tools: Tools

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Named "Menu" either way, as the web app's toggle is; VoiceOver hears
            // what a tap does.
            Button {
                isOpen.toggle()
            } label: {
                Label("Menu", image: isOpen ? .lucideChevronUp : .lucideMenu)
                    // Swapped, not faded: a crossfade shows both at once.
                    .contentTransition(.identity)
            }
            .accessibilityLabel(isOpen ? "Close menu" : "Menu")

            if isOpen {
                Divider()
                tools
            }
        }
        // As wide as its widest name, every row across all of it.
        .fixedSize()
        .labelStyle(ToolLabelStyle())
        .buttonStyle(ToolRowStyle())
        .menuStyle(.button)
        // In the web app's order, top down, even where a menu opens upwards.
        .menuOrder(.fixed)
        .padding(.vertical, 4)
        // The glass the system draws around a large `.glass` button, around the
        // whole panel instead: a menu's own arrives a beat after a button's.
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .animation(.snappy, value: isOpen)
    }
}

/// An icon in a column of its own, so the names line up, and the name beside it.
private struct ToolLabelStyle: LabelStyle {
    // Scaled with the text, icon and all, as the system's glass buttons are.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
                .scaleEffect(scale)
                .frame(width: 44 * scale)
            configuration.title
                .font(.body.weight(.medium))
                .lineLimit(1)
        }
    }
}

/// A row of the panel, across its width, a fingertip tall: with the panel's
/// inset, the toggle's middle is level with the large glass buttons' opposite.
private struct ToolRowStyle: ButtonStyle {
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.leading, 4)
            .padding(.trailing, 18)
            .frame(maxWidth: .infinity, minHeight: 44 * scale, alignment: .leading)
            .background(.white.opacity(configuration.isPressed ? 0.12 : 0))
            .contentShape(.rect)
    }
}

/// What the globe is covered with.
private struct MapMenu: View {
    @Bindable var session: Session

    var body: some View {
        Menu("Map", image: .lucideLayers) {
            Choices("Basemap", selection: $session.baseLayer, options: BaseLayer.allCases.map { ($0.title, $0) })
            // The web app's names for the two, as its links spell them.
            Choices("Terrain", selection: $session.terrain, options: [("None", false), ("ReEarth", true)])
        }
    }
}

/// From where the globe is seen: the web app's View panel, less the scene modes
/// (2D, Columbus) and the camera modes the app does not draw.
private struct ViewMenu: View {
    let session: Session

    var body: some View {
        Menu("View", image: .lucideTelescope) {
            Choices(
                "View mode",
                selection: Binding {
                    session.observer != nil ? "Sky" : "3D"
                } set: { mode in
                    if mode == "Sky" {
                        Task { await session.viewTheSky() }
                    } else {
                        session.leaveSky()
                    }
                },
                options: LinkCodec.scenes.map { ($0, $0) })
            if session.observer != nil {
                Section("Aiming") {
                    Toggle(
                        "Use compass",
                        isOn: Binding {
                            session.compass.isAiming
                        } set: { _ in
                            session.toggleCompass()
                        })
                }
            }
        }
    }
}

/// How the globe is drawn and what that costs: the web app's Graphics panel, less
/// the scene effects and MSAA, which the app does not switch.
private struct GraphicsMenu: View {
    let session: Session

    var body: some View {
        Menu("Graphics", image: .lucideGauge) {
            Section("Measurement") {
                Toggle(
                    "FPS",
                    isOn: Binding {
                        session.showsPerformance
                    } set: {
                        session.setShowsPerformance($0)
                    })
                Toggle(
                    "Benchmark",
                    isOn: Binding {
                        session.showsBenchmark
                    } set: {
                        session.setShowsBenchmark($0)
                    })
            }
            PixelRatioPicker(session: session)
        }
    }
}

/// The web app's "Pixel ratio" (src/config/rendering.ts): the fixed rungs below the
/// screen's own ratio, then the screen's, so the menu only offers savings.
private struct PixelRatioPicker: View {
    @Bindable var session: Session
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Choices(
            "Pixel ratio", selection: $session.pixelRatio,
            options: LinkCodec.pixelRatios.filter { $0 == "native" || (Double($0) ?? 0) < displayScale }.map { ratio in
                (ratio == "native" ? String(format: "%.1fx (Native)", displayScale) : String(format: "%.1fx", Double(ratio) ?? 0), ratio)
            })
    }
}

/// One of several, ticked, under the title the web app's panel gives them. Not a
/// Picker: in a menu an inline one drops its section's title.
private struct Choices<Value: Hashable>: View {
    let title: LocalizedStringKey
    @Binding var selection: Value
    let options: [(String, Value)]

    init(_ title: LocalizedStringKey, selection: Binding<Value>, options: [(String, Value)]) {
        self.title = title
        _selection = selection
        self.options = options
    }

    var body: some View {
        Section(title) {
            ForEach(options, id: \.1) { name, value in
                Toggle(
                    name,
                    isOn: Binding {
                        selection == value
                    } set: {
                        if $0 { selection = value }
                    })
            }
        }
    }
}

/// Which satellite components are drawn.
private struct ComponentsMenu: View {
    let catalog: CatalogModel

    var body: some View {
        Menu("Components", image: .lucideOrbit) {
            ForEach(SatelliteComponents.named, id: \.0) { name, component in
                Toggle(
                    name,
                    isOn: Binding {
                        catalog.components.contains(component)
                    } set: {
                        catalog.setComponent(component, enabled: $0)
                    })
            }
            if catalog.components.contains(.label), catalog.activeEntries.count > SatelliteComponents.labelBudget {
                Text("Labels show for up to \(SatelliteComponents.labelBudget) satellites")
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
