import Foundation
import Testing

@testable import SatvisCore

/// Instrument imagery and granules (ADR 0019 to 0024) against what the web app's own code
/// gives for every entry of the imagery manifest (scripts/parity/generate.mjs).
@Suite(.formatsInEnglishUS) struct ImageryParityTests {
    /// The web app's `GranulePictures`, its frame "granule", "day" or milliseconds.
    struct Pictures: Decodable, Equatable {
        let provider: String
        let layer: String
        let frame: JSONValue

        init(provider: String, layer: String, frame: JSONValue) {
            self.provider = provider
            self.layer = layer
            self.frame = frame
        }

        init(_ pictures: SatelliteDetails.GranulePictures) {
            provider = pictures.provider.rawValue
            layer = pictures.layer
            frame =
                switch pictures.frame {
                case .granule: .string("granule")
                case .day: .string("day")
                case .after(let ms): .number(ms)
                }
        }

        var swift: SatelliteDetails.GranulePictures? {
            guard let provider = SatelliteDetails.GranulePictures.Provider(rawValue: provider) else {
                return nil
            }
            let frame: SatelliteDetails.GranulePictures.Frame? =
                switch frame {
                case .string("granule"): .granule
                case .string("day"): .day
                case .number(let ms): .after(ms)
                default: nil
                }
            return frame.map { SatelliteDetails.GranulePictures(provider: provider, layer: layer, frame: $0) }
        }
    }

    /// The web app's `ImageryPreview`.
    struct Preview: Decodable, Equatable {
        let provider: String
        let layer: String
        let format: String
        let daily: Bool
        let end: String?
        let pictures: Pictures?
    }

    /// The web app's `GranuleLayer`, as far as the native app reads it.
    struct GranuleLayer: Decodable, Equatable {
        let token: String
        let provider: String
        let layer: String
        let granules: [String]
        let platform: String?
        let pictures: Pictures?
    }

    /// The web app's `ImageryWords`.
    struct Words: Decodable, Equatable {
        let picture: String
        let updates: String?
        let ended: Bool
        let archive: String?
        let cropped: String?
    }

    /// The web app's `ImageryInfo`.
    struct Imagery: Decodable, Equatable {
        let key: String
        let label: String
        let detail: String?
        let viewer: String?
        let href: String?
        let token: String?
        let preview: Preview?
        let granuleLayer: GranuleLayer?
        let type: String
        let words: Words
    }

    struct Instrument: Decodable {
        let name: String
        let imagery: [Imagery]
    }

    struct Satellite: Decodable {
        let noradId: Int
        let name: String
        let orbitClass: String
        let entries: [JSONValue]
        let instruments: [Instrument]
    }

    struct Layer: Decodable {
        let key: String
        let kind: String
        let token: String
        let group: String
        let type: String
        let name: String?
        let satellites: [String]?
    }

    struct Row: Decodable {
        struct Cell: Decodable {
            let key: String
            let name: String
            let extra: Bool
        }

        let key: String
        let name: String
        let composite: Bool
        let cells: [Cell]
    }

    struct Section: Decodable {
        let satellites: [Satellite]
        let layers: [Layer]
        let rows: [String: [Row]]
    }

    /// The manifest's satellites as records, on the fixture's first element set.
    static func records(_ satellites: [Satellite]) throws -> [GPRecord] {
        let base = try #require(try Parity.records().first)
        return satellites.map { satellite in
            var record = base
            record.name = satellite.name
            if case .omm(let objectID, _) = record.elements {
                record.elements = .omm(objectID: objectID, noradCatID: String(satellite.noradId))
            }
            if satellite.orbitClass == "GEO" {
                record.meanElements.meanMotion = 1.0027
                record.meanElements.eccentricity = 0.0001
            }
            let names = satellite.instruments.map { JSONValue.object(["name": .string($0.name)]) }
            record.metadata["instruments"] = .array(names)
            record.metadata["imagery"] = .array(satellite.entries)
            return record
        }
    }

    static func imagery(_ imagery: SatelliteDetails.Imagery) -> Imagery {
        Imagery(
            key: imagery.key, label: imagery.label, detail: imagery.detail, viewer: imagery.viewer, href: imagery.href, token: imagery.token,
            preview: imagery.preview.map {
                Preview(provider: $0.provider.rawValue, layer: $0.layer, format: $0.format.rawValue, daily: $0.isDaily, end: $0.end, pictures: $0.pictures.map(Pictures.init))
            },
            granuleLayer: imagery.granuleLayer.map {
                GranuleLayer(
                    token: $0.token, provider: $0.provider.rawValue, layer: $0.layer, granules: $0.granules, platform: $0.platform, pictures: $0.pictures.map(Pictures.init))
            },
            type: imagery.type.rawValue,
            words: Words(
                picture: imagery.words.picture, updates: imagery.words.updates, ended: imagery.words.ended, archive: imagery.words.archive, cropped: imagery.words.cropped))
    }

    @Test func readsEveryManifestEntryAsTheWebAppDoes() throws {
        let section = try Parity.section("imagery", as: Section.self)
        #expect(section.satellites.count > 10)
        for (record, satellite) in try zip(Self.records(section.satellites), section.satellites) {
            let instruments = SatelliteDetails.instruments(record)
            #expect(instruments.map(\.name) == satellite.instruments.map(\.name), "\(satellite.name)")
            for (instrument, expected) in zip(instruments, satellite.instruments) {
                #expect(instrument.imagery.map(Self.imagery) == expected.imagery, "\(satellite.name) \(instrument.name)")
                // A granule layer is drawn granule by granule, never from its GIBS tiles too.
                #expect(instrument.imagery.allSatisfy { $0.granuleLayer == nil || $0.tiles == nil }, "\(satellite.name) \(instrument.name)")
            }
        }
    }

    @Test func listsAndRowsTheLayersAsTheWebAppDoes() throws {
        let section = try Parity.section("imagery", as: Section.self)
        let listings = SatelliteDetails.imageryListings(try Self.records(section.satellites))
        let names = { (satellites: [SatelliteDetails.ImageryListing.Satellite]) in satellites.map(\.name) }
        let read = listings.map { listing -> [String?] in
            switch listing.kind {
            case .satellite(let satellite, _): [listing.key, "satellite", listing.token, listing.group.rawValue, listing.type.rawValue, satellite.name, nil]
            case .composite(let satellites):
                [listing.key, "composite", listing.token, listing.group.rawValue, listing.type.rawValue, nil, names(satellites).joined(separator: "|")]
            }
        }
        #expect(read == section.layers.map { [$0.key, $0.kind, $0.token, $0.group, $0.type, $0.name, $0.satellites?.joined(separator: "|")] })
        for group in SatelliteDetails.ImageryListing.Group.allCases {
            let rows = SatelliteDetails.imageryRows(listings.filter { $0.group == group })
            let expected = try #require(section.rows[group.rawValue])
            #expect(rows.map(\.key) == expected.map(\.key), "\(group)")
            #expect(rows.map(\.name) == expected.map(\.name), "\(group)")
            #expect(rows.map(\.isComposite) == expected.map(\.composite), "\(group)")
            #expect(
                rows.map { $0.cells.map { [$0.listing.key, $0.name, String($0.extra)] } } == expected.map { $0.cells.map { [$0.key, $0.name, String($0.extra)] } }, "\(group)")
        }
    }

    // MARK: Granules

    struct Point: Decodable, Equatable {
        let latitude: Double
        let longitude: Double

        var swift: GroundPoint { GroundPoint(latitude: latitude, longitude: longitude) }
    }

    struct GranuleCase: Decodable, Equatable {
        let start: Double
        let end: Double
        let day: Bool
        let outline: [Point]

        var swift: Granule { Granule(start: start, end: end, isDay: day, outline: outline.map(\.swift)) }

        static func of(_ granule: Granule?) -> GranuleCase? {
            granule.map { GranuleCase(start: $0.start, end: $0.end, day: $0.isDay, outline: $0.outline.map { Point(latitude: $0.latitude, longitude: $0.longitude) }) }
        }
    }

    struct Bounds: Decodable, Equatable {
        let west: Double
        let south: Double
        let east: Double
        let north: Double

        var swift: SatelliteDetails.PreviewBounds { .init(west: west, south: south, east: east, north: north) }

        static func of(_ bounds: SatelliteDetails.PreviewBounds) -> Bounds {
            Bounds(west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north)
        }
    }

    struct Query: Decodable {
        let collections: [String]
        let platform: String?
        let start: Double
        let end: Double
        let point: Point?
        let newest: Int?

        var swift: GranuleQuery { GranuleQuery(collections: collections, platform: platform, start: start, end: end, point: point?.swift, newest: newest) }
    }

    struct Granules: Decodable {
        struct Entry: Decodable {
            let entry: JSONValue
            let granule: GranuleCase?
        }

        struct Feature: Decodable {
            let feature: JSONValue
            let granule: GranuleCase?
        }

        struct SearchUrl: Decodable {
            let query: Query
            let page: Int?
            let url: String
        }

        struct Sample: Decodable {
            let granule: GranuleCase
            let key: String
            let extent: Bounds
            let centre: Point
            let probe: Bounds
            let plateCarree: Cut
            let polar: Cut
        }

        struct Cut: Decodable {
            let bounds: Bounds
            let width: Int
            let height: Int
            let srs: String?

            /// Whether `cut` is this, its bounds within `metres`.
            func matches(_ cut: PictureCut, within tolerance: Double) -> Bool {
                let ours = [cut.bounds.west, cut.bounds.south, cut.bounds.east, cut.bounds.north]
                let theirs = [bounds.west, bounds.south, bounds.east, bounds.north]
                return zip(ours, theirs).allSatisfy { abs($0 - $1) <= tolerance } && cut.width == width && cut.height == height
                    && cut.projection?.srs == srs
            }
        }

        struct OverpassCase: Decodable {
            let start: Double
            let end: Double
            let count: Int
            let day: Bool
        }

        struct Sun: Decodable {
            let instant: String
            let point: Point
            let elevation: Double
        }

        struct Polar: Decodable {
            struct Projection: Decodable {
                let srs: String
                let pole: Double
                let trueScaleLatitude: Double
            }

            struct Projected: Decodable {
                let point: Point
                let projected: XY
            }

            struct XY: Decodable {
                let x: Double
                let y: Double
            }

            let projection: Projection
            let radiusScale: Double
            let points: [Projected]
        }

        struct PictureUrl: Decodable {
            let pictures: Pictures
            let start: Double
            let bounds: Bounds
            let width: Int
            let height: Int
            let srs: String
            let url: String
        }

        struct PreviewCase: Decodable {
            struct GranulePreview: Decodable {
                let provider: String
                let layer: String
                let format: String
                let daily: Bool
                let pictures: Pictures
                let granule: Double
            }

            let preview: GranulePreview
            let centre: Point
            let halfWidthDeg: Double
            let nowMs: Double
            let url: String
        }

        struct Places: Decodable {
            struct Step: Decodable {
                let start: Double
                let end: Double
                let on: Bool
            }

            struct Place: Decodable {
                let time: Double
                let current: Int?
                let previous: Int?
                let next: Int?
            }

            let steps: [Step]
            let places: [Place]
        }

        let cmrEntries: [Entry]
        let dataStoreFeatures: [Feature]
        let searchUrls: [SearchUrl]
        let dataStoreUrls: [SearchUrl]
        let samples: [Sample]
        let overpasses: [OverpassCase]
        let sun: [Sun]
        let polar: [Polar]
        let pictureUrls: [PictureUrl]
        let previews: [PreviewCase]
        let replayPlaces: Places
        let leadMs: Double
        let afterOverpassMs: Double
        let pictureCredits: [PictureCredit]
    }

    struct PictureCredit: Decodable {
        let provider: String
        let layer: String
        let year: Int
        let credit: String
    }

    @Test func readsTheCataloguesAnswersAsTheWebAppDoes() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        for entry in granules.cmrEntries {
            #expect(GranuleCase.of(GranuleCatalogue.parseCmrGranule(entry.entry)) == entry.granule, "\(entry.entry)")
        }
        for feature in granules.dataStoreFeatures {
            #expect(GranuleCase.of(GranuleCatalogue.parseDataStoreGranule(feature.feature)) == feature.granule, "\(feature.feature)")
        }
    }

    @Test func asksTheCataloguesAsTheWebAppDoes() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        for search in granules.searchUrls {
            #expect(GranuleCatalogue.searchUrl(search.query.swift) == search.url)
        }
        for search in granules.dataStoreUrls {
            #expect(GranuleCatalogue.dataStoreUrl(search.query.swift, page: search.page ?? 0) == search.url)
        }
    }

    @Test func placesAndGroupsGranulesAsTheWebAppDoes() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        for sample in granules.samples {
            let granule = sample.granule.swift
            #expect(granule.key == sample.key)
            #expect(Bounds.of(granule.extent) == sample.extent)
            #expect(abs(granule.centre.latitude - sample.centre.latitude) < 1e-9 && abs(granule.centre.longitude - sample.centre.longitude) < 1e-9, "\(sample.key)")
            #expect(Bounds.of(GranuleCatalogue.probeBounds(granule)) == sample.probe, "\(sample.key)")
            #expect(sample.plateCarree.matches(PictureCut.plateCarree(granule.extent), within: 1e-9), "\(sample.key)")
            #expect(sample.polar.matches(PictureCut.polar(granule), within: 1e-3), "\(sample.key)")
        }
        let overpasses = GranuleCatalogue.overpasses(granules.samples.map(\.granule.swift))
        #expect(
            overpasses.map { [$0.start, $0.end, Double($0.granules.count), $0.isDay ? 1 : 0] } == granules.overpasses.map { [$0.start, $0.end, Double($0.count), $0.day ? 1 : 0] })
        for sun in granules.sun {
            let time = try #require(TimeDomain.instant(sun.instant))
            #expect(abs(GranuleCatalogue.sunElevation(sun.point.swift, time: time) - sun.elevation) < 1e-9, "\(sun.instant) \(sun.point)")
        }
        for polar in granules.polar {
            let projection = PolarProjection(srs: polar.projection.srs, pole: polar.projection.pole, trueScaleLatitude: polar.projection.trueScaleLatitude)
            #expect(projection == (polar.projection.pole > 0 ? .arctic : .antarctic))
            #expect(abs(projection.radiusScale - polar.radiusScale) < 1e-6)
            for point in polar.points {
                let projected = projection.project(GroundPoint(latitude: polar.projection.pole * abs(point.point.latitude), longitude: point.point.longitude))
                #expect(abs(projected.x - point.projected.x) < 1e-6 && abs(projected.y - point.projected.y) < 1e-6, "\(point.point)")
            }
        }
    }

    @Test func asksForTheWebAppsGranulePictures() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        for item in granules.pictureUrls {
            let pictures = try #require(item.pictures.swift)
            #expect(SatelliteDetails.granulePictureUrl(pictures, start: item.start, bounds: item.bounds.swift, width: item.width, height: item.height, srs: item.srs) == item.url)
        }
        for item in granules.previews {
            let pictures = try #require(item.preview.pictures.swift)
            let preview = try SatelliteDetails.ImageryPreview(
                provider: #require(.init(rawValue: item.preview.provider)), layer: item.preview.layer, maxLevel: 0, format: #require(.init(rawValue: item.preview.format)),
                isDaily: item.preview.daily, end: nil, pictures: pictures)
            let url = SatelliteDetails.imageryPreviewUrl(
                preview, latitude: item.centre.latitude, longitude: item.centre.longitude, halfWidthDeg: item.halfWidthDeg, now: item.nowMs, granule: item.preview.granule)
            #expect(url == item.url)
        }
    }

    @Test func creditsGranulePicturesAsTheWebAppDoes() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        #expect(!granules.pictureCredits.isEmpty)
        for item in granules.pictureCredits {
            let pictures = try SatelliteDetails.GranulePictures(provider: #require(.init(rawValue: item.provider)), layer: item.layer, frame: .granule)
            #expect(pictures.credit(year: item.year) == item.credit)
        }
    }

    @Test func placesTheClockAmongReplaysAsTheWebAppDoes() throws {
        let granules = try Parity.section("granules", as: Granules.self)
        #expect(OverpassReplay.leadMs == granules.leadMs)
        #expect(OverpassReplay.afterOverpassMs == granules.afterOverpassMs)
        let steps = granules.replayPlaces.steps
        for expected in granules.replayPlaces.places {
            let place = OverpassReplay.place(
                Array(steps.indices), time: expected.time, start: { steps[$0].start - OverpassReplay.leadMs }, end: { steps[$0].end }, on: { steps[$0].on })
            #expect([place.current, place.previous, place.next] == [expected.current, expected.previous, expected.next], "\(expected.time)")
        }
    }

    struct PassImageryCase: Decodable {
        let day: Bool
        let pictured: Bool
        let pixels: [Bool]?
        let imagery: String
    }

    @Test func saysWhatAPassRecordedAsTheWebAppDoes() throws {
        for item in try Parity.section("passImagery", as: [PassImageryCase].self) {
            let layer = SatelliteDetails.GranuleLayer(
                token: "gibs:L", provider: .gibs, layer: "L", granules: ["C1-X"], pictures: item.pictured ? .init(provider: .gibs, layer: "L", frame: .granule) : nil)
            let granule = Granule(start: 0, end: 1, isDay: item.day, outline: [])
            let entry = RecordedOverpass(pair: "p", satellite: "S", station: "T", layer: layer, overpass: Overpass(start: 0, end: 1, granules: [granule]))
            #expect(entry.imagery(pixels: item.pixels).rawValue == item.imagery)
        }
    }

    struct PassTable: Decodable {
        struct Times: Decodable {
            let name: String
            let groundStationName: String
            let start: Double
            let end: Double
        }

        struct Recorded: Decodable {
            struct Times: Decodable {
                let start: Double
                let end: Double
            }

            let pair: String
            let satellite: String
            let station: String
            let overpass: Times
            let day: Bool
        }

        struct Row: Decodable, Equatable {
            let pass: Int?
            let recorded: Int?
        }

        struct Case: Decodable {
            let showPast: Bool
            let rows: [Row]
        }

        let passes: [Times]
        let recorded: [Recorded]
        let nowMs: Double
        let cases: [Case]
    }

    @Test func listsThePassesTableAsTheWebAppDoes() throws {
        let fixture = try Parity.section("passTable", as: PassTable.self)
        let station = UUID()
        let passes = fixture.passes.map {
            Pass(
                satellite: $0.name, satelliteName: $0.name, station: $0.groundStationName, stationID: station, start: $0.start, end: $0.end,
                measure: .swath(minDistance: 0, minDistanceTime: $0.start, swathWidth: 0))
        }
        let layer = SatelliteDetails.GranuleLayer(token: "gibs:L", provider: .gibs, layer: "L", granules: ["C1-X"], pictures: nil)
        let recorded = fixture.recorded.map { item in
            RecordedOverpass(
                pair: item.pair, satellite: item.satellite, station: item.station, layer: layer,
                overpass: Overpass(
                    start: item.overpass.start, end: item.overpass.end,
                    granules: [Granule(start: item.overpass.start, end: item.overpass.end, isDay: item.day, outline: [])]))
        }
        for item in fixture.cases {
            let table = PassTableRow.table(passes, recorded: recorded, now: fixture.nowMs, past: item.showPast)
            let rows = table.map { row -> PassTable.Row in
                switch row {
                case .pass(let pass, let entry): PassTable.Row(pass: passes.firstIndex(of: pass), recorded: entry.flatMap(recorded.firstIndex(of:)))
                case .recorded(let entry): PassTable.Row(pass: nil, recorded: recorded.firstIndex(of: entry))
                }
            }
            #expect(rows == item.rows, "past \(item.showPast)")
        }
    }

    struct FormatCases: Decodable {
        struct Age: Decodable {
            let ago: Double
            let text: String
        }

        struct DateCase: Decodable {
            let iso: String
            let text: String
        }

        let agesInWords: [Age]
        let dates: [DateCase]
    }

    @Test func writesAgesAndDatesAsTheWebAppDoes() throws {
        let cases = try Parity.section("imageryFormats", as: FormatCases.self)
        let now = 1_791_460_800_000.0
        for age in cases.agesInWords {
            #expect(Formats.timeAgoInWords(now - age.ago, now: now) == age.text)
        }
        for date in cases.dates {
            #expect(Formats.date(date.iso) == date.text)
        }
    }

    // cmrGranules.test.ts's fetchGranules cases: a granule both collections list is the
    // first's, one collection's tiles of a scene are each kept, and the answer is by start.
    @Test func keepsTheFirstCollectionsCopyOfAGranule() throws {
        func entry(_ start: String, _ collection: String, corner: String = "14.218523 38.306084") -> JSONValue {
            .object([
                "collection_concept_id": .string(collection), "time_start": .string(start), "time_end": .string(start), "day_night_flag": .string("DAY"),
                "polygons": .array([.array([.string("\(corner) 18.426548 66.22702 39.330738 63.761784 34.278229 30.160732 \(corner)")])]),
            ])
        }
        let body = JSONValue.object([
            "feed": .object([
                "entry": .array([
                    entry("2026-11-20T10:00:00.000Z", "B"), entry("2026-11-20T10:00:00.000Z", "A", corner: "14.3 38.4"), entry("2026-11-20T09:54:00.000Z", "B"),
                    entry("2026-11-20T10:06:00.000Z", "A"), entry("2026-11-20T10:06:00.000Z", "A", corner: "15 40"),
                ])
            ])
        ])
        let granules = try #require(GranuleCatalogue.cmrGranules(JSONEncoder().encode(body), collections: ["A", "B"]))
        #expect(granules.map(\.start) == [1_795_168_440_000, 1_795_168_800_000, 1_795_169_160_000, 1_795_169_160_000])
        #expect(granules[1].outline[0] == GroundPoint(latitude: 14.3, longitude: 38.4))
    }
}
