import SatvisCore
import SatvisRender
import SwiftUI

/// What the menu column opens beside it, as the web app's toolbar panels
/// (`ToolbarPanel.vue`). The satellite browser and the locations are sheets
/// instead: lists too long for a panel.
enum ToolPanel: Hashable {
    case components, map, globe, sky, graphics

    var title: LocalizedStringKey {
        switch self {
        case .components: "Components"
        case .map: "Map"
        case .globe: "Globe"
        case .sky: "Sky"
        case .graphics: "Graphics"
        }
    }
}

extension EnvironmentValues {
    /// Whether the menu column shows its icons alone: on a phone, beside an open
    /// panel, as the web app's labels fold below 640 px.
    @Entry var toolNamesFolded = false
}

/// The web app's cyan for the entry whose panel is open, and for what is chosen.
private let toolAccent = Color(red: 127 / 255, green: 210 / 255, blue: 234 / 255)

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
        .padding(.vertical, 4)
        .clipShape(.rect(cornerRadius: 26))
        // The glass the system draws around a large `.glass` button, around the
        // whole panel instead.
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
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
    // Scaled with the text, icon and all, as the system's glass buttons are.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    @Environment(\.toolNamesFolded) private var folded

    var body: some View {
        HStack(spacing: 4) {
            configuration.icon
                .scaleEffect(scale)
                .frame(width: 44 * scale)
            if !folded {
                configuration.title
                    .font(.body.weight(.medium))
                    .lineLimit(1)
            }
        }
    }
}

/// A row of the column, across its width, a fingertip tall: with the column's
/// inset, the toggle's middle is level with the large glass buttons' opposite.
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
            .foregroundStyle(isSelected ? toolAccent : .primary)
            .padding(.leading, 4)
            .padding(.trailing, folded ? 4 : 18)
            .frame(maxWidth: .infinity, minHeight: 44 * scale, alignment: .leading)
            .background(.white.opacity(configuration.isPressed ? 0.12 : isSelected ? 0.1 : 0))
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
    /// Across the rest of a phone's width, over the top-right buttons as the web
    /// app's covers them; beside them, they would peek out past it.
    var fillsWidth = false
    let onClose: () -> Void
    @ViewBuilder let content: Content
    /// The column's rows', so that the two rules meet.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer(minLength: 8)
                Button("Close", systemImage: "xmark", action: onClose)
                    .labelStyle(.iconOnly)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44 * scale, height: 44 * scale)
                    .contentShape(.rect)
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            // The column's inset over its toggle's row, and none under it.
            .padding(.top, 4)
            Divider()
            ViewThatFits(in: .vertical) {
                padded(content)
                ScrollView {
                    padded(content)
                }
            }
        }
        .frame(maxWidth: fillsWidth ? .infinity : 280)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
    }

    private func padded(_ content: Content) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A group of a panel under a small title, as the web app's panels head theirs.
private struct PanelSection<Content: View>: View {
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
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

/// One of several, a row each with the chosen one ticked: the web app's radio
/// buttons, where the names are long.
private struct Choices<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(String, Value)]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(options, id: \.1) { name, value in
                Button {
                    selection = value
                } label: {
                    HStack {
                        // Cut short rather than wrapped, as the web app's rows are.
                        Text(name)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if selection == value {
                            Image(systemName: "checkmark")
                                .fontWeight(.semibold)
                                .foregroundStyle(toolAccent)
                        }
                    }
                    .frame(minHeight: 40)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
    }
}

/// Which satellite components are drawn.
struct ComponentsPanel: View {
    let catalog: CatalogModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
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
/// Sky panel, so in the sky view no projection is ticked (ADR 0003).
struct GlobePanel: View {
    @Bindable var session: Session

    var body: some View {
        let inSky = session.observer != nil
        PanelSection("Projection") {
            Choices(
                selection: Binding {
                    inSky ? nil : "3D"
                } set: { _ in
                    if inSky {
                        session.leaveSky()
                    }
                },
                options: [("3D", Optional("3D"))])
            if inSky {
                Note("In the sky view. Pick 3D to return to the globe.")
            }
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

/// Looking up from where the user is: the web app's Sky panel. Its settings stay in
/// sight on the globe, disabled where they need the sky view (ADR 0003).
struct SkyPanel: View {
    @Bindable var session: Session
    @State private var locating = false

    var body: some View {
        let inSky = session.observer != nil
        PanelSection("Sky view") {
            // Disabled while the position comes back, the spinner beside its name.
            Toggle(
                isOn: Binding {
                    inSky
                } set: { on in
                    guard on else {
                        return session.leaveSky()
                    }
                    Task {
                        locating = true
                        defer { locating = false }
                        await session.lookUpFromHere()
                    }
                }
            ) {
                Waiting("Look up", while: locating, as: "Finding your location")
            }
            .disabled(locating)
            Note("Start sky view from your current location. To look up elsewhere, use a location pin’s sky view button.")
        }
        PanelSection("Aiming") {
            // Waiting on the sensor, a second tap must not start a second probe.
            Toggle(
                isOn: Binding {
                    session.compass.isAiming && !session.compass.isProbing
                } set: { _ in
                    session.toggleCompass()
                }
            ) {
                Waiting("Use compass", while: session.compass.isProbing, as: "Waiting for the motion sensor")
            }
            .disabled(!inSky || session.compass.isProbing)
        }
        PanelSection("Out of sight") {
            Segments(title: "Out of sight", selection: $session.unseen, options: UnseenMode.allCases.map { ($0.rawValue.capitalized, $0) })
                .disabled(!inSky)
            Note("In Earth's shadow, too far away or during daylight.")
        }
    }
}

/// A switch's name, with a spinner beside it while it waits, as the web app's
/// replaces the slider.
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
private struct Note: View {
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
        max((UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.maximumFramesPerSecond ?? 60, 60)
    }
}
