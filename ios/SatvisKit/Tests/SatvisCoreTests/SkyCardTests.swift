import Foundation
import Testing

@testable import SatvisCore

/// The lock card's words against the web app's own (skyCard.ts, through
/// scripts/parity/generate.mjs).
@Suite struct SkyCardTests {
    private struct Fixture: Decodable {
        struct Position: Decodable {
            let azimuth: Double
            let elevation: Double
            let rangeKm: Double
            let text: String
            let spoken: String
        }

        let labels: [String: String]
        let positions: [Position]
    }

    private static func fixture() throws -> Fixture {
        struct Root: Decodable {
            let lockCard: Fixture
        }
        return try JSONDecoder().decode(Root.self, from: Parity.fixture("parity")).lockCard
    }

    @Test func saysWhereToLookAsTheWebAppDoes() throws {
        for sample in try Self.fixture().positions {
            let position = SkyCard.position(azimuth: sample.azimuth, elevation: sample.elevation, range: sample.rangeKm)
            #expect(position.text == sample.text)
            #expect(position.spoken == sample.spoken)
        }
    }

    @Test func namesTheVerdictAsTheWebAppDoes() throws {
        let labels = try Self.fixture().labels
        #expect(labels.count == 4)
        for (raw, label) in labels {
            #expect(Visibility(rawValue: raw)?.label == label, "\(raw)")
        }
    }
}
