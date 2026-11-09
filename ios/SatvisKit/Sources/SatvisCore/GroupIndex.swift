import Foundation

/// The group index, `/api/groups.json`: every group's status and tags, and the
/// presets, all from the worker's config. Decoded leniently, as the web app reads
/// it: whatever lacks the expected shape is dropped, so an index written before a
/// field existed reads as one without it.
public struct GroupIndex: Sendable, Hashable, Decodable {
    public var groups: [GroupStatus]
    public var presets: [String: Preset]

    public init(groups: [GroupStatus] = [], presets: [String: Preset] = [:]) {
        self.groups = groups
        self.presets = presets
    }

    enum CodingKeys: String, CodingKey {
        case groups, presets
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groups = try container.decode([Lenient<GroupStatus>].self, forKey: .groups).compactMap(\.value)
        presets = ((try? container.decodeIfPresent([String: Lenient<Preset>].self, forKey: .presets)) ?? [:]).compactMapValues(\.value)
    }

    /// The name of the preset a route opens with: `name` if there is one, else the default.
    private func presetName(_ name: String?) -> String {
        name.flatMap { presets[$0] == nil ? nil : $0 } ?? Preset.defaultName
    }

    /// The preset a route opens with: `name`'s if there is one, else the default.
    public func preset(named name: String?) -> Preset? {
        presets[presetName(name)]
    }

    /// The defaults of the preset a route opens with, in the url's vocabulary;
    /// empty without one.
    public func presetDefaults(named name: String?) -> [String: String] {
        preset(named: name)?.defaults ?? [:]
    }

    /// The featured bookmarks of the preset a route opens with, as links on its
    /// path, in the config's order (src/config/presets.ts).
    public func featured(preset name: String?) -> [Bookmark] {
        let resolved = presetName(name)
        return (presets[resolved]?.featured ?? []).enumerated().map { index, entry in
            Bookmark(
                id: "featured-\(resolved)-\(index)", kind: .featured, name: entry.name,
                scene: SceneLink(path: Bookmarks.path(preset: resolved), query: entry.query), thumbnail: entry.thumbnail, at: 0)
        }
    }
}

extension GroupIndex {
    /// The benchmark scenes of the preset a route opens with.
    public func benchmarkScenes(preset name: String?) -> [BenchmarkScene] {
        preset(named: name)?.benchmark ?? []
    }
}

public struct GroupStatus: Sendable, Hashable, Decodable {
    public var name: String
    public var count: Int
    /// What the user enables to show the group's satellites.
    public var tags: [String]

    public init(name: String, count: Int = 0, tags: [String] = []) {
        self.name = name
        self.count = count
        self.tags = tags
    }

    enum CodingKeys: String, CodingKey {
        case name, count, tags
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
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
    /// Shown in this route's Bookmarks sheet, in this order.
    public var featured: [FeaturedBookmark]
    /// What the benchmark measures from this route, the default preset's where
    /// the config lists none, as the worker serves them.
    public var benchmark: [BenchmarkScene]

    public init(
        title: String? = nil, description: String? = nil, defaults: [String: String] = [:], groups: [PresetGroup] = [],
        featured: [FeaturedBookmark] = [], benchmark: [BenchmarkScene] = []
    ) {
        self.title = title
        self.description = description
        self.defaults = defaults
        self.groups = groups
        self.featured = featured
        self.benchmark = benchmark
    }

    enum CodingKeys: String, CodingKey {
        case title, description, defaults, groups, featured, benchmark
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try? container.decodeIfPresent(String.self, forKey: .title)
        description = try? container.decodeIfPresent(String.self, forKey: .description)
        defaults = ((try? container.decodeIfPresent([String: JSONValue].self, forKey: .defaults)) ?? [:]).compactMapValues(\.string)
        groups = try container.decode([Lenient<PresetGroup>].self, forKey: .groups).compactMap(\.value)
        featured = ((try? container.decodeIfPresent([Lenient<FeaturedBookmark>].self, forKey: .featured)) ?? []).compactMap(\.value)
        benchmark = ((try? container.decodeIfPresent([Lenient<BenchmarkScene>].self, forKey: .benchmark)) ?? []).compactMap(\.value)
    }
}

/// A bookmark a preset ships (docs/adr/0011-bookmarks.md): a link against the
/// preset's defaults, with its card's picture as a path on the site.
public struct FeaturedBookmark: Sendable, Hashable, Decodable {
    public var name: String
    public var thumbnail: String
    /// Url parameters, only those that deviate from the preset's defaults.
    public var query: [String: String]

    public init(name: String, thumbnail: String, query: [String: String] = [:]) {
        self.name = name
        self.thumbnail = thumbnail
        self.query = query
    }

    enum CodingKeys: String, CodingKey {
        case name, thumbnail, query
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        thumbnail = try container.decode(String.self, forKey: .thumbnail)
        query = ((try? container.decodeIfPresent([String: JSONValue].self, forKey: .query)) ?? [:]).compactMapValues(\.string)
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

/// Decodes to nil instead of failing, so one bad element cannot sink an array.
struct Lenient<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }

    /// The elements of a JSON array that decode; none when `data` is no array.
    static func array(from data: Data) -> [Value] {
        ((try? JSONDecoder().decode([Lenient].self, from: data)) ?? []).compactMap(\.value)
    }
}
