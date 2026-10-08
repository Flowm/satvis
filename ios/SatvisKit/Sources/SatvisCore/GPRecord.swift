import Foundation

/// A CelesTrak OMM element set, in the CCSDS field names the worker passes through.
public struct OMM: Sendable, Hashable {
    public var objectName: String?
    public var objectID: String?
    /// ISO 8601 without a zone, in UTC, e.g. `2026-10-02T11:10:18.655680`.
    public var epoch: String
    public var meanMotion: Double
    public var eccentricity: Double
    public var inclination: Double
    public var raOfAscNode: Double
    public var argOfPericenter: Double
    public var meanAnomaly: Double
    public var bstar: Double
    public var meanMotionDot: Double
    public var meanMotionDDot: Double
    public var noradCatID: String
    public var ephemerisType: Int?
    public var classificationType: String?
    public var elementSetNo: Int?
    public var revAtEpoch: Int?
}

/// One satellite's element set as a group serves it: an OMM, or two TLE lines for
/// a pseudo element set no OMM can express (`GpRecord` in worker/src/gp/types.ts).
public struct GPRecord: Sendable, Hashable {
    public enum Elements: Sendable, Hashable {
        case omm(OMM)
        case tle(line1: String, line2: String)
    }

    public var name: String
    /// The element set as it was served, for showing it as such.
    public var elements: Elements
    /// The same elements in OMM keywords, which is what propagation reads.
    public var meanElements: MeanElements
    /// Static facts attached by the worker. Absent fields fall back to app defaults.
    public var metadata: [String: JSONValue]

    /// The catalog number, without leading zeros when numeric.
    public var satnum: String {
        switch elements {
        case .omm(let omm): normalizedSatnum(omm.noradCatID)
        case .tle(let line1, _): normalizedSatnum(satnumField(line1))
        }
    }

    public var orbitClass: OrbitClass {
        OrbitClass(meanMotionRevPerDay: meanElements.meanMotion, eccentricity: meanElements.eccentricity)
    }

    /// The period of the element set's own (Kozai) mean motion. Within seconds of
    /// the SGP4-recovered one: fine for sizing a window, not for placing samples.
    public var approximatePeriodMinutes: Double {
        let meanMotion = meanElements.meanMotion
        return meanMotion.isFinite && meanMotion > 0 ? minutesPerDay / meanMotion : 0
    }
}

extension GPRecord {
    /// A group's payload, `/api/gp/<group>.json`. A record that is neither an OMM
    /// nor a TLE pair is skipped rather than failing the group, as on the web.
    public static func decodePayload(_ data: Data) throws -> [GPRecord] {
        try JSONDecoder().decode([Lenient<RawRecord>].self, from: data).compactMap { $0.value?.record }
    }

    /// A group as the worker serves it, for keeping: as `decodePayload`, but a
    /// payload with records none of which decode is malformed, not an empty group.
    /// A format the app cannot read yet would otherwise replace a good copy with
    /// nothing, and the group's satellites would vanish while the web app still
    /// showed them.
    public static func decodeGroup(_ data: Data) throws -> [GPRecord] {
        let raw = try JSONDecoder().decode([Lenient<RawRecord>].self, from: data)
        let records = raw.compactMap { $0.value?.record }
        guard records.isEmpty == raw.isEmpty else {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: "No record of \(raw.count) decodes"))
        }
        return records
    }
}

private func satnumField(_ line1: String) -> String {
    column(line1, 2..<7).trimmingCharacters(in: .whitespaces)
}

private func normalizedSatnum(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed.allSatisfy(\.isASCIIDigit), let number = Int(trimmed) else {
        return trimmed
    }
    return String(number)
}

/// Fixed-width TLE columns, clamped to the line like JavaScript's `substring`.
private func column(_ line: String, _ range: Range<Int>) -> String {
    let characters = Array(line)
    let lower = min(range.lowerBound, characters.count)
    let upper = min(range.upperBound, characters.count)
    return String(characters[lower..<upper])
}

extension Character {
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}

/// Decodes to nil instead of failing, so one bad element cannot sink an array.
struct Lenient<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// Every field a served record may carry, before deciding which kind it is.
private struct RawRecord: Decodable {
    enum CodingKeys: String, CodingKey {
        case objectName = "OBJECT_NAME"
        case objectId = "OBJECT_ID"
        case epoch = "EPOCH"
        case meanMotion = "MEAN_MOTION"
        case eccentricity = "ECCENTRICITY"
        case inclination = "INCLINATION"
        case raOfAscNode = "RA_OF_ASC_NODE"
        case argOfPericenter = "ARG_OF_PERICENTER"
        case meanAnomaly = "MEAN_ANOMALY"
        case bstar = "BSTAR"
        case meanMotionDot = "MEAN_MOTION_DOT"
        case meanMotionDdot = "MEAN_MOTION_DDOT"
        case noradCatId = "NORAD_CAT_ID"
        case ephemerisType = "EPHEMERIS_TYPE"
        case classificationType = "CLASSIFICATION_TYPE"
        case elementSetNo = "ELEMENT_SET_NO"
        case revAtEpoch = "REV_AT_EPOCH"
        case tleLine1 = "TLE_LINE1"
        case tleLine2 = "TLE_LINE2"
        case metadata
    }

    let record: GPRecord?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let name = try? container.decodeIfPresent(String.self, forKey: .objectName)
        let metadata = (try? container.decodeIfPresent([String: JSONValue].self, forKey: .metadata)) ?? [:]

        if let line1 = try? container.decode(String.self, forKey: .tleLine1), let line2 = try? container.decode(String.self, forKey: .tleLine2) {
            let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            record = MeanElements(tleLine1: line1, line2: line2).map {
                GPRecord(name: trimmed.isEmpty ? satnumField(line1) : trimmed, elements: .tle(line1: line1, line2: line2), meanElements: $0, metadata: metadata)
            }
            return
        }

        guard let epoch = try? container.decode(String.self, forKey: .epoch),
            let noradCatID = container.flexibleString(.noradCatId),
            let meanMotion = container.flexibleDouble(.meanMotion),
            let eccentricity = container.flexibleDouble(.eccentricity),
            let inclination = container.flexibleDouble(.inclination),
            let raOfAscNode = container.flexibleDouble(.raOfAscNode),
            let argOfPericenter = container.flexibleDouble(.argOfPericenter),
            let meanAnomaly = container.flexibleDouble(.meanAnomaly)
        else {
            record = nil
            return
        }
        let omm = OMM(
            objectName: name,
            objectID: try? container.decodeIfPresent(String.self, forKey: .objectId),
            epoch: epoch,
            meanMotion: meanMotion,
            eccentricity: eccentricity,
            inclination: inclination,
            raOfAscNode: raOfAscNode,
            argOfPericenter: argOfPericenter,
            meanAnomaly: meanAnomaly,
            bstar: container.flexibleDouble(.bstar) ?? 0,
            meanMotionDot: container.flexibleDouble(.meanMotionDot) ?? 0,
            meanMotionDDot: container.flexibleDouble(.meanMotionDdot) ?? 0,
            noradCatID: noradCatID,
            ephemerisType: container.flexibleDouble(.ephemerisType).flatMap(wholeNumber),
            classificationType: try? container.decodeIfPresent(String.self, forKey: .classificationType),
            elementSetNo: container.flexibleDouble(.elementSetNo).flatMap(wholeNumber),
            revAtEpoch: container.flexibleDouble(.revAtEpoch).flatMap(wholeNumber))
        record = MeanElements(omm).map {
            GPRecord(name: (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines), elements: .omm(omm), meanElements: $0, metadata: metadata)
        }
    }
}

extension KeyedDecodingContainer {
    /// A number, or a string holding one: CelesTrak's JSON has carried both.
    fileprivate func flexibleDouble(_ key: Key) -> Double? {
        if let value = try? decode(Double.self, forKey: key) {
            return value
        }
        return (try? decode(String.self, forKey: key)).flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    }

    fileprivate func flexibleString(_ key: Key) -> String? {
        if let value = try? decode(String.self, forKey: key) {
            return value
        }
        return (try? decode(Double.self, forKey: key)).map { value in wholeNumber(value).map(String.init) ?? String(value) }
    }
}

/// An integer that a JSON number holds exactly, or nil. Never `Int(_:)`, which
/// traps on a NaN or an out-of-range value that a lenient decode cannot catch:
/// `Double("nan")` parses.
private func wholeNumber(_ value: Double) -> Int? {
    Int(exactly: value)
}
