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
    private(set) var stations: [GroundStation]
    private(set) var mode: OverpassMode
    /// By catalog id. A satellite asked about but not answered yet is missing.
    private(set) var passes: [String: [Pass]] = [:]
    @ObservationIgnored private let store = PassStore()
    @ObservationIgnored private let storage = GroundStationStorage()
    /// Called when the stations change, from here or from another device.
    @ObservationIgnored var onStationsChange: () -> Void = {}

    private static let modeKey = "overpassMode"
    /// Predicted per message to the store, so a station's list over thousands of
    /// satellites fills in as it goes rather than all at once.
    private static let chunk = 64

    init() {
        stations = storage.load()
        mode = UserDefaults.standard.string(forKey: Self.modeKey).flatMap(OverpassMode.init(rawValue:)) ?? .elevation
        storage.onExternalChange = { [weak self] stations in
            self?.apply(stations, save: false)
        }
    }

    var hasStations: Bool { !stations.isEmpty }

    func setStations(_ stations: [GroundStation]) {
        apply(GroundStations.normalized(stations), save: true)
    }

    func add(latitude: Double, longitude: Double, name: String? = nil) {
        setStations(stations + [GroundStation(latitude: latitude, longitude: longitude, name: name)])
    }

    func setMode(_ mode: OverpassMode) {
        guard mode != self.mode else {
            return
        }
        self.mode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
        passes = [:]
    }

    /// Predicts what is missing for these satellites around the instant, publishing
    /// as each chunk lands.
    func refresh(_ entries: [CatalogEntry], at time: Double) async {
        await store.configure(PassStore.Settings(stations: stations, mode: mode))
        let settings = (stations, mode)
        for offset in stride(from: 0, to: entries.count, by: Self.chunk) {
            let answer = await store.passes(of: Array(entries[offset..<min(offset + Self.chunk, entries.count)]), at: time)
            // Stations or mode changed while it ran.
            guard settings == (stations, mode) else {
                return
            }
            passes.merge(answer) { _, new in new }
        }
    }

    /// One satellite's passes, nil while they are being predicted.
    func passes(of id: String) -> [Pass]? {
        hasStations ? passes[id] : []
    }

    /// A station's passes over the given satellites within two days, and whether
    /// every one of them has answered.
    func passes(over station: GroundStation, of entries: [CatalogEntry], from now: Double) -> (passes: [Pass], settled: Bool) {
        let lists = entries.map { passes[$0.id] }
        return (lists.compactMap(\.self).flatMap(\.self).over(station: station.displayName, from: now), !lists.contains(nil))
    }

    /// Where the renderer draws the ground station links.
    func links(for entries: [CatalogEntry]) -> [StationLink] {
        let byName = Dictionary(stations.map { ($0.displayName, $0) }, uniquingKeysWith: { first, _ in first })
        return entries.flatMap { entry in
            (passes[entry.id] ?? []).compactMap { pass in
                byName[pass.station].map { StationLink(satellite: entry.id, latitude: $0.latitude, longitude: $0.longitude, start: pass.start, end: pass.end) }
            }
        }
    }

    var markers: [StationMarker] {
        stations.enumerated().map { StationMarker(id: Self.markerID($0.offset), latitude: $0.element.latitude, longitude: $0.element.longitude) }
    }

    /// The renderer's id for the station at a place in the list, and back.
    static func markerID(_ index: Int) -> String { "station|\(index)" }

    static func stationIndex(_ id: String) -> Int? {
        id.hasPrefix("station|") ? Int(id.dropFirst("station|".count)) : nil
    }

    private func apply(_ stations: [GroundStation], save: Bool) {
        guard stations != self.stations else {
            return
        }
        self.stations = stations
        passes = [:]
        if save {
            storage.save(stations)
        }
        onStationsChange()
    }
}

/// The station list on this device, mirrored to iCloud key-value storage so the
/// user's other devices have it too. The device's copy is what the app reads; a
/// change from iCloud replaces it.
final class GroundStationStorage {
    private static let key = "groundStations"
    private let defaults = UserDefaults.standard
    private let cloud = NSUbiquitousKeyValueStore.default
    var onExternalChange: ([GroundStation]) -> Void = { _ in }

    init() {
        NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification, object: cloud, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let data = self.cloud.data(forKey: Self.key) else {
                    return
                }
                self.defaults.set(data, forKey: Self.key)
                self.onExternalChange(Self.decode(data))
            }
        }
        cloud.synchronize()
    }

    func load() -> [GroundStation] {
        (cloud.data(forKey: Self.key) ?? defaults.data(forKey: Self.key)).map(Self.decode) ?? []
    }

    func save(_ stations: [GroundStation]) {
        guard let data = try? JSONEncoder().encode(stations) else {
            return
        }
        defaults.set(data, forKey: Self.key)
        cloud.set(data, forKey: Self.key)
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
