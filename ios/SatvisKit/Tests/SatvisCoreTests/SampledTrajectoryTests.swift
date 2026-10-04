import Foundation
import Testing
import simd

@testable import SatvisCore

@Suite struct SampledTrajectoryTests {
    // What the grid and the quintic cost against SGP4 itself, which the web app pays
    // too: ParityTests holds the samples to the web app's. The error grows with
    // eccentricity, since a fixed fraction of the period is a long way at perigee
    // (POLAR, e = 0.66, measured 281 m), and the deep-space integrator's 720-minute
    // steps keep even a GEO from being smooth (measured 3 m).
    @Test(arguments: [("ISS (ZARYA)", 10.0), ("METOP-C", 10.0), ("GPS BIIR-5  (PRN 22)", 10.0), ("GOES 19", 5.0), ("POLAR", 400.0)])
    func interpolatesWithinMetresOfSGP4(name: String, tolerance: Double) throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        let record = try #require(records.first { $0.name == name })
        let propagator = try SGP4Propagator(record.meanElements)
        let now = (propagator.epochJulianDate - 2440587.5) * 86_400_000 + 3_600_000
        let trajectory = try #require(SampledTrajectory(propagator, around: now))
        let period = record.approximatePeriodMinutes * 60_000

        var worst = 0.0
        for k in 0..<200 {
            let instant = now - 0.4 * period + Double(k) / 200 * 1.8 * period
            let sampled = try #require(trajectory.position(at: instant))
            let direct = temeToFixed(try propagator.state(epochMilliseconds: instant).position * 1000, epochMilliseconds: instant)
            worst = max(worst, distance(sampled, direct))
        }
        #expect(worst < tolerance, "\(name): \(worst) m")
    }

    @Test func centresTheStencilOnTheInstant() throws {
        let record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first)
        let propagator = try SGP4Propagator(record.meanElements)
        let now = (propagator.epochJulianDate - 2440587.5) * 86_400_000
        let trajectory = try #require(SampledTrajectory(propagator, around: now))
        let (_, offset) = try #require(trajectory.stencil(at: now))
        #expect((2..<3).contains(offset))
        #expect(trajectory.isFresh(at: now))
        #expect(!trajectory.isFresh(at: now + 0.6 * record.approximatePeriodMinutes * 60_000))
        #expect(trajectory.position(at: now + 3 * record.approximatePeriodMinutes * 60_000) == nil)
    }

    // The Sun is north of the equator in June and south in December, and over the
    // Greenwich meridian at about noon UTC.
    @Test func putsTheSunWhereItIs() throws {
        let june = try #require(utcMilliseconds(iso: "2026-06-21T12:00:00"))
        let december = try #require(utcMilliseconds(iso: "2026-12-21T12:00:00"))
        #expect(abs(asin(Sun.directionFixed(epochMilliseconds: june).z) * 180 / .pi - 23.44) < 0.1)
        #expect(abs(asin(Sun.directionFixed(epochMilliseconds: december).z) * 180 / .pi + 23.44) < 0.1)
        let noon = Sun.directionFixed(epochMilliseconds: june)
        #expect(abs(atan2(noon.y, noon.x) * 180 / .pi) < 1)
    }
}

@Suite struct TrajectoryStoreTests {
    @Test func samplesOnceAndRefillsOnlyWhatGoesStale() async throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        let store = TrajectoryStore()
        await store.replace(with: records + records)
        let iss = try SGP4Propagator(records[0].meanElements)
        let now = (iss.epochJulianDate - 2440587.5) * 86_400_000

        let first = try #require(await store.refresh(at: now))
        #expect(first.count == records.count)
        #expect(await store.refresh(at: now + 60_000) == nil)
        // Half an orbit on, the ISS needs a new window; the slower orbits do not.
        let later = try #require(await store.refresh(at: now + 0.6 * records[0].approximatePeriodMinutes * 60_000))
        #expect(later.count == records.count)
    }
}

@Suite struct TrajectoryStoreReplaceTests {
    @Test func keepsTheWindowsOfSatellitesThatStay() async throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        let store = TrajectoryStore()
        await store.replace(with: Array(records[0..<2]))
        let now = (try SGP4Propagator(records[0].meanElements).epochJulianDate - 2440587.5) * 86_400_000
        let before = try #require(await store.refresh(at: now))

        await store.replace(with: Array(records[0..<1]))
        let after = try #require(await store.refresh(at: now))
        #expect(after.map(\.record.name) == ["ISS (ZARYA)"])
        #expect(after[0].trajectory.firstIndex == before[0].trajectory.firstIndex)
        #expect(after[0].trajectory.positions == before[0].trajectory.positions)
    }
}
