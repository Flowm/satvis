import Foundation
import Testing

@testable import SatvisRender

@Suite struct MosaicTests {
    /// A little-endian classic TIFF as GDAL writes the mosaic: the full image, 1024 px,
    /// and its 512 px overview, both in 512 px WebP blocks, with the full image's tile
    /// index past the header's first read and its last tile left out.
    private static func file(tiepointX: Double = -20_037_508.342_789_244) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 20_100)
        func put(_ value: UInt64, at offset: Int, size: Int) {
            for index in 0..<size {
                bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (8 * index))
            }
        }
        bytes[0] = 0x49
        bytes[1] = 0x49
        put(42, at: 2, size: 2)
        put(8, at: 4, size: 4)
        var data = 1_000
        // A directory at `at` of (tag, type, values) entries, chained to `next`.
        func directory(at: Int, next: Int, _ entries: [(tag: UInt64, type: UInt64, values: [UInt64])], outOfLine: [UInt64: Int] = [:]) {
            put(UInt64(entries.count), at: at, size: 2)
            for (index, entry) in entries.enumerated() {
                let field = at + 2 + index * 12
                let size = entry.type == 3 ? 2 : entry.type == 12 ? 8 : 4
                put(entry.tag, at: field, size: 2)
                put(entry.type, at: field + 2, size: 2)
                put(UInt64(entry.values.count), at: field + 4, size: 4)
                var target = field + 8
                if size * entry.values.count > 4 {
                    target = outOfLine[entry.tag] ?? data
                    if outOfLine[entry.tag] == nil {
                        data += size * entry.values.count
                    }
                    put(UInt64(target), at: field + 8, size: 4)
                }
                for (offset, value) in entry.values.enumerated() {
                    put(value, at: target + offset * size, size: size)
                }
            }
            put(UInt64(next), at: at + 2 + entries.count * 12, size: 4)
        }
        let half = 20_037_508.342_789_244
        directory(
            at: 8, next: 200,
            [
                (256, 3, [1024]), (257, 3, [1024]), (259, 3, [50001]), (322, 3, [512]), (323, 3, [512]),
                (324, 4, [30_000, 31_000, 32_000, 0]), (325, 4, [100, 200, 300, 0]),
                (33550, 12, [(2 * half / 1024).bitPattern, (2 * half / 1024).bitPattern, 0]),
                (33922, 12, [0, 0, 0, tiepointX.bitPattern, half.bitPattern, 0]),
            ], outOfLine: [324: 20_000, 325: 20_016])
        directory(at: 200, next: 0, [(256, 3, [512]), (257, 3, [512]), (259, 3, [50001]), (322, 3, [512]), (323, 3, [512]), (324, 4, [40_000]), (325, 4, [400])])
        return bytes
    }

    private actor Reads {
        var ranges: [ClosedRange<Int>] = []
        func add(_ range: ClosedRange<Int>) { ranges.append(range) }
    }

    @Test func readsEachLevelsTilesFromTheHeaderAndIndex() async throws {
        let bytes = Self.file()
        let reads = Reads()
        let url = URL(string: "https://example.org/mosaic.tif")!
        let frame = try await Mosaic.open(url, credit: ["GOES-19 imagery: NOAA."]) { range in
            await reads.add(range)
            return Data(bytes[range.clamped(to: 0...(bytes.count - 1))])
        }
        // The header, then the full image's index past it.
        #expect(await reads.ranges == [0...16_383, 20_000...20_031])
        #expect(frame.credit == ["GOES-19 imagery: NOAA."])
        let source = frame.source
        #expect(source.maximumLevel == 1)
        #expect(source.projection == .webMercator && source.tileSize == 512)
        #expect(source.url(TileKey(level: 1, x: 1, y: 1)) == url)
        #expect(source.range?(TileKey(level: 0, x: 0, y: 0)) == 40_000...40_399)
        #expect(source.range?(TileKey(level: 1, x: 1, y: 0)) == 31_000...31_199)
        #expect(source.range?(TileKey(level: 1, x: 0, y: 1)) == 32_000...32_299)
        // Left out of the file, or finer than it goes.
        #expect(source.range?(TileKey(level: 1, x: 1, y: 1)) == nil)
        #expect(source.range?(TileKey(level: 2, x: 0, y: 0)) == nil)
    }

    @Test func refusesAFileThatIsNotTheWholeWorld() async {
        let bytes = Self.file(tiepointX: 0)
        await #expect(throws: MosaicError.self) {
            try await Mosaic.open(URL(string: "https://example.org/mosaic.tif")!) { Data(bytes[$0.clamped(to: 0...(bytes.count - 1))]) }
        }
        await #expect(throws: MosaicError.self) {
            try await Mosaic.open(URL(string: "https://example.org/page")!) { _ in Data("<!doctype html>".utf8) }
        }
    }

    @Test func listsTheSlotsTheItemLinksGive() throws {
        let url = URL(string: "https://example.org/geo/mosaic/collection.json")!
        let collection = Data(
            """
            {"links": [
              {"rel": "root", "href": "../catalog.json"},
              {"rel": "item", "href": "./2026/11/13/early.json", "datetime": "2026-11-13T02:00:00Z"},
              {"rel": "item", "href": "./2026/11/13/undated.json"},
              {"rel": "item", "href": "./2026/11/13/georing_mosaic_20261113T0300Z.json", "datetime": "2026-11-13T03:00:00Z"}
            ]}
            """.utf8)
        let slots = try #require(Mosaic.slots(collection: collection, at: url))
        let time = { (text: String) in try Date(text, strategy: .iso8601).timeIntervalSince1970 * 1000 }
        #expect(
            slots == [
                try time("2026-11-13T02:00:00Z"): URL(string: "https://example.org/geo/mosaic/2026/11/13/early.json")!,
                try time("2026-11-13T03:00:00Z"): URL(string: "https://example.org/geo/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.json")!,
            ])
        #expect(Mosaic.slots(collection: Data("not json".utf8), at: url) == nil)
    }

    @Test func findsAnItemsFileAndAttribution() throws {
        let url = URL(string: "https://example.org/geo/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.json")!
        let item = Data(
            """
            {"assets": {
              "thumbnail": {"href": "./thumb.png", "type": "image/png"},
              "image": {"href": "./georing_mosaic_20261113T0300Z.tif", "type": "image/tiff; application=geotiff; profile=cloud-optimized"}
            },
             "properties": {"georing:attribution": ["GOES-19 imagery: NOAA.", "Contains modified EUMETSAT Meteosat data 2026"]}}
            """.utf8)
        let file = try #require(Mosaic.file(item: item, at: url))
        #expect(file.url.absoluteString == "https://example.org/geo/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.tif")
        #expect(file.credit == ["GOES-19 imagery: NOAA.", "Contains modified EUMETSAT Meteosat data 2026"])
        #expect(Mosaic.file(item: Data(#"{"assets": {}}"#.utf8), at: url) == nil)
    }
}
