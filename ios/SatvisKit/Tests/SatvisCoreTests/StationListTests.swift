import Foundation
import Testing

@testable import SatvisCore

/// The other side of the storage seam from the app's `UserDefaults`.
private final class MemoryStationStorage: StationStorage {
    var stationJSON: Data?
    var modeRaw: String?

    init(stationJSON: Data? = nil) {
        self.stationJSON = stationJSON
    }

    func stationData() -> Data? { stationJSON }
    func setStationData(_ data: Data) { stationJSON = data }
    func modeName() -> String? { modeRaw }
    func setModeName(_ name: String) { modeRaw = name }
}

@Suite struct StationListTests {
    private let munich = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")
    private let berlin = GroundStation(latitude: 52.52, longitude: 13.405, name: "Berlin")

    @Test func keepsTheListAndModeInTheStorage() {
        let storage = MemoryStationStorage()
        var list = StationList(storage: storage)
        #expect(list.saved.isEmpty)
        list.setSaved([munich, berlin])
        storage.saveMode(.swath)

        let again = StationList(storage: storage)
        #expect(again.saved == [munich, berlin])
        #expect(storage.passSettings == PassStore.Settings(stations: [munich, berlin], mode: .swath))
    }

    // Saved before stations had ids: read once, the ids given are saved back,
    // so every later read, the background refresh's too, has the same ones.
    @Test func keepsTheIdsGivenToAnOldList() {
        let storage = MemoryStationStorage(stationJSON: Data(#"[{"latitude": 48.1351, "longitude": 11.582, "name": "Munich"}]"#.utf8))
        let list = StationList(storage: storage)
        #expect(list.saved.map(\.name) == ["Munich"])
        #expect(storage.stations().map(\.id) == list.saved.map(\.id))
        #expect(StationList(storage: storage).saved.map(\.id) == list.saved.map(\.id))
    }

    @Test func showsALinksStationInASavedOnesPlaceOnce() {
        var list = StationList(storage: MemoryStationStorage())
        list.setSaved([munich])
        list.setVisiting([GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich"), berlin])
        #expect(list.visiting.map(\.id) == [berlin.id])
        #expect(list.shown.map(\.id) == [munich.id, berlin.id])
        #expect(list.isVisiting(berlin.id))
        #expect(!list.isVisiting(munich.id))
    }

    @Test func savesAVisitUnderItsId() {
        let storage = MemoryStationStorage()
        var list = StationList(storage: storage)
        list.setSaved([munich])
        list.setVisiting([berlin])
        list.save(berlin.id)
        #expect(list.visiting.isEmpty)
        #expect(list.saved.map(\.id) == [munich.id, berlin.id])
        #expect(storage.stations().map(\.id) == [munich.id, berlin.id])
        #expect(!list.isVisiting(berlin.id))
    }

    @Test func answersAnAddInAStationsPlaceWithThatStation() {
        var list = StationList(storage: MemoryStationStorage())
        list.setSaved([munich])
        #expect(list.add(latitude: 48.135_149, longitude: 11.582, name: "Munich") == munich.id)
        #expect(list.saved.count == 1)
        let added = list.add(latitude: 52.52, longitude: 13.405)
        #expect(added != nil && list.station(added!) != nil)
        #expect(list.add(latitude: 91, longitude: 0) == nil)
    }

    // Each look from where the user stands moves the one Geolocation station,
    // to the front, and drops any others of the name an edit left.
    @Test func keepsOneGeolocationFirst() {
        var list = StationList(storage: MemoryStationStorage())
        let here = GroundStation(latitude: 1, longitude: 2, name: StationList.geolocation)
        let again = GroundStation(latitude: 3, longitude: 4, name: StationList.geolocation)
        list.setSaved([munich, here, again])
        let id = list.setGeolocation(latitude: 10, longitude: 20)
        #expect(id == here.id)
        #expect(list.saved.map(\.id) == [here.id, munich.id])
        #expect(list.saved.first?.latitude == 10)

        var fresh = StationList(storage: MemoryStationStorage())
        let added = fresh.setGeolocation(latitude: 10, longitude: 20)
        #expect(fresh.saved.map(\.id) == [added])
    }
}
