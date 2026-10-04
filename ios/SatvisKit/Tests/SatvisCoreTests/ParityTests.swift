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

    struct State: Decodable {
        let record: Int
        let instant: String
        let temePositionKm: [Double]
        let temeVelocityKmPerSecond: [Double]
        let fixedPositionMetres: [Double]
    }

    let parsed: [Parsed]
    let propagation: [State]
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
    // micrometre. ADR 0007 allows a metre; held to a centimetre so that a mistake
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
