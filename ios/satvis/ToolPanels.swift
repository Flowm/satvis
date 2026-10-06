import SatvisCore
import SatvisRender
import SwiftUI

/// What the menu column opens beside it, as the web app's toolbar panels
/// (`ToolbarPanel.vue`). The satellite browser and the ground stations are
/// sheets instead: lists too long for a panel.
enum ToolPanel: Hashable {
    case components, map, view, graphics

    var title: LocalizedStringKey {
        switch self {
        case .components: "Components"
        case .map: "Map"
        case .view: "View"
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
            // Gone with the touch, not carried through the column's animation.
            .animation(nil, value: configuration.isPressed)
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
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
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
                        Text(name)
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

/// From where the globe is seen: the web app's View panel, less the scene modes
/// (2D, Columbus) and the camera modes the app does not draw.
struct ViewPanel: View {
    let session: Session

    var body: some View {
        PanelSection("View mode") {
            Segments(
                title: "View mode",
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
        }
        if session.observer != nil {
            PanelSection("Aiming") {
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
    }
}
