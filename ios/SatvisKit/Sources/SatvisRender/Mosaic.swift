import CoreGraphics
import Foundation
import ImageIO
import SatvisCore

/// The geostationary mosaic (ADR 0022): an hour's scans of the four geostationary imagers
/// joined on one Web Mercator grid by the georing-mosaic project, a cloud-optimized
/// GeoTIFF an hour in its bucket, listed by a static STAC collection. As the web app's
/// `GeoMosaicImagery.ts` and `CogImageryProvider.ts` read it.
public enum Mosaic {
    /// The collection, whose item links carry each Slot's time.
    public static let collection = URL(string: "https://s.satvis.space/geo/mosaic/collection.json")!

    /// Pixels; the file's block size, a tile at every level.
    static let tileSize = 512

    /// The header's first read; GDAL writes a COG's directories at its start.
    static let headerBytes = 16_384

    /// Each Slot the collection lists, epoch milliseconds, to its item's url. A link without
    /// a time is left out; nil where the collection does not read.
    public static func slots(collection data: Data, at url: URL) -> [Double: URL]? {
        guard let links = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["links"] as? [[String: Any]] else {
            return nil
        }
        var slots: [Double: URL] = [:]
        for link in links where link["rel"] as? String == "item" {
            guard let href = link["href"] as? String, let item = URL(string: href, relativeTo: url)?.absoluteURL,
                let datetime = link["datetime"] as? String, let time = try? Date(datetime, strategy: .iso8601)
            else {
                continue
            }
            slots[time.timeIntervalSince1970 * 1000] = item
        }
        return slots
    }

    /// The COG among an item's assets, and the attribution lines the item asks for.
    public static func file(item data: Data, at url: URL) -> (url: URL, credit: [String])? {
        guard let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let assets = item["assets"] as? [String: [String: Any]],
            let href = assets.values.first(where: { ($0["type"] as? String)?.contains("profile=cloud-optimized") == true })?["href"] as? String,
            let file = URL(string: href, relativeTo: url)?.absoluteURL
        else {
            return nil
        }
        return (file, (item["properties"] as? [String: Any])?["georing:attribution"] as? [String] ?? [])
    }

    /// Reads the header and tile index of the COG at `url`, crediting `credit`, with
    /// `read`, which fetches a span of the file: one read, and a second where the
    /// header does not hold the finer levels' index.
    public static func open(_ url: URL, credit: [String] = [], read: @Sendable (ClosedRange<Int>) async throws -> Data) async throws -> MosaicFrame {
        var file = TIFFBytes(chunks: [(0, try await read(0...(headerBytes - 1)))])
        let images = try file.images()
        if let missing = file.missing(images.flatMap { [$0.offsets, $0.counts] }) {
            file.chunks.append((missing.lowerBound, try await read(missing)))
        }
        return try MosaicFrame(url: url, credit: credit, images: images, file: file)
    }
}

/// One frame of the mosaic: its file, and where each tile's bytes lie in it.
public struct MosaicFrame: Sendable, Equatable {
    public let url: URL
    /// The attribution its item asks for, a line a satellite.
    public let credit: [String]
    /// By level, each tile's bytes, x fastest; nil where the file holds no tile, as it
    /// leaves out those no satellite sees.
    let levels: [Int: [ClosedRange<Int>?]]

    /// A file is one frame.
    public static func == (a: MosaicFrame, b: MosaicFrame) -> Bool { a.url == b.url }

    /// Keeps the images of the whole Web Mercator square that are a level of the tile
    /// grid: 512·2^z pixels square, in 512-pixel WebP blocks.
    fileprivate init(url: URL, credit: [String], images: [TIFFBytes.Image], file: TIFFBytes) throws {
        guard let full = images.first, full.coversWorld else {
            throw MosaicError.notTheWorld
        }
        var levels: [Int: [ClosedRange<Int>?]] = [:]
        for image in images where image.width == image.height && image.tileWidth == Mosaic.tileSize && image.tileHeight == Mosaic.tileSize && image.compression == 50001 {
            let columns = image.width / Mosaic.tileSize
            guard columns > 0, columns.nonzeroBitCount == 1, columns * Mosaic.tileSize == image.width else {
                continue
            }
            let offsets = try file.values(image.offsets)
            let counts = try file.values(image.counts)
            levels[columns.trailingZeroBitCount] = (0..<columns * columns).map { index in
                // A sparse file may list fewer than it has tiles.
                let offset = index < offsets.count ? Int(offsets[index]) : 0
                let count = index < counts.count ? Int(counts[index]) : 0
                return offset > 0 && count > 0 ? offset...(offset + count - 1) : nil
            }
        }
        guard !levels.isEmpty else {
            throw MosaicError.noLevels
        }
        self.url = url
        self.credit = credit
        self.levels = levels
    }

    /// Where its tiles come from: 512-pixel Web Mercator tiles, each a range of the file,
    /// which never changes once listed.
    var source: ImagerySource {
        let levels = levels
        let url = url
        return ImagerySource(
            projection: .webMercator, tileSize: Mosaic.tileSize, maximumLevel: levels.keys.max() ?? 0, contentType: "image/tiff", isDated: true,
            url: { _ in url },
            range: { key in
                guard let level = levels[key.level] else {
                    return nil
                }
                let index = key.y * (1 << key.level) + key.x
                return index < level.count ? level[index] : nil
            })
    }
}

extension MosaicFrame {
    /// The frame in `bounds`, `width` by `height` pixels in plate carrée, as the WMS
    /// previews of the other layers are: the tiles of the coarsest level with a pixel for
    /// each of the picture's, read with `read`, resampled to the nearest pixel, as the web
    /// app's `geoMosaicPreview` makes it. Transparent where the mosaic is not; across the
    /// antimeridian the tiles wrap.
    public func preview(
        _ bounds: SatelliteDetails.PreviewBounds, width: Int, height: Int, read: @escaping @Sendable (ClosedRange<Int>) async throws -> Data
    ) async throws -> CGImage {
        let zooms = levels.keys.sorted()
        guard let zoom = zooms.first(where: { Double(Mosaic.tileSize << $0) * (bounds.east - bounds.west) / 360 >= Double(width) }) ?? zooms.last,
            let level = levels[zoom]
        else {
            throw MosaicError.noLevels
        }
        let size = Double(Mosaic.tileSize << zoom)
        let columns = 1 << zoom
        let tile = Double(Mosaic.tileSize)
        // Web Mercator pixel coordinates in the level's square.
        let mercatorX = { (longitude: Double) in (longitude + 180) / 360 * size }
        let mercatorY = { (latitude: Double) in (1 - Foundation.log(tan(Double.pi / 4 + latitude * Double.pi / 360)) / Double.pi) / 2 * size }
        let firstX = Int((mercatorX(bounds.west) / tile).rounded(.down))
        let lastX = Int((mercatorX(bounds.east) / tile).rounded(.down))
        let row = { (latitude: Double) in max(0, min(columns - 1, Int((mercatorY(latitude) / tile).rounded(.down)))) }
        let firstY = row(bounds.north)
        let lastY = row(bounds.south)

        let tiles = try await withThrowingTaskGroup(of: (x: Int, y: Int, image: CGImage?).self) { group in
            for x in firstX...lastX {
                for y in firstY...lastY {
                    let index = y * columns + ((x % columns) + columns) % columns
                    // A sparse tile, poleward of what any satellite sees, is left transparent.
                    guard index < level.count, let range = level[index] else {
                        continue
                    }
                    group.addTask {
                        let data = try await read(range)
                        return (x, y, CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
                    }
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }

        let stitchedWidth = (lastX - firstX + 1) * Mosaic.tileSize
        let stitchedHeight = (lastY - firstY + 1) * Mosaic.tileSize
        var stitched = [UInt8](repeating: 0, count: stitchedWidth * stitchedHeight * 4)
        var picture = [UInt8](repeating: 0, count: width * height * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        stitched.withUnsafeMutableBytes { bytes in
            let context = CGContext(
                data: bytes.baseAddress, width: stitchedWidth, height: stitchedHeight, bitsPerComponent: 8, bytesPerRow: stitchedWidth * 4, space: space, bitmapInfo: info)
            for case (let x, let y, let image?) in tiles {
                // A bitmap's first row is the top of the picture; Core Graphics counts from the bottom.
                context?.draw(
                    image,
                    in: CGRect(x: (x - firstX) * Mosaic.tileSize, y: stitchedHeight - (y - firstY + 1) * Mosaic.tileSize, width: Mosaic.tileSize, height: Mosaic.tileSize))
            }
        }
        let columnsFrom = (0..<width).map { px in
            Int(mercatorX(bounds.west + (Double(px) + 0.5) / Double(width) * (bounds.east - bounds.west)).rounded(.down)) - firstX * Mosaic.tileSize
        }
        for py in 0..<height {
            let sy = Int(mercatorY(bounds.north - (Double(py) + 0.5) / Double(height) * (bounds.north - bounds.south)).rounded(.down)) - firstY * Mosaic.tileSize
            guard sy >= 0, sy < stitchedHeight else {
                continue
            }
            for px in 0..<width {
                let sx = columnsFrom[px]
                guard sx >= 0, sx < stitchedWidth else {
                    continue
                }
                let from = (sy * stitchedWidth + sx) * 4
                let to = (py * width + px) * 4
                picture[to..<(to + 4)] = stitched[from..<(from + 4)]
            }
        }
        let image = picture.withUnsafeMutableBytes { bytes in
            CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: info)?.makeImage()
        }
        guard let image else {
            throw MosaicError.noLevels
        }
        return image
    }
}

enum MosaicError: Error {
    case notTIFF
    /// A value lies past the bytes read.
    case outside(Int)
    case notTheWorld
    case noLevels
}

/// The spans of a TIFF read so far, and what its directories say, classic or BigTIFF,
/// either byte order.
private struct TIFFBytes {
    var chunks: [(start: Int, data: Data)]

    /// A directory entry's values where they lie in the file.
    struct Values {
        var offset: Int
        var count: Int
        var size: Int
    }

    struct Image {
        var width = 0
        var height = 0
        var tileWidth = 0
        var tileHeight = 0
        var compression = 0
        var offsets = Values(offset: 0, count: 0, size: 4)
        var counts = Values(offset: 0, count: 0, size: 4)
        // Metres a pixel, x and y, and the top left corner's x and y.
        var scale: [Double] = []
        var tiepoint: [Double] = []

        /// Metres; the half width of the Web Mercator square.
        static let worldHalf = 20_037_508.342_789_244

        /// Covers the Web Mercator square, with 1 m of slack for the writer's rounding.
        var coversWorld: Bool {
            guard scale.count >= 2, tiepoint.count >= 5 else {
                return false
            }
            return abs(tiepoint[3] + Self.worldHalf) < 1 && abs(tiepoint[4] - Self.worldHalf) < 1 && abs(scale[0] * Double(width) - 2 * Self.worldHalf) < 1
        }
    }

    private var little = true

    init(chunks: [(start: Int, data: Data)]) {
        self.chunks = chunks
    }

    /// An unsigned integer of `size` bytes at `offset` in the file.
    func uint(_ offset: Int, _ size: Int) throws -> UInt64 {
        guard let chunk = chunks.first(where: { $0.start <= offset && offset + size <= $0.start + $0.data.count }) else {
            throw MosaicError.outside(offset)
        }
        let from = chunk.data.startIndex + offset - chunk.start
        let bytes = chunk.data[from..<from + size]
        return little ? bytes.reversed().reduce(0) { $0 << 8 | UInt64($1) } : bytes.reduce(0) { $0 << 8 | UInt64($1) }
    }

    func values(_ values: Values) throws -> [UInt64] {
        try (0..<values.count).map { try uint(values.offset + $0 * values.size, values.size) }
    }

    /// The span of the file holding those of `values` not read yet.
    func missing(_ values: [Values]) -> ClosedRange<Int>? {
        let unread = values.filter { (try? uint($0.offset, $0.size * max($0.count, 1))) == nil && $0.count > 0 }
        guard let start = unread.map(\.offset).min(), let end = unread.map({ $0.offset + $0.count * $0.size }).max() else {
            return nil
        }
        return start...(end - 1)
    }

    /// Every image the directories describe, the full one first.
    mutating func images() throws -> [Image] {
        guard let order = try? uint(0, 2), order == 0x4949 || order == 0x4D4D else {
            throw MosaicError.notTIFF
        }
        little = order == 0x4949
        let version = try uint(2, 2)
        guard version == 42 || version == 43 else {
            throw MosaicError.notTIFF
        }
        let big = version == 43
        let offsetSize = big ? 8 : 4
        var directory = Int(try uint(big ? 8 : 4, offsetSize))
        var images: [Image] = []
        // Bounded, so a looping chain of directories ends.
        while directory != 0, images.count < 64 {
            let entries = Int(try uint(directory, big ? 8 : 2))
            let first = directory + (big ? 8 : 2)
            let entrySize = big ? 20 : 12
            var image = Image()
            for index in 0..<entries {
                let entry = first + index * entrySize
                let size = Self.size(ofType: Int(try uint(entry + 2, 2)))
                let count = Int(try uint(entry + 4, big ? 8 : 4))
                let field = entry + (big ? 12 : 8)
                let values = Values(offset: size * count <= offsetSize ? field : Int(try uint(field, offsetSize)), count: count, size: size)
                switch try uint(entry, 2) {
                case 256: image.width = Int(try uint(values.offset, size))
                case 257: image.height = Int(try uint(values.offset, size))
                case 259: image.compression = Int(try uint(values.offset, size))
                case 322: image.tileWidth = Int(try uint(values.offset, size))
                case 323: image.tileHeight = Int(try uint(values.offset, size))
                case 324: image.offsets = values
                case 325: image.counts = values
                case 33550: image.scale = try self.values(values).map { Double(bitPattern: $0) }
                case 33922: image.tiepoint = try self.values(values).map { Double(bitPattern: $0) }
                default: break
                }
            }
            images.append(image)
            directory = Int(try uint(first + entries * entrySize, offsetSize))
        }
        return images
    }

    /// Bytes a value of a TIFF field type takes.
    private static func size(ofType type: Int) -> Int {
        switch type {
        case 3, 8: 2
        case 4, 9, 11, 13: 4
        case 5, 10, 12, 16, 17, 18: 8
        default: 1
        }
    }
}
