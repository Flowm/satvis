import SatvisCore
import SatvisData
import SwiftUI

/// What the app knows before it can draw it: the groups, where they came from,
/// and their satellites. Stands in until the globe arrives (M1).
struct StatusView: View {
    let source: GPSource
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            List {
                if let failure = source.failure, source.index == nil {
                    ContentUnavailableView("No satellite data", systemImage: "antenna.radiowaves.left.and.right.slash", description: Text(failure))
                }
                if let loaded = source.index {
                    Section {
                        ForEach(loaded.value.groups, id: \.name) { group in
                            NavigationLink(value: group.name) {
                                GroupRow(group: group)
                            }
                        }
                    } header: {
                        Text(loaded.value.preset(named: nil)?.title ?? "Groups")
                    } footer: {
                        Text(provenance(loaded.source, loaded.confirmed))
                    }
                }
            }
            .navigationTitle("SatVis")
            .navigationDestination(for: String.self) { name in
                GroupView(name: name, source: source)
            }
            .refreshable { await source.refresh() }
        }
        .task { await source.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await source.refresh() }
            }
        }
    }
}

private struct GroupRow: View {
    let group: GroupStatus

    var body: some View {
        VStack(alignment: .leading) {
            Text(group.name)
            if !group.tags.isEmpty {
                Text(group.tags.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .badge(group.count)
    }
}

private struct GroupView: View {
    let name: String
    let source: GPSource
    @State private var loaded: GroupRepository.Loaded<[GPRecord]>?
    @State private var failure: String?

    var body: some View {
        List {
            if let failure {
                ContentUnavailableView("Group unavailable", systemImage: "exclamationmark.triangle", description: Text(failure))
            }
            if let loaded {
                Section {
                    ForEach(loaded.value, id: \.self) { record in
                        LabeledContent(record.name, value: record.orbitClass.rawValue)
                    }
                } footer: {
                    Text(provenance(loaded.source, loaded.confirmed))
                }
            }
        }
        .navigationTitle(name)
        .task {
            do {
                loaded = try await source.records(of: name)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

private func provenance(_ source: GroupRepository.Source, _ confirmed: Date?) -> String {
    let when = confirmed.map { " · confirmed \($0.formatted(.relative(presentation: .named)))" } ?? ""
    switch source {
    case .worker: return "From satvis.space" + when
    case .cache: return "Saved copy, satvis.space unreachable" + when
    case .snapshot: return "Shipped with the app, satvis.space unreachable"
    }
}
