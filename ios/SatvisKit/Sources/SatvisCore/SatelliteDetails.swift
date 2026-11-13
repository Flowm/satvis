import Foundation

/// The tables the native app reads from the web app rather than keeping its own:
/// SATCAT and GCAT code labels, the external links, the imagery providers and the
/// bookmark tables (Shared/web-tables.json, written by scripts/parity/generate.mjs).
public struct WebTables: Sendable, Decodable {
    public struct Satcat: Sendable, Decodable {
        public var launchSite: [String: String]
        public var opsStatus: [String: String]
        public var orbitType: [String: String]
    }

    /// GCAT's payload codes (src/config/gcatCodes.ts).
    public struct Gcat: Sendable, Decodable {
        public var category: [String: String]
        public var `class`: [String: String]

        /// "IMG/TECH" as "Imaging / Technology". GCAT appends "?" to an uncertain
        /// category, kept, and "*" to one whose orbit the US keeps secret, dropped.
        public func categoryLabel(_ code: String) -> String {
            code.split(separator: "/", omittingEmptySubsequences: false).map { part in
                // Both marks can follow one code, "?" first: "SIG?*".
                let bare = String(part.reversed().drop { $0 == "?" || $0 == "*" }.reversed())
                return (category[bare] ?? bare) + (part.contains("?") ? "?" : "")
            }.joined(separator: " / ")
        }

        /// "BD" as "Commercial / Military"; a letter it does not know stays a letter.
        public func classLabel(_ code: String) -> String {
            code.map { self.class[String($0)] ?? String($0) }.joined(separator: " / ")
        }
    }

    public struct Link: Sendable, Decodable, Hashable {
        public var label: String
        public var title: String
        /// `{satnum}` stands where the catalog number goes.
        public var href: String

        public func url(satnum: String) -> URL? {
            URL(string: href.replacingOccurrences(of: "{satnum}", with: satnum))
        }
    }

    /// An imagery provider (src/config/instrumentImagery.ts): the service that holds
    /// layers showing an instrument, and its own viewer for them.
    public struct ImageryProvider: Sendable, Decodable {
        /// The viewer a link opens, as the panel names it.
        public var viewer: String
        /// `{layer}` stands where the layer's id goes.
        public var link: String
        /// Appended for a layer that stopped, `{end}` its last frame's date.
        public var ended: String?

        /// What JavaScript's `encodeURIComponent` leaves as it is.
        private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

        /// The layer in the viewer, as the web app's `imageryLink` writes it: the colon
        /// of EUMETView's `workspace:layer` stays.
        public func href(layer: String, end: String?) -> String {
            let encoded = layer.addingPercentEncoding(withAllowedCharacters: Self.unreserved.union(CharacterSet(charactersIn: ":"))) ?? layer
            let link = self.link.replacingOccurrences(of: "{layer}", with: encoded)
            guard let end, let ended else {
                return link
            }
            return link + ended.replacingOccurrences(of: "{end}", with: end.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? end)
        }
    }

    /// A column of the Instruments tab's band strip (src/config/wavebands.ts).
    public struct WavebandColumn: Sendable, Decodable, Hashable {
        /// CEOS's abbreviation, or "Radar" for the column every radar band shares.
        public var label: String
        /// "#rrggbb".
        public var colour: String
    }

    /// The url parameters the web app's stores own, which a bookmark keeps.
    public struct BookmarkTables: Sendable, Decodable {
        public var ownedParams: [String]
    }

    public var satcat: Satcat
    public var gcat: Gcat
    public var externalLinks: [Link]
    /// By the name a record's `imagery` entry carries.
    public var imageryProviders: [String: ImageryProvider]
    /// CEOS's waveband classes, shortest wavelength first, then microwave and radar.
    public var wavebandColumns: [WavebandColumn]
    public var bookmarks: BookmarkTables

    /// A colour per column, where `bands` fill it, the web app's `wavebandCells`: every
    /// radar band ("Ku-Band") fills the one Radar column, and a class CEOS adds later none.
    public func wavebandCells(_ bands: [String]) -> [String?] {
        let filled = Set(bands.map { $0.hasSuffix("-Band") ? "Radar" : $0 })
        return wavebandColumns.map { filled.contains($0.label) ? $0.colour : nil }
    }

    public static let shared: WebTables = {
        let url = Bundle.module.url(forResource: "web-tables", withExtension: "json", subdirectory: "Shared")!
        return try! JSONDecoder().decode(WebTables.self, from: Data(contentsOf: url))
    }()
}

/// What the info panel's header and its Orbit, Spacecraft and Instruments tabs say
/// about a satellite, as the web app's `getSatelliteInfo` and `getElementsInfo` say it
/// (src/modules/util/entityInfo.ts).
public enum SatelliteDetails {
    /// The Orbit tab's rows: the regime, then what the element set gives.
    public static func orbitFacts(_ record: GPRecord, propagator: SGP4Propagator?) -> [(String, String)] {
        let orbit = propagator.map(OrbitFacts.init)
        return [("Orbit", regime(record, orbit))] + (orbit?.rows ?? [])
    }

    /// The Spacecraft tab's rows: curated, GCAT and SATCAT facts, only those the record carries.
    public static func spacecraftFacts(_ record: GPRecord, tables: WebTables = .shared) -> [(String, String)] {
        var rows: [(String, String)] = []
        let metadata = record.metadata
        func label(_ table: [String: String], _ key: String) -> String? {
            metadata[key]?.string.map { table[$0] ?? $0 }
        }
        if let starboard = metadata["swathStarboardKm"]?.number, let port = metadata["swathPortKm"]?.number {
            let km = { Formats.number($0) }
            rows.append(("Swath", starboard == port ? "\(km(starboard + port)) km" : "\(km(starboard + port)) km (\(km(starboard)) stbd / \(km(port)) port)"))
        }
        if let fov = metadata["coneFovDeg"]?.number {
            rows.append(("Sensor FOV", "\(Formats.number(fov))°"))
        }
        if let mission = metadata["missionType"]?.string {
            rows.append(("Mission", mission))
        }
        if let country = metadata["country"]?.string {
            rows.append(("Country", country))
        }
        if let operatorName = metadata["operator"]?.string {
            rows.append(("Operator", operatorName))
        }
        if let category = metadata["category"]?.string {
            rows.append(("Purpose", tables.gcat.categoryLabel(category)))
        }
        if let ownerClass = metadata["class"]?.string {
            rows.append(("Class", tables.gcat.classLabel(ownerClass)))
        }
        if let manufacturer = metadata["manufacturer"]?.string {
            rows.append(("Manufacturer", manufacturer))
        }
        if let bus = metadata["bus"]?.string {
            rows.append(("Bus", bus))
        }
        if let mass = metadata["massKg"]?.number {
            rows.append(("Mass", "\(approximate(metadata, "massKg", Formats.measure(mass))) kg"))
        }
        if let size = size(metadata) {
            rows.append(("Size", size))
        }
        if let launchDate = metadata["launchDate"]?.string {
            rows.append(("Launched", label(tables.satcat.launchSite, "launchSite").map { "\(launchDate) · \($0)" } ?? launchDate))
        }
        if let status = label(tables.satcat.opsStatus, "opsStatus") {
            rows.append(("Status", status))
        }
        if let orbitType = metadata["orbitType"]?.string, orbitType != "ORB" {
            rows.append(("Orbit type", tables.satcat.orbitType[orbitType] ?? orbitType))
        }
        if let decay = metadata["decayDate"]?.string {
            rows.append(("Decayed", decay))
        }
        return rows
    }

    /// One layer of an instrument's imagery, the web app's `ImageryInfo`.
    public struct Imagery: Sendable, Hashable {
        /// What the picture is: "True colour".
        public var label: String
        /// When it has frames and of what: "daily since 2018". Nil where the record says nothing.
        public var detail: String?
        /// The provider's viewer, which the link opens: "NASA Worldview".
        public var viewer: String
        public var href: String
        /// What a picture of it needs, for a layer whose provider answers for one.
        public var preview: ImageryPreview?
    }

    /// What the Imagery tab needs to ask the provider for a picture of a layer, the web
    /// app's `ImageryPreview`: one of the layers its globe draws (`drawnImagery`).
    public struct ImageryPreview: Sendable, Hashable {
        /// "gibs" or "eumetview".
        public var provider: String
        public var layer: String
        /// "png" or "jpeg".
        public var format: String
        /// A GIBS layer with a frame a day, which GIBS names by its date.
        public var isDaily: Bool
        /// The last frame's date, of a layer that stopped.
        public var end: String?
    }

    /// One instrument in the Instruments tab, the web app's `InstrumentInfo`.
    public struct Instrument: Sendable {
        public var name: String
        /// Under the name; nil where CEOS has none beyond it.
        public var fullName: String?
        /// Its mission is over; the panel says so beside the name.
        public var isRetired: Bool
        /// Kind, Bands, Resolution and Nominal swath, those CEOS gives.
        public var rows: [(String, String)]
        /// CEOS's waveband classes, as the Bands row names them, for the band strip.
        public var bands: [String]
        /// The layers that show it, its default first, of the providers this app knows. Empty for most.
        public var imagery: [Imagery]
    }

    /// The Instruments tab: the record's `instruments`, CEOS's (ADR 0018), each with the
    /// `imagery` that shows it (ADR 0019). A curated row can give any shape: an entry
    /// without a name is skipped, a field of another type left out.
    public static func instruments(_ record: GPRecord, tables: WebTables = .shared) -> [Instrument] {
        let imagery = (record.metadata["imagery"]?.array ?? []).compactMap { imagery($0, tables: tables) }
        return (record.metadata["instruments"]?.array ?? []).compactMap { instrument in
            guard case .object(let fields) = instrument, let name = fields["name"]?.string else {
                return nil
            }
            var rows: [(String, String)] = []
            if let kind = fields["kind"]?.string {
                rows.append(("Kind", kind))
            }
            let bands = fields["bands"]?.array?.compactMap(\.string) ?? []
            if !bands.isEmpty {
                rows.append(("Bands", bands.joined(separator: " · ")))
            }
            if let metres = fields["resolutionM"]?.number {
                rows.append(("Resolution", metres < 1000 ? "\(Formats.number(metres)) m" : "\(Formats.number(metres / 1000)) km"))
            }
            if let swath = fields["nominalSwathKm"]?.number, record.orbitClass == .leo {
                rows.append(("Nominal swath", "\(Formats.number(swath)) km"))
            }
            return Instrument(
                name: name, fullName: fields["fullName"]?.string, isRetired: fields["retired"] == .bool(true), rows: rows, bands: bands,
                imagery: imagery.filter { $0.instrument == name }.map(\.imagery))
        }
    }

    /// Nil for an entry without the fields a link needs, or of a provider this app does not know.
    private static func imagery(_ entry: JSONValue, tables: WebTables) -> (instrument: String, imagery: Imagery)? {
        guard case .object(let fields) = entry, let instrument = fields["instrument"]?.string, let provider = fields["provider"]?.string,
            let layer = fields["layer"]?.string, let label = fields["label"]?.string, let known = tables.imageryProviders[provider]
        else {
            return nil
        }
        let end = fields["end"]?.string
        return (
            instrument,
            Imagery(
                label: label, detail: imageryDetail(fields), viewer: known.viewer, href: known.href(layer: layer, end: end),
                preview: preview(fields, provider: provider, layer: layer, end: end)
            )
        )
    }

    /// The web app's `drawnImagery`, as a preview: nil for another provider's layer, one
    /// without `maxLevel` and `format`, or a GIBS layer whose period does not say how its
    /// frames are named.
    private static func preview(_ fields: [String: JSONValue], provider: String, layer: String, end: String?) -> ImageryPreview? {
        guard ["gibs", "eumetview"].contains(provider), let maxLevel = fields["maxLevel"]?.number, maxLevel.isFinite, maxLevel.rounded() == maxLevel,
            let format = fields["format"]?.string, format == "png" || format == "jpeg"
        else {
            return nil
        }
        let period = fields["period"]?.string
        let isDaily = period == "P1D"
        if provider == "gibs", !isDaily, period?.hasPrefix("PT") != true {
            return nil
        }
        return ImageryPreview(provider: provider, layer: layer, format: format, isDaily: isDaily, end: end)
    }

    /// Pixels; twice the web card's size, for a Retina screen.
    private static let previewWidth = 480.0
    private static let previewHeight = 270.0

    /// A layer's latest frame, `halfWidthDeg` either side of the centre, as one WMS
    /// picture, the web app's `imageryPreviewUrl`. A stopped layer shows its last frame,
    /// a daily GIBS one yesterday's, as today's is still filling in. The centre stays
    /// within 50° of the equator, where a polar orbiter's would show only ice and the
    /// map's edge. `now` is the wall clock, in milliseconds since 1970.
    public static func imageryPreviewUrl(_ preview: ImageryPreview, latitude: Double, longitude: Double, halfWidthDeg: Double, now: Double) -> String {
        let halfHeight = (halfWidthDeg * previewHeight) / previewWidth
        let latitude = max(-50, min(50, latitude))
        let bbox = [longitude - halfWidthDeg, latitude - halfHeight, longitude + halfWidthDeg, latitude + halfHeight].map { toFixed($0, 2) }.joined(separator: ",")
        var query: [(String, String)] = [
            ("SERVICE", "WMS"), ("REQUEST", "GetMap"), ("VERSION", "1.1.1"), ("SRS", "EPSG:4326"), ("STYLES", ""), ("LAYERS", preview.layer),
            ("WIDTH", String(Int(previewWidth))), ("HEIGHT", String(Int(previewHeight))), ("BBOX", bbox),
        ]
        if preview.provider == "eumetview" {
            // Transparent, or the night side of a true colour disc comes back white.
            query += [("FORMAT", "image/png"), ("TRANSPARENT", "TRUE")]
            return "https://view.eumetsat.int/geoserver/ows?\(formEncoded(query))"
        }
        query.append(("FORMAT", "image/\(preview.format)"))
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
        let step = fields["period"]?.string.flatMap(cadence)
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

    /// "daily", "every 10 min": the periods the manifest has. Nil for any other.
    private static func cadence(_ period: String) -> String? {
        period == "P1D" ? "daily" : count(period, prefix: "PT", unit: "M").flatMap { Int($0) }.map { "every \($0) min" }
    }

    /// GCAT flags most sizes and some masses as estimates (`estimated`); "~" says so.
    private static func approximate(_ metadata: [String: JSONValue], _ key: String, _ text: String) -> String {
        metadata["estimated"]?.array?.contains(.string(key)) == true ? "~\(text)" : text
    }

    /// "12.6 × 4.2 m, span 23.9 m": the body's two dimensions as GCAT gives them,
    /// then the span with arrays and booms.
    private static func size(_ metadata: [String: JSONValue]) -> String? {
        let body = ["lengthM", "diameterM"].compactMap { key in metadata[key]?.number.map { approximate(metadata, key, Formats.number($0)) } }
        var parts = body.isEmpty ? [] : ["\(body.joined(separator: " × ")) m"]
        if let span = metadata["spanM"]?.number {
            parts.append("span \(approximate(metadata, "spanM", Formats.number(span))) m")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// What the panel shows under the name, as the web app's `SatelliteInfo.chips`:
    /// the orbit, then the country where the record has it, then `status`.
    public static func chips(_ record: GPRecord, propagator: SGP4Propagator?, tables: WebTables = .shared) -> [String] {
        [regime(record, propagator.map(OrbitFacts.init)), record.metadata["country"]?.string, status(record, tables: tables)].compactMap { $0 }
    }

    /// The status, unless it is Operational, as most satellites are, or Unknown,
    /// which says nothing. The panel tints its chip.
    public static func status(_ record: GPRecord, tables: WebTables = .shared) -> String? {
        record.metadata["opsStatus"]?.string.flatMap { unremarkableStatus.contains($0) ? nil : $0 }.map { tables.satcat.opsStatus[$0] ?? $0 }
    }

    /// SATCAT's `OPS_STATUS_CODE`s for Operational and Unknown, the web app's `UNREMARKABLE_STATUS`.
    private static let unremarkableStatus: Set<String> = ["+", "?"]

    /// The orbit class, and whether the orbit is Sun-synchronous where it is known.
    private static func regime(_ record: GPRecord, _ orbit: OrbitFacts?) -> String {
        let regime = record.orbitClass.rawValue
        return orbit?.isSunSynchronous == true ? "\(regime) (SSO)" : regime
    }

    public enum Elements: Sendable, Equatable {
        case tle(epoch: String, lines: String)
        case omm(epoch: String, rows: [Row])

        public struct Row: Sendable, Equatable {
            public var label: String
            public var value: String
        }
    }

    /// The element set as served, with its epoch as `YYYY-MM-DD HH:mm:ss` UTC.
    public static func elements(_ record: GPRecord, epochJulianDate: Double) -> Elements {
        let epoch = formatEpoch(julianDate: epochJulianDate)
        switch record.elements {
        case .tle(let line1, let line2):
            return .tle(epoch: epoch, lines: "\(line1)\n\(line2)")
        case .omm(let omm):
            var rows: [Elements.Row] = []
            if let id = omm.objectID {
                rows.append(.init(label: "OBJECT_ID", value: id))
            }
            rows += [
                ("NORAD_CAT_ID", omm.noradCatID), ("INCLINATION", jsNumberString(omm.inclination)), ("RA_OF_ASC_NODE", jsNumberString(omm.raOfAscNode)),
                ("ECCENTRICITY", jsNumberString(omm.eccentricity)), ("ARG_OF_PERICENTER", jsNumberString(omm.argOfPericenter)),
                ("MEAN_ANOMALY", jsNumberString(omm.meanAnomaly)), ("MEAN_MOTION", jsNumberString(omm.meanMotion)), ("BSTAR", jsNumberString(omm.bstar)),
            ].map { Elements.Row(label: $0.0, value: $0.1) }
            return .omm(epoch: epoch, rows: rows)
        }
    }

    /// More than this many days from the epoch, either way, a position may be off
    /// (entityInfo.ts's `STALE_ELEMENTS_DAYS`): only the latest element set is kept.
    private static let staleElementsDays = 10.0

    /// The epoch in UTC milliseconds since 1970, as entityInfo.ts's `epochMs`.
    public static func epochMilliseconds(julianDate: Double) -> Double {
        (julianDate - 2440587.5) * msPerDay
    }

    /// entityInfo.ts's `staleElementsNotice`: nil within `staleElementsDays` of the epoch.
    public static func staleElementsNotice(epochMilliseconds epoch: Double, time: Double) -> String? {
        let offsetDays = (time - epoch) / msPerDay
        guard abs(offsetDays) > staleElementsDays else {
            return nil
        }
        return "Position and passes may be inaccurate, clock \(Formats.integer(Int(abs(offsetDays).rounded()))) days \(offsetDays > 0 ? "after" : "before") element epoch"
    }

    static func formatEpoch(julianDate: Double) -> String {
        let utc = civilDate(epochMilliseconds: epochMilliseconds(julianDate: julianDate).rounded())
        return "\(utc.year)-\(two(utc.month))-\(two(utc.day)) \(two(utc.hour)):\(two(utc.minute)):\(two(utc.second))"
    }
}

/// What the web app derives from an initialised element set (orbitFacts.ts).
public struct OrbitFacts: Sendable {
    public var isSunSynchronous: Bool
    public var rows: [(String, String)]

    /// WGS-72, as satellite.js's constants.
    private static let earthRadiusKm = 6378.135
    private static let j2 = 0.001082616
    private static let sunDegreesPerDay = 360 / 365.2422

    public init(_ propagator: SGP4Propagator) {
        let shape = propagator.shape
        let elements = propagator.elements
        let degrees = 180 / Double.pi
        let eccentricity = elements.eccentricity
        let inclination = elements.inclination / degrees
        let oneMinusESquared = 1 - eccentricity * eccentricity
        let precession =
            (-1.5 * Self.j2 * propagator.meanMotion * cos(inclination)) / (shape.semiMajorAxis * shape.semiMajorAxis * oneMinusESquared * oneMinusESquared) * degrees * 1440
        isSunSynchronous = precession.isFinite && abs(precession - Self.sunDegreesPerDay) <= 0.05

        rows = []
        if shape.apogeeAltitude.isFinite, shape.perigeeAltitude.isFinite {
            let apogee = (shape.apogeeAltitude * Self.earthRadiusKm).rounded()
            let perigee = (shape.perigeeAltitude * Self.earthRadiusKm).rounded()
            rows.append(("Apogee / Perigee", "\(Formats.integer(Int(apogee))) / \(Formats.integer(Int(perigee))) km"))
        }
        if isSunSynchronous {
            let jd = propagator.epochJulianDate
            let utHours = ((jd + 0.5).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1) * 24
            let nodeLongitude = (elements.raOfAscNode / degrees - satelliteJSGstime(jd)) * degrees
            let ltan = wrapHours(utHours + nodeLongitude * 24 / 360)
            rows.append(("LTAN / LTDN", "\(formatHours(ltan)) / \(formatHours(wrapHours(ltan + 12)))"))
        }
    }
}

/// satellite.js's `gstime`, which is Vallado's.
func satelliteJSGstime(_ julianDate: Double) -> Double {
    let tut1 = (julianDate - 2451545.0) / 36525.0
    var temp = -6.2e-6 * tut1 * tut1 * tut1 + 0.093104 * tut1 * tut1 + (876600.0 * 3600 + 8640184.812866) * tut1 + 67310.54841
    temp = ((temp * Double.pi / 180) / 240.0).truncatingRemainder(dividingBy: 2 * Double.pi)
    return temp < 0 ? temp + 2 * Double.pi : temp
}

private func wrapHours(_ hours: Double) -> Double {
    (hours.truncatingRemainder(dividingBy: 24) + 24).truncatingRemainder(dividingBy: 24)
}

private func formatHours(_ hours: Double) -> String {
    let totalMinutes = Int((hours * 60).rounded()) % (24 * 60)
    let (hh, mm) = (totalMinutes / 60, totalMinutes % 60)
    return "\(two(hh)):\(two(mm))"
}
