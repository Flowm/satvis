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

        /// The web app's `ImageryInfo`.
        struct Imagery: Decodable, Equatable {
            let label: String
            let detail: String?
            let viewer: String
            let href: String
        }

        /// The web app's `InstrumentInfo`.
        struct Instrument: Decodable, Equatable {
            let name: String
            let fullName: String?
            let retired: Bool
            let rows: [[String]]
            let imagery: [Imagery]
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
                Details.Instrument(
                    name: $0.name, fullName: $0.fullName, retired: $0.isRetired, rows: $0.rows.map { [$0.0, $0.1] },
                    imagery: $0.imagery.map { Details.Imagery(label: $0.label, detail: $0.detail, viewer: $0.viewer, href: $0.href) })
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
    @Test(arguments: [OrbitClass.meo, .geo, .heo]) func leavesTheNominalSwathOffALowOrbit(_ orbitClass: OrbitClass) throws {
        var record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first { $0.orbitClass == orbitClass })
        record.metadata["instruments"] = .array([.object(["name": .string("AHI"), "resolutionM": .number(500), "nominalSwathKm": .number(500)])])
        let ahi = try #require(SatelliteDetails.instruments(record).first)
        #expect(ahi.rows.map { [$0.0, $0.1] } == [["Resolution", "500 m"]])
        #expect(!ahi.isRetired)
    }

    // entityInfo.test.ts's case: a curated row can give any shape.
    @Test func readsMalformedInstrumentsAsTheWebAppDoes() throws {
        var record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first { $0.orbitClass == .leo })
        record.metadata["instruments"] = .array([
            .object(["fullName": .string("No name")]),
            .string("MODIS"),
            .object(["name": .number(7)]),
            .object([
                "name": .string("GEDI"), "fullName": .number(3), "kind": .null, "bands": .array([.string("NIR"), .number(2), .null]), "resolutionM": .null,
                "nominalSwathKm": .string("4"), "retired": .string("yes"),
            ]),
            .object(["name": .string("EMIT"), "bands": .string("SWIR"), "resolutionM": .string("60")]),
        ])
        let instruments = SatelliteDetails.instruments(record)
        #expect(instruments.map(\.name) == ["GEDI", "EMIT"])
        #expect(instruments.map(\.fullName) == [nil, nil])
        #expect(instruments.map(\.isRetired) == [false, false])
        #expect(instruments.map { $0.rows.map { [$0.0, $0.1] } } == [[["Bands", "NIR"]], []])
        record.metadata["instruments"] = .string("MODIS")
        #expect(SatelliteDetails.instruments(record).isEmpty)
    }

    // entityInfo.test.ts's cases: a provider this app does not know, an instrument the satellite lacks, a layer that stopped.
    @Test func givesEachInstrumentTheImageryThatShowsIt() throws {
        var record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first)
        func entry(_ instrument: String, _ provider: String, _ layer: String, _ label: String, _ more: [String: JSONValue] = [:]) -> JSONValue {
            .object(["instrument": .string(instrument), "provider": .string(provider), "layer": .string(layer), "label": .string(label)].merging(more) { $1 })
        }
        record.metadata["instruments"] = .array([.object(["name": .string("MODIS")]), .object(["name": .string("MISR")]), .object(["name": .string("CERES")])])
        record.metadata["imagery"] = .array([
            entry("MODIS", "gibs", "MODIS_Terra_CorrectedReflectance_TrueColor", "True colour", ["period": .string("P1D"), "start": .string("2000-02-24")]),
            entry(
                "MISR", "gibs", "MISR_AM1_Ellipsoid_Radiance_RGB_AN", "True colour, camera An",
                ["period": .string("P1D"), "start": .string("2017-09-01"), "end": .string("2022-10-12")]),
            entry("MODIS", "eumetview", "msg_fes:rgb natural", "Natural colour"),
            entry("MODIS", "elsewhere", "a", "A"),
            entry("ASTER", "gibs", "a", "Of an instrument it does not carry"),
        ])
        let imagery = SatelliteDetails.instruments(record).map(\.imagery)
        #expect(
            imagery == [
                [
                    .init(
                        label: "True colour", detail: "daily since 2000", viewer: "NASA Worldview",
                        href: "https://worldview.earthdata.nasa.gov/?l=MODIS_Terra_CorrectedReflectance_TrueColor"),
                    .init(label: "Natural colour", detail: nil, viewer: "EUMETView", href: "https://view.eumetsat.int/productviewer?v=msg_fes:rgb%20natural"),
                ],
                [
                    .init(
                        label: "True colour, camera An", detail: "daily, 2017–2022", viewer: "NASA Worldview",
                        href: "https://worldview.earthdata.nasa.gov/?l=MISR_AM1_Ellipsoid_Radiance_RGB_AN&t=2022-10-12")
                ],
                [],
            ])
    }

    // entityInfo.test.ts's case: a record can give any shape.
    @Test func readsMalformedImageryAsTheWebAppDoes() throws {
        var record = try #require(try GPRecord.decodePayload(Parity.fixture("parity-input")).first)
        record.metadata["instruments"] = .array([.object(["name": .string("MODIS")])])
        let whole: [String: JSONValue] = ["instrument": .string("MODIS"), "provider": .string("gibs"), "layer": .string("a"), "label": .string("A")]
        record.metadata["imagery"] = .array([
            .string("MODIS"),
            .object(whole.filter { $0.key != "label" }),
            .object(whole.merging(["layer": .number(7)]) { $1 }),
            .object(whole.merging(["provider": .string("toString")]) { $1 }),
            .object(
                whole.merging([
                    "period": .number(1), "start": .number(2018), "end": .null, "window": .array([.string("P90D")]),
                    "merged": .string("yes"),
                ]) { $1 }),
        ])
        #expect(SatelliteDetails.instruments(record)[0].imagery == [.init(label: "A", detail: nil, viewer: "NASA Worldview", href: "https://worldview.earthdata.nasa.gov/?l=a")])
        record.metadata["imagery"] = .string("gibs")
        #expect(SatelliteDetails.instruments(record)[0].imagery.isEmpty)
    }

    // instrumentImagery.test.ts's cases.
    @Test(
        arguments: [
            (["period": "P1D", "start": "2018-01-05"], "daily since 2018"),
            (["period": "P1D", "start": "2017-09-01", "end": "2022-10-12"], "daily, 2017–2022"),
            (["period": "P1D", "start": "2025-08-21", "end": "2025-12-19"], "daily, 2025"),
            (["period": "PT10M", "window": "P90D"], "every 10 min, last 90 days"),
            (["period": "P1D", "end": "2022-10-12"], "daily, until 2022"),
            (["period": "PT6M", "window": "P90D", "end": "2026-11-02"], "every 6 min, until 2026"),
            (["start": "2020-02-17"], "since 2020"),
            (["period": "P8D", "start": "2020-09-01", "window": "P3M"], "since 2020"),
            ([:], nil),
        ] as [([String: String], String?)]) func wordsWhenALayerHasFrames(_ fields: [String: String], _ detail: String?)
    {
        #expect(SatelliteDetails.imageryDetail(fields.mapValues { .string($0) }) == detail)
    }

    @Test func saysALayerShowsOtherSatellitesToo() {
        #expect(SatelliteDetails.imageryDetail(["merged": .bool(true)]) == "with other satellites")
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
