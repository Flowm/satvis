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
            guard station.latitude.isFinite, station.longitude.isFinite else {
                return nil
            }
            let normalized = GroundStation(
                latitude: rounded(station.latitude), longitude: rounded(station.longitude), name: wireSafe(station.name), id: station.id)
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

/// JavaScript's `Number.prototype.toFixed`: a tie rounds away from zero.
func toFixed(_ value: Double, _ digits: Int) -> String {
    let scale = pow(10, Double(digits))
    let scaled = (abs(value) * scale).rounded(.toNearestOrAwayFromZero)
    let sign = value < 0 ? "-" : ""
    return sign + String(format: "%.\(digits)f", scaled / scale)
}
