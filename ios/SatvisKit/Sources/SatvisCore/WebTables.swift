import Foundation

/// The tables the native app reads from the web app rather than keeping its own:
/// SATCAT and GCAT code labels, the external links, the imagery providers and the
/// bookmark tables (Shared/web-tables.json, written by scripts/parity/generate.mjs).
public struct WebTables: Sendable, Decodable {
    public struct Satcat: Sendable, Decodable {
        public var launchSite: [String: String]
        public var opsStatus: [String: String]
        public var orbitType: [String: String]
    }

    /// GCAT's payload codes (src/config/gcatCodes.ts).
    public struct Gcat: Sendable, Decodable {
        public var category: [String: String]
        public var `class`: [String: String]

        /// "IMG/TECH" as "Imaging / Technology". GCAT appends "?" to an uncertain
        /// category, kept, and "*" to one whose orbit the US keeps secret, dropped.
        public func categoryLabel(_ code: String) -> String {
            code.split(separator: "/", omittingEmptySubsequences: false).map { part in
                // Both marks can follow one code, "?" first: "SIG?*".
                let bare = String(part.reversed().drop { $0 == "?" || $0 == "*" }.reversed())
                return (category[bare] ?? bare) + (part.contains("?") ? "?" : "")
            }.joined(separator: " / ")
        }

        /// "BD" as "Commercial / Military"; a letter it does not know stays a letter.
        public func classLabel(_ code: String) -> String {
            code.map { self.class[String($0)] ?? String($0) }.joined(separator: " / ")
        }
    }

    public struct Link: Sendable, Decodable, Hashable {
        public var label: String
        public var title: String
        /// `{satnum}` stands where the catalog number goes.
        public var href: String

        public func url(satnum: String) -> URL? {
            URL(string: href.replacingOccurrences(of: "{satnum}", with: satnum))
        }
    }

    /// An imagery provider (src/config/instrumentImagery.ts): the service that holds
    /// layers showing an instrument, and its own viewer for them.
    public struct ImageryProvider: Sendable, Decodable {
        /// The viewer a link opens, as the panel names it; nil for a provider with none,
        /// whose layers this app alone shows.
        public var viewer: String?
        /// `{layer}` stands where the layer's id goes.
        public var link: String?
        /// Appended for a layer that stopped, `{end}` its last frame's date.
        public var ended: String?

        /// What JavaScript's `encodeURIComponent` leaves as it is.
        private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

        /// The layer in the viewer, as the web app's `imageryLink` writes it: the colon
        /// of EUMETView's `workspace:layer` stays. Nil for a provider with no viewer.
        public func href(layer: String, end: String?) -> String? {
            guard let template = link else {
                return nil
            }
            let encoded = layer.addingPercentEncoding(withAllowedCharacters: Self.unreserved.union(CharacterSet(charactersIn: ":"))) ?? layer
            let link = template.replacingOccurrences(of: "{layer}", with: encoded)
            guard let end, let ended else {
                return link
            }
            return link + ended.replacingOccurrences(of: "{end}", with: end.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? end)
        }
    }

    /// A column of the Instruments tab's band strip (src/config/wavebands.ts).
    public struct WavebandColumn: Sendable, Decodable, Hashable {
        /// CEOS's abbreviation, or "Radar" for the column every radar band shares.
        public var label: String
        /// "#rrggbb".
        public var colour: String
    }

    /// The url parameters the web app's stores own, which a bookmark keeps.
    public struct BookmarkTables: Sendable, Decodable {
        public var ownedParams: [String]
    }

    public var satcat: Satcat
    public var gcat: Gcat
    public var externalLinks: [Link]
    /// By the name a record's `imagery` entry carries.
    public var imageryProviders: [String: ImageryProvider]
    /// CEOS's waveband classes, shortest wavelength first, then microwave and radar.
    public var wavebandColumns: [WavebandColumn]
    public var bookmarks: BookmarkTables

    /// A colour per column, where `bands` fill it, the web app's `wavebandCells`: every
    /// radar band ("Ku-Band") fills the one Radar column, and a class CEOS adds later none.
    public func wavebandCells(_ bands: [String]) -> [String?] {
        let filled = Set(bands.map { $0.hasSuffix("-Band") ? "Radar" : $0 })
        return wavebandColumns.map { filled.contains($0.label) ? $0.colour : nil }
    }

    public static let shared: WebTables = {
        let url = Bundle.module.url(forResource: "web-tables", withExtension: "json", subdirectory: "Shared")!
        return try! JSONDecoder().decode(WebTables.self, from: Data(contentsOf: url))
    }()
}
