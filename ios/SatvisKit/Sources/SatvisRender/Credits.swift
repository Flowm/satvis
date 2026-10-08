import Foundation

/// A line of the attribution the globe owes, as the web app's credit display
/// words it.
public struct Credit: Hashable, Sendable {
    public var text: String
    public var link: URL?

    public init(_ text: String, link: String? = nil) {
        self.text = text
        self.link = link.flatMap(URL.init(string:))
    }

    /// What the map is drawn from now: the shipped Natural Earth, which is under
    /// every base map, the base map, and the terrain where it is on, with the
    /// sources its `layer.json` credits.
    public static func map(baseLayer: BaseLayer, terrain: Bool) -> [Credit] {
        var credits = [Credit("Imagery courtesy Natural Earth", link: "https://www.naturalearthdata.com")]
        switch baseLayer {
        case .naturalEarth: break
        case .versaTiles: credits.append(Credit("VersaTiles sources", link: "https://versatiles.org/sources/"))
        case .blackMarble, .viirs: credits.append(Credit("NASA Global Imagery Browse Services for EOSDIS", link: "https://earthdata.nasa.gov/gibs"))
        }
        if terrain {
            credits += [
                Credit("Re:Earth Terrain · Mapterhorn (CC BY 4.0)", link: "https://terrain.reearth.land/"),
                Credit("Mapterhorn", link: "https://mapterhorn.com/"),
                Credit("EGM2008 (NGA)", link: "https://earth-info.nga.mil/"),
                Credit("Protomaps", link: "https://protomaps.com/"),
                Credit("OpenStreetMap", link: "https://www.openstreetmap.org/copyright"),
            ]
        }
        return credits
    }

    /// Where the satellites come from, as the web app credits it.
    public static let elementSets = Credit("Satellite TLE data provided by Celestrak", link: "https://celestrak.org/NORAD/elements/")
}

/// The licences of what the renderer carries.
public enum Notices {
    /// CesiumJS's Apache 2.0 licence with its third-party notices: the atmosphere,
    /// lighting and tone mapping are ported from it.
    public static var cesium: String {
        Bundle.module.url(forResource: "LICENSE.CesiumJS", withExtension: "md", subdirectory: "Shaders").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
}
