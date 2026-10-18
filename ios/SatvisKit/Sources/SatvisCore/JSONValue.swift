import Foundation

/// Any JSON value. Carries what the app reads without interpreting, such as the
/// satellite metadata bag, whose fields the worker treats as opaque.
public enum JSONValue: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// What `JSONSerialization` read, or nil for what it never returns. Cast to
    /// its Foundation classes: a cast of `Any` to a Swift type goes through the
    /// runtime's bridging and conformance lookups, which were most of a group's
    /// decoding.
    init?(jsonObject value: Any) {
        switch value {
        case let string as NSString:
            self = .string(string as String)
        case let number as NSNumber where Self.isBoolean(number):
            self = .bool(number.boolValue)
        case let number as NSNumber:
            // An infinity, which it makes of -1e999, as null, which the decoder
            // makes of 1e999 (GPRecord.decodeGroup).
            self = Self.number(number).map(JSONValue.number) ?? .null
        case let array as NSArray:
            self = .array(array.compactMap(JSONValue.init(jsonObject:)))
        case let object as NSDictionary:
            var values: [String: JSONValue] = [:]
            values.reserveCapacity(object.count)
            for case (let key as NSString, let value) in object {
                values[key as String] = JSONValue(jsonObject: value)
            }
            self = .object(values)
        case is NSNull:
            self = .null
        default:
            return nil
        }
    }

    /// A number `JSONSerialization` read, as a double; nil for a boolean, which
    /// it reads as an `NSNumber` too, and for an infinity, which it makes of
    /// `-1e999` where Codable refused the field. One of 18 significant digits or
    /// more it reads as an `NSDecimalNumber`, whose double can be a unit in the
    /// last place out; CelesTrak sends fewer.
    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !isBoolean(number), number.doubleValue.isFinite else {
            return nil
        }
        return number.doubleValue
    }

    /// `JSONSerialization` reads `true` and `false` as `NSNumber`s too.
    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    public var string: String? {
        if case .string(let value) = self { value } else { nil }
    }

    public var number: Double? {
        if case .number(let value) = self { value } else { nil }
    }

    public var array: [JSONValue]? {
        if case .array(let value) = self { value } else { nil }
    }
}
