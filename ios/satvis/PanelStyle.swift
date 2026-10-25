import SwiftUI

// The app's surfaces, shared with the web app (src/css/main.css): the system's dark
// grouped backgrounds, whose `#1c1c1e` the lists' rows already are, so a panel over
// the globe and the info panel beside it are one material. What floats over the
// globe is the surface at 85 %, with a light edge and a glow along the top where
// Liquid Glass has its rim. Nothing blurs the globe behind it: the open menu column
// cost an iPad mini's compositor 5.1 ms of GPU a frame in Liquid Glass, 1.2 ms
// frosted with `.ultraThinMaterial`, and 0.1 ms so. A shadow under it cost 0.8 ms more.

extension Color {
    /// What floats over the globe, and the lists' rows: the web app's `#1c1c1e`.
    static let panelSurface = Color(uiColor: .secondarySystemGroupedBackground)
    /// A card on a surface: the web app's `#2c2c2e`.
    static let panelRaised = Color(uiColor: .tertiarySystemGroupedBackground)
    /// The web app's `#edffff`.
    static let panelInk = Color(red: 0xED / 255, green: 1, blue: 1)
    /// The web app's cyan, `#7fd2ea`, for what is open or chosen.
    static let panelAccent = Color(red: 127 / 255, green: 210 / 255, blue: 234 / 255)
}

extension View {
    /// Floating over the globe, in `shape`.
    func panel(in shape: some InsettableShape) -> some View {
        background {
            shape.fill(Color.panelSurface.opacity(0.85))
                .overlay(shape.fill(LinearGradient(colors: [.white.opacity(0.05), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.35))))
        }
        .overlay(shape.strokeBorder(PanelEdge.gradient, lineWidth: 1))
    }

    /// Floating over the globe, its corners `cornerRadius` points round: every
    /// panel's 16 unless told otherwise, the buttons' 12 and the 4 points the menu
    /// column sets its rows in, so the column folded to its toggle is a button's
    /// shape, not a capsule.
    func panel(cornerRadius: CGFloat = 16) -> some View {
        panel(in: .rect(cornerRadius: cornerRadius))
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
/// square. `prominent` takes the web app's cyan for the action a panel offers first.
/// `square` makes an icon the folded menu column's twin, for the corner's buttons:
/// as tall, as round, and as wide whichever icon it holds.
struct PanelButtonStyle: ButtonStyle {
    var prominent = false
    var square = false
    @Environment(\.isEnabled) private var isEnabled
    /// Dynamic Type's scale, as the menu column's rows take it.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    func makeBody(configuration: Configuration) -> some View {
        // The folded column: a 44 pt row and its 4 pt inset over and under it.
        let side = square ? 44 * scale + 8 : 44
        let radius: CGFloat = square ? 16 : 12
        configuration.label
            .padding(.horizontal, square ? 0 : 12)
            .frame(minWidth: side, minHeight: side)
            .foregroundStyle(!isEnabled ? Color(white: 0x64 / 255) : prominent ? .panelAccent : .panelInk)
            .background(configuration.isPressed ? .white.opacity(0.18) : .clear, in: .rect(cornerRadius: radius))
            .panel(cornerRadius: radius)
            .contentShape(.rect(cornerRadius: radius))
            .scaleEffect(configuration.isPressed ? 1.08 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}
