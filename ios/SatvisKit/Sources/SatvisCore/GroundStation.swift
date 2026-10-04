import Foundation

/// A named position on the ground that passes are predicted for (CONTEXT.md,
/// Ground station). On the ellipsoid: the web app gives every station a height of 0.
public struct GroundStation: Sendable, Hashable, Codable {
    /// Degrees.
    public var latitude: Double
    public var longitude: Double
    /// Nil for a station known only by its coordinates.
    public var name: String?

    public init(latitude: Double, longitude: Double, name: String? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
    }

    /// The name, or the coordinates to two decimals for a station without one, as
    /// the web app shows it. Passes say which station they cross by this.
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
    /// back; no station twice.
    public static func normalized(_ stations: [GroundStation]) -> [GroundStation] {
        var seen = Set<GroundStation>()
        return stations.compactMap { station in
            guard station.latitude.isFinite, station.longitude.isFinite else {
                return nil
            }
            let normalized = GroundStation(latitude: rounded(station.latitude), longitude: rounded(station.longitude), name: wireSafe(station.name))
            return seen.insert(normalized).inserted ? normalized : nil
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
