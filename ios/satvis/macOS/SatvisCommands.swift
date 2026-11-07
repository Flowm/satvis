import SatvisCore
import SwiftUI

/// What the window offers the menu bar: its panels, sheets and Hide UI, which are
/// the window's state, not the session's.
struct WindowCommands {
    let showsUI: Bool
    let toggleUI: () -> Void
    /// Opens the panel, or closes it if it is open, as its entry in the column does.
    let togglePanel: (ToolPanel) -> Void
    let openBookmarks: () -> Void
    let openAbout: () -> Void
}

extension FocusedValues {
    /// The window's commands, while it is in front.
    @Entry var windowCommands: WindowCommands?
}

/// The Mac's menu bar: the menu column's entries, the projection, the way home and
/// the view's link, with their shortcuts.
struct SatvisCommands: Commands {
    let session: Session
    @FocusedValue(\.windowCommands) private var window

    /// The column's panels after Satellites, numbered in its order.
    private static let numbered: [ToolPanel] = [.components, .map, .locations, .globe, .sky, .graphics]

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About Satvis") { window?.openAbout() }
                .disabled(window == nil)
        }
        // One window, as on the iPhone (SatvisApp).
        CommandGroup(replacing: .newItem) {}
        CommandGroup(after: .pasteboard) {
            Button("Copy Link to This View") {
                Platform.copy(session.link(sharing: true).url(site: session.site).absoluteString)
            }
            .keyboardShortcut("c", modifiers: [.command, .shift])
        }
        CommandGroup(before: .toolbar) {
            Button("Bookmarks") { window?.openBookmarks() }
                .keyboardShortcut("b")
            Button("Satellites") { window?.togglePanel(.satellites) }
                .keyboardShortcut("f")
            ForEach(Array(Self.numbered.enumerated()), id: \.element) { index, panel in
                Button(panel.title) { window?.togglePanel(panel) }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")))
            }
            Divider()
            Button("3D Globe") { session.choose(.threeD) }
                .keyboardShortcut("1", modifiers: [.command, .control])
            Button("2D Map") { session.choose(.twoD) }
                .keyboardShortcut("2", modifiers: [.command, .control])
            Button(session.observer != nil ? "Leave the Sky View" : "Home View") { session.goHome() }
                .keyboardShortcut("h", modifiers: [.command, .shift])
            Button(window?.showsUI == false ? "Show UI" : "Hide UI") { window?.toggleUI() }
                .keyboardShortcut("u", modifiers: [.command, .shift])
            Divider()
        }
    }
}
