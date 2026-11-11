import SatvisCore
import SatvisRender
import SwiftUI

/// What the window offers the menu bar: its panels, Bookmarks among them, and
/// Hide UI, which are the window's state, not the session's.
struct WindowCommands {
    let showsUI: Bool
    let toggleUI: () -> Void
    /// The panel open beside the menu column, if any.
    let panel: ToolPanel?
    /// Opens a panel, bringing the UI and the column back for it, or closes it for nil.
    let showPanel: (ToolPanel?) -> Void
}

extension FocusedValues {
    /// The window's commands, while it is in front.
    @Entry var windowCommands: WindowCommands?
}

/// The Mac's menu bar: the menu column's entries, the projection, the sky view and
/// the base map, what is selected, the bookmarks and the links, with their shortcuts.
struct SatvisCommands: Commands {
    let session: Session
    @FocusedValue(\.windowCommands) private var window
    @Environment(\.openWindow) private var openWindow

    /// The column's panels after Satellites, numbered in its order.
    private static let numbered: [ToolPanel] = [.components, .map, .locations, .globe, .sky, .graphics]

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About Satvis") { openWindow(id: SatvisApp.aboutWindow) }
        }
        // One window, as on the iPhone (SatvisApp).
        CommandGroup(replacing: .newItem) {}
        // Not ⌘C, which copies the text selected in a field.
        CommandGroup(after: .pasteboard) {
            Button("Copy Link to This View") {
                Platform.copy(session.link(sharing: true).url(site: session.site).absoluteString)
            }
            .keyboardShortcut("c", modifiers: [.command, .shift])
        }
        CommandGroup(before: .toolbar) {
            ForEach(Array(Self.numbered.enumerated()), id: \.element) { index, panel in
                Button(panel.title) { window?.showPanel(window?.panel == panel ? nil : panel) }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")))
            }
            .disabled(window == nil)
            Divider()
            Button("3D Globe") { session.choose(.threeD) }
                .keyboardShortcut("1", modifiers: [.command, .control])
            Button("2D Map") { session.choose(.twoD) }
                .keyboardShortcut("2", modifiers: [.command, .control])
            skyView
            Picker(
                "Base Map",
                selection: Binding {
                    session.baseLayer
                } set: {
                    session.baseLayer = $0
                }
            ) {
                ForEach(BaseLayer.allCases, id: \.self) { layer in
                    Text(layer.title).tag(layer)
                }
            }
            Button(session.observer != nil ? "Leave the Sky View" : "Home View") { session.goHome() }
            Button(window?.showsUI == false ? "Show UI" : "Hide UI") { window?.toggleUI() }
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(window == nil)
            Divider()
        }
        CommandMenu("Satellite") {
            Button("Find Satellite…") { window?.showPanel(.satellites) }
                .keyboardShortcut("f")
                .disabled(window == nil)
            Divider()
            track
            info
        }
        CommandMenu("Bookmarks") {
            Button("Show Bookmarks") { window?.showPanel(.bookmarks) }
                .keyboardShortcut("b")
                .disabled(window == nil)
            Button("Save This View") { Task { await session.saveHere() } }
                .keyboardShortcut("d")
                .disabled(session.here.query.isEmpty)
            Button("Default View") { session.openDefaultView() }
                .disabled(session.here.query.isEmpty)
            if !session.bookmarks.saved.isEmpty {
                Divider()
                ForEach(session.bookmarks.saved) { bookmark in
                    Button(bookmark.name) { session.open(bookmark) }
                }
            }
            if !session.featured.isEmpty {
                Divider()
                Menu("Featured") {
                    ForEach(session.featured) { bookmark in
                        Button(bookmark.name) { session.open(bookmark) }
                    }
                }
            }
        }
        CommandGroup(replacing: .help) {
            Link("Satvis Website", destination: URL(string: "https://satvis.space/")!)
            Link("Source Code on GitHub", destination: URL(string: "https://github.com/Flowm/satvis/")!)
            Link("Privacy", destination: session.privacyPolicy)
        }
    }

    /// Looking up from a place, as the Sky panel's rows do.
    private var skyView: some View {
        Menu("Sky View") {
            Button("Look Up from My Location") { Task { await session.lookUpFromHere() } }
            // The Geolocation station is My location's, so it has no item of its own.
            ForEach(session.passes.stations.filter { $0.name != StationList.geolocation }) { station in
                Button("Look Up from \(station.displayName)") { session.enterSky(at: station.id) }
            }
            if session.observer != nil {
                Divider()
                Button("Back to the Globe") { session.leaveSky() }
            }
        }
    }

    /// Follows what is selected, or stops following, as its panel's Track button
    /// does; nothing is followed in the sky view.
    @ViewBuilder private var track: some View {
        let selection = session.selection
        if let tracked = session.tracked, selection == nil || selection == tracked {
            Button("Stop Tracking") { session.stopTracking(animated: true) }
                .keyboardShortcut("t")
        } else {
            Button("Track") {
                if let selection {
                    session.follow(selection, animated: true)
                }
            }
            .keyboardShortcut("t")
            .disabled(selection == nil || session.observer != nil)
        }
    }

    /// Closes the info card, or opens the one of what is followed.
    @ViewBuilder private var info: some View {
        if session.selection != nil {
            Button("Close Info") { session.select(nil) }
                .keyboardShortcut("i")
        } else {
            Button("Show Info") { session.select(session.tracked) }
                .keyboardShortcut("i")
                .disabled(session.tracked == nil)
        }
    }
}
