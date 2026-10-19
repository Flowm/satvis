import Foundation

/// Where the station list and the overpass mode are kept: on the device and
/// synced nowhere, as stations are often where the user lives.
public protocol StationStorage {
    /// The saved stations as JSON, as `[GroundStation]` encodes them; nil before
    /// any were saved.
    func stationData() -> Data?
    /// Keeps `data` as the saved stations.
    func setStationData(_ data: Data)
    /// The overpass mode's raw value.
    func modeName() -> String?
    /// Keeps `name` as the overpass mode's raw value.
    func setModeName(_ name: String)
}

extension StationStorage {
    /// The stations as last saved. One saved before stations had ids gets a new
    /// one on every read, until `StationList` saves it back.
    public func stations() -> [GroundStation] {
        stationData().map { GroundStations.normalized((try? JSONDecoder().decode([GroundStation].self, from: $0)) ?? []) } ?? []
    }

    /// Keeps `stations` as the saved ones.
    public func saveStations(_ stations: [GroundStation]) {
        guard let data = try? JSONEncoder().encode(stations) else {
            return
        }
        setStationData(data)
    }

    /// The overpass mode as last saved: by elevation until one is.
    public var mode: OverpassMode {
        modeName().flatMap(OverpassMode.init(rawValue:)) ?? .elevation
    }

    /// Keeps the overpass mode.
    public func saveMode(_ mode: OverpassMode) {
        setModeName(mode.rawValue)
    }

    /// The stations and mode as last saved, for predicting with no model about:
    /// in a background refresh.
    public var passSettings: PassStore.Settings {
        PassStore.Settings(stations: stations(), mode: mode)
    }
}

/// The user's ground stations and those a link brought, every edit kept in the
/// storage as it is made.
public struct StationList {
    /// The user's stations, kept.
    public private(set) var saved: [GroundStation]
    /// Stations a link brought, shown with this view until one is saved.
    public private(set) var visiting: [GroundStation] = []
    /// Every station shown: the saved ones, then the visiting ones that are not
    /// among them.
    public private(set) var shown: [GroundStation]
    /// Where every edit is kept as it is made.
    private let storage: any StationStorage

    /// The name the device's position is saved under, as on the web.
    public static let geolocation = "Geolocation"

    /// The stations as last saved in `storage`, with no visits.
    public init(storage: any StationStorage) {
        self.storage = storage
        saved = storage.stations()
        shown = saved
        // Stations read without ids are saved back with the ids they were
        // given, so that an id read once stays theirs.
        if let data = storage.stationData(), !String(decoding: data, as: UTF8.self).contains("\"id\"") {
            storage.saveStations(saved)
        }
    }

    /// A shown station, saved or visiting, by its id.
    public func station(_ id: UUID) -> GroundStation? {
        shown.first { $0.id == id }
    }

    /// Whether a station is shown only because a link brought it.
    public func isVisiting(_ id: UUID) -> Bool {
        visiting.contains { $0.id == id } && !saved.contains { $0.id == id }
    }

    /// Replaces the saved stations.
    public mutating func setSaved(_ stations: [GroundStation]) {
        let stations = GroundStations.normalized(stations)
        guard stations != saved else {
            return
        }
        saved = stations
        storage.saveStations(stations)
        combine()
    }

    /// Adds a station, and says which it became: the one already there when it
    /// is in the same place under the same name.
    @discardableResult
    public mutating func add(latitude: Double, longitude: Double, name: String? = nil) -> UUID? {
        let added = GroundStation(latitude: latitude, longitude: longitude, name: name)
        guard let place = GroundStations.normalized([added]).first.map(GroundStations.Place.init) else {
            return nil
        }
        setSaved(saved + [added])
        return saved.first { GroundStations.Place($0) == place }?.id
    }

    /// The device's position as the one saved station named "Geolocation", first in
    /// the list as on the web (src/modules/util/groundStationEdits.ts): the first of
    /// that name moved there, keeping its id, or one added, and any others of the
    /// name, which an edit can leave, dropped. Each look from where the user stands
    /// would otherwise leave a station behind.
    @discardableResult
    public mutating func setGeolocation(latitude: Double, longitude: Double) -> UUID? {
        var station = saved.first { $0.name == Self.geolocation } ?? GroundStation(latitude: latitude, longitude: longitude, name: Self.geolocation)
        station.latitude = latitude
        station.longitude = longitude
        setSaved([station] + saved.filter { $0.name != Self.geolocation })
        return saved.contains { $0.id == station.id } ? station.id : nil
    }

    /// Shows a link's stations with this view, without saving them.
    public mutating func setVisiting(_ stations: [GroundStation]) {
        visiting = GroundStations.normalized(stations)
        combine()
    }

    /// Keeps a visiting station among the user's own, under the same id, so what
    /// refers to it carries on.
    public mutating func save(_ id: UUID) {
        guard let station = visiting.first(where: { $0.id == id }) else {
            return
        }
        visiting.removeAll { $0.id == id }
        setSaved(saved + [station])
    }

    /// Shows the saved stations, then the visiting ones that are not in the place of
    /// a saved one.
    private mutating func combine() {
        let places = Set(saved.map(GroundStations.Place.init))
        // A link's station in the place of a saved one is that one, not a visit:
        // kept as a visit, it would ride along in every link from then on, the
        // view kept at a background included, which is how a sky view on a saved
        // station would come back on the next launch.
        visiting.removeAll { places.contains(GroundStations.Place($0)) }
        shown = saved + visiting
    }
}
