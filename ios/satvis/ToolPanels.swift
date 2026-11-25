import SatvisCore
import SatvisRender
import SwiftUI

/// What the menu column opens beside it, as the web app's toolbar panels
/// (`ToolbarPanel.vue`). The bookmarks are a sheet instead, and on a phone the
/// satellite browser: lists too long for a card.
enum ToolPanel: Hashable {
    case satellites, components, map, locations, globe, sky, graphics
    /// A sheet elsewhere; a panel on a Mac, as on the web.
    case bookmarks

    var title: LocalizedStringKey {
        switch self {
        case .satellites: "Satellites"
        case .components: "Components"
        case .map: "Map"
        case .locations: "Locations"
        case .globe: "Globe"
        case .sky: "Sky"
        case .graphics: "Graphics"
        case .bookmarks: "Bookmarks"
        }
    }

    /// Its card's width, or what the corner's buttons leave where that is less, as
    /// on a phone. Locations' is wider: a station's latitude and longitude stand
    /// side by side, and on a 402 pt phone the 282 pt left fits -122.2727. The
    /// satellite browser's and the Map panel's are the web app's: a satellite imagery
    /// row holds the name and its layers' buttons side by side.
    var cardWidth: CGFloat {
        switch self {
        case .locations, .satellites: 320
        case .map: 300
        // Three bookmark cards to a row.
        case .bookmarks: 520
        default: 260
        }
    }

    /// Whether it holds a list that scrolls itself, rather than rows the card scrolls.
    var scrollsItself: Bool {
        self == .satellites || self == .bookmarks
    }
}

/// What a window shows over the globe: the UI, the menu column and the panel
/// beside it, which goes with the column. The UI hidden hides both, and keeps
/// them as they were.
struct WindowChrome {
    /// The Graphics panel's Hide UI, as the web app's (`hideUI`).
    var showsUI = true
    var showsTools = false {
        didSet {
            if !showsTools {
                panel = nil
            }
        }
    }
    /// The panel open beside the menu column, if any.
    private(set) var panel: ToolPanel?

    /// Opens a panel, and the column for it, or closes it for nil.
    mutating func show(_ which: ToolPanel?) {
        if which != nil {
            showsTools = true
        }
        panel = which
    }

    /// Opens a panel, bringing the UI and the column back for it.
    mutating func reveal(_ which: ToolPanel) {
        showsUI = true
        show(which)
    }

    /// Opens a panel as `reveal` does, or closes it if it is open.
    mutating func toggle(_ which: ToolPanel) {
        if panel == which {
            panel = nil
        } else {
            reveal(which)
        }
    }

    /// Closes the panel, and on a compact width folds the column, for what happens
    /// next on the globe: a panel opened there would be under the column.
    mutating func clearTheGlobe(compact: Bool) {
        panel = nil
        if compact {
            showsTools = false
        }
    }

    /// Hides the menu column, its panel, the clock deck and the corner's buttons, for
    /// a picture of the globe. The menu closes first, so Show UI brings none of it back
    /// open, as on the web.
    mutating func hideUI(compact: Bool) {
        clearTheGlobe(compact: compact)
        showsUI = false
    }

    /// Hides the UI as `hideUI` does, or shows it again.
    mutating func toggleUI(compact: Bool) {
        if showsUI {
            hideUI(compact: compact)
        } else {
            showsUI = true
        }
    }
}

extension EnvironmentValues {
    /// How tall what a panel holds may be, under its title, where it scrolls itself;
    /// nil where it may be as tall as it is.
    @Entry var panelRoom: CGFloat?
    /// Whether the menu column shows its icons alone: on a phone, beside an open
    /// panel, as the web app's labels fold below 640 px.
    @Entry var toolNamesFolded = false
}

/// The web app's menu column: one panel, the Menu toggle over a rule and the
/// entries under it, each its icon and its name, folding to the toggle alone so
/// that a phone's width is left to the globe. The entries scroll where they are
/// taller than `maxHeight` leaves them, as on a phone in landscape or at the larger
/// text sizes.
struct ToolMenu<Tools: View>: View {
    @Binding var isOpen: Bool
    /// How tall the column may be; nil where it may be as tall as it is.
    var maxHeight: CGFloat?
    @ViewBuilder let tools: Tools
    /// The toggle's row, measured.
    @State private var toggleHeight: CGFloat = 0
    /// The entries, measured.
    @State private var toolsHeight: CGFloat?

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
                    .labelStyle(ToolLabelStyle(iconSide: 22))
            }
            .buttonStyle(ToolRowStyle())
            .accessibilityLabel(isOpen ? "Close menu" : "Menu")
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { toggleHeight = $0 }

            if isOpen {
                // In at once, where they will stand, for the growing panel to
                // uncover: faded in, they stood clear of it before it reached
                // them. Out faded, inside the shrinking panel.
                Group {
                    Divider()
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            tools
                        }
                    }
                    .measuresContent(height: $toolsHeight)
                    .frame(height: shownToolsHeight)
                }
                .transition(.asymmetric(insertion: .identity, removal: .opacity))
            }
        }
        // As wide as its widest name, every row across all of it.
        .fixedSize()
        .labelStyle(ToolLabelStyle())
        .clipShape(.rect(cornerRadius: PanelMetrics.radius))
        .panel()
        .animation(.snappy(duration: 0.2), value: isOpen)
    }

    /// The entries' height, or the room under the toggle and its rule where that is less.
    private var shownToolsHeight: CGFloat? {
        guard let toolsHeight else {
            return nil
        }
        guard let maxHeight else {
            return toolsHeight
        }
        return min(toolsHeight, max(maxHeight - toggleHeight - 1, PanelMetrics.row))
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
/// The web app's sizes: an entry's icon 20 points, the Menu toggle's 22, each
/// centred in the folded column's square, and the name 40 points in, 8 past an
/// entry's icon.
private struct ToolLabelStyle: LabelStyle {
    /// The icon's side; the Lucide assets are 22 points.
    var iconSide: CGFloat = 20

    func makeBody(configuration: Configuration) -> some View {
        ToolLabel(configuration: configuration, iconSide: iconSide)
    }
}

private struct ToolLabel: View {
    let configuration: LabelStyleConfiguration
    let iconSide: CGFloat
    /// Scaled with the text, icon and all, as the system's controls are.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    @Environment(\.toolNamesFolded) private var folded

    var body: some View {
        // The name 4 points into the icon's square: 12 to the icon, 20 of it and 8.
        HStack(spacing: -4 * scale) {
            configuration.icon
                .scaleEffect(scale * iconSide / 22)
                .frame(width: PanelMetrics.row * scale)
            if !folded {
                configuration.title
                    .font(.panelLabel)
                    .lineLimit(1)
            }
        }
    }
}

/// A row of the column, across its width, a fingertip tall: folded to its toggle,
/// the column is the corner buttons' twin opposite.
private struct ToolRowStyle: ButtonStyle {
    var isSelected = false
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    @Environment(\.toolNamesFolded) private var folded

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isSelected ? Color.panelAccent : .primary)
            // Folded, the icon's column alone: a row square, as the web app's. Open,
            // the web's 10 points and its border's 1 past the longest name.
            .padding(.trailing, folded ? 0 : 11)
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
/// with the column's, and under it what it holds, scrolling only where it would
/// run past `maxHeight`.
struct ToolPanelView<Content: View>: View {
    /// Which panel: its title, its width, and whether what it holds scrolls itself, as
    /// a list does, and is only told the height left under the title (`panelRoom`).
    let panel: ToolPanel
    /// How tall it may run, title and all: down to the clock deck. Nil leaves it
    /// what it is offered.
    let maxHeight: CGFloat?
    let onClose: () -> Void
    @ViewBuilder let content: Content
    /// Dynamic Type's scale, as the menu column's rows take it, so that the title
    /// row is as tall as the column's first and the two rules meet.
    @ScaledMetric(relativeTo: .body) private var scale = 1.0
    /// What it holds, measured, which the scroll view is as tall as where it fits.
    @State private var contentHeight: CGFloat?
    /// The title row and its rule, measured.
    @State private var headerHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(panel.title)
                    .font(.panelTitle.weight(.semibold))
                Spacer(minLength: 8)
                Button("Close", systemImage: "xmark", action: onClose)
                    .titleRowButton(side: PanelMetrics.row * scale)
            }
            .padding(.leading, 12)
            .padding(.trailing, 4)
            Divider()
                .onGeometryChange(for: CGFloat.self) {
                    $0.frame(in: .named(Self.space)).maxY
                } action: {
                    headerHeight = $0
                }
            if panel.scrollsItself {
                // Told, not capped: a frame's maxHeight grows to the cap.
                content
                    .environment(\.panelRoom, maxHeight.map { max($0 - headerHeight, 0) })
            } else {
                // Not a ViewThatFits between the content and a scroll view: capped
                // from outside, it squeezed a note to one line and stretched the
                // title row.
                ScrollView {
                    padded(content)
                }
                .measuresContent(height: $contentHeight)
                .frame(height: contentHeight.map { min($0, (maxHeight ?? .infinity) - headerHeight) })
            }
        }
        .coordinateSpace(.named(Self.space))
        .frame(maxWidth: panel.cardWidth)
        .panel()
        // Rows of small text, which the globe's labels showed through.
        .environment(\.panelDensity, .dense)
    }

    private static var space: String { "toolPanel" }

    private func padded(_ content: Content) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            content
        }
        .font(.panelLabel)
        .toggleStyle(MarkToggleStyle())
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
                .font(.panelCaption.weight(.semibold))
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
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(.white.opacity(configuration.isPressed ? 0.12 : 0))
            .opacity(isEnabled ? 1 : 0.4)
    }
}

/// A switch's mark: iOS's selection circle, empty or filled with a tick, and on a
/// Mac its own checkbox's square, as the web app's.
private struct CheckMark: View {
    let isOn: Bool

    var body: some View {
        #if os(macOS)
            RoundedRectangle(cornerRadius: 4)
                .fill(isOn ? Color.panelAccent : .clear)
                .strokeBorder(isOn ? Color.panelAccent : .white.opacity(0.35), lineWidth: 1.5)
                .overlay {
                    if isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Color.panelSurface)
                    }
                }
                .frame(width: 16, height: 16)
                .accessibilityHidden(true)
        #else
            Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                .font(.body)
                .symbolRenderingMode(.palette)
                .foregroundStyle(isOn ? Color.panelSurface : .white.opacity(0.35), Color.panelAccent)
                .accessibilityHidden(true)
        #endif
    }
}

/// A choice's mark, the web app's radio button: a ring, filled with a dot once chosen.
private struct RadioMark: View {
    let isOn: Bool
    @ScaledMetric(relativeTo: .body) private var side = PanelMetrics.row < 44 ? 16.0 : 20.0

    var body: some View {
        ZStack {
            Circle()
                .fill(isOn ? Color.panelAccent : .clear)
                .strokeBorder(isOn ? Color.panelAccent : .white.opacity(0.35), lineWidth: 1.5)
            if isOn {
                Circle()
                    .fill(Color.panelSurface)
                    .frame(width: side * 0.375, height: side * 0.375)
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

/// A switch as a card's row, led by its mark, its name dimmed while off, as the web
/// app's; still a switch to VoiceOver and to the UI tests.
private struct MarkToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            PanelRow {
                CheckMark(isOn: configuration.isOn)
            } title: {
                configuration.label
                    .foregroundStyle(configuration.isOn ? .primary : .secondary)
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

/// One of several, a row each with the chosen one's radio button filled and its name
/// lit: the web app's radio buttons, where the names are long.
private struct Choices<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(String, Value)]

    var body: some View {
        PanelCard {
            ForEach(options, id: \.1) { name, value in
                Button {
                    selection = value
                } label: {
                    PanelRow {
                        RadioMark(isOn: selection == value)
                    } title: {
                        Text(name)
                            .foregroundStyle(selection == value ? .primary : .secondary)
                    }
                }
                .buttonStyle(PanelRowStyle())
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
    }
}

/// What the globe is covered with and drawn against: the web app's Map panel,
/// less the overlays, surfaces and Tycho star map the app does not draw, with every
/// satellite's imagery under its own heading (ADR 0021).
struct MapPanel: View {
    @Bindable var session: Session
    /// Opens a satellite's info panel, which its imagery button has turned on.
    let onShow: (CatalogEntry) -> Void

    var body: some View {
        PanelSection("Basemap") {
            Choices(selection: $session.baseLayer, options: BaseLayer.allCases.map { ($0.title, $0) })
        }
        SatelliteImagerySection(catalog: session.catalog, imagery: session.instrumentImagery, clock: session.clock, onShow: onShow)
        // The web app's names for the two.
        PanelSection("Terrain") {
            Segments(title: "Terrain", selection: $session.terrain, options: [("None", false), ("Re:Earth", true)])
        }
        // Ticks Deep Star (1K) for the Tycho map a link may name, which it draws.
        PanelSection("Star map") {
            Choices(
                selection: Binding {
                    session.starMap.drawn
                } set: {
                    session.starMap = $0
                },
                options: StarMapName.drawable.map { ($0.title, $0) })
        }
    }
}

/// The Map panel's satellite imagery, the web app's MapImageryLayers (ADR 0021, 0024): the
/// layers the loaded records carry that have not stopped, in groups by orbit, one group
/// open at a time. The list is read off the records, so the panel's first showing loads
/// every group, as the satellite browser does.
private struct SatelliteImagerySection: View {
    let catalog: CatalogModel
    let imagery: InstrumentImagery
    let clock: ViewerClock
    let onShow: (CatalogEntry) -> Void
    /// Whether `loadAll` has returned, loaded or not.
    @State private var loaded = false
    /// The info panel's tab, the Imagery tab once a row's button is pressed.
    @AppStorage("infoPanelTab") private var tab = InfoTab.orbit

    var body: some View {
        // Worked out here, where only the catalog is read, so that a switch flipped in the
        // list does not go through every record again.
        SatelliteImageryList(
            listings: SatelliteDetails.imageryListings(catalog.catalog.entries.values.map(\.record)), imagery: imagery, clock: clock,
            isLoading: !loaded && !catalog.isAllLoaded, onShow: show
        )
        .task {
            await catalog.loadAll()
            loaded = true
        }
    }

    /// Opens the satellite's info panel at its Imagery tab, turning it on if need be, as
    /// the satellite browser does.
    private func show(_ satellite: SatelliteDetails.ImageryListing.Satellite) {
        guard let entry = catalog.catalog.entry(orSuccessorOf: satellite.id) else {
            return
        }
        catalog.activate(entry)
        tab = .imagery
        onShow(entry)
    }
}

/// The satellite imagery's groups, rows and buttons.
private struct SatelliteImageryList: View {
    let listings: [Listing]
    let imagery: InstrumentImagery
    let clock: ViewerClock
    let isLoading: Bool
    let onShow: (Listing.Satellite) -> Void
    /// The group the user opened, or `.some(nil)` for none; nil until they choose, when
    /// the first group with a layer on is open.
    @State private var chosen: Listing.Group??
    /// The newest pass of each passes layer of the open group, by token.
    @State private var latest = LatestPasses()
    @ScaledMetric(relativeTo: .body) private var iconSide = 20.0

    typealias Listing = SatelliteDetails.ImageryListing

    var body: some View {
        // The groups wait for every group, so that no header or row moves as the rest arrive.
        let listings = isLoading ? [] : listings
        let listed = Set(listings.map(\.token))
        let groups = Listing.Group.allCases.compactMap { key -> (key: Listing.Group, rows: [SatelliteDetails.ImageryRow], shown: Int)? in
            let layers = listings.filter { $0.group == key }
            return layers.isEmpty ? nil : (key, SatelliteDetails.imageryRows(layers), layers.filter { imagery.isShown($0.token) }.count)
        }
        let open = chosen ?? groups.first { $0.shown > 0 }?.key
        // A composite's is no one satellite's own.
        let passes = (groups.first { $0.key == open }?.rows ?? []).flatMap { row in
            row.cells.compactMap { cell -> (key: String, layer: SatelliteDetails.GranuleLayer)? in
                guard cell.listing.type == .passes, case .satellite = cell.listing.kind, let layer = cell.listing.imagery.granuleLayer else {
                    return nil
                }
                return (cell.listing.token, layer)
            }
        }
        // Before the list arrives, or while its record has not loaded, so that a layer on
        // the globe can still be taken off.
        let unlisted = imagery.tokens.filter { !listed.contains($0) }
        PanelSection("Satellite imagery") {
            if !unlisted.isEmpty {
                PanelCard {
                    ForEach(unlisted, id: \.self) { token in
                        // By its layer's id while no loaded record carries it.
                        Toggle(imagery.labels[token] ?? String(token.drop { $0 != ":" }.dropFirst()), isOn: shown(token, open: open))
                    }
                }
            }
            if groups.isEmpty {
                Text(isLoading ? "Loading the imagery list…" : "No satellite has imagery.")
                    .font(.panelNote)
                    .foregroundStyle(.secondary)
            } else {
                PanelCard {
                    ForEach(groups, id: \.key) { group in
                        Button {
                            chosen = .some(open == group.key ? nil : group.key)
                        } label: {
                            PanelRow {
                                Image(Self.icon(group.key))
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: iconSide, height: iconSide)
                            } title: {
                                HStack(spacing: 6) {
                                    Text(Self.title(group.key))
                                        .lineLimit(2)
                                    Spacer(minLength: 0)
                                    // The web app's count badge while a layer is on.
                                    Text(group.shown > 0 ? "\(group.shown) on" : "\(group.rows.count)")
                                        .font(.panelNote.weight(group.shown > 0 ? .semibold : .regular))
                                        .foregroundStyle(group.shown > 0 ? .primary : .secondary)
                                        .monospacedDigit()
                                        .padding(.horizontal, group.shown > 0 ? 7 : 0)
                                        .padding(.vertical, 1)
                                        .background(group.shown > 0 ? Color.panelSelected : .clear, in: .capsule)
                                        .fixedSize()
                                    Image(systemName: open == group.key ? "chevron.up" : "chevron.down")
                                        .font(.panelCaption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                        .fixedSize()
                                }
                            }
                        }
                        .buttonStyle(PanelRowStyle())
                        .accessibilityLabel(Self.title(group.key))
                        .accessibilityValue(group.shown > 0 ? "\(group.shown) on" : group.rows.count == 1 ? "1 satellite" : "\(group.rows.count) satellites")
                        .accessibilityHint(open == group.key ? "Hides its layers" : "Shows its layers")
                        if open == group.key {
                            ForEach(group.rows) { row in
                                self.row(row, open: open)
                            }
                        }
                    }
                }
            }
        }
        .task(id: passes.map(\.key)) {
            await latest.follow(passes)
        }
    }

    /// A satellite or composite, "METEOSAT-12", not "METEOSAT-12 (MTG-I1)", and a button a
    /// layer; a satellite's second layer of a type only while it is on.
    private func row(_ row: SatelliteDetails.ImageryRow, open: Listing.Group?) -> some View {
        let isOn = row.cells.contains { imagery.isShown($0.listing.token) }
        let buttons = HStack(spacing: 6) {
            ForEach(row.cells.filter { !$0.extra || imagery.isShown($0.listing.token) }, id: \.listing.key) { cell in
                typeButton(row, cell, open: open)
            }
        }
        .fixedSize()
        return VStack(alignment: .leading, spacing: 4) {
            // The buttons right-aligned beside the name, as the web app's, or under it
            // where they do not fit, still right-aligned.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    name(row).fixedSize()
                    Spacer(minLength: 0)
                    buttons
                }
                VStack(alignment: .trailing, spacing: 4) {
                    name(row).frame(maxWidth: .infinity, alignment: .leading)
                    buttons
                }
            }
            .foregroundStyle(isOn ? .primary : .secondary)
            ForEach(row.cells.filter { $0.listing.type == .passes && imagery.isShown($0.listing.token) }, id: \.listing.key) { cell in
                PassNotice(latest: latest, key: cell.listing.token, clock: clock)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: PanelMetrics.row, alignment: .leading)
        // A row with a layer on raised, as the web app's.
        .background(isOn ? Color.panelRaisedHover : .clear)
    }

    /// The row's name: a satellite's opens its Imagery tab, a composite's a menu of its satellites.
    @ViewBuilder private func name(_ row: SatelliteDetails.ImageryRow) -> some View {
        if row.isComposite {
            let satellites = Dictionary(
                row.cells.flatMap { cell -> [Listing.Satellite] in if case .composite(let satellites) = cell.listing.kind { satellites } else { [] } }.map { ($0.id, $0) }
            ) { first, _ in first }.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            Menu {
                Section("Show the imagery of") {
                    ForEach(satellites, id: \.id) { satellite in
                        Button(satellite.name, systemImage: "satellite") {
                            onShow(satellite)
                        }
                    }
                }
            } label: {
                Text(row.name).frame(minHeight: 28)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("Show the imagery of a satellite of the \(row.name.lowercased())")
        } else if case .satellite(let satellite, _) = row.cells.first?.listing.kind {
            Button {
                onShow(satellite)
            } label: {
                Text(row.name.replacing(/\s*\(.*\)$/, with: "")).frame(minHeight: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show the imagery of \(row.name)")
        }
    }

    /// A row's button for one layer, named by its type, which shows or hides it.
    private func typeButton(_ row: SatelliteDetails.ImageryRow, _ cell: SatelliteDetails.ImageryRow.Cell, open: Listing.Group?) -> some View {
        let layer = cell.listing
        let isShown = imagery.isShown(layer.token)
        // Every minute, for the newest pass's age in the tooltip, as ADR 0024 has it said again.
        return TimelineView(.everyMinute) { _ in
            Button {
                shown(layer.token, open: open).wrappedValue = !isShown
            } label: {
                Label {
                    Text(cell.name)
                } icon: {
                    Image(layer.type.image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: iconSide * 0.7, height: iconSide * 0.7)
                }
                .labelStyle(TypeButtonLabelStyle())
                .font(.panelCaption)
                .padding(.horizontal, 8)
                .frame(minHeight: 26)
                .foregroundStyle(isShown ? Color.panelInk : .secondary)
                .background(isShown ? Color.panelAccent.opacity(0.22) : .clear, in: .capsule)
                .overlay {
                    Capsule().strokeBorder(isShown ? Color.panelAccent : Color.white.opacity(0.12))
                }
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.isComposite ? "\(row.name), \(cell.name)" : "\(layer.type.title) of \(row.name)\(cell.extra ? " \(cell.name)" : "")")
            .accessibilityValue(isShown ? "On" : "Off")
            .accessibilityAddTraits(isShown ? [.isSelected] : [])
            .accessibilityHint(tooltip(layer))
            .help(tooltip(layer))
        }
    }

    /// What the layer is, as its card says it, and for passes how old the newest is, once known.
    private func tooltip(_ layer: Listing) -> String {
        let newest = layer.type == .passes ? latest.latest[layer.token]?.pictured.start : nil
        return [
            layer.type.title, layer.words.picture, layer.words.cropped, layer.words.updates,
            newest.map { "Newest pass \(Formats.timeAgo($0, now: Date.now.timeIntervalSince1970 * 1000))" },
        ].compactMap(\.self).joined(separator: "\n")
    }

    /// Whether the layer `token` names is on the globe, and a switch's way to set it,
    /// which keeps `open` open: else taking off a group's last layer closed the group
    /// under the finger.
    private func shown(_ token: String, open: Listing.Group?) -> Binding<Bool> {
        Binding {
            imagery.isShown(token)
        } set: {
            chosen = chosen ?? .some(open)
            imagery.show(token, $0)
        }
    }

    /// A group's row, as the web app names it.
    private static func title(_ group: Listing.Group) -> LocalizedStringKey {
        switch group {
        case .geo: "GEO satellites"
        case .leo: "LEO satellites"
        }
    }

    /// A group's mark, the web app's.
    private static func icon(_ group: Listing.Group) -> ImageResource {
        switch group {
        case .geo: .lucideEarth
        case .leo: .lucideOrbit
        }
    }
}

extension SatelliteDetails.ImageryType {
    /// Its icon, the web app's (`IMAGERY_TYPES`, src/config/instrumentImagery.ts).
    var image: ImageResource {
        switch self {
        case .passes: .lucideRoute
        case .daily: .lucideCalendarDays
        case .orbits: .lucideLayers
        case .live: .lucideEarth
        case .mosaic: .lucideGlobe
        case .scenes: .lucideImages
        }
    }
}

/// A type button's icon close beside its name.
private struct TypeButtonLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}

/// The globe's projection and camera: the web app's Globe panel, less the
/// Columbus projection the app does not draw (ADR 0009). It writes the same view
/// as the Sky panel, so in the sky view no projection is chosen, and choosing one
/// leaves it for that projection; the Sky panel enters it, as it names a place
/// (ADR 0003). The camera mode stays to be chosen in 2D, as on the web, where
/// only the globe turns with it.
struct GlobePanel: View {
    @Bindable var session: Session

    var body: some View {
        let inSky = session.observer != nil
        PanelSection("Projection") {
            Picker(
                "Projection",
                selection: Binding<GlobeProjection?> {
                    inSky ? nil : session.projection
                } set: { projection in
                    if let projection {
                        session.choose(projection)
                    }
                }
            ) {
                ForEach(GlobeProjection.allCases, id: \.self) { projection in
                    Text(verbatim: projection.rawValue).tag(GlobeProjection?.some(projection))
                }
            }
            .panelSegmented()
            if inSky {
                Note("Select a projection to leave sky view.")
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

/// Looking up from a place: the web app's Sky panel. Each place's row enters the
/// sky view standing there, or moves a view already up; its settings stay in
/// sight on the globe, disabled where they need the sky view (ADR 0003).
struct SkyPanel: View {
    @Bindable var session: Session
    @State private var locating = false

    var body: some View {
        let inSky = session.observer != nil
        let here = session.observer.flatMap(session.passes.station)
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
        if Platform.aimsByDevice {
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
            .font(.panelNote)
            .foregroundStyle(.secondary)
    }
}

/// How the globe is drawn and what that costs, and hiding the UI: the web app's
/// Graphics panel, less the scene effects and MSAA, which the app does not switch,
/// and Render only on change, which it always does but while the FPS overlay or the
/// benchmark measures (`FramePacer.mustDraw`).
struct GraphicsPanel: View {
    @Bindable var session: Session
    let hideUI: () -> Void
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        // Hide UI first, so a phone shows it without scrolling, and the frame rate
        // in view under it, as the web app's panel.
        PanelCard {
            Place(Text("Hide UI"), image: .lucideEyeOff, action: hideUI)
            Toggle("FPS", isOn: $session.showsPerformance)
            Toggle(
                "Benchmark",
                isOn: Binding {
                    session.showsBenchmark
                } set: {
                    session.setShowsBenchmark($0)
                })
        }
        PanelSection("Frame rate") {
            Segments(
                title: "Frame rate",
                selection: $session.frameRate,
                options: Session.frameRates.map { ($0 == Session.maximumFrameRate ? "Max" : "\($0) fps", $0) })
        }
        // Each rung named by the ratio it draws at here; a link keeps `native`, so
        // it opens at each screen's own. A ratio off the ladder, from a link or a
        // scene saved on another ladder, gets a segment of its own: a Picker whose
        // selection matches no tag is undefined.
        let offered = PixelRatioLadder.offered(session.pixelRatio, screen: displayScale)
        let ratios = PixelRatioLadder.rungs(screen: displayScale) + (offered == nil ? [session.pixelRatio] : [])
        PanelSection("Pixel ratio") {
            Segments(
                title: "Pixel ratio",
                selection: Binding {
                    offered ?? session.pixelRatio
                } set: {
                    session.pixelRatio = $0
                },
                options:
                    ratios
                    .sorted { PixelRatioLadder.value($0, screen: displayScale) < PixelRatioLadder.value($1, screen: displayScale) }
                    .map { ratio in
                        ("\(PixelRatioLadder.value(ratio, screen: displayScale).formatted(.number.precision(.fractionLength(0...2))))x", ratio)
                    })
        }
    }
}
