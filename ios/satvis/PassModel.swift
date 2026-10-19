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
    /// The user's stations, kept.
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
    /// The stations each satellite's passes are over: a station added is missing
    /// from them until predicted, and the others' passes stay meanwhile.
    @ObservationIgnored private var covered: [String: Set<GroundStation>] = [:]
    /// Bumped with every change to `passes`, for what is worked out from them.
    @ObservationIgnored private(set) var revision = 0
    @ObservationIgnored private var stationCache: (key: StationKey, passes: [Pass])?
    @ObservationIgnored private let store = PassStore()
    @ObservationIgnored private let storage: any StationStorage
    @ObservationIgnored private var list: StationList

    /// Satellites per message to the store: enough to keep every core busy.
    private static let chunk = 512
    /// How often a long prediction publishes what it has so far. Every
    /// publication redraws what reads the passes, so not per chunk.
    private static let publishInterval: TimeInterval = 0.5
    /// Set when the passes are forgotten, for the next refresh to reset the store.
    @ObservationIgnored private var storeIsStale = false

    init(storage: any StationStorage = UserDefaultsStationStorage()) {
        self.storage = storage
        list = StationList(storage: storage)
        saved = list.saved
        stations = list.shown
        mode = storage.mode
    }

    var hasStations: Bool { !stations.isEmpty }

    /// Replaces the saved stations.
    func setStations(_ stations: [GroundStation]) {
        edit { $0.setSaved(stations) }
    }

    /// Adds a station, and says which it became: the one already there when it
    /// is in the same place under the same name.
    @discardableResult
    func add(latitude: Double, longitude: Double, name: String? = nil) -> UUID? {
        edit { $0.add(latitude: latitude, longitude: longitude, name: name) }
    }

    /// Saves the device's position as the one station named "Geolocation"
    /// (`StationList.setGeolocation`).
    @discardableResult
    func setGeolocation(latitude: Double, longitude: Double) -> UUID? {
        edit { $0.setGeolocation(latitude: latitude, longitude: longitude) }
    }

    /// Shows a link's stations with this view, without saving them.
    func setVisiting(_ stations: [GroundStation]) {
        edit { $0.setVisiting(stations) }
    }

    /// Read from the observed lists, not `list`, so a view asking is redrawn when
    /// the station is saved.
    func isVisiting(_ id: UUID) -> Bool {
        visiting.contains { $0.id == id } && !saved.contains { $0.id == id }
    }

    /// Keeps a visiting station among the user's own, under the same id, so what
    /// refers to it carries on.
    func save(_ id: UUID) {
        edit { $0.save(id) }
    }

    /// Read from the observed `stations`, so a view asking is redrawn when the
    /// station is renamed or moved.
    func station(_ id: UUID) -> GroundStation? {
        stations.first { $0.id == id }
    }

    func setMode(_ mode: OverpassMode) {
        guard mode != self.mode else {
            return
        }
        self.mode = mode
        storage.saveMode(mode)
        forget()
    }

    /// Predicts what is missing for these satellites around the instant. Changes
    /// nothing when nothing had to be predicted; publishes a long prediction as it
    /// goes, twice a second.
    /// `over` narrows it to some of the stations, as one station's panel needs.
    func refresh(_ entries: [CatalogEntry], at time: Double, over subset: [GroundStation]? = nil) async {
        if storeIsStale {
            storeIsStale = false
            await store.reset()
        }
        await store.configure(PassStore.Settings(stations: stations, mode: mode))
        let settings = (stations, mode)
        var pending: [String: PassStore.Prediction] = [:]
        var lastPublished = Date()
        for offset in stride(from: 0, to: entries.count, by: Self.chunk) {
            pending.merge(await store.predict(Array(entries[offset..<min(offset + Self.chunk, entries.count)]), at: time, over: subset)) { _, new in new }
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
        covered = covered.filter { ids.contains($0.key) }
        revision += 1
        await store.keep(only: ids)
    }

    /// One satellite's passes, nil while they are being predicted for `now`.
    func passes(of id: String, at now: Double) -> [Pass]? {
        guard hasStations else {
            return []
        }
        return isPredicted(id, over: stations, at: now) ? passes[id] : nil
    }

    /// A station's passes over the given satellites within two days, and whether
    /// every one of them has answered for `now`. The merged list is kept until the
    /// passes or the satellites change: it can run to hundreds of thousands.
    func passes(over station: GroundStation, of entries: [CatalogEntry], from now: Double) -> (passes: [Pass], settled: Bool, predicted: Int) {
        let predicted = entries.count { isPredicted($0.id, over: [station], at: now) }
        let settled = predicted == entries.count
        let key = StationKey(station: station.id, revision: revision, satellites: entries.map(\.id))
        if stationCache?.key != key {
            let merged = entries.compactMap { passes[$0.id] }.flatMap(\.self).filter { $0.stationID == station.id }
            stationCache = (key, merged.sorted { $0.start < $1.start })
        }
        let all = stationCache?.passes ?? []
        // Sorted by start, so the two days ahead are a prefix.
        let horizon = all.partitioningIndex { $0.start - now >= 48 * 3_600_000 }
        return (Array(all[..<horizon]), settled, predicted)
    }

    /// Whether a satellite's passes over these stations are the answer for now.
    private func isPredicted(_ id: String, over stations: [GroundStation], at now: Double) -> Bool {
        windows[id]?.covers(now) == true && (covered[id].map { stations.allSatisfy($0.contains) } ?? false)
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
            covered[id] = prediction.stations
        }
        revision += 1
    }

    /// Keeps the passes over the stations still there, as they were: a station
    /// added is predicted alone, and until then its own panel says so.
    private func keepStations() {
        let current = Set(stations)
        for (id, over) in covered {
            let kept = over.intersection(current)
            guard kept != over else {
                continue
            }
            covered[id] = kept
            let ids = Set(kept.map(\.id))
            passes[id] = passes[id]?.filter { ids.contains($0.stationID) }
        }
        revision += 1
    }

    private func forget() {
        passes = [:]
        windows = [:]
        covered = [:]
        revision += 1
        // The store's own go too. It drops them when the mode it is handed
        // differs, but a mode changed and changed back before the next refresh
        // hands it what it had: it would answer that nothing is missing, and
        // what was forgotten here would never come back.
        storeIsStale = true
    }

    var markers: [StationMarker] {
        stations.map { StationMarker(id: Self.markerID($0.id), latitude: $0.latitude, longitude: $0.longitude) }
    }

    /// The renderer's id for a station, and back.
    static func markerID(_ id: UUID) -> String { "station|\(id.uuidString)" }

    static func stationID(_ markerID: String) -> UUID? {
        markerID.hasPrefix("station|") ? UUID(uuidString: String(markerID.dropFirst("station|".count))) : nil
    }

    /// Publishes what an edit of the list changed, and only that: a view
    /// opened with the same stations redraws nothing.
    private func edit<Result>(_ change: (inout StationList) -> Result) -> Result {
        let result = change(&list)
        if list.saved != saved {
            saved = list.saved
        }
        if list.visiting != visiting {
            visiting = list.visiting
        }
        if list.shown != stations {
            stations = list.shown
            keepStations()
        }
        return result
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

/// The stations and mode in `UserDefaults`, under the keys and in the format
/// existing installs saved them with.
nonisolated struct UserDefaultsStationStorage: StationStorage {
    private static let stationsKey = "groundStations"
    private static let modeKey = "overpassMode"

    func stationData() -> Data? {
        UserDefaults.standard.data(forKey: Self.stationsKey)
    }

    func setStationData(_ data: Data) {
        UserDefaults.standard.set(data, forKey: Self.stationsKey)
    }

    func modeName() -> String? {
        UserDefaults.standard.string(forKey: Self.modeKey)
    }

    func setModeName(_ name: String) {
        UserDefaults.standard.set(name, forKey: Self.modeKey)
    }
}

/// Where the device is, once: nil when the user declines, or no fix comes within
/// ten seconds of the user answering the prompt (or of asking, once answered
/// before), which a cold fix can genuinely take.
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
            // Not counted while the prompt is up: a user reading it for ten
            // seconds was told the location was unavailable before tapping Allow.
            let manager = CLLocationManager()
            var waited = Duration.zero
            while waited < .seconds(10), !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                if manager.authorizationStatus != .notDetermined {
                    waited += .milliseconds(250)
                }
            }
            return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
    }
}
