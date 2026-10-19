/// A place on the Earth by its geodetic latitude and longitude, in degrees.
public struct GeoCoordinate: Sendable, Hashable {
    /// North of the equator.
    public var latitude: Double
    /// East of Greenwich.
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}
