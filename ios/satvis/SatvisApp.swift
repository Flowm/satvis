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
        .overlay(alignment: .topLeading) {
            ToolMenu(isOpen: $showsTools) {
                // The web app's menu column: its entries, icons, order and hints.
                ToolRow("Satellites", hint: "Search and pick which satellites to show") {
                    Button("Satellites", image: .lucideSatellite) {
                        showsBrowser = true
                    }
                }
                ToolRow("Components", hint: "Orbits, ground tracks, labels and sensor cones") { ComponentsMenu(catalog: session.catalog) }
                ToolRow("Ground station", hint: "Your location, for pass predictions") {
                    Button("Ground station", image: .lucideMapPin) {
                        showsStations = true
                    }
                }
                ToolRow("Map", hint: "Basemap and terrain") { MapMenu(session: session) }
                ToolRow("View", hint: "Globe or sky view, and the compass") { ViewMenu(session: session) }
                ToolRow("Graphics", hint: "Quality and performance") { GraphicsMenu(session: session) }
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
            // Between the tool menu and Share, level with them.
            // The benchmark panel shows its own measurements in its place.
            if session.showsPerformance, !session.showsBenchmark, let renderer = session.renderer {
                PerformanceOverlay(renderer: renderer)
                    .padding(.top, 16)
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

/// The tools behind one button: a column of the same glass buttons unfolding
/// under it, each named beside it, so that a phone's width is left to the globe.
private struct ToolMenu<Tools: View>: View {
    @Binding var isOpen: Bool
    @ViewBuilder let tools: Tools

    var body: some View {
        // Spacing under the row's 10 pt gap, so a name's glass stays apart from
        // its button's rather than melting into it.
        GlassEffectContainer(spacing: 8) {
            VStack(alignment: .leading, spacing: 12) {
                // Named "Menu" beside it either way, as the web app's toggle is.
                ToolRow("Menu", hint: "") {
                    Button(isOpen ? "Close menu" : "Menu", image: isOpen ? .lucideChevronUp : .lucideMenu) {
                        isOpen.toggle()
                    }
                    // Swapped, not faded: a crossfade shows both at once.
                    .contentTransition(.identity)
                }
                if isOpen {
                    tools
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(ToolButtonStyle())
            .menuStyle(.button)
            // In the web app's order, top down, even where a menu opens upwards.
            .menuOrder(.fixed)
        }
        .animation(.snappy, value: isOpen)
    }
}

/// The size of a large `.glass` button, with no glass of its own: that goes on
/// around the whole control (`toolGlass`), where a menu's label shows it too.
private struct ToolButtonStyle: ButtonStyle {
    // Scaled with the text as the system's glass buttons are, the Share button
    // beside them among them: about as a large title grows, icon and all.
    @ScaledMetric(relativeTo: .largeTitle) private var width = 62.0

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(width / 62)
            .frame(width: width, height: width * 52 / 62)
            .contentShape(.capsule)
    }
}

extension View {
    /// The glass of a large `.glass` button, drawn by SwiftUI around a control
    /// rather than by the system inside it: a menu's system glass arrives a beat
    /// after a button's, so the column would unfold in two steps.
    fileprivate func toolGlass() -> some View {
        glassEffect(.regular.interactive(), in: .capsule)
    }
}

/// A tool and its name, small beside it on a glass of its own, which keeps it
/// legible over bright ground and dark space alike. The name is a caption: the
/// button carries the same one for VoiceOver, and a tap on it reaches the globe.
/// `hint` is the web app's hover text, what is behind the entry, read by VoiceOver.
private struct ToolRow<Tool: View>: View {
    let title: LocalizedStringKey
    let hint: LocalizedStringKey
    @ViewBuilder let tool: Tool

    init(_ title: LocalizedStringKey, hint: LocalizedStringKey, @ViewBuilder tool: () -> Tool) {
        self.title = title
        self.hint = hint
        self.tool = tool()
    }

    var body: some View {
        HStack(spacing: 10) {
            tool
                .toolGlass()
                .accessibilityHint(hint)
            Text(title)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .glassEffect(in: .capsule)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
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
