import SatvisCore
import SatvisRender
import SwiftUI

/// The satellite browser, as the web app's: a row per tag that switches the whole
/// group, expanding to its satellites one by one, and a search across everything.
struct BrowserView: View {
    let catalog: CatalogModel
    @State private var query = ""
    @State private var results: [CatalogEntry]?
    @State private var expanded: Set<String> = []
    @State private var members: [String: [CatalogEntry]] = [:]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let results {
                    if results.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                    ForEach(results) { entry in
                        SatelliteRow(entry: entry, catalog: catalog, showsTags: true)
                    }
                } else {
                    ForEach(catalog.tags, id: \.self) { tag in
                        DisclosureGroup(isExpanded: expansion(of: tag)) {
                            if let entries = members[tag] {
                                ForEach(entries) { entry in
                                    SatelliteRow(entry: entry, catalog: catalog, showsTags: false)
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
            .searchable(text: $query, prompt: "Search satellites")
            .task(id: query) {
                // As the web app's 150 ms debounce: no search per keystroke.
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else {
                    return
                }
                results = query.trimmingCharacters(in: .whitespaces).isEmpty ? nil : await catalog.search(query)
            }
            .navigationTitle("Satellites")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear all", role: .destructive) { catalog.clearAll() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                let groupsOn = catalog.tags.filter { catalog.activation.enabledTags.contains($0) }.count
                Text("^[\(groupsOn) group](inflect: true) · ^[\(catalog.activeEntries.count) satellite](inflect: true) active")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
    }

    /// Expanding a tag loads its groups, once.
    private func expansion(of tag: String) -> Binding<Bool> {
        Binding {
            expanded.contains(tag)
        } set: { open in
            if open {
                expanded.insert(tag)
                Task { members[tag] = await catalog.entries(tagged: tag) }
            } else {
                expanded.remove(tag)
            }
        }
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
/// so the list doubles as the legend.
private struct SatelliteRow: View {
    let entry: CatalogEntry
    let catalog: CatalogModel
    let showsTags: Bool

    var body: some View {
        let active = catalog.activation.isActive(entry)
        Button {
            catalog.setSatellite(entry, enabled: !active)
        } label: {
            HStack {
                Image(systemName: active ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(active ? Color.accentColor : .secondary)
                VStack(alignment: .leading) {
                    Text(entry.name)
                    if showsTags {
                        Text(entry.tags.sorted().joined(separator: ", "))
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
        }
        .buttonStyle(.plain)
    }
}

extension Color {
    /// The colour a satellite of this class is drawn in on the globe.
    init(orbitClass: OrbitClass) {
        let rgb = orbitClass.color
        self.init(.sRGB, red: Double(rgb.x), green: Double(rgb.y), blue: Double(rgb.z))
    }
}
