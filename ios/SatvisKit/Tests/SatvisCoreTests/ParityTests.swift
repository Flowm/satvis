import Foundation
import Testing

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

    let parsed: [Parsed]
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

    // A ten-millionth of a turn is 4 cm at GEO.
    @Test func hourAngleMatchesTheWebApp() throws {
        for sample in try Parity.load().greenwichHourAngle {
            let date = try Date(sample.instant, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
            let radians = greenwichHourAngle(epochMilliseconds: (date.timeIntervalSince1970 * 1000).rounded())
            #expect(abs(radians - sample.radians) < 1e-12, "\(sample.instant)")
        }
    }
}
