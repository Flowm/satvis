import Foundation
import SatvisRender

/// satvis's star map, fetched from the site rather than shipped, handed to the
/// renderer once both exist, whichever comes first.
@MainActor
final class StarMap {
    private var renderer: GlobeRenderer?
    private var faces: [Data]?

    func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        apply()
    }

    func load(from source: GPSource) async {
        faces = await source.starMap()
        apply()
    }

    private func apply() {
        guard let renderer, let faces else {
            return
        }
        renderer.setStarMap(faces: faces)
    }
}
