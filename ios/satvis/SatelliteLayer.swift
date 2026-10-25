import Foundation
import Observation
import SatvisCore
import SatvisRender

/// The active satellites on the globe, each with its window kept around the
/// clock's instant.
@Observable
final class SatelliteLayer {
    private(set) var count = 0
    @ObservationIgnored private let store = TrajectoryStore()
    @ObservationIgnored private let globe: GlobeBinding
    /// The entries `show` was last given, as the catalog keeps them.
    @ObservationIgnored private var shownEntries: [CatalogEntry] = []
    /// Bumped by every `show`, so that a set made before one is not taken for it.
    @ObservationIgnored private var showCount = 0
    /// The `showCount` that what the renderer draws was made after; -1 before anything.
    @ObservationIgnored private var drawnShowCount = -1
    /// Components a `show` gave with a set not drawn yet, handed over with it: given
    /// at once, 3D models for the set still drawn loaded 77 models, 490 MB.
    @ObservationIgnored private var pendingComponents: (components: SatelliteComponents, show: Int)?

    init(globe: GlobeBinding) {
        self.globe = globe
    }

    /// Whether the renderer draws `entries` as `show` was last given them: every
    /// one SGP4 can place, which leaves out a satellite long decayed, so the count
    /// drawn can stay below the count of entries.
    func draws(_ entries: [CatalogEntry]) -> Bool {
        drawnShowCount == showCount && isShown(entries)
    }

    /// Whether `show` was last given `entries`.
    private func isShown(_ entries: [CatalogEntry]) -> Bool {
        guard shownEntries.count == entries.count else {
            return false
        }
        // The catalog's array as it was handed over shares its storage until the
        // catalog replaces it, which spares comparing 16,000 ids four times a second.
        let same = shownEntries.withUnsafeBufferPointer { shown in entries.withUnsafeBufferPointer { $0.baseAddress == shown.baseAddress } }
        return same || shownEntries.elementsEqual(entries) { $0.id == $1.id }
    }

    /// The set to draw, and how: the components at once for the set drawn,
    /// else with the set once drawn.
    func show(_ entries: [CatalogEntry], components: SatelliteComponents, at time: Double) async {
        if draws(entries) {
            pendingComponents = nil
            globe.components = components
        } else {
            pendingComponents = (components, showCount + 1)
        }
        shownEntries = entries
        showCount += 1
        await store.replace(with: entries.map(\.record))
        await refresh(at: time)
    }

    /// Keeps every window around the clock's instant. Runs until cancelled, more
    /// often the faster the clock runs, so a window is refilled before it runs out.
    func run(clock: ViewerClock) async {
        while !Task.isCancelled {
            await refresh(at: clock.now())
            let interval = min(max(60 / max(abs(clock.clock.multiplier), 1), 0.05), 1)
            try? await Task.sleep(for: .seconds(interval))
        }
    }

    private func refresh(at time: Double) async {
        // Before the store is asked: a refresh asked before a `show`'s replacement
        // returns the set before it.
        let show = showCount
        guard let satellites = await store.refresh(at: time, as: Self.satellite) else {
            return
        }
        count = satellites.count
        let components = pendingComponents.flatMap { show >= $0.show ? $0.components : nil }
        await globe.setSatellites(satellites, components: components) { [weak self] in
            guard let self else {
                return
            }
            drawnShowCount = show
            if let pending = pendingComponents, show >= pending.show {
                pendingComponents = nil
            }
        }
    }

    /// What the renderer draws of an entry.
    private nonisolated static func satellite(_ entry: TrajectoryStore.Entry) -> PointSatellite {
        PointSatellite(
            id: Catalog.id(of: entry.record), name: entry.record.name, trajectory: entry.trajectory, color: entry.record.orbitClass.color,
            footprint: footprint(entry.record), model: entry.record.model)
    }

    /// The web app's ground track and sensor cone, which it draws for low orbits
    /// only: the record's swath or 200 km, and its field of view or 10°.
    private nonisolated static func footprint(_ record: GPRecord) -> Footprint? {
        guard record.orbitClass == .leo else {
            return nil
        }
        return Footprint(swath: SwathExtents(metadata: record.metadata) ?? .default, coneHalfAngleDegrees: record.metadata["coneFovDeg"]?.number ?? 10)
    }
}
