import CoreLocation
import Foundation
import Observation
import SatvisCore
import SatvisRender

/// The ground stations, the overpass mode, and the passes predicted over them for
/// the satellites something is showing: the selected one, the active ones while a
/// station is selected or their links are drawn.
@Observable
final class PassModel {
    /// The user's stations, kept and synced.
    private(set) var saved: [GroundStation]
    /// Stations a link brought, shown with this view until one is saved.
    private(set) var visiting: [GroundStation] = []
    /// Every station shown: the saved ones, then the visiting ones that are not
    /// among them.
    private(set) var stations: [GroundStation]
    private(set) var mode: OverpassMode
    /// By catalog id. A satellite asked about but not answered yet is missing.
    private(set) var passes: [String: [Pass]] = [:]
    /// The span each satellite's passes hold for: outside it they are an old
    /// answer, not the answer.
    @ObservationIgnored private var windows: [String: PassWindow] = [:]
    /// Bumped with every change to `passes`, for what is worked out from them.
    @ObservationIgnored private(set) var revision = 0
    @ObservationIgnored private var stationCache: (key: StationKey, passes: [Pass])?
    @ObservationIgnored private let store = PassStore()
    @ObservationIgnored private let storage = GroundStationStorage()

    private static let modeKey = "overpassMode"
    /// Satellites per message to the store: enough to keep every core busy.
    private static let chunk = 512
    /// How often a long prediction publishes what it has so far. Every
    /// publication redraws what reads the passes, so not per chunk.
    private static let publishInterval: TimeInterval = 0.5

    init() {
        let stations = storage.load()
        storage.keepIDs(stations)
        saved = stations
        self.stations = stations
        mode = UserDefaults.standard.string(forKey: Self.modeKey).flatMap(OverpassMode.init(rawValue:)) ?? .elevation
    }

    var hasStations: Bool { !stations.isEmpty }

    /// The stations and mode as last saved, for predicting with no model about:
    /// in a background refresh.
    static func storedSettings() -> PassStore.Settings {
        PassStore.Settings(
            stations: GroundStationStorage.stored(),
            mode: UserDefaults.standard.string(forKey: modeKey).flatMap(OverpassMode.init(rawValue:)) ?? .elevation)
    }

    /// Replaces the saved stations.
    func setStations(_ stations: [GroundStation]) {
        apply(GroundStations.normalized(stations))
    }

    /// Adds a station, and says which it became: the one already there when it
    /// is in the same place under the same name.
    @discardableResult
    func add(latitude: Double, longitude: Double, name: String? = nil) -> UUID? {
        let added = GroundStation(latitude: latitude, longitude: longitude, name: name)
        setStations(saved + [added])
        let place = GroundStations.Place(GroundStations.normalized([added])[0])
        return saved.first { GroundStations.Place($0) == place }?.id
    }

    /// Shows a link's stations with this view, without saving them.
    func setVisiting(_ stations: [GroundStation]) {
        visiting = GroundStations.normalized(stations)
        combine()
    }

    func isVisiting(_ id: UUID) -> Bool {
        visiting.contains { $0.id == id } && !saved.contains { $0.id == id }
    }

    /// Keeps a visiting station among the user's own, under the same id, so what
    /// refers to it carries on.
    func save(_ id: UUID) {
        guard let station = visiting.first(where: { $0.id == id }) else {
            return
        }
        visiting.removeAll { $0.id == id }
        setStations(saved + [station])
    }

    func station(_ id: UUID) -> GroundStation? {
        stations.first { $0.id == id }
    }

    func setMode(_ mode: OverpassMode) {
        guard mode != self.mode else {
            return
        }
        self.mode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
        forget()
    }

    /// Predicts what is missing for these satellites around the instant. Changes
    /// nothing when nothing had to be predicted; publishes a long prediction as it
    /// goes, twice a second.
    func refresh(_ entries: [CatalogEntry], at time: Double) async {
        await store.configure(PassStore.Settings(stations: stations, mode: mode))
        let settings = (stations, mode)
        var pending: [String: PassStore.Prediction] = [:]
        var lastPublished = Date()
        for offset in stride(from: 0, to: entries.count, by: Self.chunk) {
            pending.merge(await store.predict(Array(entries[offset..<min(offset + Self.chunk, entries.count)]), at: time)) { _, new in new }
            // Stations or mode changed while it ran.
            guard settings == (stations, mode) else {
                return
            }
            if !pending.isEmpty, Date().timeIntervalSince(lastPublished) > Self.publishInterval {
                publish(pending)
                pending = [:]
                lastPublished = Date()
            }
        }
        if !pending.isEmpty {
            publish(pending)
        }
    }

    /// Forgets the passes of satellites no longer shown.
    func keep(only entries: [CatalogEntry]) async {
        let ids = Set(entries.map(\.id))
        guard passes.keys.contains(where: { !ids.contains($0) }) else {
            return
        }
        passes = passes.filter { ids.contains($0.key) }
        windows = windows.filter { ids.contains($0.key) }
        revision += 1
        await store.keep(only: ids)
    }

    /// One satellite's passes, nil while they are being predicted for `now`.
    func passes(of id: String, at now: Double) -> [Pass]? {
        guard hasStations else {
            return []
        }
        return windows[id]?.covers(now) == true ? passes[id] : nil
    }

    /// A station's passes over the given satellites within two days, and whether
    /// every one of them has answered for `now`. The merged list is kept until the
    /// passes or the satellites change: it can run to hundreds of thousands.
    func passes(over station: GroundStation, of entries: [CatalogEntry], from now: Double) -> (passes: [Pass], settled: Bool) {
        let settled = entries.allSatisfy { windows[$0.id]?.covers(now) == true }
        let key = StationKey(station: station.id, revision: revision, satellites: entries.map(\.id))
        if stationCache?.key != key {
            let merged = entries.compactMap { passes[$0.id] }.flatMap(\.self).filter { $0.stationID == station.id }
            stationCache = (key, merged.sorted { $0.start < $1.start })
        }
        let all = stationCache?.passes ?? []
        // Sorted by start, so the two days ahead are a prefix.
        let horizon = all.partitioningIndex { $0.start - now >= 48 * 3_600_000 }
        return (Array(all[..<horizon]), settled)
    }

    /// Where the renderer draws the ground station links.
    func links(for entries: [CatalogEntry]) -> [StationLink] {
        let byID = Dictionary(stations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return entries.flatMap { entry in
            (passes[entry.id] ?? []).compactMap { pass in
                byID[pass.stationID].map { StationLink(satellite: entry.id, latitude: $0.latitude, longitude: $0.longitude, start: pass.start, end: pass.end) }
            }
        }
    }

    private func publish(_ predictions: [String: PassStore.Prediction]) {
        for (id, prediction) in predictions {
            passes[id] = prediction.passes
            windows[id] = prediction.window
        }
        revision += 1
    }

    private func forget() {
        passes = [:]
        windows = [:]
        revision += 1
    }

    var markers: [StationMarker] {
        stations.map { StationMarker(id: Self.markerID($0.id), latitude: $0.latitude, longitude: $0.longitude) }
    }

    /// The renderer's id for a station, and back.
    static func markerID(_ id: UUID) -> String { "station|\(id.uuidString)" }

    static func stationID(_ markerID: String) -> UUID? {
        markerID.hasPrefix("station|") ? UUID(uuidString: String(markerID.dropFirst("station|".count))) : nil
    }

    private func apply(_ stations: [GroundStation]) {
        guard stations != saved else {
            return
        }
        saved = stations
        storage.save(stations)
        combine()
    }

    private func combine() {
        let places = Set(saved.map(GroundStations.Place.init))
        // A link's station in the place of a saved one is that one, not a visit:
        // kept as a visit, it would ride along in every link from then on, the
        // view kept at a background included, which is how a sky view on a saved
        // station would come back on the next launch.
        visiting.removeAll { places.contains(GroundStations.Place($0)) }
        let shown = saved + visiting
        guard shown != stations else {
            return
        }
        stations = shown
        forget()
    }
}

private struct StationKey: Equatable {
    var station: UUID
    var revision: Int
    var satellites: [String]
}

extension Array {
    /// The first index whose element satisfies a predicate that, over the array,
    /// is false and then true: a binary search.
    func partitioningIndex(where predicate: (Element) -> Bool) -> Int {
        var low = 0
        var high = count
        while low < high {
            let middle = (low + high) / 2
            if predicate(self[middle]) {
                high = middle
            } else {
                low = middle + 1
            }
        }
        return low
    }
}

/// The station list, kept on this device and synced nowhere: stations are often
/// where the user lives.
final class GroundStationStorage {
    private static let key = "groundStations"
    private let defaults = UserDefaults.standard

    func load() -> [GroundStation] {
        Self.stored()
    }

    /// Saves stations read without ids back with the ids they were given, so that
    /// an id read once stays theirs.
    func keepIDs(_ stations: [GroundStation]) {
        guard let data = defaults.data(forKey: Self.key), !String(decoding: data, as: UTF8.self).contains("\"id\"") else {
            return
        }
        save(stations)
    }

    static func stored() -> [GroundStation] {
        UserDefaults.standard.data(forKey: key).map(decode) ?? []
    }

    func save(_ stations: [GroundStation]) {
        guard let data = try? JSONEncoder().encode(stations) else {
            return
        }
        defaults.set(data, forKey: Self.key)
    }

    private static func decode(_ data: Data) -> [GroundStation] {
        GroundStations.normalized((try? JSONDecoder().decode([GroundStation].self, from: data)) ?? [])
    }
}

/// Where the device is, once: nil when the user declines, or no fix comes within
/// ten seconds, which a cold fix can genuinely take.
func currentLocation() async -> CLLocationCoordinate2D? {
    await withTaskGroup(of: CLLocationCoordinate2D?.self) { group in
        group.addTask {
            let session = CLServiceSession(authorization: .whenInUse)
            defer { session.invalidate() }
            do {
                for try await update in CLLocationUpdate.liveUpdates() {
                    if let location = update.location {
                        return location.coordinate
                    }
                    if update.authorizationDenied || update.authorizationDeniedGlobally || update.authorizationRestricted {
                        return nil
                    }
                }
            } catch {}
            return nil
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(10))
            return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
    }
}
