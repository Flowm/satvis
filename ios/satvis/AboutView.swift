import SatvisRender
import SwiftUI

/// The web app's About dialog (`about.html`), for the app: what Satvis is, what it
/// does and where its data comes from. The about page's demos are the Bookmarks
/// sheet's.
struct AboutView: View {
    /// The map's sources as drawn now, for Acknowledgements.
    let map: [Credit]
    let privacyPolicy: URL
    let analytics: Analytics
    @Environment(\.dismiss) private var dismiss

    private static let features: [LocalizedStringKey] = [
        "Shows more than 12,000 satellites on a 3D globe in real time, propagated on the device with SGP4 from CelesTrak's element sets",
        "Draws points, labels, orbits, orbit tracks, ground tracks, sensor cones and 3D models, coloured by orbit class",
        "Switches the catalog's groups on and off, or searches out a single satellite",
        "Predicts the passes over your ground stations, and notifies you before one starts",
        "Stands you on the ground in the sky view, aimed by the compass and gyroscope, to find a satellite overhead",
        "Shares the exact view as a link, which opens the same view on the website",
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(
                        "Satvis is a free, open-source satellite tracker. It draws thousands of satellites on a 3D globe in real time, works out when each passes over where you are, and stands you on the ground to find it in the sky."
                    )
                }
                Section("What it does") {
                    ForEach(Array(Self.features.enumerated()), id: \.offset) { _, feature in
                        Text(feature)
                    }
                }
                Section("Where the data comes from") {
                    Text(
                        "Element sets come from CelesTrak through satvis.space, refreshed every six hours. The app keeps the last ones it fetched, so it works offline once it has been online. Positions and passes are worked out on the device, with David Vallado's reference SGP4, held to the website's results. What each satellite is (its country, operator, manufacturer, bus, mass and size) comes from Jonathan McDowell's GCAT: data from J. McDowell, planet4589.org, under CC BY 4.0."
                    )
                }
                Section {
                    Link("satvis.space", destination: URL(string: "https://satvis.space/")!)
                    Link("Source code on GitHub", destination: URL(string: "https://github.com/Flowm/satvis/")!)
                    Link("Privacy", destination: privacyPolicy)
                    // Beside the policy it answers to; the web app has no switch.
                    Toggle(
                        "Share usage data",
                        isOn: Binding {
                            analytics.isSharing
                        } set: {
                            analytics.setSharing($0)
                        }
                    )
                    // Nothing is counted where usage may not be at all: not a
                    // debug build, and not another site than satvis.space.
                    .disabled(!Analytics.isAvailable)
                    NavigationLink("Acknowledgements") { AcknowledgementsView(map: map) }
                } footer: {
                    Text("Created by Florian Mauracher, under the MIT licence.")
                }
            }
            .navigationTitle("About Satvis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
