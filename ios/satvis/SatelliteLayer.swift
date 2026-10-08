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
    @ObservationIgnored private var renderer: GlobeRenderer?
    /// Kept for a renderer that arrives after them: it compiles its shaders first.
    @ObservationIgnored private var satellites: [PointSatellite] = []
    @ObservationIgnored private var components: SatelliteComponents = [.point, .label]

    /// Bumped by every set handed over, so a slow packing never replaces a newer one.
    @ObservationIgnored private var generation = 0

    func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        renderer.components = components
        Task { await hand(satellites) }
    }

    /// The set to draw, and how.
    func show(_ entries: [CatalogEntry], components: SatelliteComponents, at time: Double) async {
        self.components = components
        renderer?.components = components
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
        guard let entries = await store.refresh(at: time) else {
            return
        }
        count = entries.count
        satellites = entries.map {
            PointSatellite(
                id: "\($0.record.satnum)|\($0.record.name)", name: $0.record.name, trajectory: $0.trajectory, color: $0.record.orbitClass.color,
                footprint: Self.footprint($0.record), modelFile: $0.record.metadata["modelFile"]?.string)
        }
        await hand(satellites)
    }

    /// The web app's ground track and sensor cone, which it draws for low orbits
    /// only: the record's swath or 200 km, and its field of view or 10°.
    private static func footprint(_ record: GPRecord) -> Footprint? {
        guard record.orbitClass == .leo else {
            return nil
        }
        return Footprint(swathKm: (SwathExtents(metadata: record.metadata) ?? .default).widthKm, coneHalfAngleDegrees: record.metadata["coneFovDeg"]?.number ?? 10)
    }

    /// Packed off the main thread, then handed to the renderer.
    private func hand(_ satellites: [PointSatellite]) async {
        guard let renderer else {
            return
        }
        generation += 1
        let mine = generation
        let prepared = await renderer.prepare(satellites)
        if mine == generation {
            renderer.setSatellites(prepared)
        }
    }
}
