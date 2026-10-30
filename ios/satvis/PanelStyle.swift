import SwiftUI

// The app's surfaces, shared with the web app (src/css/main.css, `--panel-*`): the
// system's dark grouped backgrounds, a surface of `#1c1c1e` and on it raised rows of
// `#2c2c2e`, the system's separator between them, the web app's ink and cyan, and the
// system's red for what removes. Nothing blurs the globe: the open menu column cost an
// iPad mini's compositor 5.1 ms of GPU a frame in Liquid Glass, 1.2 ms frosted with
// `.ultraThinMaterial`, and 0.1 ms drawn. A shadow under it cost 0.8 ms more. Where
// a panel floats over the globe it has a light edge and a glow along the top where
// Liquid Glass has its rim, and lets the globe through as `PanelDensity` says.

extension Color {
    /// What floats over the globe, the info panel and the sheets: the web app's
    /// `#1c1c1e`.
    static let panelSurface = Color(uiColor: .secondarySystemGroupedBackground.atBaseLevel)
    /// A row or a card on a surface: the web app's `#2c2c2e`, which a sheet's list
    /// rows already are.
    static let panelRaised = Color(uiColor: .tertiarySystemGroupedBackground.atBaseLevel)
    /// The web app's `#edffff`. The secondary style is this, fainter: the web app's
    /// muted ink is it at 60 %.
    static let panelInk = Color(red: 0xED / 255, green: 1, blue: 1)
    /// The web app's cyan, `#7fd2ea`, for what is open or chosen.
    static let panelAccent = Color(red: 127 / 255, green: 210 / 255, blue: 234 / 255)
    /// The web app's filled button, `#3d7f93`: the cyan darkened to carry the ink,
    /// which on the cyan itself reads at 1.4 to 1.
    static let panelPrimary = Color(red: 0x3D / 255, green: 0x7F / 255, blue: 0x93 / 255)
    /// What is chosen, and a tab's count: the web app's `#ffffff1f`.
    static let panelSelected = Color.white.opacity(0x1F / 255)
    /// "Not where it rests", as on the web: the clock deck's reset, a stale element set.
    static let panelAmber = Color(red: 1, green: 0xD4 / 255, blue: 0x79 / 255)
    /// The web app's `#4ade80`: what could be seen, the sky view's lock and its chip.
    static let panelGreen = Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
}

extension UIColor {
    /// Resolved at the base level wherever it is drawn: a sheet's elevated level
    /// lifts the grouped backgrounds a step, `#2c2c2e` and `#3a3a3c`.
    fileprivate var atBaseLevel: UIColor {
        UIColor { traits in
            self.resolvedColor(with: traits.modifyingTraits { $0.userInterfaceLevel = .base })
        }
    }
}

/// How much of the globe a surface over it hides: the web app's
/// `--panel-surface-float` and `--panel-surface-dense`.
enum PanelDensity {
    /// The menu column, the corner buttons, the clock deck and the sky view's card:
    /// a few large glyphs, which the globe can show through.
    case float
    /// The tool panels, the info panel and the sheets: rows of small text, which
    /// the globe and its labels show behind faintly, and do not bleed through.
    case dense

    var opacity: Double {
        switch self {
        case .float: 0.85
        case .dense: 0.9
        }
    }
}

extension EnvironmentValues {
    /// How dense the panels under it are.
    @Entry var panelDensity = PanelDensity.float
}

extension View {
    /// Floating over the globe, in `shape`, in the panels' ink.
    func panel(in shape: some InsettableShape) -> some View {
        modifier(PanelBackground(shape: shape))
    }

    /// Floating over the globe, its corners `cornerRadius` points round: every
    /// panel's 16 unless told otherwise, the buttons' 12 and the 4 points the menu
    /// column sets its rows in, so the column folded to its toggle is a button's
    /// shape, not a capsule.
    func panel(cornerRadius: CGFloat = PanelMetrics.radius) -> some View {
        panel(in: .rect(cornerRadius: cornerRadius))
    }

    /// A navigation stack's list on what is behind it, the info panel's surface:
    /// the list's background and the stack's cleared, which were black on an iPad.
    func panelList() -> some View {
        scrollContentBackground(.hidden)
            .containerBackground(.clear, for: .navigation)
    }

    /// A sheet on the dense surface, as the info panel: the system's is solid, or
    /// Liquid Glass, which blurs the globe behind it every frame.
    func panelSheet() -> some View {
        panelList()
            .presentationBackground(Color.panelSurface.opacity(PanelDensity.dense.opacity))
    }

    /// A segmented picker on a card's raised track. The system's track is a
    /// translucent fill, which let the globe's labels through a panel, and fainter
    /// still while disabled: UIKit dims the whole control.
    func panelSegmented() -> some View {
        pickerStyle(.segmented)
            .labelsHidden()
            .background(Color.panelRaised, in: .capsule)
    }
}

/// The surface of `panel(in:)`, as dense as the environment says.
private struct PanelBackground<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.panelDensity) private var density

    func body(content: Content) -> some View {
        content
            .foregroundStyle(Color.panelInk)
            .background {
                shape.fill(Color.panelSurface.opacity(density.opacity))
                    .overlay(shape.fill(LinearGradient(colors: [.white.opacity(0.05), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.35))))
            }
            .overlay(shape.strokeBorder(PanelEdge.gradient, lineWidth: 1))
    }
}

/// The panel's edge.
private enum PanelEdge {
    /// Brightest at the top leading corner and the bottom trailing one, as Liquid
    /// Glass's rim is.
    static let gradient = LinearGradient(
        stops: [
            .init(color: .white.opacity(0.33), location: 0), .init(color: .white.opacity(0.05), location: 0.45),
            .init(color: .white.opacity(0.05), location: 0.6), .init(color: .white.opacity(0.18), location: 1),
        ],
        startPoint: .topLeading, endPoint: .bottomTrailing)
}

/// The button: on the panel, its corners 12 points round, growing and lit while
/// pressed, as Liquid Glass's are. At least 44 points a side, so an icon alone is a
/// square. `emphasis` sets it apart from the panel. `square` makes an icon the folded menu column's twin, for the corner's buttons:
/// as tall, as round, and as wide whichever icon it holds.
struct PanelButtonStyle: ButtonStyle {
    /// How a button stands out from its panel.
    enum Emphasis {
        /// The panel's ink.
        case plain
        /// The web app's cyan, for the action a panel offers first.
        case accent
        /// Filled, as the web app's primary button, for a panel's main action.
        case filled
    }

    var emphasis = Emphasis.plain
    var square = false
    @Environment(\.isEnabled) private var isEnabled
    /// Dynamic Type's scale, as the menu column's rows take it.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    func makeBody(configuration: Configuration) -> some View {
        // The folded column: one row.
        let side = square ? PanelMetrics.row * scale : PanelMetrics.row
        let radius: CGFloat = square ? 16 : 12
        configuration.label
            .padding(.horizontal, square ? 0 : 12)
            .frame(minWidth: side, minHeight: side)
            .foregroundStyle(emphasis == .filled ? .panelInk : !isEnabled ? Color(white: 0x64 / 255) : emphasis == .accent ? .panelAccent : .panelInk)
            .background(configuration.isPressed ? .white.opacity(0.18) : .clear, in: .rect(cornerRadius: radius))
            .modifier(PanelButtonSurface(filled: emphasis == .filled, radius: radius))
            // Dimmed whole, as the web app's disabled buttons are.
            .opacity(emphasis == .filled && !isEnabled ? 0.5 : 1)
            .contentShape(.rect(cornerRadius: radius))
            .scaleEffect(configuration.isPressed ? 1.08 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}

/// Under a `PanelButtonStyle`: the panel, or the web app's primary fill.
private struct PanelButtonSurface: ViewModifier {
    let filled: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        if filled {
            content.background(Color.panelPrimary, in: .rect(cornerRadius: radius))
        } else {
            content.panel(cornerRadius: radius)
        }
    }
}

/// The size scale, shared with the web app (src/css/main.css, `--toolbar-row` and on):
/// in points at the default text size, which Dynamic Type scales the rows by. The text
/// is a size under the system's body, as the web app's on a touch screen: the
/// subheadline's 15 for a row's name, the callout's 16 for a panel's title, the
/// footnote's 13 for a note and the caption's 12 for a section's heading.
enum PanelMetrics {
    /// A row, a button, and the folded menu column: the fingertip Apple's Human
    /// Interface Guidelines ask for.
    static let row: CGFloat = 44
    /// Between the menu column and its panel, and between the corner's buttons.
    static let gap: CGFloat = 8
    /// From the safe area's edge to the menu column and the corner's buttons: the
    /// gap, as the web app's, since a phone's safe area already clears the notch and
    /// the rounded corners.
    static let edge = gap
    /// From the safe area's top to what sits under the menu toggle and the corner's
    /// first button.
    static let underTopRow = edge + row + gap
    /// A panel's corners, a card's and the info card's.
    static let radius: CGFloat = 16
}
