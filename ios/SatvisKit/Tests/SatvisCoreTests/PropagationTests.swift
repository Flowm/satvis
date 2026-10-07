import Foundation
import Testing

@testable import SatvisCore

@Suite struct PropagationTests {
    private static let iss = MeanElements(
        epoch: .init(year: 2026, dayOfYear: 275.46549369), meanMotion: 15.48710782, eccentricity: 0.00069284, inclination: 51.6316,
        raOfAscNode: 140.1, argOfPericenter: 30.2, meanAnomaly: 329.9, bstar: 0.00025, meanMotionDot: 0.00013, meanMotionDDot: 0)

    // The deep-space integrator goes on in place from its last step: whatever was
    // asked before, the state is the one a fresh propagator gives.
    @Test func givesTheSameDeepSpaceStatesInAnyOrder() throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        for name in ["GOES 19", "POLAR", "GPS BIIR-5  (PRN 22)"] {
            let record = try #require(records.first { $0.name == name })
            let reused = try SGP4Propagator(record.meanElements)
            let day = 1440.0
            for minutes in [0, 30 * day, 120 * day, 45.5 * day, -10 * day, 200 * day, 120 * day] {
                let fresh = try SGP4Propagator(record.meanElements).state(minutesSinceEpoch: minutes)
                #expect(try reused.state(minutesSinceEpoch: minutes) == fresh, "\(name) at \(minutes / day) days")
            }
        }
    }

    @Test func refusesElementsSGP4Rejects() {
        var hyperbolic = Self.iss
        hyperbolic.eccentricity = 1.2
        #expect(throws: SGP4Error.eccentricityOutOfRange) {
            try SGP4Propagator(hyperbolic)
        }
    }

    @Test func staysAtTheISSAltitude() throws {
        let state = try SGP4Propagator(Self.iss).state(minutesSinceEpoch: 90)
        let altitude = (state.position * state.position).sum().squareRoot() - 6378.135
        #expect((380...440).contains(altitude))
    }

    // As a JavaScript Date reads it, which is how the web app sets its epoch.
    @Test func truncatesTheEpochToTheMillisecond() {
        #expect(utcMilliseconds(iso: "2026-10-02T11:10:18.655999") == utcMilliseconds(iso: "2026-10-02T11:10:18.655Z"))
        #expect(utcMilliseconds(iso: "1970-01-01T00:00:01.5") == 1500)
        #expect(utcMilliseconds(iso: "2026-10-02") == nil)
    }

    @Test func readsAnOMMAndTheSameElementsAsATLEAlike() throws {
        let tle = try #require(
            MeanElements(
                tleLine1: "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753", line2: "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"))
        #expect(tle.epoch == .init(year: 2000, dayOfYear: 179.78495062))
        #expect(tle.eccentricity == 0.1859667)
        #expect(tle.bstar == 0.28098e-4)
        #expect(tle.meanMotion == 10.82419157)
    }
}
