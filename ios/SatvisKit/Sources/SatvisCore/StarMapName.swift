import Foundation

/// A star map a link can name: the web app's `STAR_MAPS`, cheapest first
/// (src/config/starMaps.ts), and the `stars` parameter's vocabulary (ADR 0001).
/// The app draws the two DeepStar cuts, fetched from the site; Tycho1K, which
/// ships with CesiumJS, it draws as DeepStar1K.
public enum StarMapName: String, CaseIterable, Sendable {
    case tycho1K = "Tycho1K"
    case deepStar1K = "DeepStar1K"
    case deepStar2K = "DeepStar2K"

    /// The maps the app draws, which its Map panel offers.
    public static let drawable: [StarMapName] = [.deepStar1K, .deepStar2K]

    /// What the app draws for it.
    public var drawn: StarMapName {
        self == .deepStar2K ? .deepStar2K : .deepStar1K
    }

    /// The Map panel's name for it, the web app's `STAR_MAP_LABELS`.
    public var title: String {
        switch self {
        case .tycho1K: "Tycho (1K)"
        case .deepStar1K: "Deep Star (1K)"
        case .deepStar2K: "Deep Star (2K)"
        }
    }
}
