import Foundation

/// One known satellite: the web app's `CatalogEntry`. A satellite served by two
/// groups is one entry carrying both groups' tags.
public struct CatalogEntry: Sendable, Hashable, Identifiable {
    /// `satnum|name`, the web app's identity.
    public let id: String
    public var record: GPRecord
    public var tags: Set<String>
    /// The groups that serve it, to load it again by.
    public var groups: Set<String> = []

    public var name: String { record.name }
    public var satnum: String { record.satnum }
}

/// The deduplicated registry of satellites across the loaded groups (CONTEXT.md,
/// Catalog).
public struct Catalog: Sendable {
    public private(set) var entries: [String: CatalogEntry] = [:]

    public init() {}

    /// The tags each group was last added with, which its entries carry.
    private var groupTags: [String: Set<String>] = [:]

    /// Adds a group's records, or newer element sets for satellites already known:
    /// two groups serving one satellite may lag each other, and the newer epoch
    /// wins. A group's records are the whole group: a satellite it no longer
    /// serves, renamed or decayed since a copy kept on disk or shipped in the
    /// app, leaves the group, and the catalog once no group serves it. Whether
    /// anything changed.
    @discardableResult
    public mutating func add(_ records: [GPRecord], tags: [String], group: String? = nil) -> Bool {
        var changed = false
        if let group {
            groupTags[group] = Set(tags)
        }
        var served = Set<String>()
        for record in records {
            let id = "\(record.satnum)|\(record.name)"
            served.insert(id)
            guard var entry = entries[id] else {
                entries[id] = CatalogEntry(id: id, record: record, tags: Set(tags), groups: group.map { [$0] } ?? [])
                changed = true
                continue
            }
            let before = entry
            entry.tags.formUnion(tags)
            if let group {
                entry.groups.insert(group)
                entry.tags = self.tags(of: entry.groups)
            }
            if record != entry.record, record.meanElements.epoch.julianDate >= entry.record.meanElements.epoch.julianDate {
                entry.record = record
            }
            if entry != before {
                entries[id] = entry
                changed = true
            }
        }
        if let group {
            for (id, var entry) in entries where entry.groups.contains(group) && !served.contains(id) {
                entry.groups.remove(group)
                if entry.groups.isEmpty {
                    entries[id] = nil
                } else {
                    entry.tags = self.tags(of: entry.groups)
                    entries[id] = entry
                }
                changed = true
            }
        }
        return changed
    }

    /// What the groups serving an entry tag it with.
    private func tags(of groups: Set<String>) -> Set<String> {
        groups.reduce(into: Set<String>()) { $0.formUnion(groupTags[$1] ?? []) }
    }

    public func entries(tagged tag: String) -> [CatalogEntry] {
        entries.values.filter { $0.tags.contains(tag) }.sorted { $0.name < $1.name }
    }

    /// By name or catalog number, ignoring case: what the browser's search box finds.
    public func search(_ query: String) -> [CatalogEntry] {
        let needle = query.trimmingCharacters(in: .whitespaces).uppercased()
        guard !needle.isEmpty else {
            return []
        }
        return entries.values.filter { $0.name.uppercased().contains(needle) || $0.satnum == needle }.sorted { $0.name < $1.name }
    }
}

/// Which catalog entries are live satellites (CONTEXT.md, Activation): those an
/// enabled tag carries and that were not opted out one by one, plus those enabled
/// by name, plus the tracked one. The three lists only mean something together,
/// so they change together.
public struct Activation: Sendable, Equatable {
    public private(set) var enabledTags: Set<String>
    public private(set) var enabledSatellites: Set<String>
    public private(set) var disabledSatellites: Set<String>

    public init(enabledTags: Set<String> = [], enabledSatellites: Set<String> = [], disabledSatellites: Set<String> = []) {
        self.enabledTags = enabledTags
        self.enabledSatellites = enabledSatellites
        self.disabledSatellites = disabledSatellites.subtracting(enabledSatellites)
    }

    public func isActive(_ entry: CatalogEntry, tracked: String? = nil) -> Bool {
        let byTag = !entry.tags.isDisjoint(with: enabledTags) && !disabledSatellites.contains(entry.name)
        return byTag || enabledSatellites.contains(entry.name) || entry.name == tracked
    }

    public func active(in catalog: Catalog, tracked: String? = nil) -> [CatalogEntry] {
        catalog.entries.values.filter { isActive($0, tracked: tracked) }.sorted { $0.name < $1.name }
    }

    /// A whole group on or off. Turning it on takes back every opt-out inside it;
    /// turning it off drops what was enabled one by one inside it, so that off
    /// means off.
    public mutating func setTag(_ tag: String, enabled: Bool, members: [CatalogEntry]) {
        let names = Set(members.map(\.name))
        if enabled {
            enabledTags.insert(tag)
            disabledSatellites.subtract(names)
        } else {
            enabledTags.remove(tag)
            enabledSatellites.subtract(names)
        }
    }

    /// One satellite on or off, whatever enabled it.
    public mutating func setSatellite(_ entry: CatalogEntry, enabled: Bool) {
        if enabled {
            enabledSatellites.insert(entry.name)
            disabledSatellites.remove(entry.name)
        } else {
            enabledSatellites.remove(entry.name)
            if !entry.tags.isDisjoint(with: enabledTags) {
                disabledSatellites.insert(entry.name)
            }
        }
    }

    public mutating func clear() {
        self = Activation()
    }
}
