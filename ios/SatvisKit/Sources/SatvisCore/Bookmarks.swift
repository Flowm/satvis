import Foundation

/// A scene as a url: a route and the parameters on it (the web app's `Link`).
public struct SceneLink: Sendable, Hashable {
    /// The path that opens the route's preset: `/` for the default one, `/ot`.
    public var path: String
    /// The parameters the web app's stores own (`Bookmarks.ownedParameters`),
    /// defaults left out.
    public var query: [String: String]

    public init(path: String, query: [String: String]) {
        self.path = path
        self.query = query
    }

    /// The preset `path` opens, nil for the default one.
    public var preset: String? {
        path == "/" ? nil : String(path.drop { $0 == "/" })
    }

    /// The link to open, after the parameters `carried` from the link on screen:
    /// the codec's own in its order, the rest by name.
    public func link(carrying carried: [LinkQuery.Item] = []) -> Link {
        let known = LinkCodec.parameters
        let keys = known.filter { query[$0] != nil } + query.keys.filter { !known.contains($0) }.sorted()
        return Link(preset: preset, query: LinkQuery(carried + keys.map { LinkQuery.Item(key: $0, values: [query[$0]]) }))
    }
}

/// A link to a scene, kept under a name with a picture (src/modules/util/bookmarks.ts,
/// ADR 0011): a route and the url parameters the web app's stores own, never a
/// camera position. The same records the web app keeps, so either reads the other's.
public struct Bookmark: Sendable, Hashable, Codable, Identifiable {
    /// A demo ships with the app, a saved one was named by the user, an opened one
    /// is a link that started a visit.
    public enum Kind: String, Sendable, Codable {
        case demo, saved, opened
    }

    /// Unique among one device's bookmarks.
    public var id: String
    public var kind: Kind
    /// The user's, or one drawn from the scene (`Bookmarks.defaultName`).
    public var name: String
    /// `scene`'s, flat as the web app keeps them.
    public var path: String
    public var query: [String: String]
    /// A demo's picture, as a path on the site; the app keeps the others' apart.
    public var thumbnail: String?
    /// When it was saved or opened, in epoch milliseconds; 0 for a demo.
    public var at: Double

    public init(id: String, kind: Kind, name: String, scene: SceneLink, thumbnail: String? = nil, at: Double) {
        self.id = id
        self.kind = kind
        self.name = name
        path = scene.path
        query = scene.query
        self.thumbnail = thumbnail
        self.at = at
    }

    /// The scene it opens; two bookmarks of one scene open the same.
    public var scene: SceneLink { SceneLink(path: path, query: query) }
}

/// What a card says under a bookmark's name.
public struct BookmarkSummary: Sendable, Hashable {
    /// Which satellites.
    public var what: String
    /// Where the camera is.
    public var `where`: String
    /// The pinned time, nil for live.
    public var time: String?
}

/// The web app's bookmark arithmetic (src/modules/util/bookmarks.ts), held to it by
/// the parity fixtures.
public enum Bookmarks {
    /// The newest opened links kept; older ones drop off.
    public static let openedLimit = 8

    /// The demos the web app ships (src/config/bookmarks.ts), through Shared/web-tables.json.
    public static var demos: [Bookmark] { WebTables.shared.bookmarks.demos }

    /// The parameters the web app's stores own, which a bookmark keeps; a link's
    /// others, such as `framems`, travel past it.
    public static var ownedParameters: Set<String> { Set(WebTables.shared.bookmarks.ownedParams) }

    /// A link's owned parameters, each by its first value, as a bookmark keeps them.
    public static func ownedQuery(of query: LinkQuery) -> [String: String] {
        let owned = ownedParameters
        var result: [String: String] = [:]
        for item in query.items where owned.contains(item.key) && result[item.key] == nil {
            if let value = item.values.first ?? nil {
                result[item.key] = value
            }
        }
        return result
    }

    /// The parameters of a link no store owns, kept through every bookmark opened.
    public static func carriedItems(of query: LinkQuery) -> [LinkQuery.Item] {
        let owned = ownedParameters
        return query.items.filter { !owned.contains($0.key) }
    }

    /// The path that opens a preset: `/` for the default one.
    public static func path(preset: String?) -> String {
        preset.map { $0 == Preset.defaultName ? "/" : "/\($0)" } ?? "/"
    }

    /// The query without `time`, which a pinned clock rewrites every minute while the scene stays.
    public static func withoutTime(_ query: [String: String]) -> [String: String] {
        query.filter { $0.key != "time" }
    }

    /// Records a link a visit started with: newest first, once each, at most `openedLimit`.
    public static func withOpened(_ opened: [Bookmark], _ link: Bookmark) -> [Bookmark] {
        Array(([link] + opened.filter { $0.scene != link.scene }).prefix(openedLimit))
    }

    /// What a bookmark shows, in words. `presetDefaults` fill what the query leaves
    /// out, as they do when it is opened.
    public static func summarize(_ query: [String: String], presetDefaults: [String: String], now: Date = Date()) -> BookmarkSummary {
        func value(_ parameter: String) -> String? { query[parameter] ?? presetDefaults[parameter] }
        func list(_ text: String?) -> [String] {
            guard let text, !text.isEmpty else {
                return []
            }
            return text.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        }
        let tags = list(value("tags"))
        let sats = list(value("sats"))
        let track = value("track")

        var what: String
        if tags.isEmpty {
            what = sats.isEmpty ? "No satellites" : satellitesNamed(sats)
        } else {
            what = tags.count == 1 ? groupNoun(tags[0]) : joinNames(tags)
            if !sats.isEmpty {
                what += " + \(satellitesNamed(sats))"
            }
        }

        let scene = value("scene") ?? "3D"
        let place: String
        if scene == "Sky" {
            // An empty `gs` names no station, as JavaScript's "" is false.
            place = value("gs").flatMap { $0.isEmpty ? nil : "Sky over \(firstStation($0))" } ?? "Sky view"
        } else if let track, !track.isEmpty {
            // Under its own name, the satellite needs no second mention.
            place = what == track ? "Following it" : "Following \(track)"
        } else {
            place = projections[scene] ?? scene
        }
        return BookmarkSummary(what: what, where: place, time: value("time").map { timeLabel($0, now: now) })
    }

    /// A name for a scene nobody named: the camera where it says more than the
    /// satellites, both for a projection.
    public static func defaultName(_ summary: BookmarkSummary) -> String {
        if summary.where == "Globe" {
            return summary.what
        }
        if summary.where == "Following it" {
            return "Following \(summary.what)"
        }
        return summary.where.hasPrefix("Following") || summary.where.hasPrefix("Sky") ? summary.where : "\(summary.what), \(summary.where.lowercased())"
    }

    /// "just now", "5 min ago", "3 h ago", "2 d ago".
    public static func timeAgo(_ at: Double, now: Double) -> String {
        let minutes = ((now - at) / 60_000).rounded(.down)
        if minutes < 1 {
            return "just now"
        }
        if minutes < 60 {
            return "\(Int(minutes)) min ago"
        }
        let hours = (minutes / 60).rounded(.down)
        return hours < 24 ? "\(Int(hours)) h ago" : "\(Int((hours / 24).rounded(.down))) d ago"
    }

    /// The globe's projections by their `scene` value.
    private static let projections = ["3D": "Globe", "2D": "Flat map", "Columbus": "Columbus view"]

    /// "A", "A and B", "A, B and C".
    private static func joinNames(_ names: [String]) -> String {
        names.count <= 1 ? (names.first ?? "") : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
    }

    /// "Weather satellites", but "Stations": a tag already in the plural needs no noun.
    private static func groupNoun(_ tag: String) -> String {
        tag.wholeMatch(of: /.*[a-z]s/) != nil ? tag : "\(tag) satellites"
    }

    /// Up to two names, or a count.
    private static func satellitesNamed(_ names: [String]) -> String {
        names.count <= 2 ? joinNames(names) : "\(names.count) satellites"
    }

    /// The first station of a `gs` value, which a link's sky view stands on, by name if it has one.
    private static func firstStation(_ gs: String) -> String {
        let fields = (gs.split(separator: "_", omittingEmptySubsequences: false).first ?? "").split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        if fields.count > 2, !fields[2].isEmpty {
            return fields[2]
        }
        // JavaScript's `Number`: an empty field is 0, a missing or unreadable one NaN.
        func degrees(_ index: Int) -> String {
            guard index < fields.count else {
                return "NaN"
            }
            let field = fields[index].trimmingCharacters(in: .whitespaces)
            return field.isEmpty ? "0.00" : Double(field).map { toFixed($0, 2) } ?? "NaN"
        }
        return "\(degrees(0))°, \(degrees(1))°"
    }

    /// en-GB's short months, as `toLocaleDateString` gives them.
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"]

    /// Day, month and minute in UTC, as the clock deck shows it, with the year only
    /// when it is not this one; the text as it came where it is no time.
    private static func timeLabel(_ iso: String, now: Date) -> String {
        guard let date = parseISO(iso) else {
            return iso
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let year = parts.year == calendar.component(.year, from: now) ? "" : " \(parts.year!)"
        return "\(parts.day!) \(months[parts.month! - 1])\(year), \(String(format: "%02d:%02d", parts.hour!, parts.minute!)) UTC"
    }

    /// The forms a link's `time` takes: to the minute, the second or the millisecond.
    private static func parseISO(_ text: String) -> Date? {
        for format in ["yyyy-MM-dd'T'HH:mmXXXXX", "yyyy-MM-dd'T'HH:mm:ssXXXXX", "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "UTC")
            formatter.dateFormat = format
            if let date = formatter.date(from: text) {
                return date
            }
        }
        return nil
    }
}

/// The saved bookmarks and the opened links, and the edits the Bookmarks panel
/// makes to them (src/stores/bookmarks.ts). Newest first.
public struct BookmarkLists: Sendable, Hashable, Codable {
    public var saved: [Bookmark] = []
    /// At most `Bookmarks.openedLimit`.
    public var opened: [Bookmark] = []

    public init(saved: [Bookmark] = [], opened: [Bookmark] = []) {
        self.saved = saved
        self.opened = opened
    }

    /// Saves a scene under `name`, and takes its link off the opened ones.
    @discardableResult
    public mutating func save(name: String, scene: SceneLink, id: String, at: Double) -> Bookmark {
        let bookmark = Bookmark(id: id, kind: .saved, name: name, scene: scene, at: at)
        saved.insert(bookmark, at: 0)
        opened.removeAll { $0.scene == scene }
        return bookmark
    }

    /// Records the link a visit started with.
    @discardableResult
    public mutating func recordOpened(name: String, scene: SceneLink, id: String, at: Double) -> Bookmark {
        let bookmark = Bookmark(id: id, kind: .opened, name: name, scene: scene, at: at)
        opened = Bookmarks.withOpened(opened, bookmark)
        return bookmark
    }

    /// Saves an opened link under `name`, keeping its id: its picture may still be on the way.
    @discardableResult
    public mutating func keep(_ id: String, name: String, at: Double) -> Bookmark? {
        guard let link = opened.first(where: { $0.id == id }) else {
            return nil
        }
        forget(id)
        var bookmark = link
        bookmark.kind = .saved
        bookmark.name = name
        bookmark.at = at
        saved.insert(bookmark, at: 0)
        return bookmark
    }

    /// A blank name keeps the old one.
    public mutating func rename(_ id: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let index = saved.firstIndex(where: { $0.id == id }), !trimmed.isEmpty {
            saved[index].name = trimmed
        }
    }

    /// Deletes a saved bookmark; `restore` undoes it.
    public mutating func remove(_ id: String) {
        saved.removeAll { $0.id == id }
    }

    /// Puts a deleted bookmark back where its age places it.
    public mutating func restore(_ bookmark: Bookmark) {
        guard !saved.contains(where: { $0.id == bookmark.id }) else {
            return
        }
        saved.append(bookmark)
        saved.sort { $0.at > $1.at }
    }

    /// Takes a link off the opened list.
    public mutating func forget(_ id: String) {
        opened.removeAll { $0.id == id }
    }

    /// Every id in use, for the pictures kept apart from the lists.
    public var ids: Set<String> { Set((saved + opened).map(\.id)) }
}
