import Foundation

/// Overpass replay (ADR 0023): what a replay sets, where the clock is among a list of
/// them, and the Passes table's recorded overpasses. The web app's `overpassReplay.ts`
/// and `passImagery.ts`, less the fetching, which is the app's.
public enum OverpassReplay {
    /// Milliseconds.
    static let minute = 60_000.0

    /// How long before an overpass the clock is set: the satellite comes up to it.
    public static let leadMs = 5 * minute
    /// How far before its replay's start the clock still counts as at an overpass: a step
    /// lands on it a moment early.
    static let stepSlackMs = minute
    /// How long after its end the clock still counts as at an overpass, or at a granule:
    /// the fill's slack, and some.
    public static let afterOverpassMs = 10 * minute
    /// How far back a station's overpasses are listed. GIBS keeps 90 days; a month is what
    /// a list can show.
    public static let stationDays = 30.0
    /// How far from a granule's times the satellite drawn may sense it, and past its end
    /// a granule may still be swept: today's element set places NOAA 20 up to 17 s off
    /// its granules of 30 days ago (`SENSING_SLACK_MS`).
    public static let sensingSlackMs = 2 * minute
    /// How far apart a predicted pass and a recorded overpass may lie and still be one:
    /// as the sensing slack, for today's elements on old granules.
    static let matchSlackMs = sensingSlackMs

    /// What a replay sets: the clock, its speed, and the satellite and station the camera
    /// watches.
    public struct Plan: Sendable, Hashable {
        /// Epoch milliseconds the clock starts at.
        public var time: Double
        /// One of the speed ladder's rungs.
        public var multiplier: Double
        /// The satellite passing, by name.
        public var satellite: String
        /// The station it passes over.
        public var centre: GroundPoint

        public init(time: Double, multiplier: Double, satellite: String, centre: GroundPoint) {
            self.time = time
            self.multiplier = multiplier
            self.satellite = satellite
            self.centre = centre
        }
    }

    /// `satellite`'s pass or overpass starting at `start` over a station: from five
    /// minutes before, at 30×.
    public static func stationReplay(start: Double, station: GroundPoint, satellite: String) -> Plan {
        Plan(time: start - leadMs, multiplier: 30, satellite: satellite, centre: station)
    }

    /// Where the clock is among a list of replays.
    public struct Place<Item> {
        /// The one the clock is at, from its replay's start to a little after its end.
        public var current: Item?
        public var previous: Item?
        public var next: Item?
    }

    /// Where `time` is among `items`, oldest first, each starting its replay at
    /// `start(item)` and ending at `end(item)`: so a step from one replay goes to the one
    /// before or after it. Of items replayed at the same time, as one overpass over two
    /// stations, the current is the one `on`, the replay's own.
    public static func place<Item>(_ items: [Item], time: Double, start: (Item) -> Double, end: (Item) -> Double, on: (Item) -> Bool = { _ in true }) -> Place<Item> {
        if let at = items.indices.last(where: { on(items[$0]) && start(items[$0]) <= time + stepSlackMs && time <= end(items[$0]) + afterOverpassMs }) {
            return Place(current: items[at], previous: at > 0 ? items[at - 1] : nil, next: at + 1 < items.count ? items[at + 1] : nil)
        }
        let begun = items.filter { start($0) <= time + stepSlackMs }.count
        return Place(current: nil, previous: begun > 0 ? items[begun - 1] : nil, next: begun < items.count ? items[begun] : nil)
    }
}

/// An overpass the catalogue lists of one satellite's granule layer over one station.
public struct RecordedOverpass: Sendable, Hashable, Identifiable {
    /// Its satellite, station and layer as one key.
    public var pair: String
    public var satellite: String
    public var station: String
    public var layer: SatelliteDetails.GranuleLayer
    public var overpass: Overpass

    public init(pair: String, satellite: String, station: String, layer: SatelliteDetails.GranuleLayer, overpass: Overpass) {
        self.pair = pair
        self.satellite = satellite
        self.station = station
        self.layer = layer
        self.overpass = overpass
    }

    /// Some of it sensed by day.
    public var isDay: Bool { overpass.isDay }

    public var id: String { "\(pair)|\(jsNumberString(overpass.start))" }

    /// What it shows, from how many of its day granules its pictures have, once asked.
    public func imagery(pixels: [Bool]?) -> PassImagery {
        if !isDay {
            return .night
        }
        if layer.pictures == nil {
            return .outline
        }
        guard let pixels else {
            return .asking
        }
        let count = pixels.filter(\.self).count
        return count == 0 ? .outline : count == pixels.count ? .image : .part
    }

    /// The one of `recorded` of a pass's satellite over its station, starting at `start`
    /// and ending at `end`, that overlaps it most, give or take the slack.
    public static func matching(satellite: String, station: String?, start: Double, end: Double, in recorded: [RecordedOverpass]) -> RecordedOverpass? {
        var best: RecordedOverpass?
        var bestOverlap = -Double.infinity
        for entry in recorded where entry.satellite == satellite && entry.station == station {
            let overlap = min(end, entry.overpass.end) - max(start, entry.overpass.start)
            if overlap > -OverpassReplay.matchSlackMs, overlap > bestOverlap {
                best = entry
                bestOverlap = overlap
            }
        }
        return best
    }

    /// What a replay started at `started` steps through: the recorded overpasses by day of
    /// the Passes table it was started from, which are a station's of every satellite or a
    /// satellite's over every station. One a satellite, station and overpass, of
    /// `started`'s layer where a satellite has two over it. By start.
    public static func replaySteps(_ recorded: [RecordedOverpass], started: RecordedOverpass) -> [RecordedOverpass] {
        var steps: [String: RecordedOverpass] = [:]
        var order: [String] = []
        for entry in recorded where entry.isDay {
            let key = "\(entry.satellite)|\(entry.station)|\(jsNumberString(entry.overpass.start))"
            guard let held = steps[key] else {
                steps[key] = entry
                order.append(key)
                continue
            }
            if entry.layer.token == started.layer.token, held.layer.token != started.layer.token {
                steps[key] = entry
            }
        }
        return stableSorted(order.compactMap { steps[$0] }) { $0.overpass.start < $1.overpass.start }
    }
}

/// What a recorded overpass shows: still being asked, its pictures' image of all of it or
/// part, its outline alone, or night.
public enum PassImagery: String, Sendable, Hashable {
    case asking, image, part, outline, night

    /// What its mark says.
    public var title: String {
        switch self {
        case .asking: "Asking for the image"
        case .image: "Imaged: the picture is there"
        case .part: "Imaged: part of the picture is there"
        case .outline: "Recorded, but no picture: granule outlines only"
        case .night: "Recorded by night: no true colour picture"
        }
    }
}

extension Overpass {
    /// `MM-DD HH:mm:ss` UTC, as a pass's start is labelled.
    public var startLabel: String { dayTimeLabel(start) }

    /// `HH:mm:ss` UTC.
    public var endLabel: String { timeLabel(end) }

    /// `MM-DD HH:mm` UTC, the replay bar's and Last imaged's.
    public var minuteLabel: String {
        let utc = civilDate(epochMilliseconds: start)
        return "\(two(utc.month))-\(two(utc.day)) \(two(utc.hour)):\(two(utc.minute))"
    }
}

/// A row of the Passes table: a predicted pass with the overpass recorded in it, or a
/// recorded overpass by day the predictor no longer has. The web app's `passTable`.
public enum PassTableRow: Sendable, Hashable, Identifiable {
    case pass(Pass, recorded: RecordedOverpass?)
    case recorded(RecordedOverpass)

    public var id: String {
        switch self {
        case .pass(let pass, _): "\(pass.satellite)|\(pass.stationID)|\(pass.start)"
        case .recorded(let entry): "recorded-\(entry.id)"
        }
    }

    public var start: Double {
        switch self {
        case .pass(let pass, _): pass.start
        case .recorded(let entry): entry.overpass.start
        }
    }

    public var recorded: RecordedOverpass? {
        switch self {
        case .pass(_, let recorded): recorded
        case .recorded(let entry): entry
        }
    }

    /// Each pass with what was recorded in it, and with `past` the recorded overpasses by
    /// day before `now` that no pass is, as the predictor looks back a day and the
    /// catalogue a month. By start.
    public static func table(_ passes: [Pass], recorded: [RecordedOverpass], now: Double, past: Bool) -> [PassTableRow] {
        let match = { (pass: Pass, among: [RecordedOverpass]) in
            RecordedOverpass.matching(satellite: pass.satelliteName, station: pass.station, start: pass.start, end: pass.end, in: among)
        }
        var used = Set<String>()
        var table = passes.map { pass -> PassTableRow in
            let found = match(pass, recorded)
            if let found {
                used.insert(found.id)
            }
            return .pass(pass, recorded: found)
        }
        guard past else {
            return table
        }
        for entry in recorded where !used.contains(entry.id) && entry.isDay && entry.overpass.start <= now {
            // One a pass overlaps is that pass, even where the pass took a closer one.
            if !passes.contains(where: { match($0, [entry]) != nil }) {
                table.append(.recorded(entry))
            }
        }
        return stableSorted(table) { $0.start < $1.start }
    }
}
