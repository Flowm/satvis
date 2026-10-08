import Foundation
import Testing

@testable import SatvisCore

/// The URL codec against the web app's own (urlCodec.ts, through
/// scripts/parity/generate.mjs): each kind of parameter, then whole links.
@Suite struct LinkParityTests {
    private static func links() throws -> [String: Any] {
        let root = try #require(try JSONSerialization.jsonObject(with: Parity.fixture("parity")) as? [String: Any])
        return try #require(root["links"] as? [String: Any])
    }

    private static func stations(_ json: Any?) -> [LinkStation]? {
        (json as? [[String: Any]])?.map {
            LinkStation(latitude: ($0["lat"] as! NSNumber).doubleValue, longitude: ($0["lon"] as! NSNumber).doubleValue, name: $0["name"] as? String)
        }
    }

    @Test func honoursTheVocabulariesTheFixturesWereWrittenFor() throws {
        let vocabulary = try #require(Self.links()["vocabulary"] as? [String: [String]])
        #expect(vocabulary["components"] == LinkCodec.components)
        #expect(vocabulary["layers"] == LinkCodec.layers)
        #expect(vocabulary["terrain"] == LinkCodec.terrains)
        #expect(vocabulary["overpass"] == LinkCodec.overpassModes)
        #expect(vocabulary["scenes"] == LinkCodec.scenes)
        #expect(vocabulary["unseen"] == LinkCodec.unseenModes)
        #expect(vocabulary["cameras"] == LinkCodec.cameras)
        #expect(vocabulary["pixelRatios"] == LinkCodec.pixelRatios)
    }

    @Test func readsAndWritesEachKindAsTheWebAppDoes() throws {
        let kinds = try #require(Self.links()["fieldKinds"] as? [[String: Any]])
        for entry in kinds {
            let kind = try #require(entry["kind"] as? String)
            let parses = try #require(entry["parses"] as? [[String: Any]])
            let formats = try #require(entry["formats"] as? [[String: Any]])
            for test in parses {
                let raw = try #require(test["raw"] as? String)
                let want = test["value"]
                let label = "\(kind) parses \"\(raw)\""
                switch kind {
                case "plainString": #expect(FieldKind<String>.plain.parse(raw) == want as? String, "\(label)")
                case "overpass": #expect(FieldKind<String>.oneOf(LinkCodec.overpassModes).parse(raw) == want as? String, "\(label)")
                case "stringList": #expect(FieldKind<[String]>.list.parse(raw) == want as? [String], "\(label)")
                case "tildeEscapedStringList": #expect(FieldKind<[String]>.tildeEscapedList.parse(raw) == want as? [String], "\(label)")
                case "components": #expect(FieldKind<[String]>.closedList(LinkCodec.components).parse(raw) == want as? [String], "\(label)")
                case "layers": #expect(FieldKind<[String]>.layerList(LinkCodec.layers).parse(raw) == want as? [String], "\(label)")
                case "groundStationList": #expect(FieldKind<[LinkStation]>.stations.parse(raw) == Self.stations(want), "\(label)")
                case "timestamp":
                    let parsed: String?? = FieldKind<String?>.timestamp.parse(raw)
                    if let want = want as? String {
                        #expect(parsed == .some(want), "\(label)")
                    } else {
                        #expect(parsed == nil, "\(label)")
                    }
                default: Issue.record("no kind \(kind)")
                }
            }
            for test in formats {
                let input = test["input"]
                let want = test["value"] as? String
                let label =
                    "\(kind) formats \((try? JSONSerialization.data(withJSONObject: input ?? NSNull(), options: .fragmentsAllowed)).map { String(decoding: $0, as: UTF8.self) } ?? "?")"
                switch kind {
                case "plainString": #expect(FieldKind<String>.plain.format(input as! String) == want, "\(label)")
                case "overpass": #expect(FieldKind<String>.oneOf(LinkCodec.overpassModes).format(input as! String) == want, "\(label)")
                case "stringList": #expect(FieldKind<[String]>.list.format(input as! [String]) == want, "\(label)")
                case "tildeEscapedStringList": #expect(FieldKind<[String]>.tildeEscapedList.format(input as! [String]) == want, "\(label)")
                case "components": #expect(FieldKind<[String]>.closedList(LinkCodec.components).format(input as! [String]) == want, "\(label)")
                case "layers": #expect(FieldKind<[String]>.layerList(LinkCodec.layers).format(input as! [String]) == want, "\(label)")
                case "groundStationList": #expect(FieldKind<[LinkStation]>.stations.format(Self.stations(input)!) == want, "\(label)")
                case "timestamp": #expect(FieldKind<String?>.timestamp.format(input as? String) == want, "\(label)")
                default: Issue.record("no kind \(kind)")
                }
            }
        }
    }

    @Test func readsWholeLinksOntoAPresetAndWritesThemBack() throws {
        let links = try Self.links()
        let presets = try #require(links["presets"] as? [String: [String: String]])
        let cases = try #require(links["cases"] as? [[String: Any]])
        #expect(cases.count > 10)
        for test in cases {
            let preset = try #require(presets[test["preset"] as! String])
            let query = test["query"] as! String
            let label = "\(test["preset"]!) ?\(query)"
            let defaults = LinkCodec.defaults(preset: preset)
            let read = LinkCodec.read(LinkQuery(parsing: query), defaults: defaults)
            let want = try #require(test["state"] as? [String: Any])
            #expect(read.state.elements == want["elements"] as? [String], "\(label)")
            #expect(read.state.sats == want["sats"] as? [String], "\(label)")
            #expect(read.state.xsats == want["xsats"] as? [String], "\(label)")
            #expect(read.state.tags == want["tags"] as? [String], "\(label)")
            #expect(read.state.gs == Self.stations(want["gs"]), "\(label)")
            #expect(read.state.track == want["track"] as? String, "\(label)")
            #expect(read.state.overpass == want["overpass"] as? String, "\(label)")
            #expect(read.state.layers == want["layers"] as? [String], "\(label)")
            #expect(read.state.terrain == want["terrain"] as? String, "\(label)")
            #expect(read.state.scene == want["scene"] as? String, "\(label)")
            #expect(read.state.unseen == want["unseen"] as? String, "\(label)")
            #expect(read.state.camera == want["camera"] as? String, "\(label)")
            #expect(read.state.pixelRatio == want["pixelratio"] as? String, "\(label)")
            #expect(read.state.time == want["time"] as? String, "\(label)")
            #expect(read.invalid == test["invalid"] as? [String], "\(label)")
            let written = LinkCodec.write(read.state, foreign: read.foreign, defaults: defaults).string
            #expect(written == test["written"] as? String, "\(label)")
        }
    }
}

extension LinkParityTests {
    @Test func showsAnalyticsWhatTheWebAppShowsIt() throws {
        let cases = try #require(Self.links()["sanitized"] as? [[String: String]])
        #expect(!cases.isEmpty)
        for test in cases {
            #expect(sanitizedForAnalytics(test["url"]!) == test["sanitized"], "\(test["url"]!)")
        }
    }
}

@Suite struct LinkTests {
    // As the web app's router reads a path: the last segment, less `.html`.
    @Test func namesThePresetByThePath() {
        #expect(Link("https://satvis.space/").preset == nil)
        #expect(Link("https://satvis.space/ot?tags=OT").preset == "ot")
        #expect(Link("https://satvis.space/ot.html").preset == "ot")
        #expect(Link("/ot?tags=OT#x").query["tags"] == "OT")
        #expect(Link("/?tags=&sats=ISS+(ZARYA)").query["sats"] == "ISS (ZARYA)")
        #expect(Link("?time=2026-10-04T08:52Z").query["time"] == "2026-10-04T08:52Z")
        #expect(Link("/default?tags=OT").preset == nil)
    }

    @Test func writesALinkOnTheSite() throws {
        let site = try #require(URL(string: "https://satvis.space"))
        #expect(Link().url(site: site).absoluteString == "https://satvis.space/")
        let ot = Link(preset: "ot", query: LinkQuery(parsing: "sats=NOAA+19&gs=48.1351,11.5820"))
        #expect(ot.url(site: site).absoluteString == "https://satvis.space/ot?sats=NOAA+19&gs=48.1351,11.5820")
        let local = try #require(URL(string: "http://localhost:8080/"))
        #expect(Link(query: LinkQuery(parsing: "tags=")).url(site: local).absoluteString == "http://localhost:8080/?tags=")
    }
}
