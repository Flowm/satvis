import Foundation
import Testing

@testable import SatvisCore

@Suite struct CatalogTests {
    private func catalog() throws -> Catalog {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        var catalog = Catalog()
        catalog.add(Array(records[0..<2]), tags: ["Weather"], group: "weather")
        catalog.add(Array(records[1..<4]), tags: ["Active"], group: "active")
        return catalog
    }

    @Test func keepsASatelliteOnceWithEveryGroupsTags() throws {
        let catalog = try catalog()
        #expect(catalog.entries.count == 4)
        #expect(catalog.entries.values.first { $0.name == "METOP-C" }?.tags == ["Weather", "Active"])
        #expect(catalog.entries.values.first { $0.name == "METOP-C" }?.groups == ["weather", "active"])
        #expect(catalog.search("metop").map(\.name) == ["METOP-C"])
        #expect(catalog.search("25544").map(\.name) == ["ISS (ZARYA)"])
    }

    @Test func activatesByTagLessOptOutsPlusByName() throws {
        let catalog = try catalog()
        let metop = try #require(catalog.entries.values.first { $0.name == "METOP-C" })
        let goes = try #require(catalog.entries.values.first { $0.name == "GOES 19" })
        var activation = Activation(enabledTags: ["Weather"])
        #expect(activation.active(in: catalog).map(\.name) == ["ISS (ZARYA)", "METOP-C"])

        activation.setSatellite(metop, enabled: false)
        activation.setSatellite(goes, enabled: true)
        #expect(activation.active(in: catalog).map(\.name) == ["GOES 19", "ISS (ZARYA)"])
        #expect(activation.active(in: catalog, tracked: "METOP-C").count == 3)

        // A group switched on again takes back its opt-outs.
        activation.setTag("Weather", enabled: true, members: catalog.entries(tagged: "Weather"))
        #expect(activation.disabledSatellites.isEmpty)
        activation.setTag("Active", enabled: false, members: catalog.entries(tagged: "Active"))
        #expect(!activation.enabledSatellites.contains("GOES 19"))
    }
}
