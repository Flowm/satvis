import SatvisCore
import SatvisRender
import SwiftUI

/// The satellite browser, as the web app's: a row per tag that switches the whole
/// group, expanding to its satellites one by one, and a search across everything.
/// A satellite's info button switches it on and opens its panel. A sheet, on a
/// phone; `BrowserPanel` where there is room.
struct BrowserView: View {
    let catalog: CatalogModel
    let onShow: (CatalogEntry) -> Void
    @State private var query = ""
    @FocusState private var isSearching: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            BrowserList(catalog: catalog, query: query) {
                onShow($0)
                dismiss()
            }
            .searchable(text: $query, prompt: "Search satellites")
            .searchFocused($isSearching)
            .loadsEverythingWhenFocused(isSearching, catalog: catalog)
            .navigationTitle("Satellites")
            .toolbarTitleDisplayMode(.inline)
            .panelSheet()
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    ClearAllButton(catalog: catalog)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                ActiveCount(catalog: catalog)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    // The surface, not the bar's material, which blurs what is behind.
                    .background(Color.panelSurface)
            }
        }
    }
}

/// The satellite browser as a panel beside the menu column, as the web app's: the
/// search over the list, and the count and Clear all under it. As tall as the list,
/// up to the room it is given, which the list then scrolls in.
struct BrowserPanel: View {
    let catalog: CatalogModel
    let onShow: (CatalogEntry) -> Void
    @State private var query = ""
    /// The list's rows, measured, which it is as tall as where they fit.
    @State private var listHeight: CGFloat?
    /// The search row, measured.
    @State private var searchHeight: CGFloat = 0
    /// The count's row, measured.
    @State private var countHeight: CGFloat = 0
    @Environment(\.panelRoom) private var room

    var body: some View {
        VStack(spacing: 0) {
            PanelSearchField(text: $query, prompt: "Search satellites", catalog: catalog)
                .padding(12)
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { searchHeight = $0 }
            BrowserList(catalog: catalog, query: query, onShow: onShow)
                // The panels' text size: at the sheet's, a name wrapped in 320 points.
                .font(.subheadline)
                .scrollContentBackground(.hidden)
                .contentMargins(.horizontal, 12, for: .scrollContent)
                .contentMargins(.vertical, 0, for: .scrollContent)
                .scrollDismissesKeyboard(.immediately)
                .onScrollGeometryChange(for: CGFloat.self) {
                    $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
                } action: { _, height in
                    listHeight = height
                }
                .frame(height: shownListHeight)
            HStack {
                ActiveCount(catalog: catalog)
                Spacer(minLength: 8)
                ClearAllButton(catalog: catalog)
                    .font(.subheadline)
                    .buttonStyle(.borderless)
                    // The panel's ink otherwise, which outranks the role's red.
                    .foregroundStyle(.red)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: PanelMetrics.row)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { countHeight = $0 }
        }
    }

    /// The rows' height, or the room left where that is less. At least a row: a list
    /// laid out none tall measured its rows as none tall too, and stayed so. Eight rows
    /// until the room is measured, which a long list otherwise ran past the screen for.
    private var shownListHeight: CGFloat {
        let left = room.map { max($0 - searchHeight - countHeight, PanelMetrics.row) } ?? PanelMetrics.row * 8
        guard let listHeight else {
            return left
        }
        return min(max(listHeight, PanelMetrics.row), left)
    }
}

/// The browser's list: the groups, or what a search finds.
private struct BrowserList: View {
    let catalog: CatalogModel
    let query: String
    let onShow: (CatalogEntry) -> Void
    @State private var results: [CatalogEntry]?
    @State private var searching = false
    @State private var expanded: Set<String> = []
    @State private var members: [String: [CatalogEntry]] = [:]
    /// A satellite a few rows into the group expanded last, scrolled into view, and
    /// the list no further, once the group loads.
    @State private var revealed: String?

    var body: some View {
        ScrollViewReader { proxy in
            list
                // The last group's opened below the list's foot, showing nothing.
                .onChange(of: revealed) {
                    if let revealed {
                        withAnimation { proxy.scrollTo(revealed) }
                    }
                }
        }
    }

    private var list: some View {
        List {
            Group {
                if searching, results == nil {
                    // A search loads every group, and the biggest takes seconds.
                    HStack {
                        ProgressView()
                        Text("Loading all satellites…")
                            .foregroundStyle(.secondary)
                    }
                } else if let results {
                    if results.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                    ForEach(results) { entry in
                        SatelliteRow(entry: entry, catalog: catalog, showsTags: true, onShow: show)
                    }
                } else {
                    ForEach(catalog.tags, id: \.self) { tag in
                        DisclosureGroup(isExpanded: expansion(of: tag)) {
                            if let entries = members[tag] {
                                ForEach(entries) { entry in
                                    SatelliteRow(entry: entry, catalog: catalog, showsTags: false, onShow: show)
                                }
                            } else {
                                ProgressView()
                            }
                        } label: {
                            TagRow(tag: tag, catalog: catalog)
                        }
                    }
                }
            }
            // A sheet's own; off one, the grouped rows would be the panel's surface.
            .listRowBackground(Color.panelRaised)
        }
        .task(id: query) {
            // As the web app's 150 ms debounce: no search per keystroke.
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else {
                return
            }
            guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
                results = nil
                searching = false
                return
            }
            searching = true
            let found = await catalog.search(query)
            // A newer query took over while this one waited for the groups:
            // its results and its spinner are that one's to set.
            guard !Task.isCancelled else {
                return
            }
            results = found
            searching = false
        }
    }

    private func show(_ entry: CatalogEntry) {
        if !catalog.activation.isActive(entry) {
            catalog.setSatellite(entry, enabled: true)
        }
        onShow(entry)
    }

    /// Expanding a tag loads its groups, once.
    private func expansion(of tag: String) -> Binding<Bool> {
        Binding {
            expanded.contains(tag)
        } set: { open in
            if open {
                expanded.insert(tag)
                Task {
                    let entries = await catalog.entries(tagged: tag)
                    members[tag] = entries
                    revealed = entries.prefix(4).last?.id
                }
            } else {
                expanded.remove(tag)
                if members[tag]?.contains(where: { $0.id == revealed }) == true {
                    revealed = nil
                }
            }
        }
    }
}

/// Switches every group and satellite off, in the sheet's bar and the panel's foot.
private struct ClearAllButton: View {
    let catalog: CatalogModel

    var body: some View {
        Button("Clear all", role: .destructive) { catalog.clearAll() }
    }
}

/// How many groups and satellites are on.
private struct ActiveCount: View {
    let catalog: CatalogModel

    var body: some View {
        let groupsOn = catalog.tags.filter { catalog.activation.enabledTags.contains($0) }.count
        Text("^[\(groupsOn) group](inflect: true) · ^[\(catalog.activeEntries.count) satellite](inflect: true) active")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}

/// A search field on a panel, as the web app's: a magnifying glass, the field, and
/// a cross that clears it. Read as a search field, as the sheet's is.
private struct PanelSearchField: View {
    @Binding var text: String
    let prompt: LocalizedStringKey
    let catalog: CatalogModel
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .noAutocapitalization()
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityAddTraits(.isSearchField)
                .focused($isFocused)
                .loadsEverythingWhenFocused(isFocused, catalog: catalog)
            if !text.isEmpty {
                Button("Clear search", systemImage: "xmark.circle.fill") { text = "" }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(Color.panelRaised, in: .capsule)
    }
}

/// A whole group: on, off, or some of it, with how much of it is on.
private struct TagRow: View {
    let tag: String
    let catalog: CatalogModel

    var body: some View {
        let total = catalog.count(tagged: tag)
        let active = catalog.activeCount(tagged: tag)
        let enabled = catalog.activation.enabledTags.contains(tag)
        HStack {
            Button {
                Task { await catalog.setTag(tag, enabled: !(enabled && active == total)) }
            } label: {
                Image(systemName: enabled && active == total ? "checkmark.circle.fill" : active > 0 ? "minus.circle.fill" : "circle")
                    .foregroundStyle(active > 0 ? Color.accentColor : .secondary)
                    .imageScale(.large)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(enabled ? "Hide \(tag)" : "Show \(tag)")
            Text(tag)
            Spacer()
            Text("\(active)/\(total)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

/// One satellite: on or off, its orbit class in the colour its point is drawn in,
/// so the list doubles as the legend, and the way to its panel.
private struct SatelliteRow: View {
    let entry: CatalogEntry
    let catalog: CatalogModel
    let showsTags: Bool
    let onShow: (CatalogEntry) -> Void

    var body: some View {
        let active = catalog.activation.isActive(entry)
        HStack {
            Button {
                catalog.setSatellite(entry, enabled: !active)
            } label: {
                row(active: active)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(entry.name)
            .accessibilityValue(active ? "Shown" : "Hidden")
            .accessibilityHint(active ? "Hides it" : "Shows it")
            Button("Details of \(entry.name)", systemImage: "info.circle") {
                onShow(entry)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
        }
    }

    private func row(active: Bool) -> some View {
        HStack {
            Image(systemName: active ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(active ? Color.accentColor : .secondary)
            VStack(alignment: .leading) {
                Text(entry.name)
                if showsTags {
                    Text(entry.tags.alphabetical().joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(entry.record.orbitClass.rawValue)
                .font(.caption.bold())
                .foregroundStyle(Color(orbitClass: entry.record.orbitClass))
            Text(entry.satnum)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .contentShape(.rect)
    }
}

extension View {
    /// Loads every group as the search field takes focus: a search looks through
    /// all of them, and the biggest took seconds after the first letter.
    fileprivate func loadsEverythingWhenFocused(_ isFocused: Bool, catalog: CatalogModel) -> some View {
        task(id: isFocused) {
            if isFocused {
                await catalog.loadAll()
            }
        }
    }
}

extension Color {
    /// The colour a satellite of this class is drawn in on the globe.
    init(orbitClass: OrbitClass) {
        let rgb = orbitClass.color
        self.init(.sRGB, red: Double(rgb.x), green: Double(rgb.y), blue: Double(rgb.z))
    }
}
