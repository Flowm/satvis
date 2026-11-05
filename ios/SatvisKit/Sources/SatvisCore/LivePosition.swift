import Foundation

/// Where a satellite is over the Earth and how fast it goes: the Orbit tab's live
/// position, as the web app's `Orbit.positionGeodetic` works it out (satellite.js's
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
        let geodetic = eciToGeodetic(state.position, gmst: satelliteJSGstime(julianDate(epochMilliseconds: epochMilliseconds)))
        let degrees = 180 / Double.pi
        return LivePosition(
            latitude: geodetic.latitude * degrees, longitude: geodetic.longitude * degrees, height: geodetic.height * 1000,
            speed: (state.velocity * state.velocity).sum().squareRoot())
    }
}

/// satellite.js's `eciToGeodetic`: kilometres in, radians and kilometres out.
func eciToGeodetic(_ eci: SIMD3<Double>, gmst: Double) -> (latitude: Double, longitude: Double, height: Double) {
    let (a, e2) = (WGS84.a, WGS84.e2)
    let r = (eci.x * eci.x + eci.y * eci.y).squareRoot()
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
