import Foundation
import Observation
import SatvisCore
import SatvisData
import SatvisRender
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "satellites")

/// The satellites on the globe: for now, every group carrying a tag the default
/// preset enables (Weather), at the live time.
@Observable
final class SatelliteLayer {
    private(set) var count = 0
    @ObservationIgnored private let store = TrajectoryStore()
    @ObservationIgnored private var renderer: GlobeRenderer?
    /// Kept for a renderer that arrives after them: it compiles its shaders first.
    @ObservationIgnored private var satellites: [PointSatellite] = []

    func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        renderer.setSatellites(satellites)
    }

    /// The groups the default preset's `tags` default enables.
    func load(from source: GPSource) async {
        guard let index = source.index?.value, let preset = index.preset(named: nil) else {
            return
        }
        let tags = Set((preset.defaults["tags"] ?? "").split(separator: ",").map(String.init))
        let registered = Set(preset.groups.map(\.name))
        var records: [GPRecord] = []
        for group in index.groups where registered.contains(group.name) && !tags.isDisjoint(with: group.tags) {
            do {
                records += try await source.records(of: group.name).value
            } catch {
                log.error("Group \(group.name, privacy: .public) unavailable: \(error, privacy: .public)")
            }
        }
        await store.replace(with: records)
        await refresh()
    }

    /// Keeps every window around the present. Runs until cancelled.
    func run() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func refresh() async {
        let now = ContentView.pinnedTime ?? (Date().timeIntervalSince1970 * 1000).rounded(.down)
        guard let entries = await store.refresh(at: now) else {
            return
        }
        count = entries.count
        satellites = entries.map {
            PointSatellite(id: "\($0.record.satnum)|\($0.record.name)", name: $0.record.name, trajectory: $0.trajectory, color: $0.record.orbitClass.color)
        }
        renderer?.setSatellites(satellites)
    }
}
