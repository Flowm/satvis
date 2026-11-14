import Foundation
import SatvisCore

/// A tile in a quadtree over the globe. Row 0 is the northernmost. In the
/// geographic scheme, level 0 is two tiles side by side, west and east; in Web
/// Mercator, one.
struct TileKey: Hashable, Sendable, CustomStringConvertible {
    var level: Int
    var x: Int
    var y: Int

    init(level: Int, x: Int, y: Int) {
        self.level = level
        self.x = x
        self.y = y
    }

    var description: String { "\(level)/\(x)/\(y)" }

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
        (longitude + 180) / 360 * Double(columns(level))
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
    /// Whether its tiles are kept for good once fetched rather than cached
    /// (`TileRequest.keeps`): only for a pyramid small enough to keep whole.
    var keeps = false
    /// Whether it is a dated frame, which never changes (`TileRequest.isDated`).
    var isDated = false
    var url: @Sendable (TileKey) -> URL?

    /// The source level whose texels best match a surface tile's at `level`: a
    /// surface tile is 256 texels across a geographic tile.
    func level(forSurface level: Int) -> Int {
        let shift = projection == .geographic ? Int(log2(Double(tileSize / 256))) : 0
        return min(max(level - shift, 0), maximumLevel)
    }
}

/// The globe's base map: the web app's base layers that the native app offers
/// (ADR 0009), by the names its `layers` url parameter uses.
public enum BaseLayer: String, CaseIterable, Sendable, Codable {
    case naturalEarth = "NaturalEarth"
    case versaTiles = "VersaTiles"
    case blackMarble = "BlackMarble"

    /// The Map panel's name for it, the web app's (`CesiumLayerProviders.ts`).
    public var title: String {
        switch self {
        case .naturalEarth: "Natural Earth"
        case .versaTiles: "Satellite (VersaTiles)"
        case .blackMarble: "Night (Black Marble)"
        }
    }

    /// Where its tiles come from. Natural Earth is the site's own, levels 3 to 5:
    /// the app ships level 2 and draws everything over it, and keeps each finer
    /// tile once fetched, 17 MB for the lot, so that a place seen once shows offline.
    func source(site: URL) -> ImagerySource {
        switch self {
        case .naturalEarth:
            ImagerySource(projection: .geographic, tileSize: 256, maximumLevel: 5, contentType: "image/", keeps: true) { key in
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
        }
    }
}

/// NASA's Global Imagery Browse Services, for the instrument imagery's frames.
public enum GIBS {
    static let wmts = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

    /// Whether a frame no longer changes: one to the minute, or a day two days after it
    /// began, once its last swaths have arrived; not `default`, the latest.
    static func isWhole(_ frame: String) -> Bool {
        guard frame.count == 10 else {
            return frame != "default"
        }
        guard let day = try? Date("\(frame)T00:00:00Z", strategy: .iso8601) else {
            return false
        }
        return Date().timeIntervalSince(day) >= 2 * 86_400
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

/// An instrument's layer laid over the base map (ADR 0020), at one of its frames.
public struct ImageryOverlay: Sendable, Equatable {
    public var layer: SatelliteDetails.ImageryPreview
    /// The frame, as the service names it in a request; nil for the service's latest.
    public var frame: String?
    /// West, south, east and north in degrees, where the service says the layer ends;
    /// no tile outside them is asked for.
    public var bounds: [Double]?

    public init(layer: SatelliteDetails.ImageryPreview, frame: String?, bounds: [Double]?) {
        self.layer = layer
        self.frame = frame
        self.bounds = bounds
    }

    static let eumetView = "https://view.eumetsat.int/geoserver/ows"

    /// Where its tiles come from, as the web app's `gibsFrames` and `eumetViewFrames` ask
    /// for them: GIBS's Web Mercator WMTS set, `GoogleMapsCompatible_Level<maxLevel>`;
    /// EUMETView's WMS in 512-pixel geographic tiles, which have the detail of a
    /// 256-pixel Web Mercator one two levels down.
    var source: ImagerySource {
        let layer = layer
        let frame = frame
        switch layer.provider {
        case .gibs:
            return ImagerySource(
                projection: .webMercator, tileSize: 256, maximumLevel: layer.maxLevel, contentType: "image/", isDated: frame.map(GIBS.isWhole) ?? false
            ) { key in
                URL(
                    string:
                        "\(GIBS.wmts)/\(layer.layer)/default/\(frame ?? "default")/GoogleMapsCompatible_Level\(layer.maxLevel)/\(key.level)/\(key.y)/\(key.x).\(layer.format.rawValue)"
                )
            }
        case .eumetview:
            return ImagerySource(projection: .geographic, tileSize: 512, maximumLevel: max(0, layer.maxLevel - 2), contentType: "image/", isDated: frame != nil) { key in
                let b = Projection.geographic.bounds(key)
                var components = URLComponents(string: Self.eumetView)
                components?.queryItems =
                    [
                        URLQueryItem(name: "service", value: "WMS"), URLQueryItem(name: "version", value: "1.1.1"), URLQueryItem(name: "request", value: "GetMap"),
                        URLQueryItem(name: "layers", value: layer.layer), URLQueryItem(name: "styles", value: ""),
                        URLQueryItem(name: "format", value: "image/\(layer.format.rawValue)"), URLQueryItem(name: "transparent", value: "true"),
                        URLQueryItem(name: "srs", value: "EPSG:4326"), URLQueryItem(name: "bbox", value: "\(b.west),\(b.south),\(b.east),\(b.north)"),
                        URLQueryItem(name: "width", value: "512"), URLQueryItem(name: "height", value: "512"),
                    ] + (frame.map { [URLQueryItem(name: "time", value: $0)] } ?? [])
                return components?.url
            }
        }
    }

    /// Where its frames are listed: GIBS's WMTS domain for the layer, over `covering`
    /// (epoch milliseconds) or all of it, or the layer's own WMS capabilities, which
    /// list all of EUMETView's and give its bounds too.
    public func framesURL(covering: ClosedRange<Double>? = nil) -> URL? {
        switch layer.provider {
        case .gibs:
            let name = { (time: Double) in Date(timeIntervalSince1970: time / 1000).formatted(.iso8601) }
            let range = covering.map { "\(name($0.lowerBound))--\(name($0.upperBound))" } ?? "all"
            return URL(string: "\(GIBS.wmts)/1.0.0/\(layer.layer)/default/GoogleMapsCompatible_Level\(layer.maxLevel)/all/\(range).xml")
        case .eumetview:
            return URL(
                string: "https://view.eumetsat.int/geoserver/\(layer.layer.replacingOccurrences(of: ":", with: "/"))/ows?service=WMS&version=1.3.0&request=GetCapabilities")
        }
    }
}
