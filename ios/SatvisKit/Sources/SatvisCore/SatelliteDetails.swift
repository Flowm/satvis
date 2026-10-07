import Foundation

/// The tables the native app reads from the web app rather than keeping its own:
/// SATCAT and GCAT code labels and the external links (Shared/web-tables.json,
/// written by scripts/parity/generate.mjs).
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

    public var satcat: Satcat
    public var gcat: Gcat
    public var externalLinks: [Link]

    public static let shared: WebTables = {
        let url = Bundle.module.url(forResource: "web-tables", withExtension: "json", subdirectory: "Shared")!
        return try! JSONDecoder().decode(WebTables.self, from: Data(contentsOf: url))
    }()
}

/// What the info panel's Details tab says about a satellite, as the web app's
/// `getSatelliteInfo` and `getElementsInfo` say it (src/modules/util/entityInfo.ts).
public enum SatelliteDetails {
    /// Label and value rows: the orbit, then curated, GCAT and SATCAT facts.
    public static func facts(_ record: GPRecord, propagator: SGP4Propagator?, tables: WebTables = .shared) -> [(String, String)] {
        var rows: [(String, String)] = []
        let regime = record.orbitClass.rawValue
        if let propagator {
            let orbit = OrbitFacts(propagator)
            rows.append(("Orbit", orbit.isSunSynchronous ? "\(regime) · Sun-synchronous" : regime))
            rows += orbit.rows
        } else {
            rows.append(("Orbit", regime))
        }
        let metadata = record.metadata
        func label(_ table: [String: String], _ key: String) -> String? {
            metadata[key]?.string.map { table[$0] ?? $0 }
        }
        if let starboard = metadata["swathStarboardKm"]?.number, let port = metadata["swathPortKm"]?.number {
            let total = javaScriptString(starboard + port)
            rows.append(("Swath", starboard == port ? "\(total) km" : "\(total) km (\(javaScriptString(starboard)) stbd / \(javaScriptString(port)) port)"))
        }
        if let fov = metadata["coneFovDeg"]?.number {
            rows.append(("Sensor FOV", "\(javaScriptString(fov))°"))
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
            rows.append(("Mass", "\(approximate(metadata, "massKg", groupedString(mass))) kg"))
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

    /// GCAT flags most sizes and some masses as estimates (`estimated`); "~" says so.
    private static func approximate(_ metadata: [String: JSONValue], _ key: String, _ text: String) -> String {
        metadata["estimated"]?.array?.contains(.string(key)) == true ? "~\(text)" : text
    }

    /// "12.6 × 4.2 m, span 23.9 m": the body's two dimensions as GCAT gives them,
    /// then the span with arrays and booms.
    private static func size(_ metadata: [String: JSONValue]) -> String? {
        let body = ["lengthM", "diameterM"].compactMap { key in metadata[key]?.number.map { approximate(metadata, key, javaScriptString($0)) } }
        var parts = body.isEmpty ? [] : ["\(body.joined(separator: " × ")) m"]
        if let span = metadata["spanM"]?.number {
            parts.append("span \(approximate(metadata, "spanM", javaScriptString(span))) m")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The number as `toLocaleString("en-US")` writes it: grouped by thousands, at
    /// most three decimals.
    static func groupedString(_ value: Double) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_US")).precision(.fractionLength(0...3)).rounded(rule: .toNearestOrAwayFromZero))
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
                ("NORAD_CAT_ID", omm.noradCatID), ("INCLINATION", javaScriptString(omm.inclination)), ("RA_OF_ASC_NODE", javaScriptString(omm.raOfAscNode)),
                ("ECCENTRICITY", javaScriptString(omm.eccentricity)), ("ARG_OF_PERICENTER", javaScriptString(omm.argOfPericenter)),
                ("MEAN_ANOMALY", javaScriptString(omm.meanAnomaly)), ("MEAN_MOTION", javaScriptString(omm.meanMotion)), ("BSTAR", javaScriptString(omm.bstar)),
            ].map { Elements.Row(label: $0.0, value: $0.1) }
            return .omm(epoch: epoch, rows: rows)
        }
    }

    /// More than this many days from the epoch, either way, a position may be off
    /// (entityInfo.ts's `STALE_ELEMENTS_DAYS`): only the latest element set is kept.
    public static let staleElementsDays = 10.0

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
        return "Position may be inaccurate, clock \(Int(abs(offsetDays).rounded())) days \(offsetDays > 0 ? "after" : "before") element epoch"
    }

    static func formatEpoch(julianDate: Double) -> String {
        let utc = civilDate(epochMilliseconds: ((julianDate - 2440587.5) * msPerDay).rounded())
        func two(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
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
            rows.append(("Apogee / Perigee", "\(Int(apogee)) / \(Int(perigee)) km"))
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
    return "\(hh < 10 ? "0" : "")\(hh):\(mm < 10 ? "0" : "")\(mm)"
}

/// A number as JavaScript's `String(number)` writes it: the shortest digits that
/// read back to it, in fixed notation from 1e-7 up to 1e21.
public func javaScriptString(_ value: Double) -> String {
    guard value.isFinite else {
        return value.isNaN ? "NaN" : (value < 0 ? "-Infinity" : "Infinity")
    }
    if value == 0 {
        return "0"
    }
    let magnitude = abs(value)
    guard magnitude >= 1e-7, magnitude < 1e21 else {
        return "\(value)".replacingOccurrences(of: "e-0", with: "e-").replacingOccurrences(of: "e+", with: "e+")
    }
    // Swift's description is the shortest round trip too; only the notation differs.
    let description = "\(magnitude)"
    let parts = description.lowercased().split(separator: "e")
    let mantissa = parts[0]
    let exponent = parts.count > 1 ? Int(parts[1])! : 0
    let mantissaParts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
    var digits = String(mantissaParts[0]) + (mantissaParts.count > 1 ? String(mantissaParts[1]) : "")
    var pointAt = mantissaParts[0].count + exponent
    while digits.hasPrefix("0") && digits.count > 1 {
        digits.removeFirst()
        pointAt -= 1
    }
    while digits.hasSuffix("0") && digits.count > 1 {
        digits.removeLast()
    }
    let sign = value < 0 ? "-" : ""
    if pointAt <= 0 {
        return sign + "0." + String(repeating: "0", count: -pointAt) + digits
    }
    if pointAt >= digits.count {
        return sign + digits + String(repeating: "0", count: pointAt - digits.count)
    }
    let index = digits.index(digits.startIndex, offsetBy: pointAt)
    return sign + digits[..<index] + "." + digits[index...]
}
