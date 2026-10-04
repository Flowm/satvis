import Foundation
import Testing

@testable import SatvisCore

@Suite struct GroundStationTests {
    @Test func namesAStationWithoutOneByItsCoordinates() {
        #expect(GroundStation(latitude: 48.1351, longitude: 11.582).displayName == "48.14°, 11.58°")
        // JavaScript's toFixed rounds a tie away from zero, where printf would not.
        #expect(GroundStation(latitude: 48.125, longitude: -0.125).displayName == "48.13°, -0.13°")
        #expect(GroundStation(latitude: 1, longitude: 2, name: "Munich").displayName == "Munich")
    }

    @Test func normalizesAsTheWebAppsStoreDoes() {
        let stations = GroundStations.normalized([
            GroundStation(latitude: 48.135_149, longitude: 11.582_04, name: "Munich, DE"),
            GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich  DE"),
            GroundStation(latitude: .nan, longitude: 0),
            GroundStation(latitude: 0, longitude: 0, name: " _ "),
        ])
        #expect(
            stations.map(GroundStations.Place.init)
                == [GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich DE"), GroundStation(latitude: 0, longitude: 0)].map(GroundStations.Place.init))
    }

    @Test func refusesWhatIsNotACoordinate() {
        #expect(GroundStations.coordinate(" 48.5 ", limit: 90) == 48.5)
        #expect(GroundStations.coordinate("-", limit: 90) == nil)
        #expect(GroundStations.coordinate("", limit: 90) == nil)
        #expect(GroundStations.coordinate("91", limit: 90) == nil)
        #expect(GroundStations.coordinate("48abc", limit: 90) == nil)
    }

    @Test func windowAnswersADayEitherSide() {
        let window = PassWindow(around: 1_000_000_000_000)
        #expect(window.covers(1_000_000_000_000 + 86_400_000))
        #expect(!window.covers(1_000_000_000_000 + 86_400_001))
        #expect(window.predictionEnd == 1_000_000_000_000 + 4 * 86_400_000)
    }
}

@Suite struct GroundStationIdentityTests {
    // A station saved before stations had ids reads back with one.
    @Test func givesAStationSavedWithoutAnIdOne() throws {
        let stations = try JSONDecoder().decode([GroundStation].self, from: Data(#"[{"latitude": 48.1351, "longitude": 11.582, "name": "Munich"}]"#.utf8))
        #expect(stations.first?.name == "Munich")
        let again = try JSONDecoder().decode([GroundStation].self, from: JSONEncoder().encode(stations))
        #expect(again == stations)
    }

    // Two stations in one place under one name are one; the first keeps its id.
    @Test func keepsTheFirstOfTwoInOnePlace() {
        let first = GroundStation(latitude: 48.135_149, longitude: 11.582, name: "Munich")
        let second = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")
        #expect(GroundStations.normalized([first, second]).map(\.id) == [first.id])
    }
}
