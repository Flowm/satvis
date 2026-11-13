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
    @ObservationIgnored private var layers: [String: SatelliteDetails.ImageryPreview] = [:]
    @ObservationIgnored private var frames: [String: Frames] = [:]
    @ObservationIgnored private var drawn: [ImageryOverlay] = []

    /// A layer's frames as its service last listed them.
    private struct Frames {
        var ranges: [TimeDomain.Range]?
        /// EUMETView's, from the same capabilities.
        var bounds: [Double]?
        /// The times `ranges` covers, epoch milliseconds, when not all of them.
        var covers: ClosedRange<Double>?
        var asked: Date
        var isAsking = false
        /// Whether the service has answered, with a list or without.
        var answered = false
        /// Whether its last answer was a list.
        var listed = false
    }

    /// A day, in milliseconds.
    private static let day = 86_400_000.0
    private static let hour = 3_600_000.0
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
        if !wanted.isEmpty {
            for entry in entries where entry.record.metadata["imagery"] != nil {
                for layer in SatelliteDetails.drawableImagery(entry.record) where wanted.contains(layer.token) && found[layer.token] == nil {
                    found[layer.token] = layer
                }
            }
        }
        layers = found
    }

    /// Keeps `apply` handed the drawn layers at the frame for `now`, once a second,
    /// asking each service for its frames when the clock passes the last it listed, as
    /// often as the service lets the list change, until cancelled.
    func follow(now: @escaping @MainActor () -> Double, apply: @escaping @MainActor ([ImageryOverlay]) -> Void) async {
        while !Task.isCancelled {
            let time = now()
            let overlays = tokens.compactMap { token in layers[token].flatMap { overlay($0, at: time) } }
            if overlays != drawn {
                drawn = overlays
                apply(overlays)
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// `layer` at the frame for `time`, its frames asked for when they are due. Nil
    /// until its service first answers, as on the web: its latest frame drawn
    /// meanwhile would be loaded in full before the clock's.
    private func overlay(_ layer: SatelliteDetails.ImageryPreview, at time: Double) -> ImageryOverlay? {
        let known = frames[layer.token]
        let refresh: TimeInterval = layer.provider == .gibs ? 30 * 60 : 5 * 60
        // A list that could not be read is asked for again; one that was, at once when
        // the clock leaves the times it covers, and once the clock is past its end.
        let due: TimeInterval? =
            if let known {
                if known.isAsking {
                    nil
                } else if !known.listed {
                    Self.retry
                } else if let covers = known.covers, !covers.contains(time) {
                    0
                } else if time >= (known.ranges?.last?.end ?? 0) {
                    refresh
                } else {
                    nil
                }
            } else {
                0
            }
        if let due, Date().timeIntervalSince(known?.asked ?? .distantPast) >= due {
            frames[layer.token, default: Frames(asked: Date())].asked = Date()
            frames[layer.token]?.isAsking = true
            Task { await list(layer, around: time) }
        }
        guard known?.answered == true else {
            return nil
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

    /// Asks `layer`'s service for its frames a day either side of `time`, on the hour so
    /// that other clocks ask the same, or all of them: for a daily layer, whose whole
    /// list is short, for one with none that near, as one that ended, and for EUMETView,
    /// which lists them all. Not when the service failed to answer, which would ask for
    /// the whole megabyte at every retry. A list it could not read leaves the last.
    private func list(_ layer: SatelliteDetails.ImageryPreview, around time: Double) async {
        var covers: ClosedRange<Double>?
        var listing: (ranges: [TimeDomain.Range], bounds: [Double]?)?
        if layer.provider == .gibs, !layer.isDaily {
            let hour = (time / Self.hour).rounded(.down) * Self.hour
            covers = (hour - Self.day)...(hour + Self.day)
            listing = await fetchFrames(layer, covering: covers)
        }
        if (listing == nil && covers == nil) || listing?.ranges.isEmpty == true {
            covers = nil
            listing = await fetchFrames(layer, covering: nil)
        }
        if listing?.ranges.isEmpty == true {
            listing = nil
        }
        var known = frames[layer.token] ?? Frames(asked: Date())
        known.isAsking = false
        known.answered = true
        known.listed = listing != nil
        if let listing {
            known.ranges = listing.ranges
            known.covers = covers
            known.bounds = listing.bounds ?? known.bounds
        } else {
            log.error("Could not list the frames of \(layer.token, privacy: .public)")
        }
        frames[layer.token] = known
    }

    /// The frames of `layer` its service lists over `covering`, or all of them, maybe
    /// none; nil when it cannot be reached.
    private func fetchFrames(_ layer: SatelliteDetails.ImageryPreview, covering: ClosedRange<Double>?) async -> (
        ranges: [TimeDomain.Range], bounds: [Double]?
    )? {
        let overlay = ImageryOverlay(layer: layer, frame: nil, bounds: nil)
        guard let url = overlay.framesURL(covering: covering), let (data, response) = try? await URLSession.shared.data(from: url),
            (response as? HTTPURLResponse)?.statusCode == 200
        else {
            return nil
        }
        let text = String(decoding: data, as: UTF8.self)
        var ranges: [TimeDomain.Range]
        var bounds: [Double]?
        switch layer.provider {
        case .gibs:
            guard let domain = text.firstMatch(of: /<Domain>([^<]*)<\/Domain>/) else {
                return nil
            }
            ranges = TimeDomain.parse(String(domain.1))
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
        return (ranges, bounds)
    }
}
