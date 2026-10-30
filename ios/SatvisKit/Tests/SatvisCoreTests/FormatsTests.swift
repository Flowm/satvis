import Foundation
import Testing

@testable import SatvisCore

/// Formats in en_US, as the web app's parity fixtures are written, whatever the
/// machine's region.
struct FormatsInEnglishUS: SuiteTrait, TestTrait, TestScoping {
    func provideScope(for _: Test, testCase _: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
        try await Formats.$locale.withValue(Locale(identifier: "en_US"), operation: function)
    }
}

extension Trait where Self == FormatsInEnglishUS {
    /// See `FormatsInEnglishUS`.
    static var formatsInEnglishUS: Self { Self() }
}

@Suite struct FormatsTests {
    /// What each format gives in a region, as `formats.test.ts` has it for the web app.
    struct Region: Sendable, CustomTestStringConvertible {
        let identifier: String
        let count: String
        let fixed: String
        let negative: String
        let decimal: String
        let measure: String

        var testDescription: String { identifier }
    }

    static let regions = [
        Region(
            identifier: "en_US", count: "16,819", fixed: "1,234.50", negative: "-48.14", decimal: "12.6", measure: "2,857.123"),
        Region(
            identifier: "de_DE", count: "16.819", fixed: "1.234,50", negative: "-48,14", decimal: "12,6", measure: "2.857,123"),
    ]

    @Test(arguments: regions) func numbersFollowTheRegion(region: Region) {
        Formats.$locale.withValue(Locale(identifier: region.identifier)) {
            #expect(Formats.integer(16819) == region.count)
            #expect(Formats.fixed(1234.5, 2) == region.fixed)
            #expect(Formats.fixed(-48.1351, 2) == region.negative)
            #expect(Formats.decimal("12.6") == region.decimal)
            #expect(Formats.decimal("NaN") == "NaN")
            #expect(Formats.number(12.6) == region.decimal)
            #expect(Formats.measure(2857.1234) == region.measure)
        }
    }

    @Test(.formatsInEnglishUS) func roundsAsJavaScriptDoes() {
        // 1.005 is 1.00499… in binary, so toFixed rounds it down.
        #expect(Formats.fixed(1.005, 2) == "1.00")
        #expect(Formats.fixed(-0.001, 2) == "-0.00")
        #expect(Formats.fixed(.nan, 2) == "NaN")
        #expect(Formats.coordinates(48.1372, -149.5585) == "48.14°, -149.56°")
        #expect(Formats.measure(20281) == "20,281")
        #expect(Formats.measure(1.47) == "1.47")
        #expect(Formats.measure(1234567.0005) == "1,234,567.001")
    }
}
