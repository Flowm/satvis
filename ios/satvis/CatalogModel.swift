import Foundation
import Observation
import SatvisCore
import SatvisData
import SatvisRender
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "catalog")

/// What can be shown and what is: the preset's groups, the catalog of what has
/// loaded, the activation over it, the components drawn, and the tracked
/// satellite. Groups load when something needs them, as on the web.
@Observable
final class CatalogModel {
    struct Group: Identifiable, Hashable {
        var name: String
        var tags: [String]
        var searchOnly: Bool
        /// From the group index, for a group not loaded yet.
        var count: Int
        var id: String { name }
    }

    private(set) var groups: [Group] = []
    private(set) var catalog = Catalog()
    private(set) var activation = Activation()
    private(set) var components: SatelliteComponents = [.point, .label]
    /// The tracked satellite, by catalog id.
    private(set) var tracked: String?
    @ObservationIgnored private var loaded: Set<String> = []
    @ObservationIgnored private let source: GPSource
    /// Called whenever what is active changes.
    @ObservationIgnored var onChange: () -> Void = {}

    init(source: GPSource) {
        self.source = source
    }

    /// The preset's groups and defaults: tags enabled, components drawn.
    func start() async {
        guard let index = source.index?.value, let preset = index.preset(named: nil) else {
            return
        }
        let statuses = Dictionary(index.groups.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        groups = preset.groups.compactMap { entry in
            statuses[entry.name].map { Group(name: entry.name, tags: $0.tags, searchOnly: entry.searchOnly, count: $0.count) }
        }
        let defaults = preset.defaults
        activation = Activation(enabledTags: Set(Self.list(defaults["tags"])))
        if let elements = defaults["elements"] {
            let names = Set(Self.list(elements))
            components = SatelliteComponents(SatelliteComponents.named.filter { names.contains($0.0) }.map(\.1))
        }
        await load(groups.filter { !$0.tags.isEmpty && !Set($0.tags).isDisjoint(with: activation.enabledTags) })
    }

    /// Every tag a browsable group carries, in the preset's order.
    var tags: [String] {
        var seen = Set<String>()
        return groups.filter { !$0.searchOnly }.flatMap(\.tags).filter { seen.insert($0).inserted }
    }

    var activeEntries: [CatalogEntry] {
        activation.active(in: catalog, tracked: tracked.flatMap { catalog.entries[$0]?.name })
    }

    /// Satellites carrying a tag, loading its groups first.
    func entries(tagged tag: String) async -> [CatalogEntry] {
        await load(groups.filter { $0.tags.contains(tag) })
        return catalog.entries(tagged: tag)
    }

    /// An estimate until its groups load: the index's counts.
    func count(tagged tag: String) -> Int {
        let members = catalog.entries(tagged: tag).count
        return members > 0 ? members : groups.filter { $0.tags.contains(tag) }.map(\.count).reduce(0, +)
    }

    func activeCount(tagged tag: String) -> Int {
        catalog.entries(tagged: tag).filter { activation.isActive($0) }.count
    }

    /// Searching looks through everything, so it loads everything.
    func search(_ query: String) async -> [CatalogEntry] {
        await load(groups)
        return catalog.search(query)
    }

    func setTag(_ tag: String, enabled: Bool) async {
        let members = await entries(tagged: tag)
        activation.setTag(tag, enabled: enabled, members: members)
        onChange()
    }

    func setSatellite(_ entry: CatalogEntry, enabled: Bool) {
        activation.setSatellite(entry, enabled: enabled)
        onChange()
    }

    func clearAll() {
        activation.clear()
        onChange()
    }

    func setComponent(_ component: SatelliteComponents, enabled: Bool) {
        if enabled {
            components.insert(component)
        } else {
            components.remove(component)
        }
        onChange()
    }

    func setTracked(_ id: String?) {
        tracked = id
        onChange()
    }

    private func load(_ wanted: [Group]) async {
        for group in wanted where loaded.insert(group.name).inserted {
            do {
                catalog.add(try await source.records(of: group.name).value, tags: group.tags, group: group.name)
            } catch {
                loaded.remove(group.name)
                log.error("Group \(group.name, privacy: .public) unavailable: \(error, privacy: .public)")
            }
        }
        onChange()
    }

    /// A url parameter's comma-separated list.
    private static func list(_ value: String?) -> [String] {
        (value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}
