import SatvisCore
import SwiftUI

/// One layer the Imagery tab shows, and the instrument it shows.
struct ImageryLayer: Hashable {
    let instrument: String
    let imagery: SatelliteDetails.Imagery
}

/// Where a card's picture comes from: a provider's WMS answer, or, for the geostationary
/// mosaic, which has no WMS, its newest Slot's file in these bounds.
enum ImageryPreviewSource: Hashable {
    case url(URL)
    case mosaic(SatelliteDetails.PreviewBounds)
}

/// The Imagery tab, the web app's ImageryGallery (ADR 0024): a card a layer, titled by its
/// type, with a picture of its latest frame and how fresh it is, a switch that shows it on
/// the globe where the globe can draw it, and the rest behind its info button, in as many
/// columns as fit cards 220 pt wide, as the web app's grid; a layer that ended after those
/// that have not. A row of cards is a row of the list, so that a card can be scrolled to. A
/// granule layer's card can also track the satellite, and sends the clock to its newest
/// pass where it is past it.
struct ImageryCards: View {
    let layers: [ImageryLayer]
    /// A picture a layer, as `previews` builds them.
    let previews: [ImageryLayer: ImageryPreviewSource]
    let columns: Int
    let session: Session
    /// The satellite the cards are of, which a granule layer's card tracks.
    let satellite: String
    let latest: LatestPasses

    /// The web app's `minmax(220px, 1fr)`.
    static let cardWidth = 220.0
    /// Between the cards, across and down.
    static let gap = 10.0

    /// How many cards fit across `width` points.
    static func columns(width: Double) -> Int {
        max(1, Int((width + gap) / (cardWidth + gap)))
    }

    /// The id of the row that holds `instrument`'s first card, which its imagery button
    /// scrolls to.
    static func anchor(_ instrument: String, in layers: [ImageryLayer], columns: Int) -> String {
        let layers = sorted(layers)
        return "imagery:\((layers.firstIndex { $0.instrument == instrument } ?? 0) / max(columns, 1))"
    }

    /// Degrees either side of a granule's centre in its picture: a NOAA-20 granule is about
    /// 3,000 km across.
    static let granuleHalfWidth = 20.0

    /// The cards in the record's order, a layer that ended after those that have not.
    static func sorted(_ layers: [ImageryLayer]) -> [ImageryLayer] {
        layers.filter { !$0.imagery.words.ended } + layers.filter(\.imagery.words.ended)
    }

    /// A picture of each layer, `halfWidthDeg` either side of `centre`, at `now` in
    /// milliseconds since 1970; none for a layer with no preview, nor any where the
    /// satellite has no position. A granule layer's comes with its newest pass, `granule`.
    static func previews(_ layers: [ImageryLayer], centre: LivePosition?, halfWidthDeg: Double, now: Double) -> [ImageryLayer: ImageryPreviewSource] {
        guard let centre else {
            return [:]
        }
        return layers.reduce(into: [:]) { previews, layer in
            guard let preview = layer.imagery.preview, layer.imagery.granuleLayer == nil else {
                return
            }
            if preview.provider == .georing {
                previews[layer] = .mosaic(SatelliteDetails.previewBounds(latitude: centre.latitude, longitude: centre.longitude, halfWidthDeg: halfWidthDeg))
            } else {
                let url = SatelliteDetails.imageryPreviewUrl(preview, latitude: centre.latitude, longitude: centre.longitude, halfWidthDeg: halfWidthDeg, now: now)
                previews[layer] = URL(string: url).map(ImageryPreviewSource.url)
            }
        }
    }

    /// A granule layer's picture: its newest pass, held off the antimeridian, where GIBS's
    /// WMS draws nothing for a box that crosses it.
    static func granulePreview(_ layer: ImageryLayer, latest: LatestPasses, now: Double) -> ImageryPreviewSource? {
        guard let preview = layer.imagery.preview, let granule = latest.latest[layer.imagery.key]?.pictured else {
            return nil
        }
        let centre = granule.centre
        let longitude = max(-180 + granuleHalfWidth, min(180 - granuleHalfWidth, centre.longitude))
        let url = SatelliteDetails.imageryPreviewUrl(
            preview, latitude: centre.latitude, longitude: longitude, halfWidthDeg: granuleHalfWidth, now: now, granule: granule.start)
        return URL(string: url).map(ImageryPreviewSource.url)
    }

    var body: some View {
        let layers = Self.sorted(layers)
        let now = Date.now.timeIntervalSince1970 * 1000
        let rows = stride(from: 0, to: layers.count, by: columns).map { $0..<min($0 + columns, layers.count) }
        Section {
            ForEach(Array(rows.enumerated()), id: \.offset) { row, indices in
                HStack(alignment: .top, spacing: Self.gap) {
                    ForEach(indices, id: \.self) { index in
                        ImageryCard(
                            layer: layers[index], preview: previews[layers[index]] ?? Self.granulePreview(layers[index], latest: latest, now: now),
                            session: session, satellite: satellite, latest: latest)
                    }
                    // The last row's empty places, so that its cards are as wide as the rest.
                    ForEach(indices.count..<columns, id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
                    }
                }
                // Each card as tall as the tallest beside it, its link at the foot.
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Self.gap)
                .id("imagery:\(row)")
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
    }
}

/// A layer's card: its picture and how fresh it is, its type, what it pictures and from
/// where, and what can be done with it.
private struct ImageryCard: View {
    let layer: ImageryLayer
    let preview: ImageryPreviewSource?
    let session: Session
    let satellite: String
    let latest: LatestPasses
    /// Whether its info button has opened its Updates, Archive and Source.
    @State private var isAboutOpen = false

    private var drawn: InstrumentImagery { session.instrumentImagery }

    var body: some View {
        let imagery = layer.imagery
        let token = imagery.token
        let isShown = token.map(drawn.isShown) ?? false
        VStack(alignment: .leading, spacing: 0) {
            ImageryPicture(
                label: [imagery.type.title, imagery.words.picture, imagery.words.cropped].compactMap(\.self).joined(separator: ", "),
                source: preview, mosaic: drawn.mosaic, caption: caption, ended: imagery.words.ended,
                outlinesOnly: imagery.granuleLayer.map { $0.pictures == nil } ?? false)
            VStack(alignment: .leading, spacing: 2) {
                Label(imagery.type.title, systemImage: imagery.type.symbol)
                    .labelStyle(CardTitleLabelStyle())
                    .font(.subheadline.weight(.semibold))
                Text(imagery.words.picture)
                    .font(.footnote)
                if let cropped = imagery.words.cropped {
                    Label(cropped, systemImage: "crop")
                        .labelStyle(CardTitleLabelStyle())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            Spacer(minLength: 8)
            actions(imagery, token: token, isShown: isShown)
            if isAboutOpen {
                about(imagery)
            }
            if isShown {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if latest.isPastNewest(imagery.key, time: session.clock.now()), let newest = latest.latest[imagery.key]?.pictured {
                        PassNotice(newest: newest.start) { latest.goToNewest(imagery.key, clock: session.clock) }
                            .padding(.horizontal, 10)
                            .padding(.bottom, 10)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.panelRaised)
        .clipShape(.rect(cornerRadius: 10))
        // The web app's ring round a card on the globe.
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isShown ? Color.panelAccent : Color.white.opacity(0.08), lineWidth: isShown ? 2 : 1)
        }
        .contentShape(.rect(cornerRadius: 10))
        .onTapGesture {
            if let token {
                drawn.show(token, !isShown)
            }
        }
    }

    /// How fresh its picture is: the day a stopped layer ended, the pass pictured,
    /// yesterday's for a day's.
    private var caption: String? {
        let imagery = layer.imagery
        if let end = imagery.preview?.end {
            return "Last day, \(Formats.date(end))"
        }
        if imagery.type == .passes {
            return latest.latest[imagery.key].map { "Newest pass, \(Formats.timeAgo($0.pictured.start, now: Date.now.timeIntervalSince1970 * 1000))" }
        }
        return imagery.preview.map { $0.isDaily ? "Yesterday" : "Latest" }
    }

    private func actions(_ imagery: SatelliteDetails.Imagery, token: String?, isShown: Bool) -> some View {
        HStack(spacing: 0) {
            if let token {
                Toggle(
                    "Show",
                    isOn: Binding {
                        isShown
                    } set: {
                        drawn.show(token, $0)
                    }
                )
                .toggleStyle(.switch)
                .controlSize(.mini)
                .fixedSize()
                .font(.caption)
                .tint(Color.panelPrimary)
                .padding(.leading, 10)
                .accessibilityLabel("Show \(imagery.label) as a map layer")
            }
            Spacer(minLength: 0)
            if imagery.granuleLayer != nil, session.observer == nil {
                let target = Selection.satellite(satellite)
                let isTracked = session.tracked == target
                cardButton(isTracked ? "Stop tracking" : "Track the satellite", symbol: isTracked ? "video.fill" : "video", isOn: isTracked) {
                    if isTracked {
                        session.stopTracking(animated: true)
                    } else {
                        session.follow(target, animated: true)
                    }
                }
            }
            // A layer the globe cannot draw is its viewer's alone: the link is its action.
            if token == nil, let href = imagery.href.flatMap(URL.init(string:)), let viewer = imagery.viewer {
                Link(destination: href) {
                    Image(systemName: "arrow.up.right.square")
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .foregroundStyle(.secondary)
                .accessibilityLabel("Open in \(viewer)")
            }
            cardButton("About this layer", symbol: "info.circle", isOn: isAboutOpen) {
                isAboutOpen.toggle()
            }
            .padding(.trailing, 4)
        }
        .font(.footnote)
        .padding(.vertical, 2)
    }

    private func cardButton(_ label: String, symbol: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(width: 32, height: 32)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isOn ? Color.panelAccent : .secondary)
        .accessibilityLabel(label)
    }

    /// What the info button opens: when it updates, how far back it goes, and where it
    /// comes from.
    private func about(_ imagery: SatelliteDetails.Imagery) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 2) {
            if let updates = imagery.words.updates {
                GridRow {
                    Text("Updates").foregroundStyle(.secondary)
                    // Amber: the app colour for "away from rest", as on the status chip.
                    Text(updates).foregroundStyle(imagery.words.ended ? Color.panelAmber : .primary)
                }
            }
            if let archive = imagery.words.archive {
                GridRow {
                    Text("Archive").foregroundStyle(.secondary)
                    Text(archive)
                }
            }
            if let href = imagery.href.flatMap(URL.init(string:)), let viewer = imagery.viewer {
                GridRow {
                    Text("Source").foregroundStyle(.secondary)
                    Link(destination: href) {
                        HStack(spacing: 4) {
                            Text(viewer)
                            Image(systemName: "arrow.up.right").font(.caption2.weight(.semibold))
                        }
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Open in \(viewer)")
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .overlay(alignment: .top) {
            Divider().padding(.horizontal, 10)
        }
        // A press here is not one on the card.
        .contentShape(.rect)
        .onTapGesture {}
    }
}

/// A card title's icon close beside its text, in the secondary colour.
private struct CardTitleLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.foregroundStyle(.secondary)
            configuration.title
        }
    }
}

extension SatelliteDetails.ImageryType {
    /// Its icon, the web app's Lucide one's nearest symbol.
    var symbol: String {
        switch self {
        case .passes: "point.topleft.down.to.point.bottomright.curvepath"
        case .daily: "calendar"
        case .orbits: "square.3.layers.3d"
        case .live: "globe.europe.africa"
        case .mosaic: "globe"
        case .scenes: "photo.on.rectangle"
        }
    }
}

/// A passes layer that is on, with the clock past its newest pass (ADR 0024): how old that
/// is, and a way there.
struct PassNotice: View {
    /// The start of the newest pass with pixels, the one Go goes to, epoch milliseconds.
    let newest: Double
    let go: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock.badge.exclamationmark")
            Text("Newest pass \(Formats.timeAgoInWords(newest, now: Date.now.timeIntervalSince1970 * 1000))")
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Button(action: go) {
                Label("Go", systemImage: "backward.end.fill")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.panelAccent.opacity(0.18), in: .capsule)
                    .foregroundStyle(Color.panelAccent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Go to the newest pass")
        }
        .font(.caption)
        // Amber, as the clock deck's reset: away from live.
        .foregroundStyle(Color.panelAmber)
        .padding(.leading, 8)
        .padding(.trailing, 2)
        .padding(.vertical, 2)
        .background(Color.panelAmber.opacity(0.08), in: .rect(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Passes come in hours to days after they are sensed: there is none at the clock's time yet")
    }
}

/// A layer's picture, 16:9 on black, how fresh it is on its corner; "No preview" where
/// there is none or the provider refused it, "Outlines only" for a granule layer without
/// pictures.
private struct ImageryPicture: View {
    let label: String
    let source: ImageryPreviewSource?
    /// Makes the mosaic's picture.
    let mosaic: GeoMosaic
    let caption: String?
    /// Whether the layer stopped, which its caption is amber for.
    let ended: Bool
    let outlinesOnly: Bool
    /// Showing the placeholder, which the picture's accessibility value says.
    @State private var isMissing = false
    /// The picture once had, for its source, or nil where it could not be: a provider's
    /// asked for up to three times, as GIBS's WMS answers some requests with an error page.
    @State private var made: (source: ImageryPreviewSource, image: CGImage?)?

    var body: some View {
        Color(red: 0x0B / 255, green: 0x0D / 255, blue: 0x10 / 255)
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay {
                if let source {
                    if let made, made.source == source {
                        if let image = made.image {
                            Image(decorative: image, scale: 1).resizable().scaledToFill()
                                .onAppear { isMissing = false }
                        } else {
                            placeholder
                        }
                    } else {
                        ProgressView()
                    }
                } else {
                    placeholder
                }
            }
            .clipped()
            .task(id: source) {
                guard let source, made?.source != source else {
                    return
                }
                let image: CGImage? =
                    switch source {
                    case .mosaic(let bounds):
                        try? await mosaic.preview(bounds, width: Int(SatelliteDetails.previewWidth), height: Int(SatelliteDetails.previewHeight))
                    case .url(let url):
                        await GranuleService.picture(url)
                    }
                if !Task.isCancelled {
                    made = (source, image)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if let caption {
                    // Amber: the app colour for "away from rest", as on the status chip.
                    badge(caption).foregroundStyle(ended ? Color.panelAmber : .white)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([label, caption].compactMap(\.self).joined(separator: ", "))
            .accessibilityValue(isMissing ? (outlinesOnly ? "Outlines only" : "No preview") : "")
            .accessibilityAddTraits(.isImage)
    }

    /// In place of a picture there is none of, or the provider refused.
    private var placeholder: some View {
        VStack(spacing: 4) {
            Image(systemName: outlinesOnly ? "square.dashed" : "photo")
            Text(outlinesOnly ? "Outlines only" : "No preview")
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
        .onAppear { isMissing = true }
    }

    /// A label on a corner of the picture, legible on any of it.
    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(.black.opacity(0.7), in: .capsule)
            .padding(6)
    }
}
