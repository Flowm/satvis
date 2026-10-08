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

@Suite struct CatalogRefreshTests {
    // A group fetched again brings newer element sets; an older one never wins.
    @Test func takesTheNewerElementSet() throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        var catalog = Catalog()
        var changed = catalog.add([records[0]], tags: ["Weather"], group: "weather")
        #expect(changed)
        changed = catalog.add([records[0]], tags: ["Weather"], group: "weather")
        #expect(!changed)

        var newer = records[0]
        newer.meanElements.epoch.dayOfYear += 1
        newer.meanElements.meanAnomaly += 1
        changed = catalog.add([newer], tags: ["Weather"], group: "weather")
        #expect(changed)
        #expect(catalog.entries.values.first?.record == newer)
        changed = catalog.add([records[0]], tags: ["Weather"], group: "weather")
        #expect(!changed)
        #expect(catalog.entries.values.first?.record == newer)
    }

    // A group's newer copy is the whole group: what it no longer serves, renamed
    // or decayed since the copy kept on disk, leaves it.
    @Test func dropsWhatAGroupNoLongerServes() throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        var catalog = Catalog()
        catalog.add(Array(records[0..<2]), tags: ["Weather"], group: "weather")
        catalog.add(Array(records[1..<4]), tags: ["Active"], group: "active")
        var changed = catalog.add([records[2], records[3]], tags: ["Active"], group: "active")
        #expect(changed)

        // METOP-C, still served by Weather, keeps only Weather's tag.
        let metop = try #require(catalog.entries.values.first { $0.name == records[1].name })
        #expect(metop.groups == ["weather"])
        #expect(metop.tags == ["Weather"])
        #expect(catalog.entries.count == 4)

        // Served by no group, it goes.
        changed = catalog.add([records[0]], tags: ["Weather"], group: "weather")
        #expect(changed)
        #expect(!catalog.entries.values.contains { $0.name == records[1].name })
        #expect(catalog.entries.count == 3)
    }
}
