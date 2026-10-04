import Foundation
import Testing

@testable import SatvisCore

@Suite struct PassStoreTests {
    private func entries() throws -> [CatalogEntry] {
        var catalog = Catalog()
        catalog.add(try GPRecord.decodePayload(Parity.fixture("parity-input")), tags: ["parity"])
        return catalog.entries(tagged: "parity")
    }

    private let munich = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")

    @Test func predictsEverySatelliteOverTheStations() async throws {
        let entries = try entries()
        let iss = try #require(entries.first { $0.name == "ISS (ZARYA)" })
        let geo = try #require(entries.first { $0.name == "GOES 19" })
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        #expect(await store.passes(of: entries, at: time).isEmpty)

        await store.configure(.init(stations: [munich], mode: .elevation))
        let passes = await store.passes(of: entries, at: time)
        #expect(passes.count == entries.count)
        let issPasses = try #require(passes[iss.id])
        #expect(!issPasses.isEmpty)
        #expect(issPasses.allSatisfy { $0.satellite == iss.id && $0.satelliteName == iss.name && $0.station == "Munich" })
        #expect(issPasses.first!.start >= time - 86_400_000)
        #expect(issPasses.last!.start <= time + 4 * 86_400_000)
        // Geostationary: the web app predicts nothing.
        #expect(passes[geo.id] == [])
    }

    @Test func forgetsPredictionsWhenTheModeChanges() async throws {
        let entries = try entries().filter { $0.name == "METOP-C" }
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        await store.configure(.init(stations: [munich], mode: .elevation))
        let elevation = await store.passes(of: entries, at: time)
        await store.configure(.init(stations: [munich], mode: .swath))
        let swath = await store.passes(of: entries, at: time)
        guard case .elevation = elevation.values.first?.first?.measure, case .swath = swath.values.first?.first?.measure else {
            Issue.record("expected one elevation and one swath pass list")
            return
        }
    }
}
