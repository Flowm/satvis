import Foundation
import Testing

@testable import SatvisCore

/// The lock card's words against the web app's own (skyCard.ts, through
/// scripts/parity/generate.mjs), in en_US as the fixtures are written.
@Suite(.formatsInEnglishUS) struct SkyCardTests {
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

    @Test(arguments: [("en_US", "38,362"), ("en_DE", "38.362"), ("en_FR", "38\u{202F}362")])
    func groupsTheRangeAsTheRegionDoes(identifier: String, range: String) {
        Formats.$locale.withValue(Locale(identifier: identifier)) {
            #expect(SkyCard.position(azimuth: 178.3, elevation: 32.8, range: 38_362.4).text == "178° S · 33° up · \(range) km away")
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
