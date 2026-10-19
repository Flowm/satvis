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
    private let berlin = GroundStation(latitude: 52.52, longitude: 13.405, name: "Berlin")

    @Test func predictsEverySatelliteOverTheStations() async throws {
        let entries = try entries()
        let iss = try #require(entries.first { $0.name == "ISS (ZARYA)" })
        let geo = try #require(entries.first { $0.name == "GOES 19" })
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        #expect(await store.predict(entries, at: time).isEmpty)
        #expect(await store.snapshot.passes(of: iss.id, at: time, under: .init()) == [])

        let settings = PassStore.Settings(stations: [munich], mode: .elevation)
        await store.configure(settings)
        #expect(await store.predict(entries, at: time).count == entries.count)
        let snapshot = await store.snapshot
        let issPasses = try #require(snapshot.passes(of: iss.id, at: time, under: settings))
        #expect(!issPasses.isEmpty)
        #expect(issPasses.allSatisfy { $0.satellite == iss.id && $0.satelliteName == iss.name && $0.station == "Munich" })
        #expect(issPasses.first!.start >= time - 86_400_000)
        #expect(issPasses.last!.start <= time + 4 * 86_400_000)
        // Geostationary: the web app predicts nothing.
        #expect(snapshot.passes(of: geo.id, at: time, under: settings) == [])
        // Not yet, outside the window it was predicted for.
        #expect(snapshot.passes(of: iss.id, at: time + 2 * 86_400_000, under: settings) == nil)
    }

    // A snapshot asked under another mode has nothing yet, and under the mode it
    // was predicted in, its passes, however the mode went back and forth before
    // the store heard. A store that hears of the change forgets, and predicts
    // again when the mode comes back.
    @Test func predictsAgainWhenTheModeChangesAndChangesBack() async throws {
        let entries = try entries().filter { $0.name == "METOP-C" }
        let id = try #require(entries.first?.id)
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let elevation = PassStore.Settings(stations: [munich], mode: .elevation)
        let swath = PassStore.Settings(stations: [munich], mode: .swath)
        let store = PassStore()
        await store.configure(elevation)
        #expect(await store.predict(entries, at: time).count == 1)
        #expect(await store.predict(entries, at: time).isEmpty)
        let snapshot = await store.snapshot
        #expect(snapshot.passes(of: id, at: time, under: swath) == nil)
        #expect(snapshot.heldPasses(of: id, under: swath).isEmpty)
        #expect(snapshot.passes(of: id, at: time, under: elevation) != nil)

        await store.configure(swath)
        #expect(await store.snapshot.passes(of: id, at: time, under: elevation) == nil)
        await store.configure(elevation)
        #expect(await store.predict(entries, at: time).count == 1)
    }

    // A station added is predicted alone, keeping the others' passes, and comes
    // out as a prediction over every station from scratch would.
    @Test func predictsAnAddedStationAlone() async throws {
        let entries = try entries()
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let one = PassStore.Settings(stations: [munich], mode: .elevation)
        let two = PassStore.Settings(stations: [munich, berlin], mode: .elevation)
        let store = PassStore()
        await store.configure(one)
        await store.predict(entries, at: time)
        let alone = await store.snapshot

        // Until predicted, Berlin is missing, and Munich's passes stay.
        await store.configure(two)
        let added = await store.snapshot
        for entry in entries {
            #expect(added.passes(of: entry.id, at: time, under: two) == nil)
            #expect(added.passes(of: entry.id, at: time, under: one) == alone.passes(of: entry.id, at: time, under: one))
        }

        await store.predict(entries, at: time)
        let both = await store.snapshot
        let fresh = PassStore()
        await fresh.configure(two)
        await fresh.predict(entries, at: time)
        let scratch = await fresh.snapshot
        for entry in entries {
            let passes = both.passes(of: entry.id, at: time, under: two)
            #expect(passes != nil)
            #expect(passes == scratch.passes(of: entry.id, at: time, under: two))
            #expect(passes?.filter { $0.stationID == munich.id } == alone.passes(of: entry.id, at: time, under: one))
        }
    }

    // A station removed: its passes go, from a snapshot asked under the new
    // stations at once, and from the store when it hears, with nothing to
    // predict.
    @Test func trimsARemovedStationsPasses() async throws {
        let entries = try entries()
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let one = PassStore.Settings(stations: [munich], mode: .elevation)
        let two = PassStore.Settings(stations: [munich, berlin], mode: .elevation)
        let store = PassStore()
        await store.configure(two)
        await store.predict(entries, at: time)
        let before = await store.snapshot
        let iss = try #require(entries.first { $0.name == "ISS (ZARYA)" })
        #expect(before.passes(of: iss.id, at: time, under: two)?.contains { $0.stationID == berlin.id } == true)
        #expect(before.passes(of: iss.id, at: time, under: one)?.allSatisfy { $0.stationID == munich.id } == true)
        #expect(before.heldPasses(of: iss.id, under: one).allSatisfy { $0.stationID == munich.id })

        await store.configure(one)
        #expect(await store.predict(entries, at: time).isEmpty)
        let after = await store.snapshot
        for entry in entries {
            #expect(after.passes(of: entry.id, at: time, under: one) == before.passes(of: entry.id, at: time, under: one))
        }
    }

    // A station's view lists two days ahead, by start, and counts the satellites
    // answered, those asked over that station alone included.
    @Test func showsAStationsTwoDaysAndHowFarItGot() async throws {
        let entries = try entries()
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let two = PassStore.Settings(stations: [munich, berlin], mode: .elevation)
        let store = PassStore()
        await store.configure(two)
        let half = Array(entries.prefix(entries.count / 2))
        await store.predict(half, at: time, over: [munich])

        let partial = await store.snapshot.passes(over: munich, of: entries, from: time, under: two)
        #expect(partial.predicted == half.count)
        #expect(!partial.settled)
        #expect(await store.snapshot.passes(over: berlin, of: entries, from: time, under: two).predicted == 0)

        await store.predict(entries, at: time, over: [munich])
        let snapshot = await store.snapshot
        let view = snapshot.passes(over: munich, of: entries, from: time, under: two)
        #expect(view.settled && view.predicted == entries.count)
        #expect(!view.passes.isEmpty)
        #expect(view.passes.allSatisfy { $0.stationID == munich.id && $0.start - time < 48 * 3_600_000 })
        #expect(view.passes.map(\.start) == view.passes.map(\.start).sorted())
        let all = entries.flatMap { snapshot.heldPasses(of: $0.id, under: two) }.filter { $0.stationID == munich.id && $0.start - time < 48 * 3_600_000 }
        #expect(view.passes.count == all.count)
        // Asked again, from the same snapshot, the kept list answers.
        #expect(snapshot.passes(over: munich, of: entries, from: time, under: two).passes == view.passes)
        #expect(snapshot.passes(over: munich, of: entries, from: time, under: .init(stations: [munich], mode: .swath)).predicted == 0)
    }

    // Settings changed while a prediction ran: what it worked out is dropped.
    @Test func dropsAPredictionMadeUnderOldSettings() async throws {
        let entries = try entries().filter { $0.name == "METOP-C" }
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let store = PassStore()
        await store.configure(.init(stations: [munich], mode: .elevation))
        let plan = await store.plan(entries, at: time)
        #expect(plan.jobs.count == 1)
        await store.configure(.init(stations: [munich], mode: .swath))
        let revision = await store.snapshot.revision
        #expect(await store.land(await PassStore.run(plan), of: plan).isEmpty)
        #expect(await store.snapshot.revision == revision)
        #expect(await store.snapshot.heldPasses(of: entries[0].id, under: .init(stations: [munich], mode: .swath)).isEmpty)
    }

    @Test func forgetsPredictionsWhenTheModeChanges() async throws {
        let entries = try entries().filter { $0.name == "METOP-C" }
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let elevation = PassStore.Settings(stations: [munich], mode: .elevation)
        let swath = PassStore.Settings(stations: [munich], mode: .swath)
        let store = PassStore()
        await store.configure(elevation)
        await store.predict(entries, at: time)
        let first = await store.snapshot.passes(of: entries[0].id, at: time, under: elevation)
        await store.configure(swath)
        await store.predict(entries, at: time)
        let second = await store.snapshot.passes(of: entries[0].id, at: time, under: swath)
        guard case .elevation = first?.first?.measure, case .swath = second?.first?.measure else {
            Issue.record("expected one elevation and one swath pass list")
            return
        }
    }

    @Test func forgetsSatellitesNoLongerShown() async throws {
        let entries = try entries()
        let time = try #require(utcMilliseconds(iso: "2026-10-02T12:00:00"))
        let settings = PassStore.Settings(stations: [munich], mode: .elevation)
        let store = PassStore()
        await store.configure(settings)
        await store.predict(entries, at: time)
        let revision = await store.snapshot.revision
        await store.keep(only: Set(entries.map(\.id)))
        #expect(await store.snapshot.revision == revision)
        await store.keep(only: [entries[0].id])
        #expect(await store.snapshot.revision != revision)
        #expect(await store.snapshot.passes(of: entries[1].id, at: time, under: settings) == nil)
        #expect(await store.predict(entries, at: time).count == entries.count - 1)
    }
}

@Suite struct PassStoreRepredictionTests {
    private let munich = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Munich")

    // Only what has to be predicted again is.
    @Test func predictsOnlyWhatIsMissing() async throws {
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
        #expect(Array(again) == [newer.id])
    }
}
