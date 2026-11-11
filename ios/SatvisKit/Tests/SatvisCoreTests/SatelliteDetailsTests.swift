import Foundation
import Testing

@testable import SatvisCore

/// The info panel's header, Orbit, Spacecraft and Instruments tabs, held to what the
/// web app's entityInfo.ts writes for the same records.
@Suite(.formatsInEnglishUS) struct SatelliteDetailsTests {
    struct Details: Decodable {
        struct Elements: Decodable {
            let kind: String
            let epoch: String
            let epochMs: Double
            let lines: String?
            let rows: [[String]]?
        }

        /// The web app's `InstrumentInfo`.
        struct Instrument: Decodable, Equatable {
            let name: String
            let fullName: String?
            let retired: Bool
            let rows: [[String]]
        }

        /// The web app's `SatelliteInfo`.
        struct Facts: Decodable {
            let orbitClass: String
            let chips: [String]
            let status: String?
            let orbitRows: [[String]]
            let spacecraftRows: [[String]]
            let instruments: [Instrument]
        }

        let facts: Facts
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
            #expect(SatelliteDetails.orbitFacts(record, propagator: propagator).map { [$0.0, $0.1] } == expected.facts.orbitRows, "\(record.name)")
            #expect(SatelliteDetails.spacecraftFacts(record).map { [$0.0, $0.1] } == expected.facts.spacecraftRows, "\(record.name)")
            let instruments = SatelliteDetails.instruments(record).map {
                Details.Instrument(name: $0.name, fullName: $0.fullName, retired: $0.isRetired, rows: $0.rows.map { [$0.0, $0.1] })
            }
            #expect(instruments == expected.facts.instruments, "\(record.name)")
            #expect(SatelliteDetails.chips(record, propagator: propagator) == expected.facts.chips, "\(record.name)")
            #expect(SatelliteDetails.status(record) == expected.facts.status, "\(record.name)")
            #expect(record.orbitClass.rawValue == expected.facts.orbitClass, "\(record.name)")

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

    // entityInfo.test.ts's case: CEOS gives a geostationary imager 500 km, which sweeps nothing.
    @Test func leavesTheNominalSwathOffAHighOrbit() throws {
        var record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first { $0.orbitClass == .geo })
        record.metadata["instruments"] = .array([.object(["name": .string("AHI"), "resolutionM": .number(500), "nominalSwathKm": .number(500)])])
        let ahi = try #require(SatelliteDetails.instruments(record).first)
        #expect(ahi.rows.map { [$0.0, $0.1] } == [["Resolution", "500 m"]])
        #expect(!ahi.isRetired)
    }

    // entityInfo.test.ts's cases.
    @Test func flagsAClockFarFromTheEpoch() {
        let epoch = 1_544_287_120_000.0
        let day = 86_400_000.0
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch) == nil)
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch + 10 * day) == nil)
        #expect(SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch - 10 * day) == nil)
        #expect(
            SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch + 30.4 * day) == "Position and passes may be inaccurate, clock 30 days after element epoch")
        #expect(
            SatelliteDetails.staleElementsNotice(epochMilliseconds: epoch, time: epoch - 15 * day) == "Position and passes may be inaccurate, clock 15 days before element epoch")
    }

    @Test func writesNumbersAsJavaScriptDoes() {
        #expect(jsNumberString(0.00003476) == "0.00003476")
        #expect(jsNumberString(14.21475762) == "14.21475762")
        #expect(jsNumberString(2900) == "2900")
        #expect(jsNumberString(92.5) == "92.5")
        #expect(jsNumberString(-0.000033860869) == "-0.000033860869")
        #expect(jsNumberString(1.5e-8) == "1.5e-8")
        #expect(jsNumberString(5e-7) == "5e-7")
        #expect(jsNumberString(-3.2e-7) == "-3.2e-7")
        #expect(jsNumberString(1e-6) == "0.000001")
        #expect(jsNumberString(1e21) == "1e+21")
        #expect(jsNumberString(1e20) == "100000000000000000000")
        #expect(jsNumberString(-1.23e22) == "-1.23e+22")
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

    @Test func readsTheSharedTables() throws {
        #expect(WebTables.shared.satcat.opsStatus["+"] == "Operational")
        #expect(WebTables.shared.gcat.class["D"] == "Military")
        let link = try #require(WebTables.shared.externalLinks.first)
        #expect(link.url(satnum: "25544")?.absoluteString == "https://celestrak.org/satcat/table-satcat.php?CATNR=25544")
    }
}
