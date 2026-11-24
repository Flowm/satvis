import Foundation
import SatvisCore
import SatvisRender
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "granules")

/// The drawn granule layers' granules behind the clock (ADR 0023): every day granule sensed
/// in the 50 minutes before the clock, its outline and, where the provider has them, its
/// pixels, so the swath builds up behind the satellite and falls away behind it. The web
/// app's `GranuleImagery.ts`; the renderer fills each in behind its satellite's scan line.
@MainActor
final class GranuleImagery {
    /// What one drawn layer has listed and shows.
    private final class Shown {
        var listing: (granules: [Granule], start: Double, end: Double)?
        var isAsking = false
        var asked = Date.distantPast
        var failed = false
        /// By granule key.
        var granules: [String: Entry] = [:]
    }

    private struct Entry {
        var granule: Granule
        var state: GranuleDrawing.State = .waiting
        var picture: GranulePicture?
        var task: Task<Void, Never>?
    }

    /// How long a granule stays behind the clock, in milliseconds: about the daylit half of a 101-minute polar orbit.
    static let trailMs = 50 * 60_000.0
    /// An hour, in milliseconds.
    private static let hourMs = 3_600_000.0
    /// How far before the clock's hour the granules are listed at once.
    private static let listBeforeMs = 2 * hourMs
    /// How far after the clock's hour the granules are listed at once.
    private static let listAfterMs = 2 * hourMs
    /// Seconds before a list that may still grow is asked again; CMR lists a granule hours
    /// after it is sensed.
    private static let refresh: TimeInterval = 10 * 60
    /// How far back from now a list may still grow, in milliseconds.
    private static let fillingMs = 4 * hourMs
    /// Seconds before a list the catalogue did not answer is asked again.
    private static let retry: TimeInterval = 60
    /// How often a picture the provider did not send is asked for.
    private static let pictureAttempts = 5
    /// How long apart.
    private static let pictureRetry: Duration = .seconds(20)

    private var layers: [DrawnGranuleLayer] = []
    private var shown: [String: Shown] = [:]
    private var drawn: [GranuleDrawing] = []
    private var fans: Set<String> = []
    private var pictured: [SatelliteDetails.GranulePictures] = []

    /// The layers to show, in drawn order.
    func set(_ layers: [DrawnGranuleLayer]) {
        self.layers = layers
        let tokens = Set(layers.map(\.layer.token))
        for (token, gone) in shown where !tokens.contains(token) {
            for entry in gone.granules.values {
                entry.task?.cancel()
            }
            shown[token] = nil
        }
    }

    /// Keeps `apply` handed the granules at the clock's time, the satellites whose fan
    /// they hold and the pictures of the layers that show one, four times a second, until
    /// cancelled. `isDrawn` says whether a catalog entry's satellite is on the globe, which
    /// fills the granules in behind it.
    func follow(
        now: @escaping @MainActor () -> Double, isDrawn: @escaping @MainActor (String) -> Bool,
        apply: @escaping @MainActor ([GranuleDrawing], Set<String>, [SatelliteDetails.GranulePictures]) -> Void
    ) async {
        while !Task.isCancelled {
            let time = now()
            var drawings: [GranuleDrawing] = []
            var holding = Set<String>()
            var showing: [SatelliteDetails.GranulePictures] = []
            for drawnLayer in layers {
                let layer = drawnLayer.layer
                let satellite = drawnLayer.owner.flatMap { isDrawn($0) ? $0 : nil }
                if let satellite {
                    holding.insert(satellite)
                }
                let ticked = tick(layer, satellite: satellite, at: time)
                // As the web app credits pictures: once the scan line has reached one.
                if let pictures = layer.pictures, ticked.contains(where: { $0.picture != nil && $0.start <= time }) {
                    showing.append(pictures)
                }
                drawings += ticked
            }
            if drawings != drawn || holding != fans || showing != pictured {
                drawn = drawings
                fans = holding
                pictured = showing
                apply(drawings, holding, showing)
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// The granules of `layer` behind `time`, oldest first, so a newer granule lies over
    /// the edge it shares with the one before; asks for its list when due.
    private func tick(_ layer: SatelliteDetails.GranuleLayer, satellite: String?, at time: Double) -> [GranuleDrawing] {
        let state = shown[layer.token] ?? Shown()
        shown[layer.token] = state
        let outside = state.listing.map { time - Self.trailMs < $0.start || time > $0.end } ?? true
        let filling = state.listing.map { $0.end > Date().timeIntervalSince1970 * 1000 - Self.fillingMs } ?? false
        let due: TimeInterval = state.failed ? Self.retry : outside ? 0 : filling ? Self.refresh : .infinity
        if !state.isAsking, Date().timeIntervalSince(state.asked) >= due {
            list(layer, state, around: time)
        }
        guard let listing = state.listing else {
            return []
        }
        let early = satellite == nil ? 0 : OverpassReplay.sensingSlackMs
        let trail = listing.granules.filter { $0.isDay && $0.start <= time + early && $0.start > time - Self.trailMs }
        let wanted = Set(trail.map(\.key))
        for (key, entry) in state.granules where !wanted.contains(key) {
            entry.task?.cancel()
            state.granules[key] = nil
        }
        for granule in trail where state.granules[granule.key] == nil {
            state.granules[granule.key] = Entry(granule: granule, state: layer.pictures == nil ? .pictured : .waiting)
            if layer.pictures != nil {
                state.granules[granule.key]?.task = Task { [weak state] in
                    // GIBS's WMS answered two requests in three with an error page on
                    // 2026-11-24, past the service's own three tries: asked again a while on.
                    for attempt in 0..<Self.pictureAttempts {
                        if attempt > 0 {
                            try? await Task.sleep(for: Self.pictureRetry)
                        }
                        let answer = await GranuleService.shared.picture(layer, granule)
                        guard !Task.isCancelled, let state, state.granules[granule.key] != nil else {
                            return
                        }
                        switch answer {
                        case .picture(let picture):
                            state.granules[granule.key]?.state = .pictured
                            state.granules[granule.key]?.picture = picture
                            return
                        case .missing:
                            state.granules[granule.key]?.state = .missing
                            return
                        case .none:
                            state.granules[granule.key]?.state = .pictured
                            return
                        case .failed:
                            // Waiting still: the fill's tint meanwhile.
                            continue
                        }
                    }
                }
            }
        }
        // A GIBS layer of a granule a frame drew each passed granule from its tiles on the
        // web; here its picture stays, and one without pixels keeps no fill.
        let tiled = layer.provider == .gibs && layer.pictures?.frame == .granule
        return trail.compactMap { granule in
            state.granules[granule.key].map { entry in
                GranuleDrawing(
                    id: "\(layer.token)|\(granule.key)", satellite: satellite, start: granule.start, end: granule.end, outline: granule.outline,
                    state: entry.state, picture: entry.picture, keepsFill: !(tiled && entry.state == .missing))
            }
        }
    }

    /// Asks for the granules around the clock's hour.
    private func list(_ layer: SatelliteDetails.GranuleLayer, _ state: Shown, around time: Double) {
        let hour = (time / Self.hourMs).rounded(.down) * Self.hourMs
        let start = hour - Self.listBeforeMs
        let end = hour + Self.listAfterMs
        state.isAsking = true
        state.asked = Date()
        Task { [weak state] in
            let granules = await GranuleService.shared.granules(GranuleQuery(layer, start: start, end: end))
            guard let state else {
                return
            }
            state.isAsking = false
            if granules == nil, !state.failed {
                log.error("Cannot list the granules of \(layer.layer, privacy: .public); asking again in a minute")
            }
            state.failed = granules == nil
            if let granules {
                state.listing = (granules, start, end)
            }
        }
    }
}
