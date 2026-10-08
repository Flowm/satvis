import Foundation

/// A named position on the ground that passes are predicted for (CONTEXT.md,
/// Ground station). On the ellipsoid: the web app gives every station a height of 0.
public struct GroundStation: Sendable, Hashable, Codable, Identifiable {
    /// Which station this is through renames, moves and reorders, and on the
    /// user's other devices: what its alerts, its panel and its passes hold on to.
    public var id: UUID
    /// Degrees.
    public var latitude: Double
    public var longitude: Double
    /// Nil for a station known only by its coordinates.
    public var name: String?

    public init(latitude: Double, longitude: Double, name: String? = nil, id: UUID = UUID()) {
        self.id = id
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case id, latitude, longitude, name
    }

    /// A station saved before stations had ids gets one here; save it back to
    /// keep it.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        latitude = try container.decode(Double.self, forKey: .latitude)
        longitude = try container.decode(Double.self, forKey: .longitude)
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }

    /// The name, or the coordinates to two decimals for a station without one, as
    /// the web app shows it.
    public var displayName: String {
        name ?? "\(toFixed(latitude, 2))°, \(toFixed(longitude, 2))°"
    }
}

/// The rules every edit of the station list goes through, as the web app's store
/// applies them (src/stores/sat.ts, `setGroundStations`).
public enum GroundStations {
    /// Latitude and longitude limits a typed coordinate must keep to.
    public static let maxLatitude = 90.0
    public static let maxLongitude = 180.0

    /// Coordinates rounded to four decimals, about 11 m; names a link can carry
    /// back; no station twice, by place and name, the first keeping its id.
    public static func normalized(_ stations: [GroundStation]) -> [GroundStation] {
        var seen = Set<Place>()
        return stations.compactMap { station in
            // A link's coordinates are only known to be numbers: none past a
            // pole, and a longitude however many turns around brought back.
            guard station.latitude.isFinite, station.longitude.isFinite, abs(station.latitude) <= 90 else {
                return nil
            }
            let normalized = GroundStation(
                latitude: rounded(station.latitude), longitude: rounded(wrappedLongitude(station.longitude)), name: wireSafe(station.name),
                id: station.id)
            return seen.insert(Place(normalized)).inserted ? normalized : nil
        }
    }

    /// Where a station is and what it is called: what makes two stations the
    /// same one, whatever their ids.
    public struct Place: Hashable {
        var latitude: Double
        var longitude: Double
        var name: String?

        public init(_ station: GroundStation) {
            latitude = station.latitude
            longitude = station.longitude
            name = station.name
        }
    }

    /// A coordinate read from what was typed, or nil when it is not one: empty,
    /// half typed, or out of range.
    public static func coordinate(_ text: String, limit: Double) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let value = Double(trimmed), value.isFinite, abs(value) <= limit else {
            return nil
        }
        return value
    }

    /// Links join stations with `_` and their fields with `,` (ADR 0001), so
    /// either in a name becomes a space. An empty name is no name.
    static func wireSafe(_ name: String?) -> String? {
        guard let name else {
            return nil
        }
        let safe = name.replacing(/[,_]/, with: " ").replacing(/\s+/, with: " ").trimmingCharacters(in: .whitespaces)
        return safe.isEmpty ? nil : safe
    }

    private static func rounded(_ value: Double) -> Double {
        Double(toFixed(value, 4)) ?? value
    }
}

/// JavaScript's `Number.prototype.toFixed`: the double's exact decimal value
/// rounded, a tie away from zero, so 7.90905, stored just below the tie, gives
/// 7.9090. Rounding the scaled double instead would round the tie it makes.
func toFixed(_ value: Double, _ digits: Int) -> String {
    let sign = value < 0 ? "-" : ""
    // Exact: a double's fraction has at most 52 binary digits above 1, and far
    // more digits than this below it never decide a rounding.
    let exact = String(format: "%.60f", abs(value))
    let point = exact.firstIndex(of: ".")!
    let fraction = exact[exact.index(after: point)...]
    var kept = Array(exact[..<point] + fraction.prefix(digits))
    if let next = fraction.dropFirst(digits).first, next >= "5" {
        var index = kept.count - 1
        while index >= 0 {
            if kept[index] == "9" {
                kept[index] = "0"
                index -= 1
            } else {
                kept[index] = Character(String(kept[index].wholeNumberValue! + 1))
                break
            }
        }
        if index < 0 {
            kept.insert("1", at: 0)
        }
    }
    let integer = String(kept.dropLast(digits))
    return sign + (digits == 0 ? integer : integer + "." + String(kept.suffix(digits)))
}

/// A longitude brought into -180° to 180°, however many turns around it was.
public func wrappedLongitude(_ longitude: Double) -> Double {
    remainder(longitude, 360)
}
