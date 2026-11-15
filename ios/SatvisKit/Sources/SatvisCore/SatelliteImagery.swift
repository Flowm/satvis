import Foundation

/// A satellite's instrument imagery (ADR 0019 to 0021): the layers its record carries,
/// as the Imagery tab, the Map panel and the globe read them.
extension SatelliteDetails {
    /// One layer of an instrument's imagery, the web app's `ImageryInfo`.
    public struct Imagery: Sendable, Hashable {
        /// `provider:layer`: one card's in a satellite's Imagery tab.
        public var key: String
        /// What the picture is: "True colour".
        public var label: String
        /// When it has frames and of what: "daily since 2018". Nil where the record says nothing.
        public var detail: String?
        /// The provider's viewer, which `href` opens: "NASA Worldview". Both nil for a
        /// provider with none.
        public var viewer: String?
        public var href: String?
        /// What a picture of it needs, for a layer whose provider answers for one.
        public var preview: ImageryPreview?
    }

    /// A layer the globe draws, the web app's `DrawnImagery` (ADR 0020), and what the
    /// Imagery tab needs to ask the provider for a picture of it, its `ImageryPreview`.
    public struct ImageryPreview: Sendable, Hashable {
        /// The providers that answer for a picture, by their keys in the imagery manifest.
        public enum Provider: String, Sendable {
            case gibs, eumetview, georing
        }

        /// What a provider's tiles are, by the manifest's `format`.
        public enum Format: String, Sendable {
            case png, jpeg, webp
        }

        public var provider: Provider
        public var layer: String
        /// The deepest level worth asking for, in 256-pixel Web Mercator tiles.
        public var maxLevel: Int
        public var format: Format
        /// A GIBS layer with a frame a day, which GIBS names by its date.
        public var isDaily: Bool
        /// The last frame's date, of a layer that stopped.
        public var end: String?

        /// The layer as a link and the drawn list name it, `gibs:GOES-East_ABI_GeoColor`:
        /// the layer's, not an instrument's, so a layer two satellites share is one.
        public var token: String { "\(provider.rawValue):\(layer)" }
    }

    /// The layers of a record the globe can draw, those with a `preview`, in the
    /// record's order.
    public static func drawableImagery(_ record: GPRecord) -> [Imagery] {
        (record.metadata["imagery"]?.array ?? []).compactMap { imagery($0)?.imagery }.filter { $0.preview != nil }
    }

    /// Nil for an entry without the fields a link needs, of a provider this app does not
    /// know, or one it can neither link to nor draw.
    static func imagery(_ entry: JSONValue) -> (instrument: String, imagery: Imagery, fields: [String: JSONValue])? {
        guard case .object(let fields) = entry, let instrument = fields["instrument"]?.string, let provider = fields["provider"]?.string,
            let layer = fields["layer"]?.string, let label = fields["label"]?.string, let known = WebTables.shared.imageryProviders[provider]
        else {
            return nil
        }
        let end = fields["end"]?.string
        let href = known.href(layer: layer, end: end)
        let preview = preview(fields, provider: provider, layer: layer, end: end)
        guard href != nil || preview != nil else {
            return nil
        }
        return (
            instrument,
            Imagery(
                key: "\(provider):\(layer)", label: label, detail: imageryDetail(fields), viewer: href == nil ? nil : known.viewer, href: href,
                preview: preview),
            fields
        )
    }

    /// A layer the globe can draw, as the Map panel lists it (ADR 0021): one satellite's,
    /// or a composite of several, once. The web app's `ImageryLayer`.
    public struct ImageryListing: Sendable, Hashable {
        /// The Map panel's groups, in its order: by the satellite's orbit class, GEO, and
        /// LEO for the rest, as no MEO or HEO satellite has a layer.
        public enum Group: String, CaseIterable, Sendable {
            case geo, leo
        }

        /// A satellite of a listing: the catalog's entry id, `satnum|name`, and its name.
        public struct Satellite: Sendable, Hashable {
            public var id: String
            public var name: String
        }

        /// Whose layer it is.
        public enum Kind: Sendable, Hashable {
            case satellite(Satellite, instrument: String)
            /// Named by its label's qualifier, "Geostationary Ring", or `compositeName`'s fallback;
            /// its satellites sorted by name, and its cadence, short, which its row shows
            /// where another names the instrument.
            case composite(name: String, satellites: [Satellite], cadence: String?)
        }

        /// Unique in the list: catalog number, provider and layer, or a composite's
        /// provider and layer.
        public var key: String
        public var kind: Kind
        /// The layer as the record's entry has it; a composite's `detail` from its
        /// earliest satellite's start.
        public var imagery: Imagery
        /// The label, short (`shortImageryLabel`).
        public var product: String
        /// Its token on the globe.
        public var token: String
        public var group: Group

        /// The satellite's name, or the composite's.
        public var name: String {
            switch kind {
            case .satellite(let satellite, _): satellite.name
            case .composite(let name, _, _): name
            }
        }
    }

    /// Every layer `records` carry that the globe can draw and that has not stopped, once
    /// per satellite, provider and layer: the composites first, by name, then by
    /// satellite name, then label. A composite is one layer, in its first satellite's
    /// group. The web app's `imageryLayers`. A viewer link alone, or a layer that
    /// stopped, is the satellite's Imagery tab's to offer.
    public static func imageryListings(_ records: some Sequence<GPRecord>) -> [ImageryListing] {
        var listings: [String: ImageryListing] = [:]
        // A composite's first entry and group, its satellites by catalog number, as a
        // record may be in several groups, and its earliest start.
        var composites: [String: (imagery: Imagery, fields: [String: JSONValue], group: ImageryListing.Group, satellites: [String: ImageryListing.Satellite], start: String?)] = [:]
        var compositeOrder: [String] = []
        for record in records {
            let group: ImageryListing.Group = record.orbitClass == .geo ? .geo : .leo
            let satellite = ImageryListing.Satellite(id: Catalog.id(of: record), name: record.name)
            for entry in record.metadata["imagery"]?.array ?? [] {
                guard let found = imagery(entry), let preview = found.imagery.preview, preview.end == nil else {
                    continue
                }
                let token = preview.token
                if found.fields["merged"] == .bool(true) {
                    if composites[token] == nil {
                        composites[token] = (found.imagery, found.fields, group, [:], nil)
                        compositeOrder.append(token)
                    }
                    composites[token]?.satellites[record.satnum] = satellite
                    if let start = found.fields["start"]?.string, composites[token]?.start.map({ start < $0 }) ?? true {
                        composites[token]?.start = start
                    }
                    continue
                }
                let key = "\(record.satnum):\(token)"
                guard listings[key] == nil else {
                    continue
                }
                listings[key] = ImageryListing(
                    key: key, kind: .satellite(satellite, instrument: found.instrument), imagery: found.imagery,
                    product: shortImageryLabel(found.imagery.label), token: token, group: group)
            }
        }
        let byName = { (a: String, b: String) in a.localizedStandardCompare(b) }
        let compositeListings = compositeOrder.compactMap { token -> ImageryListing? in
            guard let composite = composites[token] else {
                return nil
            }
            var imagery = composite.imagery
            var fields = composite.fields.filter { ["period", "window"].contains($0.key) }
            fields["start"] = composite.start.map(JSONValue.string)
            imagery.detail = imageryDetail(fields)
            let period = composite.fields["period"]?.string
            return ImageryListing(
                key: token,
                kind: .composite(
                    name: compositeName(imagery.label), satellites: composite.satellites.values.sorted { byName($0.name, $1.name) == .orderedAscending },
                    cadence: period.flatMap { cadence($0, short: true) }),
                imagery: imagery, product: shortImageryLabel(imagery.label), token: token, group: composite.group)
        }
        let ordered = { (a: ImageryListing, b: ImageryListing, name: (ImageryListing) -> String) in
            switch byName(name(a), name(b)) {
            case .orderedAscending: true
            case .orderedDescending: false
            case .orderedSame: byName(a.imagery.label, b.imagery.label) == .orderedAscending
            }
        }
        return compositeListings.sorted { ordered($0, $1, \.name) } + listings.values.sorted { ordered($0, $1, \.name) }
    }

    /// The name a Map panel row gives a composite where its label has no qualifier.
    public static let composite = "Composite"

    /// "Natural colour, Geostationary Ring" is "Geostationary Ring": a composite's Map panel row stands for no
    /// one satellite.
    static func compositeName(_ label: String) -> String {
        let qualifier = label.split(separator: ",", omittingEmptySubsequences: false).dropFirst().joined(separator: ",").trimmingCharacters(in: .whitespaces)
        return qualifier.isEmpty ? composite : qualifier.prefix(1).uppercased() + qualifier.dropFirst()
    }

    /// What a picture is, short enough for a Map panel row beside the satellite and the
    /// instrument, as the web app's `shortImageryLabel`: "True colour, one swath per
    /// orbit" is "True", "Natural colour and fog" is "Natural + fog", "GeoColor" stays.
    public static func shortImageryLabel(_ label: String) -> String {
        let short = String(label.prefix { $0 != "," })
            .replacing(/(?i)\s*\bcolou?r\b/, with: "")
            .replacing(/\s+and\s+/, with: " + ")
            .trimmingCharacters(in: .whitespaces)
        return short.isEmpty ? label : short
    }

    /// The web app's `drawnImagery`, as a preview: nil for another provider's layer, one
    /// without `maxLevel` and `format`, or a GIBS layer whose period does not say how its
    /// frames are named.
    private static func preview(_ fields: [String: JSONValue], provider: String, layer: String, end: String?) -> ImageryPreview? {
        guard let provider = ImageryPreview.Provider(rawValue: provider), let maxLevel = fields["maxLevel"]?.number, maxLevel.isFinite,
            maxLevel.rounded() == maxLevel, let format = fields["format"]?.string.flatMap(ImageryPreview.Format.init)
        else {
            return nil
        }
        let period = fields["period"]?.string
        let isDaily = period == "P1D"
        if provider == .gibs, !isDaily, period?.hasPrefix("PT") != true {
            return nil
        }
        return ImageryPreview(provider: provider, layer: layer, maxLevel: Int(maxLevel), format: format, isDaily: isDaily, end: end)
    }

    /// Pixels; twice the web card's size, for a Retina screen.
    public static let previewWidth = 480.0
    public static let previewHeight = 270.0

    /// Where an Imagery tab picture is, in degrees: the web app's `PreviewBounds`.
    public struct PreviewBounds: Sendable, Hashable {
        public var west: Double
        public var south: Double
        public var east: Double
        public var north: Double

        public init(west: Double, south: Double, east: Double, north: Double) {
            self.west = west
            self.south = south
            self.east = east
            self.north = north
        }
    }

    /// `halfWidthDeg` either side of the centre, as tall as the picture's shape makes it:
    /// the web app's `previewBounds`. The centre stays within 50° of the equator, where
    /// a polar orbiter's would show only ice and the map's edge.
    public static func previewBounds(latitude: Double, longitude: Double, halfWidthDeg: Double) -> PreviewBounds {
        let halfHeight = (halfWidthDeg * previewHeight) / previewWidth
        let latitude = max(-50, min(50, latitude))
        return PreviewBounds(west: longitude - halfWidthDeg, south: latitude - halfHeight, east: longitude + halfWidthDeg, north: latitude + halfHeight)
    }

    /// A layer's latest frame in `previewBounds`, as one WMS picture, the web app's
    /// `imageryPreviewUrl`. A stopped layer shows its last frame, a daily GIBS one
    /// yesterday's, as today's is still filling in. `now` is the wall clock, in
    /// milliseconds since 1970. Not for the geostationary mosaic, which has no WMS: its
    /// picture is made from its file.
    public static func imageryPreviewUrl(_ preview: ImageryPreview, latitude: Double, longitude: Double, halfWidthDeg: Double, now: Double) -> String {
        let bounds = previewBounds(latitude: latitude, longitude: longitude, halfWidthDeg: halfWidthDeg)
        let bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map { toFixed($0, 2) }.joined(separator: ",")
        var query: [(String, String)] = [
            ("SERVICE", "WMS"), ("REQUEST", "GetMap"), ("VERSION", "1.1.1"), ("SRS", "EPSG:4326"), ("STYLES", ""), ("LAYERS", preview.layer),
            ("WIDTH", String(Int(previewWidth))), ("HEIGHT", String(Int(previewHeight))), ("BBOX", bbox),
        ]
        if preview.provider == .eumetview {
            // Transparent, or the night side of a true colour disc comes back white.
            query += [("FORMAT", "image/png"), ("TRANSPARENT", "TRUE")]
            return "https://view.eumetsat.int/geoserver/ows?\(formEncoded(query))"
        }
        query.append(("FORMAT", "image/\(preview.format.rawValue)"))
        if let time = preview.end ?? (preview.isDaily ? isoDate(epochMilliseconds: now - msPerDay) : nil) {
            query.append(("TIME", time))
        }
        return "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?\(formEncoded(query))"
    }

    /// What `URLSearchParams` leaves as it is.
    private static let formUnreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._ ")

    /// A query as `URLSearchParams` writes it: a space as "+", the rest of what is not
    /// `formUnreserved` percent-encoded.
    private static func formEncoded(_ query: [(String, String)]) -> String {
        let encode = { (text: String) in (text.addingPercentEncoding(withAllowedCharacters: formUnreserved) ?? text).replacingOccurrences(of: " ", with: "+") }
        return query.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
    }

    /// The UTC date of an instant, "2026-11-11", as `toISOString().slice(0, 10)`.
    private static func isoDate(epochMilliseconds: Double) -> String {
        let utc = civilDate(epochMilliseconds: epochMilliseconds)
        return "\(utc.year)-\(two(utc.month))-\(two(utc.day))"
    }

    /// When a layer has frames, and of what, as the web app's `imageryDetail` words it:
    /// "daily since 2018", "every 10 min, last 90 days".
    static func imageryDetail(_ fields: [String: JSONValue]) -> String? {
        let start = fields["start"]?.string
        let end = fields["end"]?.string
        let year = { (date: String) in String(date.prefix(4)) }
        var history: String?
        // An ended layer's window only runs out: what is left of it is not "the last 90 days".
        if let start, let end {
            history = year(start) == year(end) ? year(end) : "\(year(start))–\(year(end))"
        } else if let end {
            history = "until \(year(end))"
        } else if let window = fields["window"]?.string, let days = count(window, prefix: "P", unit: "D") {
            history = "last \(days) days"
        } else if let start {
            history = "since \(year(start))"
        }
        let step = fields["period"]?.string.flatMap { cadence($0) }
        let when = if let step, let history, history.hasPrefix("since") { ["\(step) \(history)"] } else { [step, history] }
        let parts = (when + [fields["merged"] == .bool(true) ? "with other satellites" : nil]).compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The digits of an ISO 8601 duration of one unit: "90" of "P90D". Nil for any other.
    private static func count(_ duration: String, prefix: String, unit: Character) -> Substring? {
        guard duration.hasPrefix(prefix), duration.last == unit else {
            return nil
        }
        let digits = duration.dropFirst(prefix.count).dropLast()
        return !digits.isEmpty && digits.allSatisfy { ("0"..."9").contains($0) } ? digits : nil
    }

    /// "daily", "hourly", "every 3 h", "every 10 min": the periods the manifest has, or
    /// `short`, for a Map panel row, "3-hourly" and "10 min". Nil for any other.
    private static func cadence(_ period: String, short: Bool = false) -> String? {
        if period == "P1D" {
            return "daily"
        }
        if period == "PT1H" {
            return "hourly"
        }
        if let minutes = count(period, prefix: "PT", unit: "M").flatMap({ Int($0) }) {
            return short ? "\(minutes) min" : "every \(minutes) min"
        }
        return count(period, prefix: "PT", unit: "H").flatMap { Int($0) }.map { short ? "\($0)-hourly" : "every \($0) h" }
    }
}
