import SatvisCore
import SatvisRender
import SwiftUI

/// The web app's About dialog (`about.html`), for the app, in its order: the app's
/// name, what Satvis is, its demos, what it does, where its data comes from, and
/// the links and credits.
struct AboutView: View {
    let session: Session
    /// From the centre of a row's icon down to its text's baseline.
    @ScaledMetric(relativeTo: .body) private var iconDrop: CGFloat = 6
    @Environment(\.dismiss) private var dismiss

    /// The web app's feature rows, each with the Lucide icon the about page gives it.
    private static let features: [(icon: ImageResource, text: LocalizedStringKey)] = [
        (.lucideOrbit, "Visualize satellites on a 3D globe in real time, propagated on the device with SGP4 from CelesTrak's element sets"),
        (
            .lucideSatellite,
            "Show points, labels, orbits, orbit tracks, ground tracks, sensor cones, 3D models and ground station links per satellite, colored by orbit class (LEO, MEO, GEO, HEO)"
        ),
        (.lucideSearch, "Switch catalog groups on and off (Starlink, GNSS, weather, Earth observation, crewed stations), or search for a single satellite"),
        (.lucideInfo, "Select a satellite to see its orbit, its next passes over your locations and its spacecraft details: country, operator, manufacturer, bus, mass and size"),
        (.lucideCrosshair, "Track a satellite: the camera flies to it and follows it along its orbit"),
        (.lucideMapPin, "Save your location or any point you pick on the map, then list the upcoming passes over it and get a notification before one starts"),
        (.lucideTelescope, "Find satellites overhead in the ground-level sky view, aimed by dragging or by pointing your phone"),
        (.lucideEye, "See which satellites you could spot: the sky view dims those in Earth's shadow, too far away or in a daylit sky"),
        (.lucideLayers, "Lay the globe over the base map and terrain you choose: satellite imagery, Earth at night or the day's VIIRS imagery"),
        (.lucideBookmark, "Start from the demo views, bookmark your own, and share any view as a link: it opens the same view on satvis.space"),
        (.lucideLink, "Open satvis.space links straight in the app"),
        (.lucideWifiOff, "Keep using it offline, from the satellite data it last fetched"),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 16) {
                        hero
                        Text(
                            "Satvis is a free, open-source satellite tracker for iPhone and iPad. It draws more than 16,000 satellites on a 3D globe in real time: Starlink, GPS, weather satellites, the ISS and many more. Set your location and it predicts when each one passes overhead. The sky view shows the sky from where you stand. Point your phone up to see the satellites in that direction."
                        )
                    }
                    // A clear row is still clipped to its card's rounded corners: the
                    // bottom inset keeps the last line out of them.
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 16, trailing: 0))
                    .listRowBackground(Color.clear)
                }
                Section("See it in action") {
                    // The top inset keeps the picture's corners out of the card's larger ones.
                    DemoCarousel(session: session) { dismiss() }
                        .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 16, trailing: 0))
                        .listRowBackground(Color.clear)
                }
                Section("What it does") {
                    ForEach(Array(Self.features.enumerated()), id: \.offset) { _, feature in
                        row(feature.text, icon: feature.icon)
                    }
                }
                Section("Where the data comes from") {
                    Text(
                        "Element sets come from CelesTrak through satvis.space, refreshed several times a day. The app keeps the last ones it fetched, so it works offline once it has been online. Positions and passes are worked out on the device, with David Vallado's reference SGP4, held to the website's results. What each satellite is (its country, operator, manufacturer, bus, mass and size) comes from Jonathan McDowell's GCAT: data from J. McDowell, planet4589.org, under CC BY 4.0."
                    )
                }
                Section {
                    Link(destination: URL(string: "https://satvis.space/")!) { row("satvis.space", icon: .lucideGlobe) }
                    Link(destination: URL(string: "https://github.com/Flowm/satvis/")!) { row("Source code on GitHub", icon: .lucideGithub) }
                    Link(destination: session.privacyPolicy) { row("Privacy", icon: .lucideShield) }
                    // Beside the policy it answers to; the web app has no switch.
                    Toggle(
                        isOn: Binding {
                            session.analytics.isSharing
                        } set: {
                            session.analytics.setSharing($0)
                        }
                    ) {
                        row("Share usage data", icon: .lucideChartColumn)
                    }
                    // Nothing is counted where usage may not be at all: not a
                    // debug build, and not another site than satvis.space.
                    .disabled(!Analytics.isAvailable)
                    NavigationLink {
                        AcknowledgementsView(map: session.mapCredits)
                    } label: {
                        row("Acknowledgements", icon: .lucideScrollText)
                    }
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

    /// The app's icon, its name and the about page's tagline.
    private var hero: some View {
        HStack(spacing: 14) {
            // The flattened icon Xcode writes for the home screen.
            if let icon = UIImage(named: "AppIcon60x60") {
                Image(uiImage: icon)
                    .resizable()
                    .frame(width: 56, height: 56)
                    .clipShape(.rect(cornerRadius: 12.6, style: .continuous))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Satvis")
                    .font(.title2.bold())
                Text("3D satellite tracker and pass predictor")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// A row with the web app's icon for it, in the accent, beside its first line
    /// as on the about page: a `Label` centres it on the whole text.
    private func row(_ text: LocalizedStringKey, icon: ImageResource) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Image(icon)
                .resizable()
                .frame(width: 18, height: 18)
                .foregroundStyle(Color.panelAccent)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + iconDrop }
                .accessibilityHidden(true)
            Text(text)
                .foregroundStyle(Color.panelInk)
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        }
    }
}

/// The Bookmarks sheet's demos as the about page's carousel (`carousel.ts`) shows
/// them, one across: swiped, or stepped by the buttons over the picture, with the
/// dots under them.
///
/// The scroll view's position is read, never bound: a `scrollPosition(id:)` binding
/// written mid-swipe set the position back for a frame, so the slide jumped to
/// where it would land and back, which showed as a flicker.
private struct DemoCarousel: View {
    let session: Session
    /// After a demo is opened.
    let opened: () -> Void
    /// The demo on screen, by its place among the demos.
    @State private var shown = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let demos = Bookmarks.demos

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(demos) { demo in
                        DemoSlide(
                            demo: demo,
                            summary: session.summary(demo.scene),
                            picture: demo.thumbnail.flatMap { session.demoPictures[$0] }
                        ) {
                            session.open(demo.scene)
                            opened()
                        }
                        .equatable()
                        .containerRelativeFrame(.horizontal)
                        .id(demo.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .onScrollTargetVisibilityChange(idType: Bookmark.ID.self, threshold: 0.5) { visible in
                if let id = visible.first, let index = demos.firstIndex(where: { $0.id == id }) {
                    shown = index
                }
            }
            // The picture's box at the top of every slide.
            .overlay(alignment: .top) {
                Color.clear
                    .aspectRatio(16 / 10, contentMode: .fit)
                    .overlay(alignment: .leading) {
                        if shown > 0 {
                            step("Previous demo", systemImage: "chevron.left") { proxy.scrollTo(demos[shown - 1].id, anchor: .leading) }
                        }
                    }
                    .overlay(alignment: .trailing) {
                        if shown < demos.count - 1 {
                            step("Next demo", systemImage: "chevron.right") { proxy.scrollTo(demos[shown + 1].id, anchor: .leading) }
                        }
                    }
                    .overlay(alignment: .bottom) { dots }
            }
        }
    }

    /// Where the carousel is, as on the web: one dot a demo, the shown one lit.
    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(demos.indices, id: \.self) { index in
                Circle()
                    .fill(.white.opacity(index == shown ? 1 : 0.4))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(.black.opacity(0.73), in: .capsule)
        .padding(8)
        .accessibilityHidden(true)
    }

    /// Scrolls a demo on or back, at once under Reduce Motion.
    private func step(_ title: LocalizedStringKey, systemImage: String, to scroll: @escaping () -> Void) -> some View {
        Button(title, systemImage: systemImage) {
            withAnimation(reduceMotion ? nil : .snappy) { scroll() }
        }
        // A List row's buttons in the default style share the row's tap, which
        // then went to the slide under it and opened that demo.
        .buttonStyle(.plain)
        .labelStyle(.iconOnly)
        .font(.body.weight(.semibold))
        .foregroundStyle(.white)
        .frame(width: 36, height: 36)
        .background(.black.opacity(0.73), in: .circle)
        .contentShape(.circle)
        .padding(8)
    }
}

/// A demo as its card names it; choosing it opens it, as its card does. Equal while
/// its demo and picture are, so that a step of the carousel decodes no picture again.
private struct DemoSlide: View, Equatable {
    let demo: Bookmark
    let summary: BookmarkSummary
    /// The site's picture as JPEG, kept once fetched, as on the demo's card.
    let picture: Data?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 4) {
                Color.black
                    .aspectRatio(16 / 10, contentMode: .fit)
                    .overlay {
                        if let image = picture.flatMap(UIImage.init(data:)) {
                            Image(uiImage: image).resizable().scaledToFill()
                        } else {
                            Image(systemName: "photo").foregroundStyle(.tertiary)
                        }
                    }
                    .clipShape(.rect(cornerRadius: 12))
                    .padding(.bottom, 6)
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
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.demo == rhs.demo && lhs.summary == rhs.summary && lhs.picture == rhs.picture
    }
}
