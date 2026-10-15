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
        "Visualize satellites on a 3D globe in real time, propagated on the device with SGP4 from CelesTrak's element sets",
        "Show points, labels, orbits, orbit tracks, ground tracks, sensor cones, 3D models and ground station links per satellite, colored by orbit class (LEO, MEO, GEO, HEO)",
        "Switch catalog groups on and off (Starlink, GNSS, weather, Earth observation, crewed stations), or search for a single satellite",
        "Select a satellite to see its orbit, its next passes over your locations and its spacecraft details: country, operator, manufacturer, bus, mass and size",
        "Track a satellite: the camera flies to it and follows it along its orbit",
        "Save your location or any point you pick on the map, then list the upcoming passes over it and get a notification before one starts",
        "Find satellites overhead in the ground-level sky view, aimed by dragging or by pointing your phone",
        "See which satellites you could spot: the sky view dims those in Earth's shadow, too far away or in a daylit sky",
        "Lay the globe over the base map and terrain you choose: satellite imagery, Earth at night or the day's VIIRS imagery",
        "Start from the demo views, bookmark your own, and share any view as a link: it opens the same view on satvis.space",
        "Open satvis.space links straight in the app",
        "Keep using it offline, from the satellite data it last fetched",
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(
                        "Satvis is a free, open-source satellite tracker for iPhone and iPad. It draws more than 16,000 satellites on a 3D globe in real time: Starlink, GPS, weather satellites, the ISS and many more. Set your location and it predicts when each one passes overhead. The sky view shows the sky from where you stand. Point your phone up to see the satellites in that direction."
                    )
                }
                Section("What it does") {
                    ForEach(Array(Self.features.enumerated()), id: \.offset) { _, feature in
                        Text(feature)
                    }
                }
                Section("Where the data comes from") {
                    Text(
                        "Element sets come from CelesTrak through satvis.space, refreshed several times a day. The app keeps the last ones it fetched, so it works offline once it has been online. Positions and passes are worked out on the device, with David Vallado's reference SGP4, held to the website's results. What each satellite is (its country, operator, manufacturer, bus, mass and size) comes from Jonathan McDowell's GCAT: data from J. McDowell, planet4589.org, under CC BY 4.0."
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
                    Text("Created by Florian Mauracher, under the MIT license.")
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
