import Foundation
import Testing
import simd

@testable import SatvisCore

/// The answers the web app's own code gives for the same element sets
/// (scripts/parity/generate.mjs). Regenerate them; never edit them.
struct Parity: Decodable {
    struct Parsed: Decodable {
        let name: String
        let satnum: String
        let orbitClass: OrbitClass
        let approximatePeriodMinutes: Double
    }

    struct HourAngle: Decodable {
        let instant: String
        let radians: Double
    }

    struct Geodetic: Decodable {
        let latitude: Double
        let longitude: Double
        let height: Double
        let velocity: Double
    }

    struct State: Decodable {
        let record: Int
        let instant: String
        let geodetic: Geodetic
        let temePositionKm: [Double]
        let temeVelocityKmPerSecond: [Double]
        let fixedPositionMetres: [Double]
    }

    struct Grid: Decodable {
        struct Sample: Decodable {
            let index: Int
            let fixedPositionMetres: [Double]
        }

        let record: Int
        let anchorEpochMs: Double
        let stepSeconds: Double
        let samples: [Sample]
    }

    let parsed: [Parsed]
    let propagation: [State]
    let grids: [Grid]
    let greenwichHourAngle: [HourAngle]

    static func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    static func load() throws -> Parity {
        try JSONDecoder().decode(Parity.self, from: fixture("parity"))
    }
}

@Suite struct ParityTests {
    @Test func parsesLikeTheWebApp() throws {
        let parity = try Parity.load()
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        #expect(records.count == parity.parsed.count)
        for (record, expected) in zip(records, parity.parsed) {
            #expect(record.name == expected.name)
            #expect(record.satnum == expected.satnum)
            #expect(record.orbitClass == expected.orbitClass, "\(expected.name)")
            #expect(abs(record.approximatePeriodMinutes - expected.approximatePeriodMinutes) < 1e-9, "\(expected.name)")
        }
    }

    // satellite.js and Vallado's C++ are the same algorithm, and agree to under a
    // micrometre. ADR 0008 allows a metre; held to a centimetre so that a mistake
    // in setting up the satrec, which costs metres, cannot hide in the margin.
    @Test func propagatesLikeTheWebApp() throws {
        let parity = try Parity.load()
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        for expected in parity.propagation {
            let record = records[expected.record]
            let instant = try #require(utcMilliseconds(iso: expected.instant))
            let state = try SGP4Propagator(record.meanElements).state(epochMilliseconds: instant)

            let position = SIMD3(expected.temePositionKm[0], expected.temePositionKm[1], expected.temePositionKm[2])
            let velocity = SIMD3(expected.temeVelocityKmPerSecond[0], expected.temeVelocityKmPerSecond[1], expected.temeVelocityKmPerSecond[2])
            let angle = greenwichHourAngle(epochMilliseconds: instant)
            let (c, s) = (cos(angle), sin(angle))
            let p = state.position * 1000
            let fixed = SIMD3(c * p.x + s * p.y, -s * p.x + c * p.y, p.z)
            let expectedFixed = SIMD3(expected.fixedPositionMetres[0], expected.fixedPositionMetres[1], expected.fixedPositionMetres[2])

            let errors = (distance(state.position, position) * 1000, distance(state.velocity, velocity) * 1000, distance(fixed, expectedFixed))
            #expect(errors.0 < 0.01, "\(record.name) at \(expected.instant): \(errors.0) m")
            #expect(errors.1 < 0.0001, "\(record.name) at \(expected.instant): \(errors.1) m/s")
            #expect(errors.2 < 0.01, "\(record.name) at \(expected.instant): \(errors.2) m in the fixed frame")

            // The info panel's live strip.
            let live = try SGP4Propagator(record.meanElements).livePosition(epochMilliseconds: instant)
            #expect(abs(live.latitude - expected.geodetic.latitude) < 1e-7, "\(record.name)")
            #expect(abs(live.longitude - expected.geodetic.longitude) < 1e-7, "\(record.name)")
            #expect(abs(live.height - expected.geodetic.height) < 0.01, "\(record.name)")
            #expect(abs(live.speed - expected.geodetic.velocity) < 1e-9, "\(record.name)")
        }
    }

    // The same grid as the web app's sampler, sample for sample, so the two
    // interpolate the same nodes with the same basis.
    @Test func samplesTheWebAppsGrid() throws {
        let parity = try Parity.load()
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        for grid in parity.grids {
            let record = records[grid.record]
            let propagator = try SGP4Propagator(record.meanElements)
            let trajectory = try #require(SampledTrajectory(propagator, around: grid.anchorEpochMs + 3_600_000))
            #expect(abs(trajectory.anchorMilliseconds - grid.anchorEpochMs) < 1e-3, "\(record.name)")
            #expect(abs(trajectory.stepMilliseconds - grid.stepSeconds * 1000) < 1e-6, "\(record.name)")
            for sample in grid.samples {
                let position = trajectory.positions[sample.index - trajectory.firstIndex]
                let expected = SIMD3(sample.fixedPositionMetres[0], sample.fixedPositionMetres[1], sample.fixedPositionMetres[2])
                #expect(distance(position, expected) < 0.01, "\(record.name) sample \(sample.index)")
            }
        }
    }

    // A ten-millionth of a turn is 4 cm at GEO.
    @Test func hourAngleMatchesTheWebApp() throws {
        for sample in try Parity.load().greenwichHourAngle {
            let date = try Date(sample.instant, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
            let radians = greenwichHourAngle(epochMilliseconds: (date.timeIntervalSince1970 * 1000).rounded())
            #expect(abs(radians - sample.radians) < 1e-12, "\(sample.instant)")
        }
    }
}
