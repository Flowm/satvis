import Foundation
import Observation
import SatvisCore
import SatvisRender
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

/// The instrument imagery drawn on the globe (ADR 0020), each layer by its token,
/// `provider:layer`, as a link names it, drawn from the entry of whichever loaded record
/// carries it, at the clock's frame: the web app's `instrumentImagery` and its frame
/// sources (`GibsImagery.ts`, `EumetViewImagery.ts`).
@MainActor
@Observable
final class InstrumentImagery {
    /// What is drawn, the last on top, as a link names it: a name no loaded record
    /// carries yet stays, and is drawn once one does.
    private(set) var tokens: [String] = []
    /// The Map panel's name for each drawn layer a loaded record carries, "GeoColor ·
    /// GOES 19".
    private(set) var labels: [String: String] = [:]
    @ObservationIgnored private var layers: [String: SatelliteDetails.ImageryPreview] = [:]
    @ObservationIgnored private var frames: [String: Frames] = [:]
    @ObservationIgnored private var drawn: [ImageryOverlay] = []

    /// A layer's frames as its service last listed them.
    private struct Frames {
        var ranges: [TimeDomain.Range]?
        /// EUMETView's, from the same capabilities.
        var bounds: [Double]?
        var asked: Date
    }

    /// A day, in milliseconds.
    private static let day = 86_400_000.0
    /// How long after it began a listed day may still be filling in: the day itself,
    /// and the swaths that arrive hours behind.
    private static let filling = 2 * day
    /// How soon a service that could not list its frames is asked again.
    private static let retry: TimeInterval = 60

    func isShown(_ token: String) -> Bool {
        tokens.contains(token)
    }

    /// Draws a layer, on top, or takes it off.
    func show(_ token: String, _ shown: Bool) {
        tokens.removeAll { $0 == token }
        if shown {
            tokens.append(token)
        }
    }

    /// What a link draws, a name given twice once.
    func set(_ tokens: [String]) {
        var seen = Set<String>()
        self.tokens = tokens.filter { seen.insert($0).inserted }
    }

    /// Finds each drawn layer among the loaded records, as the catalog changes.
    func resolve(_ entries: some Sequence<CatalogEntry>) {
        let wanted = Set(tokens)
        var found: [String: SatelliteDetails.ImageryPreview] = [:]
        var named: [String: String] = [:]
        if !wanted.isEmpty {
            for entry in entries where entry.record.metadata["imagery"] != nil {
                for (label, layer) in SatelliteDetails.drawableImagery(entry.record) where wanted.contains(layer.token) && found[layer.token] == nil {
                    found[layer.token] = layer
                    named[layer.token] = "\(label) · \(entry.name)"
                }
            }
        }
        layers = found
        if named != labels {
            labels = named
        }
    }

    /// Keeps `apply` handed the drawn layers at the frame for `now`, once a second,
    /// asking each service for its frames when the clock passes the last it listed, as
    /// often as the service lets the list change, until cancelled.
    func follow(now: @escaping @MainActor () -> Double, apply: @escaping @MainActor ([ImageryOverlay]) -> Void) async {
        while !Task.isCancelled {
            let time = now()
            let overlays = tokens.compactMap { token in layers[token].map { overlay($0, at: time) } }
            if overlays != drawn {
                drawn = overlays
                apply(overlays)
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// `layer` at the frame for `time`, its frames asked for when they are due.
    private func overlay(_ layer: SatelliteDetails.ImageryPreview, at time: Double) -> ImageryOverlay {
        let known = frames[layer.token]
        let refresh: TimeInterval = layer.provider == .gibs ? 30 * 60 : 5 * 60
        let due: TimeInterval? =
            switch known?.ranges {
            case nil: known == nil ? 0 : Self.retry
            case let ranges?: time >= (ranges.last?.end ?? 0) ? refresh : nil
            }
        if let due, Date().timeIntervalSince(known?.asked ?? .distantPast) >= due {
            frames[layer.token, default: Frames(asked: Date())].asked = Date()
            Task { await list(layer) }
        }
        let daily = layer.provider == .gibs && layer.isDaily
        let frame: String? =
            if let ranges = known?.ranges, let snapped = TimeDomain.snap(ranges, to: time) {
                TimeDomain.format(snapped, daily: daily)
            } else {
                // GIBS's own name for its latest frame, which for a daily layer is the
                // day still filling in, so yesterday's; EUMETView draws its latest.
                daily ? TimeDomain.format(Date().timeIntervalSince1970 * 1000 - Self.day, daily: true) : layer.provider == .gibs ? "default" : nil
            }
        return ImageryOverlay(layer: layer, frame: frame, bounds: known?.bounds)
    }

    /// Asks `layer`'s service for its frames. A list it could not read leaves the last.
    private func list(_ layer: SatelliteDetails.ImageryPreview) async {
        let overlay = ImageryOverlay(layer: layer, frame: nil, bounds: nil)
        guard let url = overlay.framesURL, let (data, response) = try? await URLSession.shared.data(from: url),
            (response as? HTTPURLResponse)?.statusCode == 200
        else {
            log.error("No frames for \(layer.token, privacy: .public); drawing its latest")
            return
        }
        let text = String(decoding: data, as: UTF8.self)
        var ranges: [TimeDomain.Range]
        var bounds: [Double]?
        switch layer.provider {
        case .gibs:
            ranges = text.firstMatch(of: /<Domain>([^<]*)<\/Domain>/).map { TimeDomain.parse(String($0.1)) } ?? []
            // GIBS lists a day while it is still imaging it, and serves what is missing as
            // opaque black, so a daily layer shows the newest finished day.
            if layer.isDaily, let last = ranges.last, Date().timeIntervalSince1970 * 1000 - last.end < Self.filling {
                ranges = TimeDomain.withoutLatestFrame(ranges)
            }
        case .eumetview:
            let capabilities = EumetViewCapabilities(text)
            ranges = capabilities.ranges
            bounds = capabilities.bounds
        }
        var known = frames[layer.token] ?? Frames(asked: Date())
        if !ranges.isEmpty {
            known.ranges = ranges
        }
        known.bounds = bounds ?? known.bounds
        frames[layer.token] = known
    }
}
