import Foundation
import Observation
import SatvisCore

/// The newest pass of each granule layer a satellite's cards show, by card key: the newest
/// day granule with pixels, which a card pictures and the clock goes to, as a layer's
/// latest frame may be by night or one GIBS left out. The web app's `useLatestPasses`.
@MainActor
@Observable
final class LatestPasses {
    /// The newest passes of each layer, by its key, once the catalogue has answered.
    private(set) var latest: [String: (newest: Granule, pictured: Granule)] = [:]

    /// How often the newest granules are asked again while they are shown: CMR lists one
    /// every 6 minutes.
    private static let refresh: Duration = .seconds(10 * 60)

    /// Asks for each layer's newest passes, and again each `refresh`, until cancelled.
    func follow(_ layers: [(key: String, layer: SatelliteDetails.GranuleLayer)]) async {
        latest = [:]
        guard !layers.isEmpty else {
            return
        }
        while !Task.isCancelled {
            let now = Date().timeIntervalSince1970 * 1000
            let found = await withTaskGroup(of: (String, (newest: Granule, pictured: Granule)?).self) { group in
                for (key, layer) in layers {
                    group.addTask { (key, await GranuleService.shared.latest(layer, now: now)) }
                }
                var found: [String: (newest: Granule, pictured: Granule)] = [:]
                for await (key, granules) in group {
                    found[key] = granules
                }
                return found
            }
            if Task.isCancelled {
                return
            }
            latest.merge(found) { _, new in new }
            try? await Task.sleep(for: Self.refresh)
        }
    }

    /// The clock is past the newest pass, so the layer shows nothing at its time.
    func isPastNewest(_ key: String, time: Double) -> Bool {
        latest[key].map { time > $0.newest.end + OverpassReplay.afterOverpassMs } ?? false
    }

    /// The clock to a few minutes before the newest pictured pass, so the satellite flies onto it.
    func goToNewest(_ key: String, clock: ViewerClock) {
        if let granule = latest[key]?.pictured {
            clock.scrub(to: granule.start - OverpassReplay.leadMs)
        }
    }
}
