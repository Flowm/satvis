import Foundation
import SatvisCore

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
    /// sources its `layer.json` credits. `mosaic` is the attribution the geostationary
    /// mosaic's drawn frame asks for, a line a satellite.
    public static func map(baseLayer: BaseLayer, terrain: Bool, instrumentImagery: [SatelliteDetails.ImageryPreview.Provider] = [], mosaic: [String] = []) -> [Credit] {
        var credits = [Credit("Imagery courtesy Natural Earth", link: "https://www.naturalearthdata.com")]
        if baseLayer == .versaTiles {
            credits.append(Credit("VersaTiles sources", link: "https://versatiles.org/sources/"))
        }
        if baseLayer == .geoMosaic {
            credits += mosaic.map { Credit($0) }
        }
        // The base map's or the instrument imagery's, once, as the web app's layers credit them.
        if baseLayer == .blackMarble || instrumentImagery.contains(.gibs) {
            credits.append(Credit("NASA Global Imagery Browse Services for EOSDIS", link: "https://earthdata.nasa.gov/gibs"))
        }
        if instrumentImagery.contains(.eumetview) {
            credits.append(Credit("EUMETSAT", link: "https://view.eumetsat.int"))
        }
        if terrain {
            credits += [
                Credit("Re:Earth Terrain · Mapterhorn (CC BY 4.0)", link: "https://terrain.reearth.land/"),
                Credit("Mapterhorn", link: "https://mapterhorn.com/"),
                Credit("EGM2008 (NGA)", link: "https://earth-info.nga.mil/"),
                Credit("Protomaps", link: "https://protomaps.com/"),
                .openStreetMap,
            ]
        }
        return credits
    }

    /// The one source whose terms want its name in sight of the map, not only in a
    /// list behind it: the OpenStreetMap Foundation's attribution guidelines, for
    /// the ODbL. Of the maps the app draws only the terrain uses its data; the
    /// VersaTiles imagery is satellite and aerial photography.
    public static let openStreetMap = Credit("OpenStreetMap", link: "https://www.openstreetmap.org/copyright")

    /// Where the satellites come from, as the web app credits it.
    public static let elementSets = Credit("Satellite TLE data provided by Celestrak", link: "https://celestrak.org/NORAD/elements/")

    /// Where the instruments come from, as the web app credits it.
    public static let instruments = Credit("CEOS MIM Database, CC BY 4.0", link: "https://database.eohandbook.com")
}

/// The licences of what the renderer carries.
public enum Notices {
    /// CesiumJS's Apache 2.0 licence with its third-party notices: the atmosphere,
    /// lighting and tone mapping are ported from it.
    public static var cesium: String {
        Bundle.module.url(forResource: "LICENSE.CesiumJS", withExtension: "md", subdirectory: "Shaders").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
}
