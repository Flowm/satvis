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
    /// The store's predictions, as last published.
    private(set) var predictions = PassStore.Snapshot()
    /// Bumped with every change to what the passes answer, for what is worked
    /// out from them.
    @ObservationIgnored private(set) var revision = 0
    @ObservationIgnored private let store = PassStore()
    @ObservationIgnored private let storage: any StationStorage
    @ObservationIgnored private var list: StationList

    /// Satellites per message to the store: enough to keep every core busy.
    private static let chunk = 512
    /// How often a long prediction publishes what it has so far. Every
    /// publication redraws what reads the passes, so not per chunk.
    private static let publishInterval: TimeInterval = 0.5

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
        revision += 1
    }

    /// The settings the passes are asked under.
    private var settings: PassStore.Settings {
        PassStore.Settings(stations: stations, mode: mode)
    }

    /// Predicts what is missing for these satellites around the instant. Changes
    /// nothing when nothing had to be predicted; publishes a long prediction as it
    /// goes, twice a second.
    /// `over` narrows it to some of the stations, as one station's panel needs.
    func refresh(_ entries: [CatalogEntry], at time: Double, over subset: [GroundStation]? = nil) async {
        let settings = settings
        await store.configure(settings)
        var lastPublished = Date()
        for offset in stride(from: 0, to: entries.count, by: Self.chunk) {
            await store.predict(Array(entries[offset..<min(offset + Self.chunk, entries.count)]), at: time, over: subset)
            // Stations or mode changed while it ran: the next refresh takes
            // them up, and publishes.
            guard settings == self.settings else {
                return
            }
            if Date().timeIntervalSince(lastPublished) > Self.publishInterval {
                await publish()
                lastPublished = Date()
            }
        }
        await publish()
    }

    /// Forgets the passes of satellites no longer shown.
    func keep(only entries: [CatalogEntry]) async {
        await store.keep(only: Set(entries.map(\.id)))
        await publish()
    }

    /// One satellite's passes, nil while they are being predicted for `now`.
    func passes(of id: String, at now: Double) -> [Pass]? {
        predictions.passes(of: id, at: now, under: settings)
    }

    /// A station's passes over the given satellites within two days, and how many
    /// of them have answered for `now`.
    func passes(over station: GroundStation, of entries: [CatalogEntry], from now: Double) -> PassStore.StationPasses {
        predictions.passes(over: station, of: entries, from: now, under: settings)
    }

    /// Where the renderer draws the ground station links.
    func links(for entries: [CatalogEntry]) -> [StationLink] {
        let byID = Dictionary(stations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let settings = settings
        return entries.flatMap { entry in
            predictions.heldPasses(of: entry.id, under: settings).compactMap { pass in
                byID[pass.stationID].map { StationLink(satellite: entry.id, latitude: $0.latitude, longitude: $0.longitude, start: pass.start, end: pass.end) }
            }
        }
    }

    /// Takes up what the store holds, when it changed: a redraw for whatever
    /// reads the passes.
    private func publish() async {
        let snapshot = await store.snapshot
        guard snapshot.revision != predictions.revision else {
            return
        }
        predictions = snapshot
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
            revision += 1
        }
        return result
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
