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

    // The settings went away and came back before the store heard: it is told
    // to forget anyway, and predicts again under the same settings.
    @Test func predictsAgainAfterAReset() async throws {
        let entries = try entries().filter { $0.name == "METOP-C" }
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        await store.configure(.init(stations: [munich], mode: .elevation))
        #expect(await store.predict(entries, at: time).count == 1)
        #expect(await store.predict(entries, at: time).isEmpty)
        await store.reset()
        await store.configure(.init(stations: [munich], mode: .elevation))
        #expect(await store.predict(entries, at: time).count == 1)
    }

    // A station added is predicted alone, keeping the others' passes, and comes
    // out as a prediction over every station from scratch would; one removed
    // leaves nothing to predict.
    @Test func predictsAnAddedStationAlone() async throws {
        let entries = try entries()
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let berlin = GroundStation(latitude: 52.52, longitude: 13.405, name: "Berlin")
        let store = PassStore()
        await store.configure(.init(stations: [munich], mode: .elevation))
        let alone = await store.predict(entries, at: time)

        await store.configure(.init(stations: [munich, berlin], mode: .elevation))
        let added = await store.predict(entries, at: time)
        let fresh = PassStore()
        await fresh.configure(.init(stations: [munich, berlin], mode: .elevation))
        let both = await fresh.predict(entries, at: time)
        #expect(added.mapValues(\.passes) == both.mapValues(\.passes))
        for (id, prediction) in added {
            #expect(prediction.passes.filter { $0.stationID == munich.id } == alone[id]?.passes)
            #expect(prediction.window == alone[id]?.window)
        }

        await store.configure(.init(stations: [munich], mode: .elevation))
        #expect(await store.predict(entries, at: time).isEmpty)
        #expect(await store.passes(of: entries, at: time) == alone.mapValues(\.passes))
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

@Suite struct PassStoreRepredictionTests {
    private let munich = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")

    // Only what has to be predicted again comes back, so a caller holding the
    // rest has nothing to redo.
    @Test func returnsOnlyWhatItPredictedAgain() async throws {
        var catalog = Catalog()
        catalog.add(try GPRecord.decodePayload(Parity.fixture("parity-input")), tags: ["parity"])
        let entries = catalog.entries(tagged: "parity")
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        await store.configure(.init(stations: [munich], mode: .elevation))

        #expect(await store.predict(entries, at: time).count == entries.count)
        #expect(await store.predict(entries, at: time + 3_600_000).isEmpty)
        // Out of the window: everything again.
        #expect(await store.predict(entries, at: time + 2 * 86_400_000).count == entries.count)

        // A newer element set for one satellite: that one again.
        var newer = entries[0]
        newer.record.meanElements.meanAnomaly += 1
        let again = await store.predict([newer] + entries.dropFirst(), at: time + 2 * 86_400_000)
        #expect(Array(again.keys) == [newer.id])
    }
}
