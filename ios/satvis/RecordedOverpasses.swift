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

    /// Every pair's overpasses as last listed, and when, shared by every table: a panel
    /// opened again within `relist` asks nothing.
    private static var listed: [String: (time: Date, entries: [RecordedOverpass])] = [:]
    /// Seconds a listing is kept: CMR lists a granule hours after it is sensed.
    private static let relist: TimeInterval = 600

    /// Every overpass listed, of every pair asked about.
    var recorded: [RecordedOverpass] {
        asked.flatMap { byPair[$0] ?? [] }
    }

    /// Whether `follow` is on these pairs, and every one has answered or failed to.
    func isSettled(for pairs: [Pair]) -> Bool {
        asked == pairs.map(\.key) && asked.allSatisfy { byPair[$0] != nil }
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

    /// Lists each pair's overpasses, those not listed within `relist`, and again each
    /// `relist`, until cancelled.
    func follow(_ pairs: [Pair]) async {
        asked = pairs.map(\.key)
        byPair = Dictionary(uniqueKeysWithValues: pairs.compactMap { pair in Self.fresh(pair).map { (pair.key, $0) } })
        while !Task.isCancelled {
            let now = Date().timeIntervalSince1970 * 1000
            await withTaskGroup(of: (Pair, [Overpass]?).self) { group in
                for pair in pairs where Self.fresh(pair) == nil {
                    group.addTask { (pair, await GranuleService.shared.stationOverpasses(pair.layer, point: pair.point, now: now)) }
                }
                for await (pair, overpasses) in group where !Task.isCancelled {
                    // Not kept when it failed, so it is asked again; none for now, so the rest settle.
                    let entries = (overpasses ?? []).map {
                        RecordedOverpass(pair: pair.key, satellite: pair.satellite, station: pair.station, layer: pair.layer, overpass: $0)
                    }
                    if overpasses != nil {
                        Self.listed[pair.key] = (Date(), entries)
                    }
                    if overpasses != nil || byPair[pair.key] == nil {
                        byPair[pair.key] = entries
                    }
                }
            }
            try? await Task.sleep(for: .seconds(Self.relist))
        }
    }

    /// The pair's overpasses, if listed within `relist`.
    private static func fresh(_ pair: Pair) -> [RecordedOverpass]? {
        listed[pair.key].flatMap { Date().timeIntervalSince($0.time) < relist ? $0.entries : nil }
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
