import Foundation
import SatvisCore
import SatvisData
import SatvisRender

/// satvis's star maps, fetched from the site rather than shipped, each kept once
/// fetched. The 2K one is fetched only once it is chosen.
@MainActor
final class StarMap {
    private let globe: GlobeBinding
    private let repository: GroupRepository
    /// The map drawn or on its way, a `StarMapName.drawn`.
    private var wanted: StarMapName?
    /// The map whose faces the globe was given last.
    private var drawn: StarMapName?
    /// The fetch of `wanted` under way, cancelled when another map is chosen.
    private var loading: Task<Void, Never>?
    /// Told of a map neither kept nor fetched, while another is drawn in its place.
    var onUnavailable: ((StarMapName) -> Void)?

    init(globe: GlobeBinding, repository: GroupRepository) {
        self.globe = globe
        self.repository = repository
    }

    /// Draws `map` as the app can, dropping a map still on its way.
    func show(_ map: StarMapName) {
        let map = map.drawn
        guard map != wanted else {
            return
        }
        wanted = map
        loading?.cancel()
        loading = Task { await load(map) }
    }

    /// The kept faces at once, then the site's, if they came back. A 2K map not
    /// kept yet is waited for behind the 1K one, which stays drawn until it arrives.
    private func load(_ map: StarMapName) async {
        if let kept = await repository.keptStarMap(map) {
            draw(kept, as: map)
        } else if map != .deepStar1K, drawn == nil {
            if let kept = await repository.keptStarMap(.deepStar1K) {
                draw(kept, as: .deepStar1K)
            } else if let fetched = await repository.starMap(.deepStar1K) {
                draw(fetched, as: .deepStar1K)
            }
        }
        if let fetched = await repository.starMap(map) {
            draw(fetched, as: map)
        } else if map != .deepStar1K, drawn != map, !Task.isCancelled {
            onUnavailable?(map)
        }
    }

    /// Hands `faces` to the globe as `map`, unless another map was chosen meanwhile.
    private func draw(_ faces: [Data], as map: StarMapName) {
        guard !Task.isCancelled else {
            return
        }
        drawn = map
        // Decoded again only when they changed, as revalidating mostly finds them the same.
        if faces != globe.starMap {
            globe.starMap = faces
        }
    }
}
