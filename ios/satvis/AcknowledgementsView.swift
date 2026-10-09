import SatvisRender
import SwiftUI

/// What the app is built from and owes credit for, opened from About and from the
/// map's OpenStreetMap credit: what the map is drawn from now, where the
/// satellites come from, the data it ships or fetches, and the code it carries,
/// under its licences.
struct AcknowledgementsView: View {
    /// The map's sources as drawn now, which change with the base map and terrain.
    let map: [Credit]

    var body: some View {
        List {
            Section("Map") {
                ForEach(map, id: \.self) { credit in
                    if let link = credit.link {
                        Link(credit.text, destination: link)
                    } else {
                        Text(credit.text)
                    }
                }
            }
            Section("Satellites") {
                Link(destination: Credit.elementSets.link!) {
                    entry("CelesTrak", "The element sets the satellites are propagated from.")
                }
                Link(destination: URL(string: "https://planet4589.org/space/gcat/")!) {
                    entry("GCAT", "What each satellite is: its country, operator, manufacturer, bus, mass and size. Data from J. McDowell, planet4589.org, under CC BY 4.0.")
                }
            }
            Section("Data") {
                // As the models repository's manifest credits each model.
                Link(destination: URL(string: "https://nasa3d.arc.nasa.gov")!) {
                    entry(
                        "3D models",
                        "From NASA 3D Resources, not subject to US copyright; NASA's insignia are not free to use, and their use implies no endorsement. The generic CubeSats, communications satellites and constellation buses are satvis's own, built from published dimensions, under the MIT licence."
                    )
                }
                Link(destination: URL(string: "https://svs.gsfc.nasa.gov/4851")!) {
                    entry(
                        "Deep Star Maps 2020",
                        "The stars: NASA/Goddard Space Flight Center Scientific Visualization Studio, from Hipparcos-2, Tycho-2 and Gaia DR2.")
                }
                Section("Software") {
                    NavigationLink {
                        LicenceText(title: "CesiumJS", text: Notices.cesium)
                    } label: {
                        entry("CesiumJS", "The atmosphere, lighting and tone mapping, ported to Metal. Apache License 2.0, with its third-party notices.")
                    }
                    entry("SGP4", "David Vallado's reference implementation (AIAA 2006-6753), released without restriction.")
                    NavigationLink {
                        LicenceText(title: "Draco", text: Self.bundled("draco"))
                    } label: {
                        entry("Draco", "Google's mesh decompression, for the satellites' 3D models. Apache License 2.0.")
                    }
                    NavigationLink {
                        LicenceText(title: "Lucide", text: Self.bundled("lucide"))
                    } label: {
                        entry("Lucide", "The toolbar's icons and the ground station pin, the web app's own. ISC License.")
                    }
                    NavigationLink {
                        LicenceText(title: "PostHog for iOS", text: Self.bundled("posthog-ios"))
                    } label: {
                        entry("PostHog for iOS", "Usage analytics. MIT License.")
                    }
                    // Built into PostHog for iOS, which ships them in its binary.
                    NavigationLink {
                        LicenceText(title: "PLCrashReporter", text: Self.bundled("plcrashreporter"))
                    } label: {
                        entry("PLCrashReporter", "Part of PostHog for iOS. MIT License; its protobuf-c, Apache License 2.0.")
                    }
                    NavigationLink {
                        LicenceText(title: "libwebp", text: Self.bundled("libwebp"))
                    } label: {
                        entry("libwebp", "Part of PostHog for iOS. BSD 3-Clause License, with Google's patent grant.")
                    }
                }
            }
        }
        .navigationTitle("Acknowledgements")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func entry(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// A licence kept in the app's Licences folder.
    private static func bundled(_ name: String) -> String {
        Bundle.main.url(forResource: name, withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
}

/// A licence, as written.
private struct LicenceText: View {
    let title: String
    let text: String

    var body: some View {
        ScrollView {
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
