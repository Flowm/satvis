import SatvisCore
import SwiftUI

/// The web app's About dialog (`about.html`), for the app: what Satvis is, the
/// three views the about page shows off, opened here, what it does and where its
/// data comes from.
struct AboutView: View {
    /// Opens a demo's link in the app, as the about page's links open the site.
    let onOpen: (SatvisCore.Link) -> Void
    let privacyPolicy: URL
    @Environment(\.dismiss) private var dismiss

    /// The about page's demos, by their links.
    private static let demos: [(title: LocalizedStringKey, detail: LocalizedStringKey, link: String)] = [
        ("Open it", "The globe, with the weather satellites switched on.", "/?time=2026-10-04T08:52Z"),
        (
            "Follow it", "Tracking the ISS: the camera follows the station along its orbit.",
            "/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles&time=2026-10-04T02:07Z"
        ),
        (
            "Stand there",
            "The sky view at night from the Lauterbrunnen valley: navigation, weather and OneWeb satellites overhead, and the cliffs hiding the rest.",
            "/?scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&layers=VersaTiles&stars=DeepStar2K&time=2026-10-04T19:22Z&tags=GNSS,Weather,OneWeb"
                + "&elements=Point,Label&xsats=COSMOS+2500+(755),GSAT0220+(GALILEO+24),METEOSAT-11+(MSG-4),BEIDOU-3+M27+(C49),SES-5+(EGNOS/PRN+136),"
                + "EUTELSAT+5+WEST+B+(EGNOS/PRN+121),BEIDOU-3+M21+(C43),METEOSAT-12+(MTG-I1),METEOSAT-10+(MSG-3),MTG-I2,LUCH+5B+(SDCM/PRN+125),"
                + "BEIDOU-3+M8+(C28),ONEWEB-0169,ONEWEB-0336,BEIDOU-3+M11+(C25),ONEWEB-0112,ONEWEB-0628,GSAT-8+(GAGAN/PRN+127),BEIDOU-2+G5+(C05),"
                + "TIANMU-1+10,TIANMU-1+13"
        ),
    ]

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
                Section("See it in action") {
                    ForEach(Self.demos, id: \.link) { demo in
                        Button {
                            onOpen(SatvisCore.Link(demo.link))
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(demo.title)
                                Text(demo.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("What it does") {
                    ForEach(Array(Self.features.enumerated()), id: \.offset) { _, feature in
                        Text(feature)
                    }
                }
                Section("Where the data comes from") {
                    Text(
                        "Element sets come from CelesTrak through satvis.space, refreshed every six hours, and a copy ships inside the app so that it works offline. Positions and passes are worked out on the device, with David Vallado's reference SGP4, held to the website's results."
                    )
                }
                Section {
                    SwiftUI.Link("satvis.space", destination: URL(string: "https://satvis.space/")!)
                    SwiftUI.Link("Source code on GitHub", destination: URL(string: "https://github.com/Flowm/satvis/")!)
                    SwiftUI.Link("Privacy", destination: privacyPolicy)
                    NavigationLink("Acknowledgements") { AcknowledgementsView() }
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
