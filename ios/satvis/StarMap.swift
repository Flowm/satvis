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

    /// The kept faces at once, then the site's, if they came back.
    func load(from source: GPSource) async {
        if let kept = await source.keptStarMap() {
            faces = kept
            apply()
        }
        if let fetched = await source.starMap(), fetched != faces {
            faces = fetched
            apply()
        }
    }

    private func apply() {
        guard let renderer, let faces else {
            return
        }
        renderer.setStarMap(faces: faces)
    }
}
