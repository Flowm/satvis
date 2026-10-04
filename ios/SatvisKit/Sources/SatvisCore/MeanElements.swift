import Foundation

/// The SGP4 mean elements of one element set, in OMM keywords and units: the one
/// form propagation starts from, whichever form the record arrived in.
public struct MeanElements: Sendable, Hashable {
    /// The epoch as SGP4 counts it: a year, and the day of that year from 1.0 at
    /// 00:00 UTC on 1 January. Kept in this form rather than as an instant because
    /// a TLE's epoch is finer than the milliseconds a Date round trip keeps.
    public struct Epoch: Sendable, Hashable {
        public var year: Int
        public var dayOfYear: Double

        /// The Julian date, by the arithmetic satellite.js uses (`days2mdhms`, then `jday`).
        public var julianDate: Double {
            let (month, day, hour, minute, second) = days2mdhms(year: year, days: dayOfYear)
            return jday(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
        }
    }

    public var epoch: Epoch
    /// Revolutions per day.
    public var meanMotion: Double
    public var eccentricity: Double
    /// Degrees.
    public var inclination: Double
    public var raOfAscNode: Double
    public var argOfPericenter: Double
    public var meanAnomaly: Double
    /// Per Earth radius.
    public var bstar: Double
    /// Revolutions per day squared, halved; and per day cubed, divided by six.
    public var meanMotionDot: Double
    public var meanMotionDDot: Double
}

extension MeanElements {
    /// As satellite.js's `json2satrec` reads an OMM: `EPOCH` is UTC, truncated to
    /// the millisecond as a JavaScript Date keeps it.
    public init?(_ omm: OMM) {
        guard let epochMilliseconds = utcMilliseconds(iso: omm.epoch) else {
            return nil
        }
        let year = civilDate(epochMilliseconds: epochMilliseconds).year
        let yearStart = Double(daysFromCivil(year: year, month: 1, day: 1)) * msPerDay
        self.init(
            epoch: Epoch(year: year, dayOfYear: (epochMilliseconds - yearStart) / msPerDay + 1),
            meanMotion: omm.meanMotion,
            eccentricity: omm.eccentricity,
            inclination: omm.inclination,
            raOfAscNode: omm.raOfAscNode,
            argOfPericenter: omm.argOfPericenter,
            meanAnomaly: omm.meanAnomaly,
            bstar: omm.bstar,
            meanMotionDot: omm.meanMotionDot,
            meanMotionDDot: omm.meanMotionDDot)
    }

    /// As satellite.js's `twoline2satrec` reads the fixed columns of a TLE, so a
    /// pseudo element set the worker still serves as TLE lines takes the same path
    /// into SGP4 as every OMM.
    public init?(tleLine1 line1: String, line2: String) {
        let one = Array(line1)
        let two = Array(line2)
        func field(_ line: [Character], _ range: Range<Int>) -> String {
            String(line[min(range.lowerBound, line.count)..<min(range.upperBound, line.count)])
        }
        func number(_ text: String) -> Double? {
            Double(text.trimmingCharacters(in: .whitespaces))
        }
        guard let twoDigitYear = Int(field(one, 18..<20).trimmingCharacters(in: .whitespaces)),
            let dayOfYear = number(field(one, 20..<32)),
            let meanMotionDot = number(field(one, 33..<43)),
            let meanMotionDDot = number("\(field(one, 44..<45)).\(field(one, 45..<50))E\(field(one, 50..<52))".replacingOccurrences(of: " ", with: "")),
            let bstar = number("\(field(one, 53..<54)).\(field(one, 54..<59))E\(field(one, 59..<61))".replacingOccurrences(of: " ", with: "")),
            let inclination = number(field(two, 8..<16)),
            let raOfAscNode = number(field(two, 17..<25)),
            let eccentricity = number("." + field(two, 26..<33).replacingOccurrences(of: " ", with: "0")),
            let argOfPericenter = number(field(two, 34..<42)),
            let meanAnomaly = number(field(two, 43..<51)),
            let meanMotion = number(field(two, 52..<63))
        else {
            return nil
        }
        self.init(
            epoch: Epoch(year: twoDigitYear < 57 ? twoDigitYear + 2000 : twoDigitYear + 1900, dayOfYear: dayOfYear),
            meanMotion: meanMotion,
            eccentricity: eccentricity,
            inclination: inclination,
            raOfAscNode: raOfAscNode,
            argOfPericenter: argOfPericenter,
            meanAnomaly: meanAnomaly,
            bstar: bstar,
            meanMotionDot: meanMotionDot,
            meanMotionDDot: meanMotionDDot)
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.ffffff][Z]`, always UTC, to whole milliseconds since 1970.
func utcMilliseconds(iso text: String) -> Double? {
    let trimmed = text.hasSuffix("Z") ? String(text.dropLast()) : text
    let parts = trimmed.split(separator: "T", omittingEmptySubsequences: false)
    guard parts.count == 2 else {
        return nil
    }
    let date = parts[0].split(separator: "-").compactMap { Int($0) }
    let clock = parts[1].split(separator: ":", omittingEmptySubsequences: false)
    guard date.count == 3, clock.count == 3, let hour = Int(clock[0]), let minute = Int(clock[1]) else {
        return nil
    }
    let secondParts = clock[2].split(separator: ".", omittingEmptySubsequences: false)
    guard let second = Int(secondParts[0]), secondParts.count <= 2 else {
        return nil
    }
    var milliseconds = 0
    if secondParts.count == 2 {
        let digits = secondParts[1].prefix(3).padding(toLength: 3, withPad: "0", startingAt: 0)
        guard secondParts[1].allSatisfy(\.isNumber), let value = Int(digits) else {
            return nil
        }
        milliseconds = value
    }
    let days = daysFromCivil(year: date[0], month: date[1], day: date[2])
    return Double(days) * msPerDay + Double(((hour * 60 + minute) * 60 + second) * 1000 + milliseconds)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yearOfEra = y - era * 400
    let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146097 + dayOfEra - 719468
}

/// The UTC calendar fields of an instant, as a JavaScript Date's `getUTC*` reports them.
func civilDate(epochMilliseconds: Double) -> (year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int, millisecond: Int) {
    let days = Int((epochMilliseconds / msPerDay).rounded(.down))
    let msOfDay = Int(epochMilliseconds - Double(days) * msPerDay)
    let z = days + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let dayOfEra = z - era * 146097
    let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
    let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let mp = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
    return (year, month, day, msOfDay / 3_600_000, msOfDay / 60000 % 60, msOfDay / 1000 % 60, msOfDay % 1000)
}

/// satellite.js's `jday`.
func jday(year: Int, month: Int, day: Int, hour: Double, minute: Double, second: Double, millisecond: Double = 0) -> Double {
    let y = Double(year)
    let m = Double(month)
    return 367.0 * y - (7 * (y + ((m + 9) / 12.0).rounded(.down)) * 0.25).rounded(.down) + ((275 * m) / 9.0).rounded(.down) + Double(day) + 1721013.5
        + ((millisecond / 60000 + second / 60.0 + minute) / 60.0 + hour) / 24.0
}

/// satellite.js's `days2mdhms`, including its every-fourth-year leap rule.
func days2mdhms(year: Int, days: Double) -> (month: Int, day: Int, hour: Double, minute: Double, second: Double) {
    let monthLengths = [31, year % 4 == 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    let dayOfYear = Int(days.rounded(.down))
    var month = 1
    var elapsed = 0
    while dayOfYear > elapsed + monthLengths[month - 1] && month < 12 {
        elapsed += monthLengths[month - 1]
        month += 1
    }
    var temp = (days - Double(dayOfYear)) * 24.0
    let hour = temp.rounded(.down)
    temp = (temp - hour) * 60.0
    let minute = temp.rounded(.down)
    return (month, dayOfYear - elapsed, hour, minute, (temp - minute) * 60.0)
}

let msPerDay = 86_400_000.0
