import SatvisCore
import SatvisRender
import SwiftUI

/// The web app's About dialog (`about.html`), for the app: what Satvis is, its
/// demos, what it does and where its data comes from.
struct AboutView: View {
    let session: Session
    /// The demo on screen in the carousel.
    @State private var shownDemo: Bookmark.ID?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                Section("See it in action") {
                    demos
                        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
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
                    Link("Privacy", destination: session.privacyPolicy)
                    // Beside the policy it answers to; the web app has no switch.
                    Toggle(
                        "Share usage data",
                        isOn: Binding {
                            session.analytics.isSharing
                        } set: {
                            session.analytics.setSharing($0)
                        }
                    )
                    // Nothing is counted where usage may not be at all: not a
                    // debug build, and not another site than satvis.space.
                    .disabled(!Analytics.isAvailable)
                    NavigationLink("Acknowledgements") { AcknowledgementsView(map: session.mapCredits) }
                } footer: {
                    Text("Created by Florian Mauracher, under the MIT license.")
                }
            }
            .navigationTitle("About Satvis")
            .navigationBarTitleDisplayMode(.inline)
            .panelSheet()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// The Bookmarks sheet's demos (the web app's about page, `carousel.ts`), one
    /// across: swiped, or stepped by the buttons on the picture.
    private var demos: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 16) {
                ForEach(Array(Bookmarks.demos.enumerated()), id: \.element.id) { index, demo in
                    demoSlide(demo, index: index)
                        .padding(.horizontal, 16)
                        .containerRelativeFrame(.horizontal)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $shownDemo)
        .scrollIndicators(.hidden)
    }

    /// A demo as its card names it; choosing it opens it, as its card does.
    private func demoSlide(_ demo: Bookmark, index: Int) -> some View {
        let summary = session.summary(demo.scene)
        let count = Bookmarks.demos.count
        return Button {
            session.open(demo.scene)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Color.black
                    .aspectRatio(16 / 10, contentMode: .fit)
                    .overlay { picture(demo) }
                    .clipShape(.rect(cornerRadius: 8))
                    .padding(.bottom, 4)
                Text(demo.name)
                    .font(.headline)
                    .foregroundStyle(Color.panelAccent)
                BookmarkFacts(summary: summary)
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel([demo.name, summary.what, summary.where].joined(separator: ", "))
        // A 16:10 box at the top of the slide is its picture.
        .overlay(alignment: .top) {
            Color.clear
                .aspectRatio(16 / 10, contentMode: .fit)
                .overlay(alignment: .leading) {
                    if index > 0 {
                        stepButton("Previous demo", systemImage: "chevron.left", to: Bookmarks.demos[index - 1].id)
                    }
                }
                .overlay(alignment: .trailing) {
                    if index < count - 1 {
                        stepButton("Next demo", systemImage: "chevron.right", to: Bookmarks.demos[index + 1].id)
                    }
                }
                .overlay(alignment: .bottom) {
                    HStack(spacing: 6) {
                        ForEach(0..<count, id: \.self) { dot in
                            Circle()
                                .fill(.white.opacity(dot == index ? 1 : 0.4))
                                .frame(width: 6, height: 6)
                        }
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(.black.opacity(0.73), in: .capsule)
                    .padding(8)
                    .accessibilityHidden(true)
                }
        }
    }

    /// Scrolls to `demo`, at once under Reduce Motion.
    private func stepButton(_ title: LocalizedStringKey, systemImage: String, to demo: Bookmark.ID) -> some View {
        Button(title, systemImage: systemImage) {
            withAnimation(reduceMotion ? nil : .snappy) { shownDemo = demo }
        }
        .labelStyle(.iconOnly)
        .font(.body.weight(.semibold))
        .foregroundStyle(.white)
        .frame(width: 36, height: 36)
        .background(.black.opacity(0.73), in: .circle)
        .padding(8)
    }

    /// The site's picture, kept once fetched, as on the demo's card.
    @ViewBuilder private func picture(_ demo: Bookmark) -> some View {
        if let image = demo.thumbnail.flatMap({ session.demoPictures[$0] }).flatMap(UIImage.init(data:)) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            Image(systemName: "photo").foregroundStyle(.tertiary)
        }
    }
}
