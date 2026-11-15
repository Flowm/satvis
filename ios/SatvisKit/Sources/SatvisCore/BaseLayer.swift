import Foundation

/// The globe's base map: the web app's base layers that the native app offers
/// (ADR 0009), and the `layers` parameter's vocabulary (ADR 0001), in the web
/// app's order.
public enum BaseLayer: String, CaseIterable, Sendable, Codable {
    case naturalEarth = "NaturalEarth"
    case versaTiles = "VersaTiles"
    case blackMarble = "BlackMarble"

    /// The Map panel's name for it, the web app's (`CesiumLayerProviders.ts`).
    public var title: String {
        switch self {
        case .naturalEarth: "Natural Earth"
        case .versaTiles: "Satellite (VersaTiles)"
        case .blackMarble: "Night (Black Marble)"
        }
    }
}
