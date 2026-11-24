import Foundation

/// A satellite's instrument imagery (ADR 0019 to 0024): the layers its record carries,
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
        /// The layer as a link and the drawn list name it, where the globe can draw it.
        public var token: String?
        /// The tiles the globe draws it from, frame by frame; nil for a granule layer, whose
        /// granules the globe draws one by one.
        public var tiles: ImageryPreview?
        /// What a card's picture of it needs, where its provider answers for one: its
        /// own frames, or those its granules are cut from.
        public var preview: ImageryPreview?
        /// The layer itself, where it is one of granules: the recorded swath (ADR 0023).
        public var granuleLayer: GranuleLayer?
        /// What kind of layer it is, a card's title (ADR 0024).
        public var type: ImageryType
        /// What the Imagery tab and the Map panel say of it.
        public var words: ImageryWords
    }

    /// A layer the globe draws from a provider's tiles, the web app's `TiledImagery`, and
    /// what the Imagery tab needs to ask a provider for a picture, its `ImageryPreview`.
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
        /// A granule layer's pictures, which name the frame of a granule.
        public var pictures: GranulePictures?

        public init(provider: Provider, layer: String, maxLevel: Int, format: Format, isDaily: Bool, end: String? = nil, pictures: GranulePictures? = nil) {
            self.provider = provider
            self.layer = layer
            self.maxLevel = maxLevel
            self.format = format
            self.isDaily = isDaily
            self.end = end
            self.pictures = pictures
        }

        /// The layer as a link and the drawn list name it, `gibs:GOES-East_ABI_GeoColor`:
        /// the layer's, not an instrument's, so a layer two satellites share is one.
        public var token: String { "\(provider.rawValue):\(layer)" }
    }

    /// Where a granule layer's pictures come from, and how the frame holding a granule is
    /// named (ADR 0023): the web app's `GranulePictures`.
    public struct GranulePictures: Sendable, Hashable {
        public enum Provider: String, Sendable {
            case gibs, eumetview
        }

        /// A frame a granule, named by its start (GIBS's granule layers); a frame a UTC
        /// day; or stamped nearest this many milliseconds after a granule's start
        /// (EUMETView's swaths and orbits).
        public enum Frame: Sendable, Hashable {
            case granule
            case day
            case after(Double)
        }

        public var provider: Provider
        public var layer: String
        public var frame: Frame

        public init(provider: Provider, layer: String, frame: Frame) {
            self.provider = provider
            self.layer = layer
            self.frame = frame
        }
    }

    /// A layer the globe draws granule by granule (ADR 0023): a GIBS layer of a granule a
    /// frame, a EUMETView one of a swath an orbit, each granule cut from it, or a `cmr` one
    /// of outlines, with or without pictures cut from another layer. The web app's `GranuleLayer`.
    public struct GranuleLayer: Sendable, Hashable {
        public enum Provider: String, Sendable {
            case gibs, eumetview, cmr
        }

        /// `provider:layer`, which names it in a link.
        public var token: String
        public var provider: Provider
        public var layer: String
        /// The collections that list its granules, CMR's concept ids or one of EUMETSAT's
        /// Data Store, the preferred one first.
        public var granules: [String]
        /// The satellite's name in a collection that lists several.
        public var platform: String?
        /// Its pictures, its own frames or another layer's; nil for outlines alone.
        public var pictures: GranulePictures?
        /// A GIBS granule layer's tiles, whose level-0 tile says whether it has a granule.
        public var maxLevel: Int?
        public var format: ImageryPreview.Format?

        public init(
            token: String, provider: Provider, layer: String, granules: [String], platform: String? = nil, pictures: GranulePictures? = nil, maxLevel: Int? = nil,
            format: ImageryPreview.Format? = nil
        ) {
            self.token = token
            self.provider = provider
            self.layer = layer
            self.granules = granules
            self.platform = platform
            self.pictures = pictures
            self.maxLevel = maxLevel
            self.format = format
        }
    }

    /// What a layer shows, named for what a user sees rather than how it is made (ADR 0024).
    public enum ImageryType: String, Sendable, CaseIterable {
        /// A granule layer, each pass drawn behind the satellite as the clock runs, hours to
        /// days behind live.
        case passes
        /// A day's passes in one picture.
        case daily
        /// The last few orbits stacked in one picture (Metop's).
        case orbits
        /// A geostationary imager's picture every few minutes.
        case live
        /// A composite the globe draws, several satellites' pictures in one.
        case mosaic
        /// A composite only its provider's viewer shows, scene by scene.
        case scenes

        /// A card's title.
        public var title: String {
            switch self {
            case .passes: "Passes"
            case .daily: "Daily mosaic"
            case .orbits: "Latest orbits"
            case .live: "Live view"
            case .mosaic: "World mosaic"
            case .scenes: "Scene archive"
            }
        }

        /// A Map panel button's name.
        public var short: String {
            switch self {
            case .passes: "Passes"
            case .daily: "Daily"
            case .orbits: "Orbits"
            case .live: "Live"
            case .mosaic: "World"
            case .scenes: "Scenes"
            }
        }

        /// The order of a row's buttons: what shows at once first, the passes, which may
        /// not, last.
        static let order: [ImageryType] = [.daily, .orbits, .live, .mosaic, .scenes, .passes]
    }

    /// A layer in words, one question a slot, the same for every layer (ADR 0024).
    public struct ImageryWords: Sendable, Hashable {
        /// What the picture is: its colours, then the instrument. "True colour · MODIS".
        public var picture: String
        /// How often it has a new picture, or the day it ended. "Once a day", "Every 10 min".
        public var updates: String?
        /// It has ended: `updates` says when.
        public var ended: Bool
        /// How far back its frames go: "Back to 2002", "The last 90 days", "2017–2022".
        public var archive: String?
        /// Where a passes layer's pictures are cut from, where that frame holds other
        /// passes: "Cropped from the daily mosaic".
        public var cropped: String?
    }

    /// The layers of a record the globe can draw, its tiles' or its granules', in the
    /// record's order.
    public static func drawableImagery(_ record: GPRecord) -> [Imagery] {
        (record.metadata["imagery"]?.array ?? []).compactMap { imagery($0)?.imagery }.filter { $0.token != nil }
    }

    /// The record whose own granule layer `token` is, and the layer; nil for a composite's,
    /// which is no one satellite's, or a token of another layer: the web app's
    /// `granuleLayerOwner`.
    public static func granuleLayerOwner(_ records: some Sequence<GPRecord>, token: String) -> (record: GPRecord, layer: GranuleLayer, instrument: String)? {
        for record in records {
            for entry in record.metadata["imagery"]?.array ?? [] {
                guard let found = imagery(entry), found.fields["merged"] != .bool(true), found.imagery.token == token else {
                    continue
                }
                return found.imagery.granuleLayer.map { (record, $0, found.instrument) }
            }
        }
        return nil
    }

    /// The granule layers of a record's own instruments, not of composites it is merged into.
    public static func ownGranuleLayers(_ record: GPRecord) -> [GranuleLayer] {
        (record.metadata["imagery"]?.array ?? []).compactMap { entry in
            imagery(entry).flatMap { $0.fields["merged"] == .bool(true) ? nil : $0.imagery.granuleLayer }
        }
    }

    /// Nil for an entry without the fields a link needs, of a provider this app does not
    /// know, or one it can neither link to nor draw: the web app's `readImagery`.
    static func imagery(_ entry: JSONValue) -> (instrument: String, imagery: Imagery, fields: [String: JSONValue])? {
        guard case .object(let fields) = entry, let instrument = fields["instrument"]?.string, let provider = fields["provider"]?.string,
            let layer = fields["layer"]?.string, let label = fields["label"]?.string, let known = WebTables.shared.imageryProviders[provider]
        else {
            return nil
        }
        let end = fields["end"]?.string
        let href = known.href(layer: layer, end: end)
        let drawn = drawn(fields, provider: provider, layer: layer, end: end)
        guard href != nil || drawn != nil else {
            return nil
        }
        let merged = fields["merged"] == .bool(true)
        let type = imageryType(label: label, period: fields["period"]?.string, merged: merged, drawn: drawn != nil, granules: drawn?.granules != nil)
        let words = imageryWords(
            type: type, provider: provider, instrument: instrument, label: label, period: fields["period"]?.string, start: fields["start"]?.string, end: end,
            window: fields["window"]?.string, merged: merged, pictures: drawn?.granules?.pictures)
        let pictures = drawn?.granules?.pictures
        var preview = drawn?.tiles
        preview?.pictures = pictures
        if let pictures, pictures.frame != .granule {
            // Cut from another layer's frames: its frame of the newest granule.
            preview = ImageryPreview(
                provider: pictures.provider == .gibs ? .gibs : .eumetview, layer: pictures.layer, maxLevel: 0, format: .jpeg, isDaily: pictures.frame == .day, end: nil,
                pictures: pictures)
        }
        return (
            instrument,
            Imagery(
                key: "\(provider):\(layer)", label: label, detail: imageryDetail(fields), viewer: href == nil ? nil : known.viewer, href: href, token: drawn?.token,
                tiles: drawn?.granules == nil ? drawn?.tiles : nil, preview: preview, granuleLayer: drawn?.granules, type: type, words: words),
            fields
        )
    }

    /// What the globe needs to draw an entry, the web app's `drawnImagery`: nil for
    /// another provider's, one without `maxLevel` and `format`, a GIBS layer whose period
    /// does not say how its frames are named, or a `cmr` one without collections.
    private static func drawn(_ fields: [String: JSONValue], provider: String, layer: String, end: String?) -> (
        token: String, tiles: ImageryPreview?, granules: GranuleLayer?
    )? {
        let platform = fields["platform"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        let collections = (fields["granules"]?.array ?? []).compactMap { $0.string.flatMap { $0.isEmpty ? nil : $0 } }
        if provider == "cmr" {
            guard !collections.isEmpty else {
                return nil
            }
            let token = "cmr:\(layer)"
            let granules = GranuleLayer(token: token, provider: .cmr, layer: layer, granules: collections, platform: platform, pictures: pictures(fields["pictures"]))
            return (token, nil, granules)
        }
        guard let drawing = ImageryPreview.Provider(rawValue: provider), let maxLevel = fields["maxLevel"]?.number, maxLevel.isFinite,
            maxLevel.rounded() == maxLevel, let format = fields["format"]?.string.flatMap(ImageryPreview.Format.init)
        else {
            return nil
        }
        let period = fields["period"]?.string
        let isDaily = period == "P1D"
        if drawing == .gibs, !isDaily, period?.hasPrefix("PT") != true {
            return nil
        }
        let tiles = ImageryPreview(provider: drawing, layer: layer, maxLevel: Int(maxLevel), format: format, isDaily: isDaily, end: end)
        // A GIBS granule layer has a frame a granule; a EUMETView one says when its frame of a granule is stamped.
        let own: GranulePictures? =
            switch drawing {
            case .gibs: GranulePictures(provider: .gibs, layer: layer, frame: .granule)
            case .eumetview:
                (fields["frame"]?.string).flatMap(frame).flatMap { if case .after = $0 { GranulePictures(provider: .eumetview, layer: layer, frame: $0) } else { nil } }
            case .georing: nil
            }
        guard let own, period?.hasPrefix("PT") == true, !collections.isEmpty else {
            return (tiles.token, tiles, nil)
        }
        let granules = GranuleLayer(
            token: tiles.token, provider: drawing == .gibs ? .gibs : .eumetview, layer: layer, granules: collections, platform: platform, pictures: own,
            maxLevel: Int(maxLevel), format: format)
        return (tiles.token, tiles, granules)
    }

    /// "day", or a duration, of an entry's `frame`; nil for another.
    private static func frame(_ text: String) -> GranulePictures.Frame? {
        text == "day" ? .day : TimeDomain.duration(text).map { .after($0) }
    }

    /// A `cmr` entry's `pictures`, or nil where they do not read.
    private static func pictures(_ value: JSONValue?) -> GranulePictures? {
        guard case .object(let fields) = value, let provider = fields["provider"]?.string.flatMap(GranulePictures.Provider.init),
            let layer = fields["layer"]?.string, let frame = fields["frame"]?.string.flatMap(frame)
        else {
            return nil
        }
        return GranulePictures(provider: provider, layer: layer, frame: frame)
    }

    /// An entry's type, the web app's `imageryType`. Only Metop's stacked orbits say so in
    /// their label: the manifest gives them no period, as a frame holds several.
    static func imageryType(label: String, period: String?, merged: Bool, drawn: Bool, granules: Bool) -> ImageryType {
        if granules {
            return .passes
        }
        if merged {
            return drawn ? .mosaic : .scenes
        }
        if label.firstMatch(of: /(?i)\borbits\b/) != nil {
            return .orbits
        }
        return period == "P1D" ? .daily : .live
    }

    /// The words for an entry, the web app's `imageryWords`. The label's qualifier stays in
    /// the picture where it says something of it ("nadir camera", "Europe"), not where the
    /// type's title says it already: Metop's "six orbits stacked", a composite's "GeoRing".
    static func imageryWords(
        type: ImageryType, provider: String, instrument: String, label: String, period: String?, start: String?, end: String?, window: String?, merged: Bool,
        pictures: GranulePictures?
    ) -> ImageryWords {
        let parts = label.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        let colours = (parts.first ?? label).replacing(/\s+and\s+/, with: " + ")
        let qualifier = [.orbits, .mosaic, .scenes].contains(type) ? "" : parts.dropFirst().joined(separator: ", ")
        let maker = WebTables.shared.imageryProviders[provider]?.maker
        // A composite is no one instrument's: it says who joined the satellites' pictures.
        let source = !merged ? instrument : maker.map { "by \($0)" } ?? "\(instrument) and others"
        let picture = "\(colours)\(qualifier.isEmpty ? "" : " (\(qualifier))") · \(source)"
        let every = period.flatMap { cadence($0) }
        let typeUpdates: String? =
            switch type {
            case .passes: "With each pass, hours behind live"
            case .daily: "Once a day"
            case .orbits: "With each orbit"
            case .scenes: "As new scenes come in"
            case .live, .mosaic: nil
            }
        let updates = end.map { "Ended \(Formats.date($0))" } ?? typeUpdates ?? every.map { $0.prefix(1).uppercased() + $0.dropFirst() }
        let year = { (date: String) in String(date.prefix(4)) }
        let archive: String? =
            if let start, let end {
                year(start) == year(end) ? year(end) : "\(year(start))–\(year(end))"
            } else if end != nil {
                nil
            } else if let days = window.flatMap({ count($0, prefix: "P", unit: "D") }) {
                "The last \(days) days"
            } else if let start {
                "Back to \(year(start))"
            } else {
                nil
            }
        // A `cmr` layer's EUMETView frames are another layer's, Metop's orbits stacked; a
        // EUMETView layer's own are a pass each (Sentinel-3's swaths), as a GIBS granule
        // layer's are a granule.
        let cropped: String? =
            switch pictures?.frame {
            case .day: "Cropped from the daily mosaic"
            case .after where provider == "cmr": "Cropped from the latest orbits"
            default: nil
            }
        return ImageryWords(picture: picture, updates: updates, ended: end != nil, archive: archive, cropped: cropped)
    }

    /// A layer the globe can draw, as the Map panel lists it (ADR 0021, 0024): one
    /// satellite's, or a composite of several, once. The web app's `ImageryLayer`.
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
            /// Its satellites sorted by name.
            case composite(satellites: [Satellite])
        }

        /// Unique in the list: catalog number, provider and layer, or a composite's
        /// provider and layer.
        public var key: String
        public var kind: Kind
        /// The layer as the record's entry has it; a composite's `detail` from its
        /// earliest satellite's start.
        public var imagery: Imagery
        /// Its token on the globe.
        public var token: String
        public var group: Group

        public var type: ImageryType { imagery.type }
        public var words: ImageryWords { imagery.words }
        public var label: String { imagery.label }

        /// The satellite's name, or the composite's type.
        public var name: String {
            switch kind {
            case .satellite(let satellite, _): satellite.name
            case .composite: imagery.type.title
            }
        }

        public var instrument: String? {
            if case .satellite(_, let instrument) = kind { instrument } else { nil }
        }
    }

    /// Every layer `records` carry that the globe can draw and that has not stopped, once
    /// per satellite, provider and layer: the composites first, by label, then by
    /// satellite name, then label. A composite is one layer, in its first satellite's
    /// group. The web app's `imageryLayers`. A viewer link alone, or a layer that
    /// stopped, is the satellite's Imagery tab's to offer.
    public static func imageryListings(_ records: some Sequence<GPRecord>) -> [ImageryListing] {
        var listings: [String: ImageryListing] = [:]
        var listingOrder: [String] = []
        // A composite's first entry and group, its satellites by catalog number, as a
        // record may be in several groups, and its earliest start.
        var composites: [String: (imagery: Imagery, fields: [String: JSONValue], group: ImageryListing.Group, satellites: [String: ImageryListing.Satellite], start: String?)] = [:]
        var compositeOrder: [String] = []
        for record in records {
            let group: ImageryListing.Group = record.orbitClass == .geo ? .geo : .leo
            let satellite = ImageryListing.Satellite(id: Catalog.id(of: record), name: record.name)
            for entry in record.metadata["imagery"]?.array ?? [] {
                guard let found = imagery(entry), let token = found.imagery.token, found.fields["end"]?.string == nil else {
                    continue
                }
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
                listings[key] = ImageryListing(key: key, kind: .satellite(satellite, instrument: found.instrument), imagery: found.imagery, token: token, group: group)
                listingOrder.append(key)
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
            return ImageryListing(
                key: token, kind: .composite(satellites: composite.satellites.values.sorted { byName($0.name, $1.name) == .orderedAscending }), imagery: imagery,
                token: token, group: composite.group)
        }
        let ordered = { (a: ImageryListing, b: ImageryListing) in
            switch byName(a.name, b.name) {
            case .orderedAscending: true
            case .orderedDescending: false
            case .orderedSame: a.label.localizedCompare(b.label) == .orderedAscending
            }
        }
        // Stable, as the web's: a satellite's layers of one label stay in the record's order.
        return stableSorted(compositeListings) { $0.label.localizedCompare($1.label) == .orderedAscending }
            + stableSorted(listingOrder.compactMap { listings[$0] }, by: ordered)
    }

    /// A Map panel row: a satellite, or a group's composites of a type, and a button for
    /// each of its layers (ADR 0024). The web app's `ImageryRow`.
    public struct ImageryRow: Sendable, Hashable, Identifiable {
        /// One layer's button.
        public struct Cell: Sendable, Hashable {
            public var listing: ImageryListing
            /// Its type's short name, a composite's picture ("Day/Night", "Natural"), or for
            /// a satellite's second layer of a type its instrument or colours.
            public var name: String
            /// A satellite's second layer of a type: the row shows it only while it is on,
            /// and the satellite's Imagery tab always.
            public var extra: Bool
        }

        /// Unique in its group: the satellite's name, or `composite:` and the type.
        public var key: String
        /// The satellite's whole name, or a composite row's type ("World mosaic").
        public var name: String
        public var isComposite: Bool
        public var cells: [Cell]

        public var id: String { key }
    }

    /// A group's rows: its composites first, a row a type, then its satellites, in the
    /// order they come. The web app's `imageryRows`.
    public static func imageryRows(_ listings: [ImageryListing]) -> [ImageryRow] {
        var rows: [String: ImageryRow] = [:]
        var order: [String] = []
        for listing in listings {
            let isComposite: Bool
            let key: String
            switch listing.kind {
            case .composite:
                isComposite = true
                key = "composite:\(listing.type.rawValue)"
            case .satellite(let satellite, _):
                isComposite = false
                key = satellite.name
            }
            if rows[key] == nil {
                rows[key] = ImageryRow(key: key, name: isComposite ? listing.type.title : listing.name, isComposite: isComposite, cells: [])
                order.append(key)
            }
            rows[key]?.cells.append(ImageryRow.Cell(listing: listing, name: "", extra: false))
        }
        for key in order {
            guard var row = rows[key] else {
                continue
            }
            // Stable, as the web's `Array.prototype.sort`.
            let rank = { (cell: ImageryRow.Cell) in ImageryType.order.firstIndex(of: cell.listing.type) ?? 0 }
            row.cells = row.cells.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
            for index in row.cells.indices {
                let listing = row.cells[index].listing
                guard let instrument = listing.instrument else {
                    row.cells[index].name = shortImageryLabel(listing.label)
                    continue
                }
                let before = row.cells[..<index].map(\.listing).filter { $0.instrument != nil && $0.type == listing.type }
                let extra = !before.isEmpty
                row.cells[index].extra = extra
                row.cells[index].name =
                    !extra ? listing.type.short : before.contains { $0.instrument == instrument } ? shortImageryLabel(listing.label) : instrument
            }
            rows[key] = row
        }
        let all = order.compactMap { rows[$0] }
        return all.filter(\.isComposite) + all.filter { !$0.isComposite }
    }

    /// What a picture is, short enough for a Map panel button, as the web app's
    /// `shortImageryLabel`: "True colour, one swath per orbit" is "True", "Natural colour
    /// and fog" is "Natural + fog", "GeoColor" stays.
    public static func shortImageryLabel(_ label: String) -> String {
        let short = String(label.prefix { $0 != "," })
            .replacing(/(?i)\s*\bcolou?r\b/, with: "")
            .replacing(/\s+and\s+/, with: " + ")
            .trimmingCharacters(in: .whitespaces)
        return short.isEmpty ? label : short
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

    static let gibsWMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
    static let eumetViewWMS = "https://view.eumetsat.int/geoserver/ows"

    /// A layer's latest frame in `previewBounds`, as one WMS picture, the web app's
    /// `imageryPreviewUrl`; with `granule`, the frame of the granule that starts then
    /// (epoch milliseconds), for a layer with pictures. A stopped layer shows its last
    /// frame, a daily GIBS one yesterday's, as today's is still filling in. `now` is the
    /// wall clock, in milliseconds since 1970. Not for the geostationary mosaic, which
    /// has no WMS: its picture is made from its file.
    public static func imageryPreviewUrl(
        _ preview: ImageryPreview, latitude: Double, longitude: Double, halfWidthDeg: Double, now: Double, granule: Double? = nil
    ) -> String {
        let bounds = previewBounds(latitude: latitude, longitude: longitude, halfWidthDeg: halfWidthDeg)
        let bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map { toFixed($0, 2) }.joined(separator: ",")
        var query: [(String, String)] = [
            ("SERVICE", "WMS"), ("REQUEST", "GetMap"), ("VERSION", "1.1.1"), ("SRS", "EPSG:4326"), ("STYLES", ""), ("LAYERS", preview.layer),
            ("WIDTH", String(Int(previewWidth))), ("HEIGHT", String(Int(previewHeight))), ("BBOX", bbox),
        ]
        let granuleTime = granule.flatMap { start in preview.pictures.map { granuleFrame($0, start: start) } }
        if preview.provider == .eumetview {
            // Transparent, or the night side of a true colour disc comes back white.
            query += [("FORMAT", "image/png"), ("TRANSPARENT", "TRUE")]
            if let granuleTime {
                query.append(("TIME", granuleTime))
            }
            return "\(eumetViewWMS)?\(formEncoded(query))"
        }
        query.append(("FORMAT", "image/\(preview.format.rawValue)"))
        if let time = granuleTime ?? preview.end ?? (preview.isDaily ? isoDate(epochMilliseconds: now - msPerDay) : nil) {
            query.append(("TIME", time))
        }
        return "\(gibsWMS)?\(formEncoded(query))"
    }

    /// The time that names the frame of `pictures` holding the granule that starts at
    /// `start` (epoch milliseconds).
    static func granuleFrame(_ pictures: GranulePictures, start: Double) -> String {
        switch pictures.frame {
        case .day: isoDate(epochMilliseconds: start)
        case .granule: isoSecond(epochMilliseconds: start)
        case .after(let after): isoSecond(epochMilliseconds: start + after)
        }
    }

    /// The frame of the granule that starts at `start` over `bounds`, as one WMS picture
    /// `width` pixels across, in plate carrée, or with `srs` in that projection, the
    /// bounds in its metres: the web app's `granulePictureUrl`. JPEG on black, where it has
    /// no pixels.
    public static func granulePictureUrl(
        _ pictures: GranulePictures, start: Double, bounds: PreviewBounds, width: Int, height: Int, srs: String = "EPSG:4326"
    ) -> String {
        let query: [(String, String)] = [
            ("SERVICE", "WMS"), ("REQUEST", "GetMap"), ("VERSION", "1.1.1"), ("SRS", srs), ("STYLES", ""), ("LAYERS", pictures.layer),
            ("WIDTH", String(width)), ("HEIGHT", String(height)),
            ("BBOX", [bounds.west, bounds.south, bounds.east, bounds.north].map { toFixed($0, 3) }.joined(separator: ",")),
            ("FORMAT", "image/jpeg"), ("BGCOLOR", "0x000000"), ("TIME", granuleFrame(pictures, start: start)),
        ]
        return "\(pictures.provider == .eumetview ? eumetViewWMS : gibsWMS)?\(formEncoded(query))"
    }

    /// What `URLSearchParams` leaves as it is.
    private static let formUnreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._ ")

    /// A query as `URLSearchParams` writes it: a space as "+", the rest of what is not
    /// `formUnreserved` percent-encoded.
    static func formEncoded(_ query: [(String, String)]) -> String {
        let encode = { (text: String) in (text.addingPercentEncoding(withAllowedCharacters: formUnreserved) ?? text).replacingOccurrences(of: " ", with: "+") }
        return query.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
    }

    /// The UTC date of an instant, "2026-11-11", as `toISOString().slice(0, 10)`.
    static func isoDate(epochMilliseconds: Double) -> String {
        let utc = civilDate(epochMilliseconds: epochMilliseconds)
        return "\(utc.year)-\(two(utc.month))-\(two(utc.day))"
    }

    /// An instant to the second, "2026-11-11T03:04:05Z", as `toISOString()` cut there.
    static func isoSecond(epochMilliseconds: Double) -> String {
        let utc = civilDate(epochMilliseconds: epochMilliseconds)
        return "\(utc.year)-\(two(utc.month))-\(two(utc.day))T\(two(utc.hour)):\(two(utc.minute)):\(two(utc.second))Z"
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

    /// "daily", "hourly", "every 3 h", "every 10 min": the periods the manifest has. Nil
    /// for any other.
    private static func cadence(_ period: String) -> String? {
        if period == "P1D" {
            return "daily"
        }
        if period == "PT1H" {
            return "hourly"
        }
        if let minutes = count(period, prefix: "PT", unit: "M").flatMap({ Int($0) }) {
            return "every \(minutes) min"
        }
        return count(period, prefix: "PT", unit: "H").flatMap { Int($0) }.map { "every \($0) h" }
    }
}
