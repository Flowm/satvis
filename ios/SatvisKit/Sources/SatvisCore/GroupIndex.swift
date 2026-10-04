import Foundation

/// The group index, `/api/groups.json`: every group's status and tags, and the
/// presets, all from the worker's config. Decoded leniently, as the web app reads
/// it: whatever lacks the expected shape is dropped, so an index written before a
/// field existed reads as one without it.
public struct GroupIndex: Sendable, Hashable, Decodable {
    /// When the last refresh ran, as ISO 8601. Empty before the first one.
    public var updated: String
    public var groups: [GroupStatus]
    public var presets: [String: Preset]

    public init(updated: String = "", groups: [GroupStatus] = [], presets: [String: Preset] = [:]) {
        self.updated = updated
        self.groups = groups
        self.presets = presets
    }

    enum CodingKeys: String, CodingKey {
        case updated, groups, presets
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updated = (try? container.decodeIfPresent(String.self, forKey: .updated)) ?? ""
        groups = try container.decode([Lenient<GroupStatus>].self, forKey: .groups).compactMap(\.value)
        presets = ((try? container.decodeIfPresent([String: Lenient<Preset>].self, forKey: .presets)) ?? [:]).compactMapValues(\.value)
    }

    /// The preset a route opens with: `name`'s if there is one, else the default.
    public func preset(named name: String?) -> Preset? {
        name.flatMap { presets[$0] } ?? presets[Preset.defaultName]
    }
}

public struct GroupStatus: Sendable, Hashable, Decodable {
    public var name: String
    /// When the group's records were last written. Nil before the first success.
    public var updated: String?
    public var count: Int
    /// What the user enables to show the group's satellites.
    public var tags: [String]

    public init(name: String, updated: String? = nil, count: Int = 0, tags: [String] = []) {
        self.name = name
        self.updated = updated
        self.count = count
        self.tags = tags
    }

    enum CodingKeys: String, CodingKey {
        case name, updated, count, tags
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        updated = try? container.decodeIfPresent(String.self, forKey: .updated)
        count = (try? container.decodeIfPresent(Int.self, forKey: .count)) ?? 0
        tags = (try? container.decodeIfPresent([String].self, forKey: .tags)) ?? []
    }
}

/// A route's starting configuration, shared with the web app. `defaults` are url
/// parameters (docs/adr/0001-url-parameter-specification.md); a client ignores
/// the ones it has no use for.
public struct Preset: Sendable, Hashable, Decodable {
    public static let defaultName = "default"

    public var title: String?
    public var description: String?
    public var defaults: [String: String]
    public var groups: [PresetGroup]

    public init(title: String? = nil, description: String? = nil, defaults: [String: String] = [:], groups: [PresetGroup] = []) {
        self.title = title
        self.description = description
        self.defaults = defaults
        self.groups = groups
    }

    enum CodingKeys: String, CodingKey {
        case title, description, defaults, groups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try? container.decodeIfPresent(String.self, forKey: .title)
        description = try? container.decodeIfPresent(String.self, forKey: .description)
        defaults = ((try? container.decodeIfPresent([String: JSONValue].self, forKey: .defaults)) ?? [:]).compactMapValues(\.string)
        groups = try container.decode([Lenient<PresetGroup>].self, forKey: .groups).compactMap(\.value)
    }
}

/// One group a preset registers. A search-only group fills the catalog but gets
/// no group row: it is too large to be worth enabling whole.
public struct PresetGroup: Sendable, Hashable, Decodable {
    public var name: String
    public var searchOnly: Bool

    public init(name: String, searchOnly: Bool = false) {
        self.name = name
        self.searchOnly = searchOnly
    }

    enum CodingKeys: String, CodingKey {
        case name, searchOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        searchOnly = (try? container.decodeIfPresent(Bool.self, forKey: .searchOnly)) ?? false
    }
}
