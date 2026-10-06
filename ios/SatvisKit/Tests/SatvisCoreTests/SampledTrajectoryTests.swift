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

    // Two catalog entries sharing a catalog number under two names are both drawn,
    // as the catalog keeps both.
    @Test func drawsEachCatalogEntrySharingANumber() async throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        var renamed = records[0]
        renamed.name = "ISS (RENAMED)"
        let store = TrajectoryStore()
        await store.replace(with: [records[0], renamed])
        let now = (try SGP4Propagator(records[0].meanElements).epochJulianDate - 2440587.5) * 86_400_000
        let drawn = try #require(await store.refresh(at: now))
        #expect(Set(drawn.map(\.record.name)) == ["ISS (ZARYA)", "ISS (RENAMED)"])
    }
}

/// A low orbit with heavy drag, which SGP4 gives up on a few weeks after its epoch.
@Suite struct DecayTests {
    private let record: GPRecord
    private let propagator: SGP4Propagator
    private let epoch: Double
    /// The first whole minute SGP4 refuses.
    private let decay: Double

    init() throws {
        let json = """
            [{"OBJECT_NAME": "DECAYING", "NORAD_CAT_ID": 99999, "EPOCH": "2026-10-01T00:00:00", "MEAN_MOTION": 16.2,
              "ECCENTRICITY": 0.0005, "INCLINATION": 51.6, "RA_OF_ASC_NODE": 10, "ARG_OF_PERICENTER": 20, "MEAN_ANOMALY": 30,
              "BSTAR": 0.0005, "MEAN_MOTION_DOT": 0.001, "MEAN_MOTION_DDOT": 0}]
            """
        record = try #require(try GPRecord.decodePayload(Data(json.utf8)).first)
        propagator = try SGP4Propagator(record.meanElements)
        epoch = try #require(utcMilliseconds(iso: "2026-10-01T00:00:00"))
        var minute = 0.0
        while (try? propagator.state(epochMilliseconds: epoch + minute * 60_000)) != nil {
            minute += 1
            try #require(minute < 200 * 1440, "never decays")
        }
        decay = epoch + minute * 60_000
    }

    // Hidden only where the interpolation needs a refused node, as the web app's
    // sampler skips each refused instant on its own.
    @Test func samplesUpToTheDecay() throws {
        let trajectory = try #require(SampledTrajectory(propagator, around: decay - 600_000))
        #expect(trajectory.positions.contains { $0.x.isNaN })
        #expect(trajectory.position(at: decay - 1_200_000) != nil)
        #expect(trajectory.position(at: decay + 60_000) == nil)
        #expect(SampledTrajectory(propagator, around: decay + 7 * 86_400_000) == nil)
    }

    // The renderer finds thousands of stencils a frame from a few numbers each
    // (`SampledTrajectory.stencil(at:anchor:…)`), and checks the nodes only of a
    // window that is not complete: the two agree at every instant, refused nodes
    // and the window's edges included.
    @Test func findsTheSameStencilFromTheWindowsBounds() throws {
        let trajectory = try #require(SampledTrajectory(propagator, around: decay - 600_000))
        let whole = try #require(SampledTrajectory(propagator, around: decay - 3 * 86_400_000))
        #expect(!trajectory.isComplete && whole.isComplete)
        for window in [trajectory, whole] {
            let start = window.anchorMilliseconds + Double(window.firstIndex) * window.stepMilliseconds
            for step in stride(from: -2.0, through: Double(window.positions.count) + 2, by: 0.37) {
                let instant = start + step * window.stepMilliseconds
                let packed = SampledTrajectory.stencil(
                    at: instant, anchor: window.anchorMilliseconds, step: window.stepMilliseconds, firstIndex: window.firstIndex,
                    count: window.positions.count)
                if window.isComplete {
                    #expect(packed?.start == window.stencil(at: instant)?.start && packed?.offset == window.stencil(at: instant)?.offset)
                } else if let found = window.stencil(at: instant) {
                    #expect(packed?.start == found.start && packed?.offset == found.offset)
                }
            }
        }
    }

    // Scrubbed past the decay and back, it is drawn again.
    @Test func bringsItBackWhenTheClockReturns() async throws {
        let store = TrajectoryStore()
        await store.replace(with: [record])
        #expect(await store.refresh(at: epoch)?.count == 1)
        #expect(await store.refresh(at: decay + 7 * 86_400_000)?.count == 0)
        #expect(await store.refresh(at: decay + 7 * 86_400_000 + 60_000) == nil)
        #expect(await store.refresh(at: epoch)?.count == 1)
        await store.replace(with: [record])
        #expect(await store.refresh(at: epoch)?.count == 1)
    }
}

@Suite struct MalformedRecordTests {
    // A number no Int holds is dropped, not a crash: `Double("nan")` parses.
    @Test func survivesNumbersNoIntegerHolds() throws {
        let json = """
            [{"OBJECT_NAME": "ODD", "NORAD_CAT_ID": 1e20, "EPOCH": "2026-10-01T00:00:00", "MEAN_MOTION": 15, "ECCENTRICITY": 0.001,
              "INCLINATION": 51.6, "RA_OF_ASC_NODE": 10, "ARG_OF_PERICENTER": 20, "MEAN_ANOMALY": 30, "BSTAR": 0,
              "MEAN_MOTION_DOT": 0, "MEAN_MOTION_DDOT": 0, "EPHEMERIS_TYPE": "nan", "ELEMENT_SET_NO": 1e300, "REV_AT_EPOCH": "inf"}]
            """
        let records = try GPRecord.decodePayload(Data(json.utf8))
        #expect(records.count == 1)
        if case .omm(let omm) = records.first?.elements {
            #expect(omm.ephemerisType == nil && omm.elementSetNo == nil && omm.revAtEpoch == nil)
        }
    }
}
