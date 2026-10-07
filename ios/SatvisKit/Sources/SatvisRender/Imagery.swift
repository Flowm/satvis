import Foundation

/// A tile in a quadtree over the globe. Row 0 is the northernmost. In the
/// geographic scheme, level 0 is two tiles side by side, west and east; in Web
/// Mercator, one.
public struct TileKey: Hashable, Sendable, CustomStringConvertible {
    public var level: Int
    public var x: Int
    public var y: Int

    public init(level: Int, x: Int, y: Int) {
        self.level = level
        self.x = x
        self.y = y
    }

    public var description: String { "\(level)/\(x)/\(y)" }

    var parent: TileKey? {
        level > 0 ? TileKey(level: level - 1, x: x / 2, y: y / 2) : nil
    }

    var children: [TileKey] {
        [(0, 0), (1, 0), (0, 1), (1, 1)].map { TileKey(level: level + 1, x: 2 * x + $0.0, y: 2 * y + $0.1) }
    }
}

/// West, south, east and north, in degrees.
struct Bounds: Equatable {
    var west: Double
    var south: Double
    var east: Double
    var north: Double

    func contains(latitude: Double, longitude: Double) -> Bool {
        west <= longitude && longitude <= east && south <= latitude && latitude <= north
    }
}

enum Projection: Sendable {
    /// Latitude and longitude, linear.
    case geographic
    /// Spherical Web Mercator, as XYZ tile servers use it, to ±85.05°.
    case webMercator

    static let mercatorLimit = 85.051_128_779_806_59

    func bounds(_ key: TileKey) -> Bounds {
        switch self {
        case .geographic:
            let span = 180 / Double(1 << key.level)
            return Bounds(west: -180 + Double(key.x) * span, south: 90 - Double(key.y + 1) * span, east: -180 + Double(key.x + 1) * span, north: 90 - Double(key.y) * span)
        case .webMercator:
            let n = Double(1 << key.level)
            func latitude(_ y: Double) -> Double { atan(sinh(.pi * (1 - 2 * y / n))) * 180 / .pi }
            return Bounds(west: -180 + Double(key.x) * 360 / n, south: latitude(Double(key.y + 1)), east: -180 + Double(key.x + 1) * 360 / n, north: latitude(Double(key.y)))
        }
    }

    /// Where a latitude falls down a tile of this projection at `level`, in tiles from
    /// the top: an integer part for the row and a fraction for within it.
    func row(latitude: Double, level: Int) -> Double {
        let n = Double(1 << level)
        switch self {
        case .geographic:
            return (90 - latitude) / 180 * n
        case .webMercator:
            let clamped = min(max(latitude, -Self.mercatorLimit), Self.mercatorLimit) * .pi / 180
            return (1 - log(tan(.pi / 4 + clamped / 2)) / .pi) / 2 * n
        }
    }

    func column(longitude: Double, level: Int) -> Double {
        let columns = Double(self == .geographic ? 2 << level : 1 << level)
        return (longitude + 180) / 360 * columns
    }

    func columns(_ level: Int) -> Int { self == .geographic ? 2 << level : 1 << level }

    func rows(_ level: Int) -> Int { 1 << level }

    /// The tiles at `level` that cover `bounds`.
    func covering(_ bounds: Bounds, level: Int) -> [TileKey] {
        let epsilon = 1e-9
        let firstColumn = max(0, Int((column(longitude: bounds.west, level: level) + epsilon).rounded(.down)))
        let lastColumn = min(columns(level) - 1, Int((column(longitude: bounds.east, level: level) - epsilon).rounded(.down)))
        let firstRow = max(0, Int((row(latitude: bounds.north, level: level) + epsilon).rounded(.down)))
        let lastRow = min(rows(level) - 1, Int((row(latitude: bounds.south, level: level) - epsilon).rounded(.down)))
        guard firstColumn <= lastColumn, firstRow <= lastRow else {
            return []
        }
        return (firstRow...lastRow).flatMap { y in (firstColumn...lastColumn).map { TileKey(level: level, x: $0, y: y) } }
    }
}

/// Where a tile server's imagery comes from, and how it is cut.
struct ImagerySource: Sendable {
    var projection: Projection
    var tileSize: Int
    var maximumLevel: Int
    /// What the answer's Content-Type must start with.
    var contentType: String
    var url: @Sendable (TileKey) -> URL?

    /// The source level whose texels best match a surface tile's at `level`: a
    /// surface tile is 256 texels across a geographic tile.
    func level(forSurface level: Int) -> Int {
        let shift = projection == .geographic ? Int(log2(Double(tileSize / 256))) : 0
        return min(max(level - shift, 0), maximumLevel)
    }
}

/// The globe's base map: the web app's base layers that the native app offers
/// (ADR 0008), by the names its `layers` url parameter uses.
public enum BaseLayer: String, CaseIterable, Sendable, Codable {
    case naturalEarth = "NaturalEarth"
    case versaTiles = "VersaTiles"
    case blackMarble = "BlackMarble"
    case viirs = "VIIRS"

    public var title: String {
        switch self {
        case .naturalEarth: "Natural Earth"
        case .versaTiles: "Satellite (VersaTiles)"
        case .blackMarble: "Black Marble"
        case .viirs: "VIIRS"
        }
    }

    /// Whether it shows the clock's day (`frame`), as VIIRS's daily true colour does.
    public var isDaily: Bool { self == .viirs }

    /// Where its tiles come from. Natural Earth is the site's own, levels 3 to 5:
    /// the app ships level 2 and draws everything over it. `frame` is a daily
    /// layer's day, `YYYY-MM-DD`; nil asks GIBS for its latest.
    func source(site: URL, frame: String? = nil) -> ImagerySource {
        switch self {
        case .naturalEarth:
            ImagerySource(projection: .geographic, tileSize: 256, maximumLevel: 5, contentType: "image/") { key in
                // A TMS pyramid: rows counted from the south.
                site.appending(path: "data/imagery/NaturalEarthII/\(key.level)/\(key.x)/\((1 << key.level) - 1 - key.y).webp")
            }
        case .versaTiles:
            ImagerySource(projection: .webMercator, tileSize: 512, maximumLevel: 19, contentType: "image/") { key in
                URL(string: "https://tiles.versatiles.org/tiles/satellite/\(key.level)/\(key.x)/\(key.y)")
            }
        case .blackMarble:
            // GIBS's geographic WMS, as the web app asks it: 512 pixels a tile. VIIRS
            // at 500 m gains nothing past level 7.
            ImagerySource(projection: .geographic, tileSize: 512, maximumLevel: 7, contentType: "image/") { key in
                let b = Projection.geographic.bounds(key)
                var components = URLComponents(string: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi")
                components?.queryItems = [
                    URLQueryItem(name: "service", value: "WMS"), URLQueryItem(name: "version", value: "1.1.1"), URLQueryItem(name: "request", value: "GetMap"),
                    URLQueryItem(name: "styles", value: ""), URLQueryItem(name: "layers", value: "VIIRS_Black_Marble"),
                    URLQueryItem(name: "format", value: "image/png"), URLQueryItem(name: "srs", value: "EPSG:4326"),
                    URLQueryItem(name: "bbox", value: "\(b.west),\(b.south),\(b.east),\(b.north)"),
                    URLQueryItem(name: "width", value: "512"), URLQueryItem(name: "height", value: "512"),
                ]
                return components?.url
            }
        case .viirs:
            // GIBS's daily true colour since 2015, as the web app's GibsTimeLayer asks
            // for it: Web Mercator WMTS, 256-pixel tiles to level 9, a frame a day. A
            // composite of swaths, so the gaps near the equator are black.
            ImagerySource(projection: .webMercator, tileSize: 256, maximumLevel: 9, contentType: "image/") { key in
                URL(
                    string:
                        "\(GIBS.wmts)/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/\(frame ?? "default")/GoogleMapsCompatible_Level9/\(key.level)/\(key.y)/\(key.x).jpg")
            }
        }
    }
}

/// NASA's Global Imagery Browse Services, for the daily layers' frames.
public enum GIBS {
    static let wmts = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

    /// Where VIIRS's frames are listed: the capabilities the web app's
    /// GibsTimeLayer reads its domain from.
    public static let viirsDomain = URL(string: "\(wmts)/1.0.0/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/all/all.xml")!

    /// The first and last day a layer's `<Domain>` lists (`timeDomain.ts`'s
    /// `parseDomain`, for a daily layer): ranges `start/end/P1D` or single days,
    /// by commas. Nil where it lists nothing usable.
    public static func days(inDomain xml: String) -> ClosedRange<String>? {
        guard let open = xml.range(of: "<Domain>"), let close = xml.range(of: "</Domain>", range: open.upperBound..<xml.endIndex) else {
            return nil
        }
        let dates = xml[open.upperBound..<close.lowerBound].split(separator: ",").flatMap { range in
            range.split(separator: "/").prefix(2).map { String($0.trimmingCharacters(in: .whitespaces).prefix(10)) }
        }
        .filter { $0.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil }
        guard let first = dates.min(), let last = dates.max() else {
            return nil
        }
        return first...last
    }

    /// The day a daily layer shows at an instant: its UTC date, within the days
    /// GIBS lists; outside them the nearest, as the web app's open-ended first and
    /// last frames show.
    public static func frame(at epochMilliseconds: Double, within days: ClosedRange<String>) -> String {
        let date = Date(timeIntervalSince1970: epochMilliseconds / 1000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let day = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 1, parts.day ?? 1)
        return min(max(day, days.lowerBound), days.upperBound)
    }
}

/// Mirrors `BakeVertex` in Shaders/Surface.msl: where on the surface tile, in clip
/// space, and where in the source tile, as texture coordinates.
struct BakeVertex {
    var position: SIMD2<Float>
    var source: SIMD2<Float>
}

enum Bake {
    /// How a source tile lands on a surface tile: a strip down the surface tile, its
    /// rows' texture coordinates worked out in double precision, since a float
    /// cannot place a pixel of a level-19 tile. One row for a geographic source,
    /// whose mapping is linear; 32 for Web Mercator, linear between them.
    static func strip(surface: Bounds, source: Bounds, projection: Projection) -> [BakeVertex] {
        let rows = projection == .geographic ? 1 : 32
        let u0 = (surface.west - source.west) / (source.east - source.west)
        let u1 = (surface.east - source.west) / (source.east - source.west)
        let top = projection.row(latitude: source.north, level: 0)
        let bottom = projection.row(latitude: source.south, level: 0)
        return (0...rows).flatMap { row -> [BakeVertex] in
            let t = Double(row) / Double(rows)
            let latitude = surface.north - t * (surface.north - surface.south)
            let v = (projection.row(latitude: latitude, level: 0) - top) / (bottom - top)
            let y = Float(1 - 2 * t)
            return [BakeVertex(position: SIMD2(-1, y), source: SIMD2(Float(u0), Float(v))), BakeVertex(position: SIMD2(1, y), source: SIMD2(Float(u1), Float(v)))]
        }
    }
}
