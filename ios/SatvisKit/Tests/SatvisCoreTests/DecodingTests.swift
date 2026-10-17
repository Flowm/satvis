import Foundation
import Testing

@testable import SatvisCore

@Suite struct GPRecordDecodingTests {
    @Test func keepsTheMetadataBag() throws {
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        let metop = try #require(records.first { $0.name == "METOP-C" })
        #expect(metop.metadata["country"]?.string == "EUMETSAT")
        guard case .omm(let omm) = metop.elements else {
            Issue.record("METOP-C is an OMM")
            return
        }
        #expect(omm.noradCatID == "43689")
        #expect(omm.epoch == "2026-10-02T13:12:07.842528")
    }

    @Test func namesAnUnnamedTLEByItsCatalogNumber() throws {
        let payload = #"""
            [{"TLE_LINE1": "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753",
              "TLE_LINE2": "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"}]
            """#
        let record = try #require(try GPRecord.decodePayload(Data(payload.utf8)).first)
        #expect(record.name == "00005")
        #expect(record.satnum == "5")
    }

    @Test func readsNumbersSentAsStrings() throws {
        let payload = #"""
            [{"OBJECT_NAME": " X ", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": "00042", "MEAN_MOTION": "15.5",
              "ECCENTRICITY": 0.001, "INCLINATION": 51.6, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0}]
            """#
        let record = try #require(try GPRecord.decodePayload(Data(payload.utf8)).first)
        #expect(record.name == "X")
        #expect(record.satnum == "42")
        #expect(record.orbitClass == .leo)
    }

    // Fields no clock or orbit can hold are dropped with their record, not carried
    // into SGP4: a NaN epoch day trapped there on every launch the group was kept.
    @Test func dropsEpochsAndNumbersNoClockCanHold() throws {
        let valid = Array("1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753")
        func line1(epoch: String) -> String {
            String(valid[..<20]) + epoch.padding(toLength: 12, withPad: " ", startingAt: 0) + String(valid[32...])
        }
        let line2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"
        func tle(_ epoch: String) -> Data {
            Data(#"[{"TLE_LINE1": "\#(line1(epoch: epoch))", "TLE_LINE2": "\#(line2)"}]"#.utf8)
        }
        for epoch in ["nan", "inf", "1e309", "-1.5", "400.5"] {
            #expect(try GPRecord.decodePayload(tle(epoch)).isEmpty, "\(epoch)")
        }
        #expect(try GPRecord.decodePayload(tle("179.78495062")).count == 1)

        func omm(epoch: String, meanMotion: String = "15.5") -> Data {
            Data(
                #"""
                [{"EPOCH": "\#(epoch)", "NORAD_CAT_ID": 42, "MEAN_MOTION": \#(meanMotion), "ECCENTRICITY": 0.001, "INCLINATION": 51.6,
                  "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0}]
                """#.utf8)
        }
        for epoch in ["2026-13-02T00:00:00", "2026-10-02T99:00:00", "2026-10-02T999999999999999999:00:00", "12345678901234567-10-02T00:00:00"] {
            #expect(try GPRecord.decodePayload(omm(epoch: epoch)).isEmpty, "\(epoch)")
        }
        #expect(try GPRecord.decodePayload(omm(epoch: "2026-10-02T00:00:00", meanMotion: #""NaN""#)).isEmpty)
        #expect(try GPRecord.decodePayload(omm(epoch: "2026-10-02T00:00:00")).count == 1)
    }

    // JSONSerialization reads a boolean as a number; the bag keeps them apart.
    @Test func keepsEveryKindOfMetadata() throws {
        let payload = #"""
            [{"OBJECT_NAME": "X", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": 42, "MEAN_MOTION": 15.5, "ECCENTRICITY": 0.001,
              "INCLINATION": 51.6, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0,
              "metadata": {"yes": true, "one": 1, "zero": 0, "text": "a", "list": [2, "b", false], "bag": {"none": null}}}]
            """#
        let record = try #require(try GPRecord.decodePayload(Data(payload.utf8)).first)
        #expect(
            record.metadata == [
                "yes": .bool(true), "one": .number(1), "zero": .number(0), "text": .string("a"),
                "list": .array([.number(2), .string("b"), .bool(false)]), "bag": .object(["none": .null]),
            ])
        #expect(record.satnum == "42")
    }

    // A number past a double's range costs its field, as it did under Codable,
    // not the group: required, its record; optional, its default. In the
    // metadata it reads as null, either sign, where Codable dropped the bag.
    @Test func readsANumberPastADoublesRangeAsAbsent() throws {
        func omm(_ name: String, meanMotion: String = "15.5", bstar: String = "0.0001", metadata: String = "{}") -> String {
            #"{"OBJECT_NAME": "\#(name)", "EPOCH": "2026-10-02T00:00:00", "NORAD_CAT_ID": 42, "MEAN_MOTION": \#(meanMotion), "ECCENTRICITY": 0.001, "INCLINATION": 51.6, "RA_OF_ASC_NODE": 0, "ARG_OF_PERICENTER": 0, "MEAN_ANOMALY": 0, "BSTAR": \#(bstar), "metadata": \#(metadata)}"#
        }
        let many = (0..<20).map { omm("M\($0)", bstar: "1e309") }
        let odd = [
            omm("A", bstar: "-1E+400"), omm("B", meanMotion: "1e309"),
            omm("C", metadata: #"{"big": 1e999, "small": -1e999, "list": [1e999, -1e999, 1], "text": "1e999 \" 1e999"}"#),
        ]
        let records = try GPRecord.decodeGroup(Data(("[" + (many + odd).joined(separator: ",") + "]").utf8))
        #expect(records.map(\.name) == many.indices.map { "M\($0)" } + ["A", "C"])
        #expect(records.dropLast().allSatisfy { $0.meanElements.bstar == 0 })
        #expect(
            records.last?.metadata == [
                "big": .null, "small": .null, "list": .array([.null, .null, .number(1)]), "text": .string(#"1e999 " 1e999"#),
            ])
    }

    // Every served epoch is read byte by byte; a leading "+" sends the same instant
    // through the general reading, which has to agree.
    @Test func readsCanonicalEpochsAsTheGeneralReadingDoes() throws {
        for epoch in [
            "2026-10-02T11:10:18.655680", "2026-10-02T11:10:18.5Z", "2026-10-02T11:10:18", "2024-02-29T24:00:00", "2026-10-02T23:59:60.9999999",
            "2026-13-02T00:00:00", "0000-10-02T00:00:00",
        ] {
            #expect(utcMilliseconds(iso: epoch) == utcMilliseconds(iso: "+" + epoch), "\(epoch)")
        }
        #expect(utcMilliseconds(iso: "1970-01-01T00:00:00.001Z") == 1)
        #expect(utcMilliseconds(iso: "2026-10-02T11:10:18.") == utcMilliseconds(iso: "2026-10-02T11:10:18"))
    }

    // One unusable record must not cost the group the rest.
    @Test func skipsWhatIsNeitherAnOMMNorATLE() throws {
        let payload = #"[42, {"OBJECT_NAME": "NO ELEMENTS"}, {"TLE_LINE1": "1 00005U"}]"#
        #expect(try GPRecord.decodePayload(Data(payload.utf8)).isEmpty)
    }
}

@Suite struct GroupIndexDecodingTests {
    @Test func readsTagsAndPresets() throws {
        let payload = #"""
            {"updated": "2026-10-04T00:00:00.000Z",
             "groups": [{"name": "weather", "updated": null, "count": 72, "tags": ["Weather"]}],
             "presets": {"default": {"title": "Satvis", "defaults": {"tags": "Weather"}, "groups": [{"name": "weather"}, {"name": "starlink", "searchOnly": true}]}}}
            """#
        let index = try JSONDecoder().decode(GroupIndex.self, from: Data(payload.utf8))
        #expect(index.groups == [GroupStatus(name: "weather", count: 72, tags: ["Weather"])])
        #expect(index.preset(named: nil)?.defaults == ["tags": "Weather"])
        #expect(index.preset(named: "ot")?.groups == [PresetGroup(name: "weather"), PresetGroup(name: "starlink", searchOnly: true)])
    }

    // What an index from before tags and presets, or a malformed one, reads as.
    @Test func dropsWhatHasTheWrongShape() throws {
        let payload = #"""
            {"updated": "", "groups": [{"name": "weather", "tags": "Weather"}, {"count": 3}],
             "presets": {"default": {"groups": "weather"}, "ot": {"defaults": {"tags": "OT", "fps": true}, "groups": [{"name": "ot"}, {"searchOnly": true}]}}}
            """#
        let index = try JSONDecoder().decode(GroupIndex.self, from: Data(payload.utf8))
        #expect(index.groups == [GroupStatus(name: "weather")])
        #expect(index.presets == ["ot": Preset(defaults: ["tags": "OT"], groups: [PresetGroup(name: "ot")])])
    }
}
