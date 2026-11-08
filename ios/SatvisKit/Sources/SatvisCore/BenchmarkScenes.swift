import Foundation

/// A link the benchmark opens and measures (docs/adr/0016-benchmark.md), served
/// with each preset in the group index, written like a featured bookmark.
public struct BenchmarkScene: Sendable, Hashable, Identifiable, Decodable {
    /// Names the scene's fields in a report, so it outlives a change of name.
    public var id: String
    public var name: String
    /// The path it opens on, `/` or `/<preset>`, which need not be the route it
    /// was served for: a preset with none is served the default preset's.
    public var route: String
    /// Url parameters, only those that deviate from the route's preset's defaults.
    public var query: [String: String]
    /// Its frames paced, as outside a benchmark, so its frame rate is low by
    /// design and its load is the cost.
    public var paced: Bool

    public init(id: String, name: String, route: String = "/", query: [String: String] = [:], paced: Bool = false) {
        self.id = id
        self.name = name
        self.route = route
        self.query = query
        self.paced = paced
    }

    enum CodingKeys: String, CodingKey {
        case id, name, route, query, paced
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        route = try container.decode(String.self, forKey: .route)
        query = ((try? container.decodeIfPresent([String: JSONValue].self, forKey: .query)) ?? [:]).compactMapValues(\.string)
        paced = (try? container.decodeIfPresent(Bool.self, forKey: .paced)) ?? false
    }

    /// The scene as a link, its query in the order the web app writes it.
    public var link: Link {
        Link(route + "?" + LinkQuery(query.sorted { $0.key < $1.key }.map { LinkQuery.Item(key: $0.key, values: [$0.value]) }).string)
    }

    /// The scenes in order and the first again, last: the drift check. `only`,
    /// scene ids, runs those alone, in the list's order and without the repeat
    /// (src/modules/benchmark/benchmarkPlan.ts `planScenes`).
    public static func plan(_ scenes: [BenchmarkScene], only: [String] = []) -> [BenchmarkStep] {
        if !only.isEmpty {
            return scenes.filter { only.contains($0.id) }.map { BenchmarkStep(scene: $0) }
        }
        guard let first = scenes.first else {
            return []
        }
        return scenes.map { BenchmarkStep(scene: $0) } + [BenchmarkStep(scene: first, repeat: true)]
    }
}

/// One link the benchmark opens, waits for, settles and measures: what both
/// apps do with a benchmark scene.
public struct BenchmarkStep: Sendable, Hashable, Identifiable {
    public var scene: BenchmarkScene
    /// The closing re-run of the first step, the drift check.
    public var `repeat`: Bool

    public init(scene: BenchmarkScene, repeat: Bool = false) {
        self.scene = scene
        self.repeat = `repeat`
    }

    /// The scene's id, or `<id>_repeat` for the drift check.
    public var id: String { `repeat` ? "\(scene.id)_repeat" : scene.id }
    public var paced: Bool { scene.paced }
    public var label: String { `repeat` ? "\(scene.name) (repeat)" : scene.name }
}
