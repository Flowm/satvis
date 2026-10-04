import Foundation
import Testing

@testable import SatvisCore

/// The info panel's Details tab, held to what the web app's entityInfo.ts writes
/// for the same records.
@Suite struct SatelliteDetailsTests {
    struct Details: Decodable {
        struct Elements: Decodable {
            let kind: String
            let epoch: String
            let lines: String?
            let rows: [[String]]?
        }

        let facts: [[String]]
        let elements: Elements
    }

    struct Fixture: Decodable {
        let details: [Details]
    }

    @Test func writesTheWebAppsDetails() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Parity.fixture("parity"))
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        for (record, expected) in zip(records, fixture.details) {
            let propagator = try SGP4Propagator(record.meanElements)
            let facts = SatelliteDetails.facts(record, propagator: propagator).map { [$0.0, $0.1] }
            #expect(facts == expected.facts, "\(record.name)")

            switch SatelliteDetails.elements(record, epochJulianDate: propagator.epochJulianDate) {
            case .tle(let epoch, let lines):
                #expect(expected.elements.kind == "tle")
                #expect(epoch == expected.elements.epoch)
                #expect(lines == expected.elements.lines)
            case .omm(let epoch, let rows):
                #expect(expected.elements.kind == "omm")
                #expect(epoch == expected.elements.epoch, "\(record.name)")
                #expect(rows.map { [$0.label, $0.value] } == expected.elements.rows, "\(record.name)")
            }
        }
    }

    @Test func writesNumbersAsJavaScriptDoes() {
        #expect(javaScriptString(0.00003476) == "0.00003476")
        #expect(javaScriptString(14.21475762) == "14.21475762")
        #expect(javaScriptString(2900) == "2900")
        #expect(javaScriptString(92.5) == "92.5")
        #expect(javaScriptString(-0.000033860869) == "-0.000033860869")
        #expect(javaScriptString(1.5e-8) == "1.5e-8")
    }

    @Test func readsTheSharedTables() throws {
        #expect(WebTables.shared.satcat.owner["US"] == "United States")
        let link = try #require(WebTables.shared.externalLinks.first)
        #expect(link.url(satnum: "25544")?.absoluteString == "https://celestrak.org/satcat/table-satcat.php?CATNR=25544")
    }
}
