import Foundation
import SatvisData
import SatvisRender

/// satvis's star map, fetched from the site rather than shipped.
@MainActor
final class StarMap {
    private let globe: GlobeBinding

    init(globe: GlobeBinding) {
        self.globe = globe
    }

    /// The kept faces at once, then the site's, if they came back.
    func load(from repository: GroupRepository) async {
        if let kept = await repository.keptStarMap() {
            globe.starMap = kept
        }
        if let fetched = await repository.starMap(), fetched != globe.starMap {
            globe.starMap = fetched
        }
    }
}
