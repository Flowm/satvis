import Foundation

/// A link's query as vue-router reads and writes it: the parameters in order, each
/// with its values, nil for a valueless one (`?embed`).
public struct LinkQuery: Sendable, Hashable {
    public struct Item: Sendable, Hashable {
        public var key: String
        public var values: [String?]

        public init(key: String, values: [String?]) {
            self.key = key
            self.values = values
        }
    }

    public var items: [Item]

    public init(_ items: [Item] = []) {
        self.items = items
    }

    /// vue-router's `parseQuery`: `+` is a space, each part is percent-decoded, and
    /// a repeated key collects its values.
    public init(parsing search: String) {
        items = []
        var search = Substring(search)
        if search.first == "?" {
            search = search.dropFirst()
        }
        guard !search.isEmpty else {
            return
        }
        for part in search.split(separator: "&", omittingEmptySubsequences: false) {
            let spaced = part.replacing("+", with: " ")
            let key: String
            let value: String?
            if let equals = spaced.firstIndex(of: "=") {
                key = Self.decode(spaced[..<equals])
                value = Self.decode(spaced[spaced.index(after: equals)...])
            } else {
                key = Self.decode(spaced)
                value = nil
            }
            if let index = items.firstIndex(where: { $0.key == key }) {
                items[index].values.append(value)
            } else {
                items.append(Item(key: key, values: [value]))
            }
        }
    }

    /// vue-router's `stringifyQuery`.
    public var string: String {
        items.flatMap { item in
            item.values.map { value in
                let key = Self.encode(item.key, isKey: true)
                return value.map { "\(key)=\(Self.encode($0, isKey: false))" } ?? key
            }
        }.joined(separator: "&")
    }

    /// The first value given for a key, as the codec reads a parameter it owns.
    public subscript(key: String) -> String? {
        items.first { $0.key == key }?.values.first ?? nil
    }

    /// `decodeURIComponent`, keeping the text as it was where that throws.
    private static func decode(_ text: Substring) -> String {
        String(text).removingPercentEncoding ?? String(text)
    }

    /// `encodeURI`, then vue-router's adjustments for a query (`encodeQueryValue`,
    /// `encodeQueryKey`).
    private static func encode(_ text: String, isKey: Bool) -> String {
        var out = ""
        for byte in text.utf8 {
            let scalar = Unicode.Scalar(byte)
            switch scalar {
            case " ": out += "+"
            case "+": out += "%2B"
            case "#": out += "%23"
            case "&": out += "%26"
            case "=" where isKey: out += "%3D"
            case _ where byte < 0x80 && (scalar.properties.isASCIIHexDigit || CharacterSet.alphanumerics.contains(scalar) || keptLiteral.contains(scalar)):
                out.unicodeScalars.append(scalar)
            default: out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    /// What `encodeURI` leaves alone, with what vue-router turns back.
    private static let keptLiteral = Set(";,/?:@=$-_.!~*'()|[]`{}^".unicodeScalars)
}

/// A ground station as a link carries it (ADR 0001, `gs`).
public struct LinkStation: Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double
    public var name: String?

    public init(latitude: Double, longitude: Double, name: String? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
    }
}

/// What a link sets, in the wire vocabulary of ADR 0001: the parameters the
/// native app honours. Everything else a link carries passes through untouched.
public struct LinkState: Sendable, Hashable {
    public var elements: [String]
    public var sats: [String]
    public var xsats: [String]
    public var tags: [String]
    public var gs: [LinkStation]
    public var track: String
    public var overpass: String
    public var layers: [String]
    public var terrain: String
    /// `3D`, or `Sky` for the sky view (ADR 0003).
    public var scene: String
    /// Drawable pixels per point: `1`, `1.5`, or `native` for the screen's own.
    public var pixelRatio: String
    /// The minute the clock is pinned at (`2026-10-04T20:46Z`), nil while live.
    public var time: String?

    /// The web app's defaults before any preset (src/stores).
    public static let global = LinkState(
        elements: ["Point", "Label"], sats: [], xsats: [], tags: [], gs: [], track: "", overpass: "elevation", layers: ["NaturalEarth"], terrain: "None",
        scene: "3D", pixelRatio: "native", time: nil)

    public init(
        elements: [String], sats: [String], xsats: [String], tags: [String], gs: [LinkStation], track: String, overpass: String, layers: [String],
        terrain: String, scene: String = "3D", pixelRatio: String = "native", time: String?
    ) {
        self.elements = elements
        self.sats = sats
        self.xsats = xsats
        self.tags = tags
        self.gs = gs
        self.track = track
        self.overpass = overpass
        self.layers = layers
        self.terrain = terrain
        self.scene = scene
        self.pixelRatio = pixelRatio
        self.time = time
    }
}

/// The URL codec (src/modules/util/urlCodec.ts, ADR 0001), over the parameters
/// the native app honours and the vocabularies it can draw.
public enum LinkCodec {
    /// What the app can show of each closed vocabulary. A link naming anything
    /// else loses that member, as a link from another build does on the web.
    public static let components = ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone", "3D model", "Ground station link"]
    public static let layers = ["NaturalEarth", "VersaTiles", "BlackMarble"]
    public static let terrains = ["None", "ReEarth"]
    public static let overpassModes = ["elevation", "swath"]
    public static let scenes = ["3D", "Sky"]
    /// The web app's `PIXEL_RATIOS` (src/config/rendering.ts).
    public static let pixelRatios = ["1", "1.5", "native"]

    /// One parameter: how it reads into the state and writes out of it.
    struct Field: Sendable {
        let name: String
        /// False when the value was unusable and the default stands.
        let read: @Sendable (String?, inout LinkState, LinkState) -> Bool
        let write: @Sendable (LinkState) -> String?

        init<Value: Sendable>(_ name: String, _ path: WritableKeyPath<LinkState, Value> & Sendable, _ kind: FieldKind<Value>) {
            self.name = name
            read = { raw, state, defaults in
                guard let raw else {
                    state[keyPath: path] = defaults[keyPath: path]
                    return true
                }
                guard let value = kind.parse(raw) else {
                    state[keyPath: path] = defaults[keyPath: path]
                    return false
                }
                state[keyPath: path] = value
                return true
            }
            write = { kind.format($0[keyPath: path]) }
        }
    }

    /// In the web app's order: the satellite store's parameters, then the globe's.
    static let schema: [Field] = [
        Field("elements", \.elements, .closedList(components)),
        Field("sats", \.sats, .tildeEscapedList),
        Field("xsats", \.xsats, .tildeEscapedList),
        Field("tags", \.tags, .list),
        Field("gs", \.gs, .stations),
        Field("track", \.track, .plain),
        Field("overpass", \.overpass, .oneOf(overpassModes)),
        Field("layers", \.layers, .layerList(layers)),
        Field("terrain", \.terrain, .oneOf(terrains)),
        Field("scene", \.scene, .oneOf(scenes)),
        Field("pixelratio", \.pixelRatio, .oneOf(pixelRatios)),
        Field("time", \.time, .timestamp),
    ]

    public static var parameters: [String] { schema.map(\.name) }

    /// A preset's defaults, which are written as a link, read onto the global ones.
    public static func defaults(preset: [String: String]) -> LinkState {
        decode(LinkQuery(preset.map { LinkQuery.Item(key: $0.key, values: [$0.value]) }), defaults: .global).state
    }

    /// Query -> state. An absent parameter is its default; an unusable one too,
    /// and is named in `invalid`.
    public static func decode(_ query: LinkQuery, defaults: LinkState) -> (state: LinkState, invalid: [String]) {
        var state = defaults
        var invalid: [String] = []
        for field in schema where !field.read(query[field.name], &state, defaults) {
            invalid.append(field.name)
        }
        return (state, invalid)
    }

    /// State -> the parameters that differ from the defaults, in order. One that
    /// cannot be written is left out rather than written as something else.
    public static func encode(_ state: LinkState, defaults: LinkState) -> [(String, String)] {
        schema.compactMap { field in
            guard let value = field.write(state), value != field.write(defaults) else {
                return nil
            }
            return (field.name, value)
        }
    }
}

extension LinkCodec {
    /// A whole query as urlSync.ts takes it: the parameters the codec owns read
    /// onto `defaults`, the rest kept as they came.
    public static func read(_ query: LinkQuery, defaults: LinkState) -> (state: LinkState, foreign: LinkQuery, invalid: [String]) {
        let owned = Set(parameters)
        let (state, invalid) = decode(query, defaults: defaults)
        return (state, LinkQuery(query.items.filter { !owned.contains($0.key) }), invalid)
    }

    /// The query for a state: the foreign parameters as they came, then what
    /// differs from the defaults.
    public static func write(_ state: LinkState, foreign: LinkQuery = LinkQuery(), defaults: LinkState) -> LinkQuery {
        LinkQuery(foreign.items + encode(state, defaults: defaults).map { LinkQuery.Item(key: $0.0, values: [$0.1]) })
    }
}

/// How one kind of parameter reads and writes (urlCodec.ts). Nil is "cannot be
/// represented".
struct FieldKind<Value: Sendable>: Sendable {
    let parse: @Sendable (String) -> Value?
    let format: @Sendable (Value) -> String?
}

extension FieldKind where Value == String {
    static var plain: Self { Self(parse: { $0 }, format: { $0 }) }

    static func oneOf(_ values: [String]) -> Self {
        Self(parse: { values.contains($0) ? $0 : nil }, format: { values.contains($0) ? $0 : nil })
    }
}

extension FieldKind where Value == [String] {
    static var list: Self { Self(parse: splitList, format: formatList) }

    /// `sats`, `xsats`: `~` was once a space, and still reads as one.
    static var tildeEscapedList: Self {
        Self(
            parse: { splitList($0).map { $0.replacing("~", with: " ") } },
            format: { $0.contains { $0.contains("~") } ? nil : formatList($0) })
    }

    /// `elements`: the literal, else `-` read as a space, else the member is lost.
    static func closedList(_ members: [String]) -> Self {
        Self(
            parse: { raw in
                resolveList(raw) { entry in
                    members.contains(entry) ? entry : members.contains(entry.replacing("-", with: " ")) ? entry.replacing("-", with: " ") : nil
                }
            },
            format: { $0.allSatisfy(members.contains) ? formatList($0) : nil })
    }

    /// `layers`: a provider with an optional `_<alpha>` opacity, in its canonical form.
    static func layerList(_ providers: [String]) -> Self {
        let usable: @Sendable (String) -> String? = { entry in
            parseLayer(entry).flatMap { providers.contains($0.provider) ? formatLayer($0) : nil }
        }
        return Self(
            parse: { raw in resolveList(raw, usable) },
            format: { value in value.allSatisfy { usable($0) != nil } ? formatList(value) : nil })
    }
}

extension FieldKind where Value == [LinkStation] {
    /// `gs`: `_`-joined stations, each `lat,lon[,name]`; a malformed one is lost.
    static var stations: Self {
        Self(
            parse: { raw in
                raw.split(separator: "_").compactMap { entry in
                    let parts = entry.split(separator: ",", omittingEmptySubsequences: false)
                    guard parts.count == 2 || parts.count == 3, let latitude = jsParseFloat(parts[0]), let longitude = jsParseFloat(parts[1]) else {
                        return nil
                    }
                    let name = parts.count == 3 && !parts[2].isEmpty ? String(parts[2]) : nil
                    return LinkStation(latitude: latitude, longitude: longitude, name: name)
                }
            },
            format: { stations in
                var parts: [String] = []
                for station in stations {
                    guard station.latitude.isFinite, station.longitude.isFinite else {
                        return nil
                    }
                    if let name = station.name, name.contains(",") || name.contains("_") {
                        return nil
                    }
                    let coordinates = "\(toFixed(station.latitude, 4)),\(toFixed(station.longitude, 4))"
                    parts.append(station.name.flatMap { $0.isEmpty ? nil : "\(coordinates),\($0)" } ?? coordinates)
                }
                return parts.joined(separator: "_")
            })
    }
}

extension FieldKind where Value == String? {
    /// `time`: any ISO-8601 instant in, the minute out; nil is live and absent.
    static var timestamp: Self {
        Self(
            parse: { raw in
                guard let minute = minuteISO(raw) else {
                    return nil
                }
                return .some(minute)
            },
            format: { $0.flatMap(minuteISO) })
    }
}

// MARK: The wire forms

private func splitList(_ raw: String) -> [String] {
    raw.split(separator: ",").map(String.init)
}

/// A member holding the separator cannot be written: it would read back as two.
private func formatList(_ value: [String]) -> String? {
    value.contains { $0.contains(",") } ? nil : value.joined(separator: ",")
}

/// A closed list loses an unusable member, but where it names members and none is
/// usable, the whole parameter is unusable: an empty list is a state of its own.
private func resolveList(_ raw: String, _ resolve: (String) -> String?) -> [String]? {
    let entries = splitList(raw)
    let resolved = entries.compactMap(resolve)
    return !entries.isEmpty && resolved.isEmpty ? nil : resolved
}

/// src/config/layers.ts `parseLayer`: the provider, and an opacity in 0...1.
func parseLayer(_ token: String) -> (provider: String, alpha: Double?)? {
    guard let separator = token.firstIndex(of: "_") else {
        return token.isEmpty ? nil : (token, nil)
    }
    let provider = String(token[..<separator])
    let rawAlpha = String(token[token.index(after: separator)...])
    guard !provider.isEmpty, !rawAlpha.isEmpty, let alpha = jsNumber(rawAlpha), alpha.isFinite, (0...1).contains(alpha) else {
        return nil
    }
    return (provider, alpha)
}

func formatLayer(_ layer: (provider: String, alpha: Double?)) -> String {
    layer.alpha.map { "\(layer.provider)_\(jsNumberString($0))" } ?? layer.provider
}

/// JavaScript's `Number.parseFloat`: the longest decimal prefix after leading
/// white space, so `48.1abc` is 48.1. Nil for no number and for an infinity.
func jsParseFloat(_ text: Substring) -> Double? {
    let trimmed = text.drop { $0.isWhitespace }
    guard let match = trimmed.prefixMatch(of: /[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/), let value = Double(match.output) else {
        return nil
    }
    return value.isFinite ? value : nil
}

/// JavaScript's `Number(string)`: the whole string, trimmed, as a decimal, a
/// `0x`/`0o`/`0b` integer or an infinity; empty is 0. Nil where that is NaN.
func jsNumber(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        return 0
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] where trimmed.hasPrefix(prefix) {
        return UInt64(trimmed.dropFirst(2), radix: radix).map { Double($0) }
    }
    guard trimmed.wholeMatch(of: /[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/) != nil else {
        return nil
    }
    return Double(trimmed.replacing("Infinity", with: "inf"))
}

/// JavaScript's `Number.prototype.toString()`: the shortest digits that read back
/// as the same double, positional from 1e-6 up to 1e21, exponential outside.
func jsNumberString(_ value: Double) -> String {
    if value == 0 {
        return "0"
    }
    if !value.isFinite {
        return value.isNaN ? "NaN" : value < 0 ? "-Infinity" : "Infinity"
    }
    // Swift's description holds the same shortest digits, in a format of its own.
    let description = abs(value).description
    let parts = description.split(separator: "e")
    let mantissa = parts[0]
    let exponent = parts.count > 1 ? Int(parts[1])! : 0
    let integerDigits = mantissa.split(separator: ".", omittingEmptySubsequences: false)[0]
    var digits = mantissa.replacing(".", with: "")
    // As 0.d₁d₂…dₖ × 10ⁿ.
    var n = integerDigits.count + exponent
    while digits.first == "0" {
        digits.removeFirst()
        n -= 1
    }
    while digits.last == "0" {
        digits.removeLast()
    }
    let k = digits.count
    let sign = value < 0 ? "-" : ""
    if k <= n && n <= 21 {
        return sign + digits + String(repeating: "0", count: n - k)
    }
    if 0 < n && n <= 21 {
        return sign + digits.prefix(n) + "." + digits.dropFirst(n)
    }
    if -6 < n && n <= 0 {
        return sign + "0." + String(repeating: "0", count: -n) + digits
    }
    let e = n - 1
    let rest = digits.dropFirst()
    return sign + digits.prefix(1) + (rest.isEmpty ? "" : "." + rest) + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
}

/// The minute an ISO-8601 date or time falls in, UTC, as the web app writes it
/// (`2026-10-04T20:46Z`); a time with no zone is UTC, as dayjs.utc reads it. Nil
/// for anything else: the web app also takes other forms `Date.parse` knows,
/// which no link it writes uses.
func minuteISO(_ raw: String) -> String? {
    guard
        let match = raw.wholeMatch(
            of: /(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|z|[+-]\d{2}:\d{2})?/)
    else {
        return nil
    }
    let output = match.output
    var components = DateComponents()
    components.calendar = Calendar(identifier: .gregorian)
    components.timeZone = .gmt
    components.year = Int(output.1)
    components.month = Int(output.2)
    components.day = Int(output.3)
    components.hour = output.4.flatMap { Int($0) } ?? 0
    components.minute = output.5.flatMap { Int($0) } ?? 0
    components.second = output.6.flatMap { Int($0) } ?? 0
    guard components.isValidDate, var date = components.date else {
        return nil
    }
    if let zone = output.7, zone.count == 6 {
        let sign: Double = zone.hasPrefix("-") ? -1 : 1
        let hours = Double(zone.dropFirst().prefix(2))!
        let minutes = Double(zone.suffix(2))!
        date -= sign * (hours * 3600 + minutes * 60)
    }
    return minuteISO(date)
}

/// The minute a date falls in, UTC, as the web app writes it.
public func minuteISO(_ date: Date) -> String {
    var format = Date.ISO8601FormatStyle(timeZone: .gmt)
    format = format.year().month().day().dateTimeSeparator(.standard).time(includingFractionalSeconds: false)
    return String(date.formatted(format).prefix(16)) + "Z"
}

/// A satvis link: the preset it opens on, by its path (`/ot`), and its query.
public struct Link: Sendable, Hashable {
    /// The preset the path names, nil for the default one.
    public var preset: String?
    public var query: LinkQuery

    public init(preset: String? = nil, query: LinkQuery = LinkQuery()) {
        self.preset = preset == Preset.defaultName ? nil : preset
        self.query = query
    }

    /// From a whole link or a path with its query, as `/ot?tags=OT`: the path's
    /// last segment names the preset, less any `.html`, as src/config/presets.ts
    /// reads it.
    public init(_ text: String) {
        var rest = Substring(text)
        if let fragment = rest.firstIndex(of: "#") {
            rest = rest[..<fragment]
        }
        let question = rest.firstIndex(of: "?")
        var path = question.map { rest[..<$0] } ?? rest
        if let scheme = path.range(of: "://") {
            path = path[scheme.upperBound...].drop { $0 != "/" }
        }
        var name = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if name.hasSuffix(".html") {
            name.removeLast(".html".count)
        }
        self.init(preset: name.isEmpty ? nil : name, query: LinkQuery(parsing: question.map { String(rest[rest.index(after: $0)...]) } ?? ""))
    }

    /// The link on a site, as the web app would show it in its address bar.
    public func url(site: URL) -> URL {
        let query = query.string
        let path = "/" + (preset ?? "") + (query.isEmpty ? "" : "?" + query)
        return URL(string: path, relativeTo: site)?.absoluteURL ?? site
    }
}

extension LinkState {
    /// The imagery providers `layers` names, in order, less their opacities.
    public var layerProviders: [String] {
        layers.compactMap { parseLayer($0)?.provider }
    }
}

/// The instant a link's minute (`2026-10-04T20:46Z`) stands for.
public func date(minuteISO: String) -> Date? {
    guard minuteISO.hasSuffix("Z") else {
        return nil
    }
    return try? Date(String(minuteISO.dropLast()) + ":00Z", strategy: .iso8601)
}

/// What analytics may see of a link (src/modules/util/posthogPrivacy.ts): its
/// ground stations cut to the whole degree, which is all a usage count needs.
public func sanitizedForAnalytics(_ url: String) -> String {
    url.replacing(/([?&]gs=)([^&#]*)/) { station in
        station.output.1
            + station.output.2.replacing(/([+-]?)(\d*)\.\d+/) { number in
                number.output.1 + (number.output.2.isEmpty ? "0" : number.output.2)
            }
    }
}
