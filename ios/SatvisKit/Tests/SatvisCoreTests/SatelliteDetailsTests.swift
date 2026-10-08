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
            let epochMs: Double
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

            #expect(abs(SatelliteDetails.epochMilliseconds(julianDate: propagator.epochJulianDate) - expected.elements.epochMs) < 1, "\(record.name)")
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

    // entityInfo.test.ts's cases.
    @Test func flagsAClockFarFromTheEpoch() {
        let epoch = 1_544_287_120_000.0
        let day = 86_400_000.0
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch) == nil)
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch + 10 * day) == nil)
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch - 10 * day) == nil)
        #expect(
            SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch + 30.4 * day) == "Position may be inaccurate, clock 30 days after element epoch")
        #expect(
            SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch - 15 * day) == "Position may be inaccurate, clock 15 days before element epoch")
    }

    @Test func writesNumbersAsJavaScriptDoes() {
        #expect(javaScriptString(0.00003476) == "0.00003476")
        #expect(javaScriptString(14.21475762) == "14.21475762")
        #expect(javaScriptString(2900) == "2900")
        #expect(javaScriptString(92.5) == "92.5")
        #expect(javaScriptString(-0.000033860869) == "-0.000033860869")
        #expect(javaScriptString(1.5e-8) == "1.5e-8")
    }

    // The web app's own cases (entityInfo.test.ts): a code the table lacks shows
    // as itself, "?" stays and "*" goes.
    @Test func labelsGCATsCodes() {
        let gcat = WebTables.shared.gcat
        #expect(gcat.categoryLabel("IMG/TECH?") == "Imaging / Technology?")
        #expect(gcat.categoryLabel("NEW*") == "NEW")
        #expect(gcat.categoryLabel("SIG?*") == "Signals intelligence?")
        #expect(gcat.classLabel("BD") == "Commercial / Military")
        #expect(gcat.classLabel("BX") == "Commercial / X")
    }

    @Test func groupsMassesAsJavaScriptDoes() {
        #expect(SatelliteDetails.groupedString(20281) == "20,281")
        #expect(SatelliteDetails.groupedString(2857.1234) == "2,857.123")
        #expect(SatelliteDetails.groupedString(1.47) == "1.47")
        #expect(SatelliteDetails.groupedString(1234567.0005) == "1,234,567.001")
    }

    @Test func readsTheSharedTables() throws {
        #expect(WebTables.shared.satcat.opsStatus["+"] == "Operational")
        #expect(WebTables.shared.gcat.class["D"] == "Military")
        let link = try #require(WebTables.shared.externalLinks.first)
        #expect(link.url(satnum: "25544")?.absoluteString == "https://celestrak.org/satcat/table-satcat.php?CATNR=25544")
    }
}
