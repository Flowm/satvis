import Foundation

/// Which frames a layer that follows the clock has, in GIBS's notation
/// (`start/end/PT10M,…`), and which one to show when: the web app's `timeDomain.ts`,
/// in milliseconds since 1970.
public enum TimeDomain {
    /// A run of frames `step` apart, or one frame where `step` is 0.
    public struct Range: Sendable, Hashable {
        public var start: Double
        public var end: Double
        public var step: Double

        public init(start: Double, end: Double, step: Double) {
            self.start = start
            self.end = end
            self.step = step
        }
    }

    /// The comma-separated ranges of a GIBS `<Domain>` or a WMS time dimension, sorted.
    /// What cannot be read is skipped.
    public static func parse(_ text: String) -> [Range] {
        text.split(separator: ",").compactMap { entry -> Range? in
            let parts = entry.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard let start = instant(parts[0]) else {
                return nil
            }
            if parts.count == 1 {
                return Range(start: start, end: start, step: 0)
            }
            guard let end = instant(parts[1]), end >= start, parts.count > 2, let step = duration(parts[2]) else {
                return nil
            }
            return Range(start: start, end: end, step: step)
        }
        .sorted { $0.start < $1.start }
    }

    /// `ranges` without their latest frame.
    public static func withoutLatestFrame(_ ranges: [Range]) -> [Range] {
        guard var last = ranges.last else {
            return []
        }
        let rest = Array(ranges.dropLast())
        if last.step == 0 || last.end - last.step < last.start {
            return rest
        }
        last.end -= last.step
        return rest + [last]
    }

    /// The frame to show at `time`: the latest at or before it, so a gap holds the frame
    /// before it, or the earliest where `time` precedes them all.
    public static func snap(_ ranges: [Range], to time: Double) -> Double? {
        guard let range = ranges.last(where: { $0.start <= time }) else {
            return ranges.first?.start
        }
        if time >= range.end || range.step == 0 {
            return range.end
        }
        return range.start + ((time - range.start) / range.step).rounded(.down) * range.step
    }

    /// A frame as a tile url names it: `2026-10-05` for a daily layer, else to the second.
    public static func format(_ frame: Double, daily: Bool) -> String {
        let date = Date(timeIntervalSince1970: frame / 1000)
        return daily ? date.formatted(.iso8601.year().month().day()) : date.formatted(.iso8601)
    }

    /// `Date.parse` of an ISO 8601 date or UTC time, in milliseconds.
    private static func instant(_ text: String) -> Double? {
        let strategies: [Date.ISO8601FormatStyle] = [.iso8601, .iso8601.year().month().day(), Date.ISO8601FormatStyle(includingFractionalSeconds: true)]
        for strategy in strategies {
            if let date = try? Date(text, strategy: strategy) {
                return (date.timeIntervalSince1970 * 1000).rounded()
            }
        }
        return nil
    }

    /// An ISO 8601 duration of days, hours, minutes and seconds, in milliseconds; nil
    /// for a zero or another one.
    private static func duration(_ text: String) -> Double? {
        guard let match = text.wholeMatch(of: /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/) else {
            return nil
        }
        let value = { (part: Substring?) in Double(part ?? "0") ?? 0 }
        let milliseconds = (((value(match.1) * 24 + value(match.2)) * 60 + value(match.3)) * 60 + value(match.4)) * 1000
        return milliseconds > 0 ? milliseconds : nil
    }
}

/// What a EUMETView layer's own WMS capabilities say of it: its frames, and its bounds,
/// west, south, east and north in degrees (`EumetViewImagery.ts`'s `parseCapabilities`).
/// Of two bounding boxes the later is the layer's, the first its workspace's.
public struct EumetViewCapabilities: Sendable, Hashable {
    public var ranges: [TimeDomain.Range]
    public var bounds: [Double]?

    public init(_ xml: String) {
        let dimension = xml.firstMatch(of: /<Dimension name="time"[^>]*>([^<]*)</).map { String($0.1) }
        ranges = dimension.map(TimeDomain.parse) ?? []
        let box = xml.range(of: "<EX_GeographicBoundingBox>", options: .backwards).map { String(xml[$0.lowerBound...]) } ?? ""
        let values = ["westBoundLongitude", "southBoundLatitude", "eastBoundLongitude", "northBoundLatitude"].map { name -> Double? in
            guard let open = box.range(of: "<\(name)>"), let close = box.range(of: "<", range: open.upperBound..<box.endIndex) else {
                return nil
            }
            return Double(box[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespaces))
        }
        // Sentinel-3's box ends at 180.005° east.
        if let west = values[0], let south = values[1], let east = values[2], let north = values[3] {
            bounds = [max(west, -180), max(south, -90), min(east, 180), min(north, 90)]
        } else {
            bounds = nil
        }
    }
}
