import SatvisCore
import SatvisRender
import SwiftUI

/// What the menu column opens beside it, as the web app's toolbar panels
/// (`ToolbarPanel.vue`). The satellite browser and the bookmarks are sheets
/// instead: lists too long for a panel.
enum ToolPanel: Hashable {
    case components, map, locations, globe, sky, graphics

    var title: LocalizedStringKey {
        switch self {
        case .components: "Components"
        case .map: "Map"
        case .locations: "Locations"
        case .globe: "Globe"
        case .sky: "Sky"
        case .graphics: "Graphics"
        }
    }

    /// Its card's width. Locations' is wider: a station's latitude and longitude
    /// stand side by side, and 280 pt cut -122.2727 short.
    var cardWidth: CGFloat {
        self == .locations ? 320 : 260
    }

    /// Whether it takes the rest of a phone's width, over the corner's buttons,
    /// rather than a card short of them: 258 pt on a 402 pt phone cut "Ground
    /// station link" and "Satellite (VersaTiles)" short, and Locations' longitudes.
    var needsWidth: Bool {
        switch self {
        case .components, .map, .locations: true
        case .globe, .sky, .graphics: false
        }
    }
}

extension EnvironmentValues {
    /// Whether the menu column shows its icons alone: on a phone, beside an open
    /// panel, as the web app's labels fold below 640 px.
    @Entry var toolNamesFolded = false
}

/// The web app's menu column: one panel, the Menu toggle over a rule and the
/// entries under it, each its icon and its name, folding to the toggle alone so
/// that a phone's width is left to the globe.
struct ToolMenu<Tools: View>: View {
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
            .buttonStyle(ToolRowStyle())
            .accessibilityLabel(isOpen ? "Close menu" : "Menu")

            if isOpen {
                // In at once, where they will stand, for the growing panel to
                // uncover: faded in, they stood clear of it before it reached
                // them. Out faded, inside the shrinking panel.
                Group {
                    Divider()
                    tools
                }
                .transition(.asymmetric(insertion: .identity, removal: .opacity))
            }
        }
        // As wide as its widest name, every row across all of it.
        .fixedSize()
        .labelStyle(ToolLabelStyle())
        .clipShape(.rect(cornerRadius: 16))
        .panel()
        .animation(.snappy(duration: 0.2), value: isOpen)
    }
}

/// An entry of the menu column, highlighted while its panel is open. `hint` is
/// the web app's hover text, read by VoiceOver.
struct ToolEntry: View {
    let title: LocalizedStringKey
    let image: ImageResource
    let hint: LocalizedStringKey
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, image: image)
        }
        .buttonStyle(ToolRowStyle(isSelected: isSelected))
        // Named even where the column shows the icon alone.
        .accessibilityLabel(Text(title))
        .accessibilityHint(hint)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// An icon in a column of its own, so the names line up, and the name beside it.
private struct ToolLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        ToolLabel(configuration: configuration)
    }
}

private struct ToolLabel: View {
    let configuration: LabelStyleConfiguration
    /// Scaled with the text, icon and all, as the system's controls are.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    @Environment(\.toolNamesFolded) private var folded

    var body: some View {
        HStack(spacing: 4) {
            configuration.icon
                .scaleEffect(scale)
                .frame(width: PanelMetrics.row * scale)
            if !folded {
                configuration.title
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }
        }
    }
}

/// A row of the column, across its width, a fingertip tall: folded to its toggle,
/// the column is the corner buttons' twin opposite.
private struct ToolRowStyle: ButtonStyle {
    var isSelected = false

    func makeBody(configuration: Configuration) -> some View {
        ToolRow(configuration: configuration, isSelected: isSelected)
    }
}

private struct ToolRow: View {
    let configuration: ButtonStyleConfiguration
    let isSelected: Bool
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    @Environment(\.toolNamesFolded) private var folded

    var body: some View {
        configuration.label
            .foregroundStyle(isSelected ? Color.panelAccent : .primary)
            // Folded, the icon's column alone: a row square, as the web app's.
            .padding(.trailing, folded ? 0 : 18)
            .frame(maxWidth: .infinity, minHeight: PanelMetrics.row * scale, alignment: .leading)
            .background(.white.opacity(configuration.isPressed || isSelected ? 0.12 : 0))
            // Changed at once, the press's and the open panel's alike: the panel's
            // animation faded the latter in after the former had gone, a flicker.
            .animation(nil, value: configuration.isPressed)
            .animation(nil, value: isSelected)
            .contentShape(.rect)
    }
}

/// A panel beside the menu column: its title and a close button over a rule level
/// with the column's, and under it what it holds, scrolling only where the
/// screen is too short for it.
struct ToolPanelView<Content: View>: View {
    let title: LocalizedStringKey
    /// A card's width, or nil across all the room it is given.
    var width: CGFloat?
    let onClose: () -> Void
    @ViewBuilder let content: Content
    /// Dynamic Type's scale, as the menu column's rows take it, so that the title
    /// row is as tall as the column's first and the two rules meet.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title)
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Button("Close", systemImage: "xmark", action: onClose)
                    .labelStyle(.iconOnly)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: PanelMetrics.row * scale, height: PanelMetrics.row * scale)
                    .contentShape(.rect)
            }
            .padding(.leading, 12)
            .padding(.trailing, 4)
            Divider()
            ViewThatFits(in: .vertical) {
                padded(content)
                ScrollView {
                    padded(content)
                }
            }
        }
        .frame(maxWidth: width ?? .infinity)
        .panel()
        // Rows of small text, which the globe's labels showed through.
        .environment(\.panelDensity, .dense)
    }

    private func padded(_ content: Content) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            content
        }
        .font(.subheadline)
        .toggleStyle(CircleToggleStyle())
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A group of a panel under a small title, as the web app's panels head theirs.
struct PanelSection<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
    }
}

/// One of a few, side by side: the web app's radio buttons, where the names are short.
private struct Segments<Value: Hashable>: View {
    let title: LocalizedStringKey
    @Binding var selection: Value
    let options: [(String, Value)]

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(options, id: \.1) { name, value in
                Text(name).tag(value)
            }
        }
        .panelSegmented()
    }
}

/// Rows on an inset card, as Settings groups them, a hairline between each two
/// from the names' edge: a panel's switches, choices and places.
struct PanelCard<Content: View>: View {
    @ViewBuilder let content: Content
    @ScaledMetric(relativeTo: .body) private var markWidth = PanelRowMetrics.markWidth

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows.indices, id: \.self) { index in
                    rows[index]
                        .overlay(alignment: .top) {
                            if index > 0 {
                                Divider()
                                    .padding(.leading, PanelRowMetrics.inset + markWidth + PanelRowMetrics.spacing)
                            }
                        }
                }
            }
        }
        .background(Color.panelRaised)
        .clipShape(.rect(cornerRadius: 12))
    }
}

/// Where a card's row puts its mark and name, in points at the default text size,
/// which the card's hairlines start level with.
enum PanelRowMetrics {
    static let markWidth: CGFloat = 24
    static let inset: CGFloat = 14
    static let spacing: CGFloat = 12
}

/// A card's row: a mark in a column of its own, so the names line up, and the name,
/// cut short rather than wrapped, as the web app's rows are.
struct PanelRow<Mark: View, Title: View>: View {
    @ViewBuilder let mark: Mark
    @ViewBuilder let title: Title
    @ScaledMetric(relativeTo: .body) private var markWidth = PanelRowMetrics.markWidth
    @ScaledMetric(relativeTo: .body) private var height = PanelMetrics.row

    var body: some View {
        HStack(spacing: PanelRowMetrics.spacing) {
            mark
                .frame(width: markWidth)
            title
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, PanelRowMetrics.inset)
        .frame(minHeight: height)
        .contentShape(.rect)
    }
}

/// A row pressed lit, and greyed while it is disabled, as the web app's rows.
struct PanelRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PanelRowBody(configuration: configuration)
    }
}

private struct PanelRowBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .background(.white.opacity(configuration.isPressed ? 0.12 : 0))
            .opacity(isEnabled ? 1 : 0.4)
    }
}

/// iOS's selection circle, empty or filled with a tick: one mark for a switch and a
/// choice alike, as the web app gives both one language.
private struct SelectionCircle: View {
    let isOn: Bool

    var body: some View {
        Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
            .font(.body)
            .symbolRenderingMode(.palette)
            .foregroundStyle(isOn ? Color.panelSurface : .white.opacity(0.35), Color.panelAccent)
            .accessibilityHidden(true)
    }
}

/// A switch as a card's row, led by the selection circle; still a switch to
/// VoiceOver and to the UI tests.
private struct CircleToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            PanelRow {
                SelectionCircle(isOn: configuration.isOn)
            } title: {
                configuration.label
            }
        }
        .buttonStyle(PanelRowStyle())
        .accessibilityRepresentation {
            // Not pinned to `.switch`: that nests a second, unhittable switch in
            // the row for VoiceOver and the UI tests to stop at.
            Toggle(isOn: configuration.$isOn) {
                configuration.label
            }
        }
    }
}

/// One of several, a row each with the chosen one's circle filled: the web app's
/// radio buttons, where the names are long.
private struct Choices<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(String, Value)]
    /// Shown but not offered, greyed as the web app's disabled rows.
    var disabled: Set<Value> = []

    var body: some View {
        PanelCard {
            ForEach(options, id: \.1) { name, value in
                Button {
                    selection = value
                } label: {
                    PanelRow {
                        SelectionCircle(isOn: selection == value)
                    } title: {
                        Text(name)
                    }
                }
                .buttonStyle(PanelRowStyle())
                .disabled(disabled.contains(value))
                .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
    }
}

/// Which satellite components are drawn.
struct ComponentsPanel: View {
    let catalog: CatalogModel

    var body: some View {
        PanelCard {
            ForEach(SatelliteComponents.named, id: \.0) { name, component in
                Toggle(
                    name,
                    isOn: Binding {
                        catalog.components.contains(component)
                    } set: {
                        catalog.setComponent(component, enabled: $0)
                    })
            }
        }
        if catalog.components.contains(.label), catalog.activeEntries.count > SatelliteComponents.labelBudget {
            Text("Labels show for up to \(SatelliteComponents.labelBudget) satellites")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// What the globe is covered with: the web app's Map panel, less the overlays,
/// surfaces and star maps the app does not draw.
struct MapPanel: View {
    @Bindable var session: Session

    var body: some View {
        PanelSection("Basemap") {
            Choices(selection: $session.baseLayer, options: BaseLayer.allCases.map { ($0.title, $0) })
        }
        // The web app's names for the two, as its links spell them.
        PanelSection("Terrain") {
            Segments(title: "Terrain", selection: $session.terrain, options: [("None", false), ("ReEarth", true)])
        }
    }
}

/// The globe's projection and camera: the web app's Globe panel, less the 2D and
/// Columbus projections the app does not draw. It writes the same view as the
/// Sky panel, so in the sky view no projection is ticked; Sky view is, listed only
/// then and greyed, as it is entered from the Sky panel, which names a place
/// (ADR 0003).
struct GlobePanel: View {
    @Bindable var session: Session

    var body: some View {
        let inSky = session.observer != nil
        PanelSection("Projection") {
            Choices(
                selection: Binding {
                    inSky ? "Sky" : "3D"
                } set: { _ in
                    if inSky {
                        session.leaveSky()
                    }
                },
                options: inSky ? [("3D", "3D"), ("Sky view", "Sky")] : [("3D", "3D")],
                disabled: ["Sky"])
        }
        PanelSection("Camera") {
            Segments(title: "Camera", selection: $session.cameraFrame, options: CameraFrame.allCases.map { ($0.rawValue, $0) })
                .disabled(inSky)
            if inSky {
                Note("The sky view holds the camera.")
            }
        }
    }
}

/// Looking up from a place: the web app's Sky panel. Each place's row enters the
/// sky view standing there, or moves a view already up; its settings stay in
/// sight on the globe, disabled where they need the sky view (ADR 0003).
struct SkyPanel: View {
    @Bindable var session: Session
    @State private var locating = false

    var body: some View {
        let inSky = session.observer != nil
        let here = session.observer.flatMap { id in session.passes.stations.first { $0.id == id } }
        // The Geolocation station is My location's, so it has no row of its own.
        let places = session.passes.stations.filter { $0.name != StationList.geolocation }
        PanelSection("Look up from") {
            PanelCard {
                Place(Text("My location"), image: .lucideLocateFixed, isHere: here?.name == StationList.geolocation, waitingFor: locating ? "Finding your location" : nil) {
                    Task {
                        locating = true
                        defer { locating = false }
                        await session.lookUpFromHere()
                    }
                }
                .disabled(locating)
                ForEach(places) { station in
                    Place(Text(verbatim: station.displayName), image: .lucideMapPin, isHere: here?.id == station.id) {
                        session.enterSky(at: station.id)
                    }
                    // A fix in flight would move the view after this tap.
                    .disabled(locating)
                }
                if inSky {
                    Place(Text("Back to the globe"), image: .lucideGlobe, isMuted: true) {
                        session.leaveSky()
                    }
                    .disabled(locating)
                }
            }
            if places.isEmpty {
                Note("Locations you add are listed here too.")
            }
        }
        PanelSection("Aiming") {
            // Waiting on the sensor, a second tap must not start a second probe.
            PanelCard {
                Toggle(
                    isOn: Binding {
                        session.aim.compass.isAiming && !session.aim.compass.isProbing
                    } set: { _ in
                        session.aim.toggleCompass()
                    }
                ) {
                    Waiting("Use compass", while: session.aim.compass.isProbing, as: "Waiting for the motion sensor")
                }
                .disabled(!inSky || session.aim.compass.isProbing)
            }
        }
        PanelSection("Camera") {
            PanelCard {
                Toggle(
                    isOn: Binding {
                        session.aim.passthrough.isShowing
                    } set: { _ in
                        session.aim.togglePassthrough()
                    }
                ) {
                    Waiting("Show camera", while: session.aim.isStartingCamera, as: "Starting the camera")
                }
                .disabled(!inSky || session.aim.isStartingCamera)
            }
            Note("The sky through the camera, aimed by compass.")
        }
        PanelSection("Out of sight") {
            Segments(title: "Out of sight", selection: $session.unseen, options: UnseenMode.allCases.map { ($0.rawValue.capitalized, $0) })
                .disabled(!inSky)
            Note("In Earth's shadow, too far away or during daylight.")
        }
    }
}

/// A card's row that acts rather than chooses, the web app's `toolbarPlace`: an icon
/// in the circle's place, or a spinner while it waits, and a name, lit where the sky
/// view stands.
struct Place: View {
    let title: Text
    let image: ImageResource
    let isHere: Bool
    let isMuted: Bool
    /// What VoiceOver hears of the spinner, shown while there is one.
    let waitingFor: LocalizedStringKey?
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var iconSize = 20.0

    init(_ title: Text, image: ImageResource, isHere: Bool = false, isMuted: Bool = false, waitingFor: LocalizedStringKey? = nil, action: @escaping () -> Void) {
        self.title = title
        self.image = image
        self.isHere = isHere
        self.isMuted = isMuted
        self.waitingFor = waitingFor
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            PanelRow {
                if let waitingFor {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(Text(waitingFor))
                } else {
                    Image(image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: iconSize, height: iconSize)
                }
            } title: {
                title
            }
            .foregroundStyle(isHere ? Color.panelAccent : isMuted ? .secondary : .primary)
            .background(.white.opacity(isHere ? 0.08 : 0))
        }
        .buttonStyle(PanelRowStyle())
        .accessibilityAddTraits(isHere ? .isSelected : [])
    }
}

/// A switch's name, with a spinner beside it while it waits, as the web app's
/// replaces the mark.
private struct Waiting: View {
    let title: LocalizedStringKey
    let waiting: Bool
    /// What VoiceOver hears of the spinner.
    let what: LocalizedStringKey

    init(_ title: LocalizedStringKey, while waiting: Bool, as what: LocalizedStringKey) {
        self.title = title
        self.waiting = waiting
        self.what = what
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
            if waiting {
                ProgressView()
                    .accessibilityLabel(Text(what))
            }
        }
    }
}

/// A line under a panel's settings, as the web app's `toolbarNote`.
struct Note: View {
    let text: LocalizedStringKey

    init(_ text: LocalizedStringKey) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}

/// How the globe is drawn and what that costs: the web app's Graphics panel, less
/// the scene effects and MSAA, which the app does not switch.
struct GraphicsPanel: View {
    @Bindable var session: Session
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        PanelSection("Measurement") {
            PanelCard {
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
        }
        // The web app's ladder (src/config/rendering.ts): the fixed rungs below
        // the screen's own ratio, then the screen's, so it only offers savings.
        PanelSection("Pixel ratio") {
            Choices(
                selection: $session.pixelRatio,
                options: LinkCodec.pixelRatios.filter { $0 == "native" || (Double($0) ?? 0) < displayScale }.map { ratio in
                    (ratio == "native" ? String(format: "%.1fx (Native)", displayScale) : String(format: "%.1fx", Double(ratio) ?? 0), ratio)
                })
        }
        // Only the rates the screen can show; a rate kept from a faster screen, as a
        // restored backup brings, reads as the fastest here.
        let rates = Session.frameRates.filter { $0 <= maximumFrameRate }
        PanelSection("Frame rate") {
            Segments(
                title: "Frame rate",
                selection: Binding {
                    rates.last { $0 <= session.frameRate } ?? rates[0]
                } set: {
                    session.frameRate = $0
                },
                options: rates.map { ("\($0) fps", $0) })
            Note("Fewer frames save battery.")
        }
    }

    /// 120 on a ProMotion screen, never under 60.
    private var maximumFrameRate: Int {
        max(GlobeRenderer.displayMaximumFramesPerSecond, 60)
    }
}
