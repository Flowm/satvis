import Foundation
import Observation
import SatvisCore

/// The overpasses the catalogues list for a panel's Passes table (ADR 0023): of every
/// active satellite with a granule layer over a selected station, or of a selected
/// satellite over every station, the last 30 days, whether or not a pass is predicted in
/// view. The table matches them to its rows, with whether their pictures have their pixels
/// and a replay of each. The web app's `useRecordedOverpasses`.
@MainActor
@Observable
final class RecordedOverpasses {
    /// A satellite's own granule layer over a station: what is asked about.
    struct Pair: Hashable {
        var satellite: String
        var station: String
        var layer: SatelliteDetails.GranuleLayer
        var point: GroundPoint

        var key: String { "\(satellite)|\(station)|\(layer.token)|\(point.latitude)|\(point.longitude)" }
    }

    /// By pair key, as each answers.
    private var byPair: [String: [RecordedOverpass]] = [:]
    private var asked: [String] = []
    /// The pictures' answer for each day granule of an overpass, by its id.
    private var pixels: [String: [Bool]] = [:]
    @ObservationIgnored private var askedPixels: Set<String> = []

    /// Every pair's overpasses once listed, shared by every table: a panel opened again
    /// asks nothing.
    private static var listed: [String: [RecordedOverpass]] = [:]

    /// Every overpass listed, of every pair asked about.
    var recorded: [RecordedOverpass] {
        asked.flatMap { byPair[$0] ?? [] }
    }

    /// Every pair asked about has answered, or failed to.
    var isSettled: Bool {
        asked.allSatisfy { byPair[$0] != nil }
    }

    /// The newest overpass recorded by day, which the header button and Last imaged replay.
    var latest: RecordedOverpass? {
        recorded.filter(\.isDay).max { $0.overpass.start < $1.overpass.start }
    }

    /// The pairs of `satellites`' own granule layers over `stations`.
    static func pairs(satellites: [CatalogEntry], stations: [GroundStation]) -> [Pair] {
        satellites.flatMap { entry in
            SatelliteDetails.ownGranuleLayers(entry.record).flatMap { layer in
                stations.map {
                    Pair(satellite: entry.name, station: $0.displayName, layer: layer, point: GroundPoint(latitude: $0.latitude, longitude: $0.longitude))
                }
            }
        }
    }

    /// Lists each pair's overpasses, those not listed before, until cancelled.
    func follow(_ pairs: [Pair]) async {
        asked = pairs.map(\.key)
        byPair = Dictionary(uniqueKeysWithValues: pairs.compactMap { pair in Self.listed[pair.key].map { (pair.key, $0) } })
        let now = Date().timeIntervalSince1970 * 1000
        await withTaskGroup(of: (Pair, [Overpass]?).self) { group in
            for pair in pairs where Self.listed[pair.key] == nil {
                group.addTask { (pair, await GranuleService.shared.stationOverpasses(pair.layer, point: pair.point, now: now)) }
            }
            for await (pair, overpasses) in group where !Task.isCancelled {
                // Not kept when it failed, so it is asked again; none for now, so the rest settle.
                let entries = (overpasses ?? []).map {
                    RecordedOverpass(pair: pair.key, satellite: pair.satellite, station: pair.station, layer: pair.layer, overpass: $0)
                }
                if overpasses != nil {
                    Self.listed[pair.key] = entries
                }
                byPair[pair.key] = entries
            }
        }
    }

    /// What the overpass shows, once `ask` has had its pictures' answer.
    func imagery(of entry: RecordedOverpass) -> PassImagery {
        entry.imagery(pixels: pixels[entry.id])
    }

    /// Asks the pictures' provider about the overpass's day granules, the first time.
    func ask(_ entry: RecordedOverpass) async {
        guard entry.isDay, entry.layer.pictures != nil, askedPixels.insert(entry.id).inserted else {
            return
        }
        let granules = entry.overpass.granules.filter(\.isDay)
        var answers = Array(repeating: false, count: granules.count)
        await withTaskGroup(of: (Int, Bool).self) { group in
            for (index, granule) in granules.enumerated() {
                group.addTask { (index, await GranuleService.shared.hasPixels(entry.layer, granule)) }
            }
            for await (index, has) in group {
                answers[index] = has
            }
        }
        pixels[entry.id] = answers
    }
}

/// A row of the Passes table: a predicted pass with the overpass recorded in it, or a
/// recorded overpass by day the predictor no longer has. The web app's `passTable`.
enum PassTableRow: Identifiable {
    case pass(Pass, recorded: RecordedOverpass?)
    case recorded(RecordedOverpass)

    var id: String {
        switch self {
        case .pass(let pass, _): "\(pass.satellite)|\(pass.stationID)|\(pass.start)"
        case .recorded(let entry): "recorded-\(entry.id)"
        }
    }

    var start: Double {
        switch self {
        case .pass(let pass, _): pass.start
        case .recorded(let entry): entry.overpass.start
        }
    }

    var recorded: RecordedOverpass? {
        switch self {
        case .pass(_, let recorded): recorded
        case .recorded(let entry): entry
        }
    }

    /// Each pass with what was recorded in it, and with `past` the recorded overpasses by
    /// day before `now` that no pass is, as the predictor looks back a day and the
    /// catalogue a month. By start.
    static func table(_ passes: [Pass], recorded: [RecordedOverpass], now: Double, past: Bool) -> [PassTableRow] {
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
        return table.enumerated().sorted { $0.element.start < $1.element.start || ($0.element.start == $1.element.start && $0.offset < $1.offset) }.map(\.element)
    }
}
