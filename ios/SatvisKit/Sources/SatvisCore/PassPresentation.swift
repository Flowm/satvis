import Foundation

/// The span a pass list is predicted for, and while which instants it still
/// answers: a day either side of where it was asked, predicting four days ahead
/// (src/modules/PassPredictor.ts).
public struct PassWindow: Sendable, Hashable {
    public var start: Double
    public var stop: Double
    public var predictionEnd: Double

    public init(around time: Double) {
        start = time - msPerDay
        stop = time + msPerDay
        predictionEnd = time + 4 * msPerDay
    }

    public func covers(_ time: Double) -> Bool {
        start <= time && time <= stop
    }
}

extension Pass {
    /// How good a pass is, 0 to 1: the maximum elevation over 90°, or how near the
    /// centre of the swath the station falls.
    public var quality: Double {
        switch measure {
        case .elevation(let maxElevation, _, _, _, _):
            min(1, max(0, maxElevation / 90))
        case .swath(let minDistance, _, let swathWidth):
            min(1, max(0, 1 - minDistance / max(1, swathWidth / 2)))
        }
    }

    /// Three bands, split at 45° and 20° of elevation or the same fractions of the
    /// swath.
    public var band: PassBand {
        quality >= 0.5 ? .high : quality >= 0.222 ? .mid : .low
    }

    /// The pass in one line: window, length, and what the mode measures.
    public var summary: String {
        "\(Self.hhmm(start))–\(Self.hhmm(end)) UTC · \(length)"
    }

    /// The summary without the window: how long, and what the mode measures.
    public var length: String {
        let minutes = "\(Int((duration / 60_000).rounded())) min"
        switch measure {
        case .elevation(let maxElevation, _, let azimuthApex, _, _):
            return "\(minutes) · \(toFixed(maxElevation, 0))° max, apex \(compassPoint(azimuthApex))"
        case .swath(let minDistance, _, let swathWidth):
            return "\(minutes) · \(toFixed(minDistance, 0)) km off track, swath \(toFixed(swathWidth, 0)) km"
        }
    }

    /// The table's two measure columns: maximum elevation and azimuth at the apex,
    /// or distance off track and swath width.
    public var columns: (primary: String, secondary: String) {
        switch measure {
        case .elevation(let maxElevation, _, let azimuthApex, _, _):
            ("\(toFixed(maxElevation, 0))°", "\(toFixed(azimuthApex, 2))°")
        case .swath(let minDistance, _, let swathWidth):
            ("\(toFixed(minDistance, 1))km", "\(toFixed(swathWidth, 0))km")
        }
    }

    /// `DD.MM HH:mm:ss` UTC.
    public var startLabel: String {
        let utc = civilDate(epochMilliseconds: start)
        return "\(two(utc.day)).\(two(utc.month)) \(two(utc.hour)):\(two(utc.minute)):\(two(utc.second))"
    }

    /// `HH:mm:ss` UTC.
    public var endLabel: String {
        let utc = civilDate(epochMilliseconds: end)
        return "\(two(utc.hour)):\(two(utc.minute)):\(two(utc.second))"
    }

    /// How long until it starts, at the precision it is read at: "3 h 27 m",
    /// "42 s", "ongoing", "ended".
    public func countdown(at now: Double) -> String {
        if end < now {
            return "ended"
        }
        if start <= now {
            return "ongoing"
        }
        let seconds = Int(((start - now) / 1000).rounded(.down))
        if seconds < 60 {
            return "\(seconds) s"
        }
        let minutes = seconds / 60
        if minutes < 60 {
            return "\(minutes) m \(seconds % 60) s"
        }
        let hours = minutes / 60
        if hours < 24 {
            return "\(hours) h \(minutes % 60) m"
        }
        return "\(hours / 24) d \(hours % 24) h"
    }

    static func hhmm(_ time: Double) -> String {
        let utc = civilDate(epochMilliseconds: time)
        return "\(two(utc.hour)):\(two(utc.minute))"
    }
}

public enum PassBand: String, Sendable, CaseIterable {
    case high, mid, low
}

extension [Pass] {
    /// Ongoing and upcoming passes, or every one with `past`.
    public func visible(at now: Double, past: Bool) -> [Pass] {
        past ? self : filter { $0.end > now }
    }

    /// A station's list: the passes over it that start within two days, by start.
    public func over(station: String, from now: Double, hours: Double = 48) -> [Pass] {
        filter { $0.station == station && $0.start - now < hours * 3_600_000 }.sorted { $0.start < $1.start }
    }
}

/// A bearing as one of the 16 compass points.
public func compassPoint(_ azimuthDegrees: Double) -> String {
    let points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    let wrapped = (azimuthDegrees.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    return points[Int((wrapped / 22.5).rounded(.toNearestOrAwayFromZero)) % 16]
}

/// A pass list laid out as a strip from half an hour ago to a horizon sized to
/// hold about six passes, as the web app's pass timeline (src/modules/util/passTimeline.ts).
public struct PassTimelineLayout: Sendable {
    public struct Block: Sendable, Identifiable {
        public var start: Double
        /// Fractions of the strip, 0 to 1.
        public var left: Double
        public var width: Double
        public var height: Double
        public var band: PassBand
        public var isLive: Bool
        public var isPast: Bool
        public var id: Double { start }
    }

    public struct Tick: Sendable {
        public var label: String
        public var position: Double
    }

    public var blocks: [Block]
    public var ticks: [Tick]
    public var now: Double
    /// How far the strip reaches: "7 h", "1.5 d".
    public var horizonLabel: String
    /// Passes that start beyond it.
    public var beyond: Int

    private static let hourMs = 3_600_000.0
    private static let leadInMs = 30 * 60_000.0

    public init(passes: [Pass], now nowMs: Double) {
        let horizon = Self.horizon(passes, now: nowMs)
        let spanStart = nowMs - Self.leadInMs
        let spanEnd = nowMs + horizon
        let span = Self.leadInMs + horizon
        let fraction = { (time: Double) in (time - spanStart) / span }
        blocks = passes.filter { $0.end >= spanStart && $0.start <= spanEnd }.map { pass in
            let left = fraction(max(spanStart, pass.start))
            return Block(
                start: pass.start, left: left, width: max(0.012, fraction(min(spanEnd, pass.end)) - left), height: 0.25 + pass.quality * 0.75, band: pass.band,
                isLive: pass.start <= nowMs && pass.end >= nowMs, isPast: pass.end < nowMs)
        }
        let hours = horizon / Self.hourMs
        let step = [1.0, 2, 3, 6, 12, 24].first { hours / $0 <= 5 } ?? 24
        var ticks: [Tick] = []
        var hour = step
        while hour < hours {
            let at = fraction(nowMs + hour * Self.hourMs)
            if at > 0.9 {
                break
            }
            ticks.append(Tick(label: "+\(Int(hour))h", position: at))
            hour += step
        }
        self.ticks = ticks
        now = fraction(nowMs)
        horizonLabel = hours >= 24 ? "\(toFixed(hours / 24, hours.truncatingRemainder(dividingBy: 24) == 0 ? 0 : 1)) d" : "\(Int(hours.rounded())) h"
        beyond = passes.filter { $0.start > spanEnd }.count
    }

    /// Enough span for six passes, between 6 and 48 hours, with a tenth to spare.
    private static func horizon(_ passes: [Pass], now: Double) -> Double {
        let upcoming = passes.filter { $0.end >= now }
        guard !upcoming.isEmpty else {
            return 6 * hourMs
        }
        let last = upcoming[Swift.min(6, upcoming.count) - 1]
        return Swift.min(48 * hourMs, Swift.max(6 * hourMs, (last.end - now) * 1.1))
    }
}

private func two(_ value: Int) -> String {
    value < 10 ? "0\(value)" : "\(value)"
}
