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
        try elements(of: data).compactMap(record)
    }

    /// A group as the worker serves it, for keeping: as `decodePayload`, but a
    /// payload with records none of which decode is malformed, not an empty group.
    /// A format the app cannot read yet would otherwise replace a good copy with
    /// nothing, and the group's satellites would vanish while the web app still
    /// showed them.
    public static func decodeGroup(_ data: Data) throws -> [GPRecord] {
        let raw = try elements(of: data)
        let records = raw.compactMap(record)
        guard records.isEmpty == raw.isEmpty else {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: "No record of \(raw.count) decodes"))
        }
        return records
    }

    /// The payload's array, by `JSONSerialization`: `Codable` tried each field's
    /// types in turn, each miss threw an error that built its coding path, and
    /// Starlink took 558 ms on an M4 Pro.
    private static func elements(of data: Data) throws -> [Any] {
        guard let array = try jsonObject(data) as? NSArray else {
            throw DecodingError.typeMismatch([Any].self, DecodingError.Context(codingPath: [], debugDescription: "A group is an array of records"))
        }
        return array as [AnyObject]
    }

    /// JSONSerialization refuses a whole document over one number past a double's
    /// range, such as `1e309`, where Codable failed only that field: a document it
    /// refuses is read again with every such number as null.
    private static func jsonObject(_ data: Data) throws -> Any {
        do {
            return try JSONSerialization.jsonObject(with: data)
        } catch {
            guard let nulled = nullingOverflowingNumbers(data) else {
                throw error
            }
            return try JSONSerialization.jsonObject(with: nulled)
        }
    }

    /// The document with every number past a double's range outside a string
    /// overwritten with `null` and spaces; nil when it has none.
    private static func nullingOverflowingNumbers(_ data: Data) -> Data? {
        let numeric = Set("+-0123456789.eE".utf8)
        var bytes = [UInt8](data)
        var changed = false
        var index = 0
        var inString = false
        while index < bytes.count {
            let byte = bytes[index]
            if inString {
                // A backslash escapes the byte after it, a quote among them.
                inString = byte != UInt8(ascii: "\"")
                index += byte == UInt8(ascii: "\\") ? 2 : 1
            } else if byte == UInt8(ascii: "\"") {
                inString = true
                index += 1
            } else if numeric.contains(byte) {
                var end = index
                while end < bytes.count, numeric.contains(bytes[end]) {
                    end += 1
                }
                if end - index >= 4, let value = Double(String(decoding: bytes[index..<end], as: UTF8.self)), value.isInfinite {
                    bytes.replaceSubrange(index..<end, with: Array("null".utf8) + Array(repeating: UInt8(ascii: " "), count: end - index - 4))
                    changed = true
                }
                index = end
            } else {
                index += 1
            }
        }
        return changed ? Data(bytes) : nil
    }

    /// One served record, or nil when it is neither an OMM nor a TLE pair.
    private static func record(_ element: Any) -> GPRecord? {
        guard let fields = element as? NSDictionary else {
            return nil
        }
        let name = string(fields["OBJECT_NAME"])
        var metadata: [String: JSONValue] = [:]
        if let bag = fields["metadata"].flatMap(JSONValue.init(jsonObject:)), case .object(let values) = bag {
            metadata = values
        }

        if let line1 = string(fields["TLE_LINE1"]), let line2 = string(fields["TLE_LINE2"]) {
            let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return MeanElements(tleLine1: line1, line2: line2).map {
                GPRecord(name: trimmed.isEmpty ? satnumField(line1) : trimmed, elements: .tle(line1: line1, line2: line2), meanElements: $0, metadata: metadata)
            }
        }

        guard let epoch = string(fields["EPOCH"]),
            let noradCatID = flexibleString(fields["NORAD_CAT_ID"]),
            let meanMotion = flexibleDouble(fields["MEAN_MOTION"]),
            let eccentricity = flexibleDouble(fields["ECCENTRICITY"]),
            let inclination = flexibleDouble(fields["INCLINATION"]),
            let raOfAscNode = flexibleDouble(fields["RA_OF_ASC_NODE"]),
            let argOfPericenter = flexibleDouble(fields["ARG_OF_PERICENTER"]),
            let meanAnomaly = flexibleDouble(fields["MEAN_ANOMALY"])
        else {
            return nil
        }
        let omm = OMM(
            objectName: name,
            objectID: string(fields["OBJECT_ID"]),
            epoch: epoch,
            meanMotion: meanMotion,
            eccentricity: eccentricity,
            inclination: inclination,
            raOfAscNode: raOfAscNode,
            argOfPericenter: argOfPericenter,
            meanAnomaly: meanAnomaly,
            bstar: flexibleDouble(fields["BSTAR"]) ?? 0,
            meanMotionDot: flexibleDouble(fields["MEAN_MOTION_DOT"]) ?? 0,
            meanMotionDDot: flexibleDouble(fields["MEAN_MOTION_DDOT"]) ?? 0,
            noradCatID: noradCatID,
            ephemerisType: flexibleDouble(fields["EPHEMERIS_TYPE"]).flatMap(wholeNumber),
            classificationType: string(fields["CLASSIFICATION_TYPE"]),
            elementSetNo: flexibleDouble(fields["ELEMENT_SET_NO"]).flatMap(wholeNumber),
            revAtEpoch: flexibleDouble(fields["REV_AT_EPOCH"]).flatMap(wholeNumber))
        return MeanElements(omm).map {
            GPRecord(name: (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines), elements: .omm(omm), meanElements: $0, metadata: metadata)
        }
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

/// A string `JSONSerialization` read, cast as `JSONValue(jsonObject:)` casts.
private func string(_ value: Any?) -> String? {
    (value as? NSString).map { $0 as String }
}

/// A number, or a string holding one: CelesTrak's JSON has carried both.
private func flexibleDouble(_ value: Any?) -> Double? {
    if let number = JSONValue.number(value) {
        return number
    }
    return string(value).flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
}

private func flexibleString(_ value: Any?) -> String? {
    if let string = string(value) {
        return string
    }
    return JSONValue.number(value).map { value in wholeNumber(value).map(String.init) ?? String(value) }
}

/// An integer that a JSON number holds exactly, or nil. Never `Int(_:)`, which
/// traps on a NaN or an out-of-range value that a lenient decode cannot catch:
/// `Double("nan")` parses.
private func wholeNumber(_ value: Double) -> Int? {
    Int(exactly: value)
}
