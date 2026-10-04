import Foundation

/// The Greenwich hour angle for a UTC instant, in radians and not reduced to one
/// turn: the angle that rotates TEME into the pseudo-fixed frame the samples are
/// kept in. A port of `greenwichHourAngle` in src/modules/util/temeToFixed.ts,
/// which uses Cesium's GMST polynomial and treats UTC as UT1, operation for
/// operation, so that both apps put a satellite in the same place.
public func greenwichHourAngle(epochMilliseconds: Double) -> Double {
    let days = (epochMilliseconds / msPerDay).rounded(.down)
    let msIntoDay = epochMilliseconds - days * msPerDay
    var dayNumber = unixEpochDayNumber + days
    var secondsOfDay = halfDaySeconds + msIntoDay / 1000
    if secondsOfDay >= secondsPerDay {
        secondsOfDay -= secondsPerDay
        dayNumber += 1
    }

    let centuries = (dayNumber - j2000DayNumber + (secondsOfDay >= halfDaySeconds ? 0.5 : -0.5)) / 36525
    let gmstSeconds = gmstC0 + centuries * (gmstC1 + centuries * (gmstC2 + centuries * gmstC3))
    let angleAt0h = (gmstSeconds * twoPiPerSecondsPerDay).truncatingRemainder(dividingBy: twoPi)
    let rotationRate = wgs84RotationRatePrecessing + rateCoefficient * (dayNumber - j2000Midnight)
    let secondsSinceMidnight = (secondsOfDay + halfDaySeconds).truncatingRemainder(dividingBy: secondsPerDay)
    return angleAt0h + rotationRate * secondsSinceMidnight
}

public func greenwichHourAngle(at date: Date) -> Double {
    greenwichHourAngle(epochMilliseconds: (date.timeIntervalSince1970 * 1000).rounded())
}

private let gmstC0 = 6.0 * 3600 + 41 * 60 + 50.54841
private let gmstC1 = 8640184.812866
private let gmstC2 = 0.093104
private let gmstC3 = -6.2e-6
private let rateCoefficient = 1.1772758384668e-19
private let wgs84RotationRatePrecessing = 7.2921158553e-5
private let twoPi = Double.pi * 2
private let secondsPerDay = 86400.0
private let twoPiPerSecondsPerDay = twoPi / secondsPerDay
private let msPerDay = 86_400_000.0
private let j2000DayNumber = 2451545.0
private let j2000Midnight = j2000DayNumber - 0.5
private let unixEpochDayNumber = 2440587.0
private let halfDaySeconds = 43200.0
