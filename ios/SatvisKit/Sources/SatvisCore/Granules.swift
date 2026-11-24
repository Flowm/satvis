import Foundation

// A granule layer's granules as NASA's CMR or EUMETSAT's Data Store lists them (ADR 0023):
// when each was sensed and the ground it covers. The web app's `cmrGranules.ts`,
// `eumetsatGranules.ts`, `granuleDay.ts` and `polarStereographic.ts`; fetching is the app's.

/// A point on the ground, in degrees.
public struct GroundPoint: Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

/// One granule: a few minutes of one instrument's swath.
public struct Granule: Sendable, Hashable {
    /// Epoch milliseconds.
    public var start: Double
    public var end: Double
    /// Sensed at least partly by day; a true colour picture has nothing of a night granule.
    public var isDay: Bool
    /// The ground it covers, a closed ring, its last point the first: CMR's outer polygon,
    /// a ring across the antimeridian unwrapped past it.
    public var outline: [GroundPoint]

    public init(start: Double, end: Double, isDay: Bool, outline: [GroundPoint]) {
        self.start = start
        self.end = end
        self.isDay = isDay
        self.outline = outline
    }

    /// Tells granules apart: when and where. HLS's tiles of one Landsat or Sentinel-2
    /// scene share their start, as many as 11 (2026-11-19).
    public var key: String {
        let corner = outline.first
        return "\(jsNumberString(start)) \(corner.map { jsNumberString($0.latitude) } ?? "undefined") \(corner.map { jsNumberString($0.longitude) } ?? "undefined")"
    }

    /// Its extent in degrees, its longitudes unwrapped from its first corner's, so one
    /// across the antimeridian has an `east` past 180 or a `west` before -180.
    public var extent: SatelliteDetails.PreviewBounds {
        let first = outline.first?.longitude ?? 0
        let longitudes = outline.map { $0.longitude + 360 * jsRound((first - $0.longitude) / 360) }
        let latitudes = outline.map(\.latitude)
        return SatelliteDetails.PreviewBounds(
            west: longitudes.min() ?? .infinity, south: latitudes.min() ?? .infinity, east: longitudes.max() ?? -.infinity, north: latitudes.max() ?? -.infinity)
    }

    /// Where it is, roughly: the mean of its outline's corners, across the antimeridian too.
    public var centre: GroundPoint {
        let corners = outline.dropLast()
        let first = corners.first?.longitude ?? 0
        // Each longitude within 180° of the first, so a granule across the antimeridian is
        // not averaged to the far side.
        let unwrap = { (longitude: Double) in longitude + 360 * jsRound((first - longitude) / 360) }
        let latitude = corners.reduce(0) { $0 + $1.latitude } / Double(corners.count)
        let longitude = corners.reduce(0) { $0 + unwrap($1.longitude) } / Double(corners.count)
        return GroundPoint(latitude: latitude, longitude: jsRemainder(jsRemainder(longitude + 180, 360) + 360, 360) - 180)
    }
}

/// Consecutive granules: one overpass of the satellite.
public struct Overpass: Sendable, Hashable {
    public var start: Double
    public var end: Double
    public var granules: [Granule]

    public init(start: Double, end: Double, granules: [Granule]) {
        self.start = start
        self.end = end
        self.granules = granules
    }

    /// Some of it sensed by day: a true colour picture has something of it.
    public var isDay: Bool { granules.contains(where: \.isDay) }
}

/// The granules from `start` to `end` (epoch milliseconds), or only those covering
/// `point`, or only the `newest` few.
public struct GranuleQuery: Sendable, Hashable {
    /// CMR concept ids, the preferred collection first, or one Data Store collection's id.
    public var collections: [String]
    /// The satellite's name, where a collection lists several.
    public var platform: String?
    public var start: Double
    public var end: Double
    public var point: GroundPoint?
    public var newest: Int?

    public init(collections: [String], platform: String? = nil, start: Double, end: Double, point: GroundPoint? = nil, newest: Int? = nil) {
        self.collections = collections
        self.platform = platform
        self.start = start
        self.end = end
        self.point = point
        self.newest = newest
    }

    /// `layer`'s catalogue, from `start` to `end`.
    public init(_ layer: SatelliteDetails.GranuleLayer, start: Double, end: Double, point: GroundPoint? = nil, newest: Int? = nil) {
        self.init(collections: layer.granules, platform: layer.platform, start: start, end: end, point: point, newest: newest)
    }

    /// Whether the Data Store lists it rather than CMR: "EO:EUM:DAT:0409".
    public var isDataStore: Bool {
        collections.first?.wholeMatch(of: /EO:EUM:DAT:[A-Z0-9:_-]+/) != nil
    }
}

/// Reading the catalogues' answers, and asking them.
public enum GranuleCatalogue {
    /// CMR asks every client to name itself, and throttles one that does not first.
    public static let clientId = "satvis"

    static let cmr = "https://cmr.earthdata.nasa.gov/search/granules.json"
    static let dataStore = "https://api.eumetsat.int/data/search-products/1.0.0/os"

    /// CMR's largest page. A 6-minute collection has 240 granules a day.
    static let cmrPageSize = 2000
    /// The Data Store's largest page.
    public static let dataStorePageSize = 500
    /// Pages asked of the Data Store at most: a day either side of the clock is 900
    /// Sentinel-3A granules, near-real-time and archived.
    public static let dataStoreMaxPages = 5
    /// Its near-real-time and archived copies of a granule start within microseconds.
    static let sameGranuleMs = 1000.0
    /// The longest gap between granules of one overpass: PACE's OCI and Sentinel-3's OLCI
    /// leave 1 s (measured 2026-11-21).
    static let joinGapMs = 60_000.0

    /// CMR's address for `query`, sorted by start, or newest first for `newest`.
    public static func searchUrl(_ query: GranuleQuery) -> String {
        var params = query.collections.map { ("collection_concept_id", $0) }
        if let platform = query.platform {
            params.append(("platform", platform))
        }
        params.append(("temporal", "\(isoInstant(query.start)),\(isoInstant(query.end))"))
        if let point = query.point {
            params.append(("point", "\(jsNumberString(point.longitude)),\(jsNumberString(point.latitude))"))
        }
        params.append(("page_size", String(query.newest ?? cmrPageSize)))
        params.append(("sort_key", query.newest == nil ? "start_date" : "-start_date"))
        return "\(cmr)?\(SatelliteDetails.formEncoded(params))"
    }

    /// One page of `query`'s granules from the Data Store, oldest first, or newest first
    /// for `newest`.
    public static func dataStoreUrl(_ query: GranuleQuery, page: Int = 0) -> String {
        var params = [("format", "json"), ("pi", query.collections.first ?? "")]
        if let platform = query.platform {
            params.append(("sat", platform))
        }
        params.append(("dtstart", isoInstant(query.start)))
        params.append(("dtend", isoInstant(query.end)))
        if let point = query.point {
            params.append(("geo", "POINT(\(jsNumberString(point.longitude)) \(jsNumberString(point.latitude)))"))
        }
        params.append(("c", String(min(query.newest ?? dataStorePageSize, dataStorePageSize))))
        params.append(("si", String(page * dataStorePageSize)))
        params.append(("sort", query.newest == nil ? "start,time,1" : "start,time,0"))
        return "\(dataStore)?\(SatelliteDetails.formEncoded(params))"
    }

    /// An instant as `toISOString` writes it: "2026-11-20T11:42:00.000Z".
    static func isoInstant(_ ms: Double) -> String {
        let utc = civilDate(epochMilliseconds: ms)
        let millisecond = String(utc.millisecond).leftPadded(to: 3)
        return "\(utc.year)-\(two(utc.month))-\(two(utc.day))T\(two(utc.hour)):\(two(utc.minute)):\(two(utc.second)).\(millisecond)Z"
    }

    /// The granules of CMR's JSON answer, sorted by start; of a start several
    /// collections list, the first collection's alone, as the near-real-time and standard
    /// copies of a granule start together, their corners apart. Nil for an answer that
    /// does not read.
    public static func cmrGranules(_ data: Data, collections: [String]) -> [Granule]? {
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = body else {
            return nil
        }
        let feed = fields["feed"].flatMap { if case .object(let feed) = $0 { feed } else { nil } }
        let entries = feed?["entry"]?.array ?? []
        let rank = Dictionary(collections.enumerated().map { ($1, $0) }) { first, _ in first }
        let ranked = entries.compactMap { entry -> (Granule, Int)? in
            guard let granule = parseCmrGranule(entry) else {
                return nil
            }
            let collection = if case .object(let fields) = entry { fields["collection_concept_id"]?.string } else { String?.none }
            return (granule, collection.flatMap { rank[$0] } ?? collections.count)
        }
        var best: [Double: Int] = [:]
        for (granule, rank) in ranked {
            best[granule.start] = min(rank, best[granule.start] ?? rank)
        }
        return stableSorted(ranked.filter { best[$0.0.start] == $0.1 }.map(\.0)) { $0.start < $1.start }
    }

    /// One page of the Data Store's answer: its granules, and how many the query has. Nil
    /// for an answer that does not read.
    public static func dataStorePage(_ data: Data) -> (granules: [Granule], total: Int)? {
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = body else {
            return nil
        }
        return ((fields["features"]?.array ?? []).compactMap(parseDataStoreGranule), Int(fields["totalResults"]?.number ?? 0))
    }

    /// The Data Store's pages as one list, one of each granule, sorted by start: it lists a
    /// granule twice for three weeks, near-real-time and archived.
    public static func dataStoreGranules(_ pages: [[Granule]]) -> [Granule] {
        let sorted = stableSorted(pages.flatMap(\.self)) { $0.start < $1.start }
        return sorted.enumerated().filter { $0.offset == 0 || $0.element.start - sorted[$0.offset - 1].start >= sameGranuleMs }.map(\.element)
    }

    /// One entry of CMR's JSON feed, or nil for one without times or a polygon.
    public static func parseCmrGranule(_ entry: JSONValue) -> Granule? {
        guard case .object(let fields) = entry, let start = fields["time_start"]?.string.flatMap(TimeDomain.instant),
            let end = fields["time_end"]?.string.flatMap(TimeDomain.instant), let ring = parseOutline(fields["polygons"])
        else {
            return nil
        }
        // NOAA's Metop granules say neither: the sun does.
        let flag = fields["day_night_flag"]?.string
        let isDay = flag == "DAY" || flag == "BOTH" ? true : flag == "NIGHT" ? false : sunlit(ring, start: start, end: end)
        return Granule(start: start, end: end, isDay: isDay, outline: withoutPoleCut(ring))
    }

    /// `"lat lon lat lon …"`, CMR's ring, to points; nil for one that does not read.
    static func parseRing(_ ring: JSONValue?) -> [GroundPoint]? {
        guard let text = ring?.string else {
            return nil
        }
        let words = text.split(whereSeparator: \.isWhitespace)
        let numbers = words.compactMap { Double($0) }.filter(\.isFinite)
        guard numbers.count == words.count, numbers.count >= 8, numbers.count % 2 == 0 else {
            return nil
        }
        return stride(from: 0, to: numbers.count, by: 2).map { GroundPoint(latitude: numbers[$0], longitude: numbers[$0 + 1]) }
    }

    /// An entry's outline: its outer ring, or the parts CMR splits a granule into at the
    /// antimeridian joined. Where they do not join, the largest part.
    static func parseOutline(_ polygons: JSONValue?) -> [GroundPoint]? {
        guard let polygons = polygons?.array, !polygons.isEmpty else {
            return nil
        }
        var rings: [[GroundPoint]] = []
        for polygon in polygons {
            guard let ring = parseRing(polygon.array?.first) else {
                return nil
            }
            rings.append(ring)
        }
        if rings.count == 1 {
            return rings[0]
        }
        return outerRing(rings.map { $0.map { [$0.longitude, $0.latitude] } })?.map { GroundPoint(latitude: $0[1], longitude: $0[0]) }
    }

    /// A ring round a pole without the cut CMR closes it with, up the antimeridian to the
    /// pole, along it and back: drawn, the cut was a line across the cap. Any other ring
    /// as it is.
    public static func withoutPoleCut(_ ring: [GroundPoint]) -> [GroundPoint] {
        let open = ring.dropLast().filter { abs($0.latitude) < 90 }
        guard open.count != ring.count - 1 else {
            return ring
        }
        // The cut's two ends, at 180° and -180°, are one point.
        let same = { (a: GroundPoint, b: GroundPoint) in a.latitude == b.latitude && jsRemainder(a.longitude - b.longitude, 360) == 0 }
        let kept = open.enumerated().filter { !same($0.element, open[(open.startIndex + ($0.offset + 1) % open.count)]) }.map(\.element)
        return kept.count < 3 ? ring : kept + [kept[0]]
    }

    /// Degrees from 180° a point may be and still lie on the cut.
    private static let onMeridian = 1e-6

    /// One ring of the parts the Data Store splits a granule into at the antimeridian,
    /// as `[longitude, latitude]` pairs: the western part a turn east, and the cut along
    /// 180° left out. Nil where the parts do not meet there, as a granule over a pole's cap.
    public static func joinAtAntimeridian(_ parts: [[[Double]]]) -> [[Double]]? {
        var chains: [[[Double]]] = []
        for part in parts {
            let open = part.dropLast().map { [$0[0] < 0 ? $0[0] + 360 : $0[0], $0[1]] }
            let onCut = open.map { abs($0[0] - 180) < onMeridian }
            // The cut is the run of points on the meridian; the chain runs from its last
            // point round to its first.
            guard let last = onCut.indices.first(where: { onCut[$0] && !onCut[($0 + 1) % open.count] }), !onCut.allSatisfy(\.self) else {
                return nil
            }
            var chain: [[Double]] = []
            var at = last
            for i in 0..<open.count {
                chain.append(open[at])
                if i > 0, onCut[at] {
                    break
                }
                at = (at + 1) % open.count
            }
            chains.append(chain)
        }
        guard chains.count == 2 else {
            return nil
        }
        let first = chains[0]
        // The second chain starts where the first ends, or runs the other way.
        let meets = { (a: [Double], b: [Double]) in abs(a[1] - b[1]) < 1e-3 }
        let next = meets(first.last!, chains[1][0]) ? chains[1] : chains[1].reversed()
        guard meets(first.last!, next[0]) else {
            return nil
        }
        let ring = first + next.dropFirst().dropLast()
        return ring + [ring[0]]
    }

    /// One ring of a granule's parts, joined at the antimeridian, or where they do not
    /// join the largest part.
    static func outerRing(_ parts: [[[Double]]]) -> [[Double]]? {
        joinAtAntimeridian(parts) ?? stableSorted(parts) { $0.count > $1.count }.first
    }

    /// A feature's outline as points, its parts joined; nil for one without a polygon.
    static func parseGeometry(_ geometry: JSONValue?) -> [GroundPoint]? {
        guard case .object(let fields) = geometry, let type = fields["type"]?.string, let coordinates = fields["coordinates"]?.array else {
            return nil
        }
        let ringOf = { (value: JSONValue?) -> [[Double]]? in
            guard let points = value?.array else {
                return nil
            }
            let pairs = points.map { $0.array?.compactMap(\.number) ?? [] }
            return pairs.allSatisfy { $0.count >= 2 && $0.allSatisfy(\.isFinite) } ? pairs : nil
        }
        var ring: [[Double]]?
        if type == "Polygon" {
            ring = ringOf(coordinates.first)
        } else if type == "MultiPolygon" {
            let parts = coordinates.map { ringOf($0.array?.first) }
            ring = parts.contains { $0 == nil } ? nil : outerRing(parts.compactMap(\.self))
        }
        guard let ring, ring.count >= 4 else {
            return nil
        }
        return ring.map { GroundPoint(latitude: $0[1], longitude: $0[0]) }
    }

    /// One feature of the Data Store's answer, or nil for one without times or a
    /// polygon. Whether by day is the sun's.
    public static func parseDataStoreGranule(_ feature: JSONValue) -> Granule? {
        guard case .object(let fields) = feature, case .object(let properties) = fields["properties"], let date = properties["date"]?.string else {
            return nil
        }
        let times = date.split(separator: "/", omittingEmptySubsequences: false).map { TimeDomain.instant(String($0)) }
        guard times.count >= 2, let start = times[0], let end = times[1], let outline = parseGeometry(fields["geometry"]) else {
            return nil
        }
        return Granule(start: start, end: end, isDay: sunlit(outline, start: start, end: end), outline: outline)
    }

    /// Granules that follow one another, as one overpass each. `granules` sorted by start.
    public static func overpasses(_ granules: [Granule]) -> [Overpass] {
        var overpasses: [Overpass] = []
        for granule in granules {
            if var last = overpasses.last, granule.start <= last.end + joinGapMs {
                last.end = max(last.end, granule.end)
                last.granules.append(granule)
                overpasses[overpasses.count - 1] = last
            } else {
                overpasses.append(Overpass(start: granule.start, end: granule.end, granules: [granule]))
            }
        }
        return overpasses
    }

    // MARK: Day or night

    /// Days since J2000.0 (2000-01-01T12:00Z), in milliseconds since 1970.
    private static let j2000 = 946_728_000_000.0

    /// The sun's elevation in degrees at `point` and `time` (epoch milliseconds), by the
    /// Astronomical Almanac's low-precision formulas: within 0.1° to 2050, ample for day
    /// or night.
    public static func sunElevation(_ point: GroundPoint, time: Double) -> Double {
        let radians = Double.pi / 180
        let days = (time - j2000) / 86_400_000
        let anomaly = (357.529 + 0.98560028 * days) * radians
        let meanLongitude = 280.459 + 0.98564736 * days
        let longitude = (meanLongitude + 1.915 * sin(anomaly) + 0.02 * sin(2 * anomaly)) * radians
        let obliquity = (23.439 - 0.00000036 * days) * radians
        let rightAscension = atan2(cos(obliquity) * sin(longitude), cos(longitude))
        let declination = asin(sin(obliquity) * sin(longitude))
        let siderealDegrees = 280.46061837 + 360.98564736629 * days
        let hourAngle = (siderealDegrees + point.longitude) * radians - rightAscension
        let latitude = point.latitude * radians
        return asin(sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle)) / radians
    }

    /// Whether the sun was up over any corner of `outline` midway through `start` to
    /// `end`: some of it sensed by day.
    public static func sunlit(_ outline: [GroundPoint], start: Double, end: Double) -> Bool {
        let time = (start + end) / 2
        return outline.contains { sunElevation($0, time: time) > 0 }
    }

    // MARK: Probing a picture

    /// Degrees either side of a granule's centre a probe asks for at most: well inside a
    /// 3-minute OLCI granule, 11° across.
    static let probeHalfWidth = 1.0

    /// The middle of a granule's extent, its longitude on the globe, and a box a quarter
    /// of the granule's size across at most, on one side of the antimeridian, where GIBS's
    /// WMS draws nothing across it.
    public static func probeBounds(_ granule: Granule) -> SatelliteDetails.PreviewBounds {
        let extent = granule.extent
        let longitude = jsRemainder(jsRemainder((extent.west + extent.east) / 2 + 180, 360) + 360, 360) - 180
        let latitude = (extent.south + extent.north) / 2
        let half = min(probeHalfWidth, (extent.east - extent.west) / 4, (extent.north - extent.south) / 4)
        let centre = min(180 - half, max(-180 + half, longitude))
        return SatelliteDetails.PreviewBounds(west: centre - half, south: latitude - half, east: centre + half, north: latitude + half)
    }
}

/// A polar stereographic projection on WGS84, its central meridian 0°, as EUMETView's WMS
/// draws a pole's pictures in (Snyder, Map Projections: A Working Manual, 21-33 to 21-38).
public struct PolarProjection: Sendable, Hashable {
    /// Its EPSG code, as a WMS names it.
    public var srs: String
    /// 1 for the north pole, -1 for the south.
    public var pole: Double
    /// Degrees, where a metre of the map is a metre of the ground.
    public var trueScaleLatitude: Double

    /// Arctic Polar Stereographic.
    public static let arctic = PolarProjection(srs: "EPSG:3995", pole: 1, trueScaleLatitude: 71)
    /// NSIDC Sea Ice Polar Stereographic South.
    public static let antarctic = PolarProjection(srs: "EPSG:3976", pole: -1, trueScaleLatitude: -70)

    /// WGS84's first eccentricity.
    public static let eccentricity = 0.00669437999014.squareRoot()
    private static let semiMajorAxis = 6_378_137.0

    /// Snyder's t of a latitude in radians, on the pole's own side.
    private static func t(_ latitude: Double) -> Double {
        let sine = eccentricity * sin(latitude)
        return tan(.pi / 4 - latitude / 2) / pow((1 - sine) / (1 + sine), eccentricity / 2)
    }

    /// Metres from the pole a unit of `t` is: a times Snyder's m over t at the latitude
    /// of true scale.
    public var radiusScale: Double {
        let latitude = pole * trueScaleLatitude * .pi / 180
        let sine = sin(latitude)
        return Self.semiMajorAxis * cos(latitude) / (1 - Self.eccentricity * Self.eccentricity * sine * sine).squareRoot() / Self.t(latitude)
    }

    /// Where `point` lies, metres east and north of the pole.
    public func project(_ point: GroundPoint) -> (x: Double, y: Double) {
        let radius = radiusScale * Self.t(pole * point.latitude * .pi / 180)
        let longitude = point.longitude * .pi / 180
        return (radius * sin(longitude), -pole * radius * cos(longitude))
    }
}

/// `Math.round`: halves up, toward positive infinity.
func jsRound(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// JavaScript's `%`: the remainder with the dividend's sign.
func jsRemainder(_ a: Double, _ b: Double) -> Double {
    a.truncatingRemainder(dividingBy: b)
}

/// Sorted as `Array.prototype.sort` sorts, keeping equal elements in order.
func stableSorted<T>(_ items: [T], by less: (T, T) -> Bool) -> [T] {
    items.enumerated().sorted { less($0.element, $1.element) || (!less($1.element, $0.element) && $0.offset < $1.offset) }.map(\.element)
}

extension String {
    /// Zeros before it up to `width` characters, as `padStart(width, "0")`.
    func leftPadded(to width: Int) -> String {
        String(repeating: "0", count: max(0, width - count)) + self
    }
}
