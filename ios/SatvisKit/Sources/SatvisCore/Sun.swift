import Foundation
import simd

/// The direction to the Sun, by the Astronomical Almanac's low-precision formula
/// (about 0.01° from 1950 to 2050): plenty for lighting a globe and a terminator.
public enum Sun {
    /// A unit vector in the true-of-date equatorial frame, which is TEME to the
    /// precision this formula has.
    public static func directionTEME(epochMilliseconds: Double) -> SIMD3<Double> {
        let n = epochMilliseconds / msPerDay + 2440587.5 - 2451545.0
        let degrees = Double.pi / 180
        let meanLongitude = (280.460 + 0.9856474 * n) * degrees
        let meanAnomaly = (357.528 + 0.9856003 * n) * degrees
        let eclipticLongitude = meanLongitude + (1.915 * sin(meanAnomaly) + 0.020 * sin(2 * meanAnomaly)) * degrees
        let obliquity = (23.439 - 0.0000004 * n) * degrees
        return SIMD3(cos(eclipticLongitude), cos(obliquity) * sin(eclipticLongitude), sin(obliquity) * sin(eclipticLongitude))
    }

    /// A unit vector in the Earth-fixed frame the globe is drawn in.
    public static func directionFixed(epochMilliseconds: Double) -> SIMD3<Double> {
        temeToFixed(directionTEME(epochMilliseconds: epochMilliseconds), epochMilliseconds: epochMilliseconds)
    }
}

/// TEME rotated about Z by the Greenwich hour angle: the pseudo-fixed frame the
/// samples are kept in, as the web app's `temeToFixed` rotates them.
public func temeToFixed(_ teme: SIMD3<Double>, epochMilliseconds: Double) -> SIMD3<Double> {
    let angle = greenwichHourAngle(epochMilliseconds: epochMilliseconds)
    let (c, s) = (cos(angle), sin(angle))
    return SIMD3(c * teme.x + s * teme.y, -s * teme.x + c * teme.y, teme.z)
}
