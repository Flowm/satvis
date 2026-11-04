import Foundation
import Testing

@testable import SatvisCore

@Suite final class StationListTests {
    private let munich = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")
    private let berlin = GroundStation(latitude: 52.52, longitude: 13.405, name: "Berlin")
    /// The defaults `storage(stationJSON:)` made, removed after each test.
    private var suites: [String] = []

    deinit {
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
    }

    /// Storage over defaults of its own, holding `stationJSON` as the saved stations.
    private func storage(stationJSON: String? = nil) -> StationStorage {
        let suite = UUID().uuidString
        suites.append(suite)
        let storage = StationStorage(defaults: UserDefaults(suiteName: suite)!)
        if let stationJSON {
            storage.setStationData(Data(stationJSON.utf8))
        }
        return storage
    }

    @Test func keepsTheListAndModeInTheStorage() {
        let storage = storage()
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
        let storage = storage(stationJSON: #"[{"latitude": 48.1351, "longitude": 11.582, "name": "Munich"}]"#)
        let list = StationList(storage: storage)
        #expect(list.saved.map(\.name) == ["Munich"])
        #expect(storage.stations().map(\.id) == list.saved.map(\.id))
        #expect(StationList(storage: storage).saved.map(\.id) == list.saved.map(\.id))
    }

    // A station that does not decode drops alone, not the whole list.
    @Test func readsTheStationsThatDecode() {
        let storage = storage(stationJSON: #"[{"latitude": 48.1351, "longitude": 11.582, "name": "Munich"}, {"latitude": "north"}]"#)
        #expect(StationList(storage: storage).saved.map(\.name) == ["Munich"])
    }

    @Test func showsALinksStationInASavedOnesPlaceOnce() {
        var list = StationList(storage: storage())
        list.setSaved([munich])
        list.setVisiting([GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich"), berlin])
        #expect(list.visiting.map(\.id) == [berlin.id])
        #expect(list.shown.map(\.id) == [munich.id, berlin.id])
        #expect(list.isVisiting(berlin.id))
        #expect(!list.isVisiting(munich.id))
    }

    @Test func savesAVisitUnderItsId() {
        let storage = storage()
        var list = StationList(storage: storage)
        list.setSaved([munich])
        list.setVisiting([berlin])
        list.save(berlin.id)
        #expect(list.visiting.isEmpty)
        #expect(list.saved.map(\.id) == [munich.id, berlin.id])
        #expect(storage.stations().map(\.id) == [munich.id, berlin.id])
        #expect(!list.isVisiting(berlin.id))
    }

    @Test func removesASavedStationOrALinks() {
        let storage = storage()
        var list = StationList(storage: storage)
        list.setSaved([munich])
        list.setVisiting([berlin])
        list.remove(berlin.id)
        #expect(list.visiting.isEmpty)
        list.remove(munich.id)
        #expect(list.shown.isEmpty)
        #expect(storage.stations().isEmpty)
    }

    @Test func answersAnAddInAStationsPlaceWithThatStation() {
        var list = StationList(storage: storage())
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
        var list = StationList(storage: storage())
        let here = GroundStation(latitude: 1, longitude: 2, name: StationList.geolocation)
        let again = GroundStation(latitude: 3, longitude: 4, name: StationList.geolocation)
        list.setSaved([munich, here, again])
        let id = list.setGeolocation(latitude: 10, longitude: 20)
        #expect(id == here.id)
        #expect(list.saved.map(\.id) == [here.id, munich.id])
        #expect(list.saved.first?.latitude == 10)

        var fresh = StationList(storage: storage())
        let added = fresh.setGeolocation(latitude: 10, longitude: 20)
        #expect(fresh.saved.map(\.id) == [added])
    }
}
