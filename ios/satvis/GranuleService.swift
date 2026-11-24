import CoreGraphics
import Foundation
import ImageIO
import SatvisCore
import SatvisRender
import os
import simd

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "granules")

/// Asks the granule catalogues and the picture services (ADR 0023): the web app's
/// `fetchGranules`, `gibsHasGranule`, `granulePictures.ts`, `overpassReplay.ts`'s
/// fetches and `GranuleLayers.ts`'s picture cuts. Answers are kept as the web app keeps
/// them: a granule's pixels once there, a "no" for ten minutes.
actor GranuleService {
    nonisolated static let shared = GranuleService()
    /// GIBS WMTS, whose level-0 tile of a granule says whether GIBS drew it.
    nonisolated private static let gibsWMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

    /// A minute, in milliseconds.
    nonisolated private static let minute = 60_000.0
    /// An hour, in milliseconds.
    nonisolated private static let hour = 60 * minute
    /// A day, in milliseconds.
    nonisolated private static let day = 24 * hour

    /// Seconds a granule found without pixels is taken as without them: its provider may
    /// still be taking it in.
    nonisolated private static let recheck: TimeInterval = 10 * 60
    /// Opaque pixels a granule's level-0 GIBS tile has at least where GIBS drew it.
    nonisolated private static let minOpaquePixels = 50
    /// Pixels across a cut probe; half of them lit is a granule there.
    nonisolated private static let probeSize = 16
    /// Darker than this in every channel is the black where the frame has no pixels.
    nonisolated private static let black: UInt8 = 8
    /// Times a picture is asked for before it counts as missing: GIBS's WMS answers about
    /// one small request in five with an empty exception, and the next one with it.
    nonisolated static let pictureTries = 3
    /// How far past the newest frame EUMETView's capabilities list its pictures may reach.
    nonisolated private static let eumetViewGridSlack = hour

    /// How far back the newest granule is looked for: as long as GIBS keeps a granule layer's frames.
    nonisolated private static let latestWithin = 90 * day
    /// Newest day granules asked for pixels before giving up.
    nonisolated private static let latestTries = 12
    /// Degrees from the equator past which a granule is not the one a card pictures.
    nonisolated private static let latestMaxLatitude = 50.0

    /// How far each way from the clock a satellite's own overpasses are listed.
    nonisolated private static let orbitsAround = day
    /// How long after a day ends the catalogue may still add granules to it, in milliseconds.
    nonisolated private static let growingDay = 4 * day
    /// Seconds before such a day is listed again.
    nonisolated private static let growingDayTTL: TimeInterval = 10 * 60
    /// Days kept at most, a fortnight's scrubbing either way.
    nonisolated private static let maxDays = 32

    // When a granule gets a picture, `GranuleLayers.ts`'s.
    /// Degrees from the equator past which a granule cut from a daily layer gets no picture:
    /// its day's later passes overlap it there.
    nonisolated private static let dailyMaxLatitude = 60.0
    /// Degrees of longitude past which a granule is pictured in polar stereographic where
    /// its provider draws that (EUMETView), and gets no picture otherwise.
    nonisolated private static let pictureMaxSpan = 90.0

    private struct DayListing {
        var task: Task<[Granule]?, Never>
        var asked: Date
    }

    private var pixelAnswers: [String: Task<Bool, Never>] = [:]
    private var days: [String: DayListing] = [:]
    private var dayOrder: [String] = []

    // MARK: Catalogues

    /// The granules `query` lists, sorted by start, or nil where the catalogue does not answer.
    func granules(_ query: GranuleQuery) async -> [Granule]? {
        if query.isDataStore {
            return await dataStoreGranules(query)
        }
        guard let url = URL(string: GranuleCatalogue.searchUrl(query)), let data = await Self.fetch(url, clientId: true) else {
            return nil
        }
        return GranuleCatalogue.cmrGranules(data, collections: query.collections)
    }

    /// The Data Store's granules for `query`, every page; nil where a page fails.
    private func dataStoreGranules(_ query: GranuleQuery) async -> [Granule]? {
        guard let url = URL(string: GranuleCatalogue.dataStoreUrl(query)), let data = await Self.fetch(url),
            let first = GranuleCatalogue.dataStorePage(data)
        else {
            return nil
        }
        // The first page says how many there are; the rest are asked for at once.
        let pages =
            query.newest == nil
            ? min(GranuleCatalogue.dataStoreMaxPages, (first.total + GranuleCatalogue.dataStorePageSize - 1) / GranuleCatalogue.dataStorePageSize) : 1
        var rest: [[Granule]?] = Array(repeating: nil, count: max(0, pages - 1))
        await withTaskGroup(of: (Int, [Granule]?).self) { group in
            for index in rest.indices {
                group.addTask { (index, await Self.dataStorePage(query, index + 1)) }
            }
            for await (index, granules) in group {
                rest[index] = granules
            }
        }
        guard !rest.contains(where: { $0 == nil }) else {
            return nil
        }
        return GranuleCatalogue.dataStoreGranules([first.granules] + rest.compactMap(\.self))
    }

    /// One page of the Data Store's granules, after the first.
    nonisolated private static func dataStorePage(_ query: GranuleQuery, _ index: Int) async -> [Granule]? {
        guard let url = URL(string: GranuleCatalogue.dataStoreUrl(query, page: index)), let data = await fetch(url) else {
            return nil
        }
        return GranuleCatalogue.dataStorePage(data)?.granules
    }

    /// The overpasses over `point` in the last month before `now`, by day and by night,
    /// oldest first; nil where the catalogue does not answer.
    func stationOverpasses(_ layer: SatelliteDetails.GranuleLayer, point: GroundPoint, now: Double) async -> [Overpass]? {
        let query = GranuleQuery(layer, start: now - OverpassReplay.stationDays * Self.day, end: now, point: point)
        return await granules(query).map(GranuleCatalogue.overpasses)
    }

    /// The satellite's overpasses by day from a day before `around` to a day after it, or
    /// to `now`, oldest first. Asked a UTC day at a time and kept, so the clock moving on
    /// asks for one new day.
    func orbitOverpasses(_ layer: SatelliteDetails.GranuleLayer, around: Double, now: Double) async -> [Overpass]? {
        let start = around - Self.orbitsAround
        let end = min(now, around + Self.orbitsAround)
        var day = (start / Self.day).rounded(.down) * Self.day
        var listed: [[Granule]?] = []
        while day < end {
            listed.append(await granulesOfDay(layer, day: day, now: now))
            day += Self.day
        }
        guard !listed.contains(where: { $0 == nil }) else {
            return nil
        }
        // A granule across midnight is in both days.
        var seen = Set<String>()
        let granules = listed.flatMap { $0 ?? [] }.filter { $0.end >= start && $0.start <= end && seen.insert($0.key).inserted }
        return GranuleCatalogue.overpasses(granules.sorted { $0.start < $1.start })
    }

    /// The layer's day granules of the UTC day starting at `day`, kept; a day that may still
    /// grow is asked again once `growingDayTTL` has passed.
    private func granulesOfDay(_ layer: SatelliteDetails.GranuleLayer, day: Double, now: Double) async -> [Granule]? {
        let key = "\(layer.token) \(day)"
        if let listing = days[key], !(day + Self.day >= now - Self.growingDay && Date().timeIntervalSince(listing.asked) >= Self.growingDayTTL) {
            return await listing.task.value
        }
        let task = Task { await self.granules(GranuleQuery(layer, start: day, end: day + Self.day))?.filter(\.isDay) }
        days[key] = DayListing(task: task, asked: Date())
        dayOrder.removeAll { $0 == key }
        dayOrder.append(key)
        while dayOrder.count > Self.maxDays {
            days[dayOrder.removeFirst()] = nil
        }
        let granules = await task.value
        if granules == nil {
            days[key] = nil
        }
        return granules
    }

    /// A layer's newest day granule whose pixels its pictures have, from before their
    /// newest frame, and the newest away from the poles, which a card pictures; nil where
    /// none of the last few has them or the catalogue does not answer.
    func latest(_ layer: SatelliteDetails.GranuleLayer, now: Double) async -> (newest: Granule, pictured: Granule)? {
        // Granules newer than the pictures' newest frame would each be asked for in vain.
        let picturesEnd = await layer.pictures.asyncFlatMap { await self.picturesEnd($0) }
        let end = min(now, picturesEnd ?? now)
        let query = GranuleQuery(layer, start: end - Self.latestWithin, end: end, newest: 3 * Self.latestTries)
        let newest = Array((await granules(query) ?? []).filter(\.isDay).reversed().prefix(Self.latestTries))
        var answers = Array(repeating: layer.pictures == nil, count: newest.count)
        if layer.pictures != nil {
            await withTaskGroup(of: (Int, Bool).self) { group in
                for (index, granule) in newest.enumerated() {
                    group.addTask { (index, await self.hasPixels(layer, granule)) }
                }
                for await (index, has) in group {
                    answers[index] = has
                }
            }
        }
        let had = newest.indices.filter { answers[$0] }.map { newest[$0] }
        guard let first = had.first else {
            return nil
        }
        return (first, had.first { abs($0.centre.latitude) <= Self.latestMaxLatitude } ?? first)
    }

    // MARK: Pixels

    /// Whether the layer's pictures have the granule's pixels; never for a layer of
    /// outlines alone. False, and asked again later, where the provider cannot be reached.
    func hasPixels(_ layer: SatelliteDetails.GranuleLayer, _ granule: Granule) async -> Bool {
        guard let pictures = layer.pictures else {
            return false
        }
        let key = "\(pictures.provider):\(pictures.layer)/\(granule.key)"
        if let answer = pixelAnswers[key] {
            return await answer.value
        }
        let task = Task<Bool, Never> {
            if case .granule = pictures.frame, layer.provider == .gibs {
                return await Self.gibsHasGranule(layer, start: granule.start)
            }
            return await Self.cutHasGranule(pictures, granule)
        }
        pixelAnswers[key] = task
        let has = await task.value
        if !has {
            forget(key, after: Self.recheck)
        }
        return has
    }

    /// Drops the pixel answer kept under `key` after `delay` seconds.
    private func forget(_ key: String, after delay: TimeInterval) {
        Task {
            try? await Task.sleep(for: .seconds(delay))
            self.pixelAnswers[key] = nil
        }
    }

    /// Whether GIBS has a granule layer's frame at `start`: its one tile at level 0, a 404
    /// where GIBS left the granule out, nearly empty where it drew little of it.
    nonisolated private static func gibsHasGranule(_ layer: SatelliteDetails.GranuleLayer, start: Double) async -> Bool {
        let format = layer.format?.rawValue ?? "png"
        let url = URL(
            string: "\(Self.gibsWMTS)/\(layer.layer)/default/\(TimeDomain.format(start, daily: false))/GoogleMapsCompatible_Level\(layer.maxLevel ?? 9)/0/0/0.\(format)")
        guard let url, let data = await fetch(url), let image = decode(data) else {
            return false
        }
        let pixels = rgba(image)
        var opaque = 0
        for index in stride(from: 3, to: pixels.count, by: 4) where pixels[index] > 0 {
            opaque += 1
        }
        return opaque >= minOpaquePixels
    }

    /// Whether the frame of `pictures` holding `granule` has its pixels: a small picture
    /// around the granule's centre, black where the frame lacks the granule.
    nonisolated private static func cutHasGranule(_ pictures: SatelliteDetails.GranulePictures, _ granule: Granule) async -> Bool {
        let bounds = GranuleCatalogue.probeBounds(granule)
        guard let url = URL(string: SatelliteDetails.granulePictureUrl(pictures, start: granule.start, bounds: bounds, width: probeSize, height: probeSize)),
            let image = await picture(url)
        else {
            return false
        }
        let pixels = rgba(image)
        var lit = 0
        for index in stride(from: 0, to: pixels.count, by: 4) where max(pixels[index], pixels[index + 1], pixels[index + 2]) > black {
            lit += 1
        }
        return lit >= probeSize * probeSize / 2
    }

    /// About when the newest frame of `pictures` ends, or nil where its provider does not
    /// say or does not answer.
    func picturesEnd(_ pictures: SatelliteDetails.GranulePictures) async -> Double? {
        if case .granule = pictures.frame {
            return nil
        }
        let preview = SatelliteDetails.ImageryPreview(
            provider: pictures.provider.tiles, layer: pictures.layer, maxLevel: 9, format: .jpeg, isDaily: false)
        guard let url = ImageryOverlay(layer: preview, frame: nil, bounds: nil).framesURL(), let data = await Self.fetch(url) else {
            return nil
        }
        let text = String(decoding: data, as: UTF8.self)
        if pictures.provider == .gibs {
            guard let domain = text.firstMatch(of: /<Domain>([^<]*)<\/Domain>/) else {
                return nil
            }
            var ranges = TimeDomain.parse(String(domain.1))
            // A day still being imaged.
            if let last = ranges.last, Date().timeIntervalSince1970 * 1000 - last.end < 2 * Self.day {
                ranges = TimeDomain.withoutLatestFrame(ranges)
            }
            return ranges.last.map { $0.end + Self.day }
        }
        return EumetViewCapabilities(text).ranges.last.map { $0.end + Self.eumetViewGridSlack }
    }

    // MARK: Pictures

    /// What asking for a granule's picture came to.
    enum PictureAnswer {
        case picture(GranulePicture)
        /// The provider has no pixels of it.
        case missing
        /// It gets none: near a pole from a daily layer or a provider that draws no polar
        /// projection, or a layer of outlines alone.
        case none
        /// The provider did not send it: worth asking again later.
        case failed
    }

    /// A granule's picture cut from its layer's pictures, black made clear.
    func picture(_ layer: SatelliteDetails.GranuleLayer, _ granule: Granule) async -> PictureAnswer {
        guard let pictures = layer.pictures else {
            return .none
        }
        guard await hasPixels(layer, granule) else {
            return .missing
        }
        let extent = granule.extent
        let stereographic = extent.east - extent.west > Self.pictureMaxSpan
        let daily = pictures.frame == .day && abs(granule.centre.latitude) > Self.dailyMaxLatitude
        if daily || (stereographic && pictures.provider != .eumetview) {
            return .none
        }
        let cut = stereographic ? PictureCut.polar(granule) : PictureCut.plateCarree(extent)
        let image: CGImage? =
            if cut.projection == nil, cut.bounds.east > 180, pictures.provider == .gibs {
                await Self.joinedPicture(pictures, start: granule.start, cut: cut)
            } else {
                await URL(
                    string: SatelliteDetails.granulePictureUrl(
                        pictures, start: granule.start, bounds: cut.bounds, width: cut.width, height: cut.height, srs: cut.projection?.srs ?? "EPSG:4326")
                ).asyncFlatMap { await Self.picture($0) }
            }
        guard let image, let clear = Self.clearingBlack(image) else {
            log.error("No picture of granule \(granule.key, privacy: .public) of \(layer.token, privacy: .public)")
            return .failed
        }
        return .picture(GranulePicture(image: clear, bounds: cut.bounds, projection: cut.projection))
    }

    /// The picture of a box that runs past 180° east, from its two sides: GIBS's WMS draws
    /// nothing for a box across the antimeridian.
    nonisolated private static func joinedPicture(_ pictures: SatelliteDetails.GranulePictures, start: Double, cut: PictureCut) async -> CGImage? {
        let bounds = cut.bounds
        let westWidth = max(1, Int((Double(cut.width) * (180 - bounds.west) / (bounds.east - bounds.west)).rounded()))
        var westBounds = bounds
        westBounds.east = 180
        let eastBounds = SatelliteDetails.PreviewBounds(west: -180, south: bounds.south, east: bounds.east - 360, north: bounds.north)
        let url = { (bounds: SatelliteDetails.PreviewBounds, width: Int) in
            URL(string: SatelliteDetails.granulePictureUrl(pictures, start: start, bounds: bounds, width: width, height: cut.height))
        }
        let westURL = url(westBounds, westWidth)
        let eastURL = url(eastBounds, max(1, cut.width - westWidth))
        async let west = picture(westURL)
        async let east = picture(eastURL)
        guard let west = await west, let east = await east,
            let context = CGContext(
                data: nil, width: west.width + east.width, height: cut.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else {
            return nil
        }
        context.draw(west, in: CGRect(x: 0, y: 0, width: west.width, height: cut.height))
        context.draw(east, in: CGRect(x: west.width, y: 0, width: east.width, height: cut.height))
        return context.makeImage()
    }

    /// The picture at `url`, asked for again where the service answers with an error: both
    /// answer one as XML, with a success status.
    nonisolated static func picture(_ url: URL, tries: Int = pictureTries) async -> CGImage? {
        for _ in 0..<tries {
            let answer: (Data, URLResponse)
            do {
                answer = try await URLSession.shared.data(from: url)
            } catch {
                log.error("Picture \(url, privacy: .public) unreachable: \(error, privacy: .public)")
                return nil
            }
            let response = answer.1 as? HTTPURLResponse
            let type = response?.value(forHTTPHeaderField: "Content-Type") ?? ""
            if response?.statusCode == 200, type.hasPrefix("image/"), let image = decode(answer.0) {
                return image
            }
            log.debug("Picture \(url, privacy: .public) answered \(response?.statusCode ?? 0) \(type, privacy: .public)")
        }
        return nil
    }

    /// `picture(_:tries:)` for an optional URL.
    nonisolated private static func picture(_ url: URL?) async -> CGImage? {
        guard let url else {
            return nil
        }
        return await picture(url)
    }

    /// The JPEG's black is where the granule has no pixels: clear, as a tile layer leaves it.
    nonisolated private static func clearingBlack(_ image: CGImage) -> CGImage? {
        var pixels = rgba(image)
        for index in stride(from: 0, to: pixels.count, by: 4) where max(pixels[index], pixels[index + 1], pixels[index + 2]) <= 5 {
            pixels[index] = 0
            pixels[index + 1] = 0
            pixels[index + 2] = 0
            pixels[index + 3] = 0
        }
        let data = Data(pixels) as CFData
        guard let provider = CGDataProvider(data: data) else {
            return nil
        }
        return CGImage(
            width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
            decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    /// An image's pixels as RGBA, premultiplied.
    nonisolated private static func rgba(_ image: CGImage) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            context?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return pixels
    }

    /// The first image in `data`, of any format Image I/O reads.
    nonisolated private static func decode(_ data: Data) -> CGImage? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    }

    /// The body of a successful answer; CMR asks every client to name itself.
    nonisolated private static func fetch(_ url: URL, clientId: Bool = false) async -> Data? {
        var request = URLRequest(url: url)
        if clientId {
            request.setValue(GranuleCatalogue.clientId, forHTTPHeaderField: "Client-Id")
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else {
            return nil
        }
        return data
    }
}

extension Optional {
    /// `flatMap` for an async transform.
    nonisolated func asyncFlatMap<T>(_ transform: (Wrapped) async -> T?) async -> T? {
        guard let self else {
            return nil
        }
        return await transform(self)
    }
}
