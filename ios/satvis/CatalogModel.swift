import Foundation
import Observation
import SatvisCore
import SatvisData

/// What can be shown and what is: the preset's groups, the catalog of what has
/// loaded, the activation over it, the components drawn, and the tracked
/// satellite. Groups load when something needs them, as on the web: from the
/// kept copy at once, then from the worker (`GroupLoader`).
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

    /// The group index as last loaded.
    private(set) var index: GroupIndex?
    private(set) var groups: [Group] = []
    /// The preset the catalog is on, nil for the default one.
    private(set) var presetName: String?
    private(set) var catalog = Catalog()
    private(set) var activation = Activation()
    private(set) var components: SatelliteComponents = [.point, .label]
    /// What is past its budget for what is active.
    private var budgets = ComponentBudgets()
    /// What the link being opened names in `elements`: kept through the crossing
    /// its own activation causes.
    @ObservationIgnored private var named: SatelliteComponents = []
    /// The tracked satellite, by catalog id: the session's `Focus.trackedSatellite`,
    /// which stays active.
    private(set) var tracked: String?
    /// The satellites drawn, by name. Kept rather than worked out on every read:
    /// the catalog can hold tens of thousands.
    private(set) var activeEntries: [CatalogEntry] = []
    @ObservationIgnored private let loader: GroupLoader

    init(loader: GroupLoader) {
        self.loader = loader
    }

    /// The components past their budget for what is active, which links leave
    /// out of the default for `elements`, so that one naming them keeps them.
    var overBudget: SatelliteComponents { budgets.over }

    /// The preset's defaults, in the url's vocabulary.
    var presetDefaults: [String: String] {
        index?.presetDefaults(named: presetName) ?? [:]
    }

    /// The index to start on, waiting for one while there is none
    /// (`GroupLoader.firstIndex`).
    func loadIndex(waiting: @Sendable () async -> Void) async {
        guard index == nil else {
            return
        }
        if let first = await loader.firstIndex(waiting: waiting) {
            index = first
        }
    }

    /// Asks the worker for the index again, keeping the last when it cannot be asked.
    func refreshIndex() async {
        if let fresh = await loader.refreshIndex() {
            index = fresh
        }
    }

    /// Takes a preset's groups, with what is active and drawn over them, and loads
    /// the groups that needs: the enabled tags', or every one where satellites are
    /// named, since a name does not say which group it is in.
    /// `named` is what the link names in `elements`, which a budget crossed on
    /// the way does not switch off.
    func open(preset: String?, activation: Activation, components: SatelliteComponents, named: SatelliteComponents = []) async {
        presetName = preset
        if let index {
            apply(index)
        }
        self.activation = activation
        self.components = components
        self.named = named
        // Counted afresh for what this link activates.
        budgets = ComponentBudgets()
        changed()
        if !activation.enabledSatellites.isEmpty || !activation.disabledSatellites.isEmpty {
            await load(groups)
        } else {
            await load(groups.filter { !$0.tags.isEmpty && !Set($0.tags).isDisjoint(with: activation.enabledTags) })
        }
        self.named = []
    }

    /// A satellite by name, among the groups loaded, loading every one first.
    func entry(named name: String) async -> CatalogEntry? {
        if let entry = catalog.entries.values.first(where: { $0.name == name }) {
            return entry
        }
        await load(groups)
        return catalog.entries.values.first { $0.name == name }
    }

    /// Asks the worker for the index again and takes it up and, `refetching`, asks
    /// about every group loaded so far, which costs a 304 for each that has not
    /// changed. For a return to the foreground: a suspended app can sit on old
    /// element sets for days.
    func revalidate(refetching: Bool = true) async {
        await refreshIndex()
        if let index {
            apply(index)
        }
        guard refetching else {
            return
        }
        await loader.revalidate(groups.map(\.name), deliver: deliver(to: groups))
    }

    /// Every tag a browsable group carries, A to Z as the web app's `localeCompare` lists them.
    var tags: [String] {
        var seen = Set<String>()
        return groups.filter { !$0.searchOnly }.flatMap(\.tags).filter { seen.insert($0).inserted }.alphabetical()
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
        changed()
    }

    func setSatellite(_ entry: CatalogEntry, enabled: Bool) {
        activation.setSatellite(entry, enabled: enabled)
        changed()
    }

    func clearAll() {
        activation.clear()
        changed()
    }

    func setComponent(_ component: SatelliteComponents, enabled: Bool) {
        if enabled {
            components.insert(component)
        } else {
            components.remove(component)
        }
    }

    func setTracked(_ id: String?) {
        tracked = id
        changed()
    }

    /// The preset's groups, as the index now describes them.
    private func apply(_ index: GroupIndex) {
        guard let preset = index.preset(named: presetName) else {
            return
        }
        let statuses = Dictionary(index.groups.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        let next = preset.groups.compactMap { entry in
            statuses[entry.name].map { Group(name: entry.name, tags: $0.tags, searchOnly: entry.searchOnly, count: $0.count) }
        }
        if next != groups {
            groups = next
        }
    }

    /// Loads the groups not loaded yet. Returns once each is in the catalog, from
    /// the kept copy where there is one; the worker's answer follows by itself.
    private func load(_ wanted: [Group]) async {
        await loader.load(wanted.map(\.name), deliver: deliver(to: wanted))
    }

    /// Takes the records of any of `groups` into the catalog, with its tags as
    /// they were asked for.
    private func deliver(to groups: [Group]) -> GroupLoader.Deliver {
        let byName = Dictionary(groups.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        return { name, records in
            if let group = byName[name] {
                await self.add(records, to: group)
            }
        }
    }

    private func add(_ records: [GPRecord], to group: Group) {
        if catalog.add(records, tags: group.tags, group: group.name) {
            changed()
        }
    }

    /// Works out what is drawn again.
    private func changed() {
        let active = activation.active(in: catalog, tracked: tracked.flatMap { catalog.entries[$0]?.name })
        if active != activeEntries {
            activeEntries = active
        }
        let modelled = active.count { $0.record.model != nil }
        var budgets = budgets
        let next = budgets.components(components, active: active.count, modelled: modelled, named: named)
        if budgets != self.budgets {
            self.budgets = budgets
        }
        if next != components {
            components = next
        }
    }
}
