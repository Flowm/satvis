import Foundation

/// Where a satellite is over the Earth and how fast it goes: the info panel's live
/// strip, as the web app's `Orbit.positionGeodetic` works it out (satellite.js's
/// `gstime` and `eciToGeodetic`, on WGS84).
public struct LivePosition: Sendable, Equatable {
    /// Degrees.
    public var latitude: Double
    public var longitude: Double
    /// Metres above the ellipsoid.
    public var height: Double
    /// Kilometres per second, in TEME.
    public var speed: Double
}

extension SGP4Propagator {
    public func livePosition(epochMilliseconds: Double) throws(SGP4Error) -> LivePosition {
        let state = try state(epochMilliseconds: epochMilliseconds)
        let utc = civilDate(epochMilliseconds: epochMilliseconds)
        let julianDate = jday(
            year: utc.year, month: utc.month, day: utc.day, hour: Double(utc.hour), minute: Double(utc.minute), second: Double(utc.second),
            millisecond: Double(utc.millisecond))
        let geodetic = eciToGeodetic(state.position, gmst: satelliteJSGstime(julianDate))
        let degrees = 180 / Double.pi
        return LivePosition(
            latitude: geodetic.latitude * degrees, longitude: geodetic.longitude * degrees, height: geodetic.height * 1000,
            speed: (state.velocity * state.velocity).sum().squareRoot())
    }
}

/// satellite.js's `eciToGeodetic`: kilometres in, radians and kilometres out.
func eciToGeodetic(_ eci: SIMD3<Double>, gmst: Double) -> (latitude: Double, longitude: Double, height: Double) {
    let a = 6378.137
    let b = 6356.7523142
    let r = (eci.x * eci.x + eci.y * eci.y).squareRoot()
    let f = (a - b) / a
    let e2 = 2 * f - f * f
    let twoPi = 2 * Double.pi
    let longitude = ((atan2(eci.y, eci.x) - gmst + .pi).truncatingRemainder(dividingBy: twoPi) + twoPi).truncatingRemainder(dividingBy: twoPi) - .pi
    var latitude = atan2(eci.z, r)
    var c = 0.0
    for _ in 0..<20 {
        c = 1 / (1 - e2 * (sin(latitude) * sin(latitude))).squareRoot()
        latitude = atan2(eci.z + a * c * e2 * sin(latitude), r)
    }
    return (latitude, longitude, r / cos(latitude) - a * c)
}
