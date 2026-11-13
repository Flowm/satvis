import SatvisCore
import SwiftUI

/// One layer the Imagery tab shows, and the instrument it shows.
struct ImageryLayer: Hashable {
    let instrument: String
    let imagery: SatelliteDetails.Imagery
}

/// The Imagery tab, the web app's ImageryGallery: a card a layer, with a picture of its
/// latest frame around the satellite, what it is, and a link to it in its provider's
/// viewer, in as many columns as fit cards 220 pt wide, as the web app's grid. A row of
/// cards is a row of the list, so that a card can be scrolled to. A layer the globe can
/// draw has a Show switch, and a press anywhere else on its card does what it does.
struct ImageryCards: View {
    let layers: [ImageryLayer]
    /// A picture a layer, as `previews` builds them.
    let previews: [URL?]
    let columns: Int
    let drawn: InstrumentImagery

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
        "imagery:\((layers.firstIndex { $0.instrument == instrument } ?? 0) / max(columns, 1))"
    }

    /// A picture of each layer, `halfWidthDeg` either side of `centre`, at `now` in
    /// milliseconds since 1970; nil for a layer with no preview, and all of them where
    /// the satellite has no position.
    static func previews(_ layers: [ImageryLayer], centre: LivePosition?, halfWidthDeg: Double, now: Double) -> [URL?] {
        layers.map { layer in
            guard let preview = layer.imagery.preview, let centre else {
                return nil
            }
            return URL(
                string: SatelliteDetails.imageryPreviewUrl(preview, latitude: centre.latitude, longitude: centre.longitude, halfWidthDeg: halfWidthDeg, now: now))
        }
    }

    var body: some View {
        let rows = stride(from: 0, to: layers.count, by: columns).map { $0..<min($0 + columns, layers.count) }
        Section {
            ForEach(Array(rows.enumerated()), id: \.offset) { row, indices in
                HStack(alignment: .top, spacing: Self.gap) {
                    ForEach(indices, id: \.self) { index in
                        ImageryCard(layer: layers[index], preview: previews.indices.contains(index) ? previews[index] : nil, drawn: drawn)
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

/// A layer's card: its picture, what it is, and its provider's viewer.
private struct ImageryCard: View {
    let layer: ImageryLayer
    let preview: URL?
    let drawn: InstrumentImagery

    var body: some View {
        let imagery = layer.imagery
        let token = imagery.preview?.token
        let isShown = token.map(drawn.isShown) ?? false
        VStack(alignment: .leading, spacing: 0) {
            ImageryPicture(instrument: layer.instrument, label: imagery.label, url: preview, end: imagery.preview?.end)
            VStack(alignment: .leading, spacing: 2) {
                Text(imagery.label)
                    .font(.subheadline.weight(.semibold))
                if let detail = imagery.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            Spacer(minLength: 8)
            HStack(spacing: 0) {
                if let token {
                    Toggle(
                        "Show",
                        isOn: Binding {
                            drawn.isShown(token)
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
                    .accessibilityLabel("Show \(imagery.label) on the globe")
                }
                Spacer(minLength: 0)
                link(imagery)
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

    /// The provider's viewer, which opens the layer there.
    @ViewBuilder private func link(_ imagery: SatelliteDetails.Imagery) -> some View {
        if let href = URL(string: imagery.href) {
            Link(destination: href) {
                HStack(spacing: 4) {
                    Text(imagery.viewer)
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.semibold))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .contentShape(.rect)
            }
            .accessibilityLabel("Open in \(imagery.viewer)")
        }
    }
}

/// A layer's picture, 16:9 on black, the instrument on its corner and, of a layer that
/// stopped, when; "No preview" where there is none or the provider refused it.
private struct ImageryPicture: View {
    let instrument: String
    let label: String
    let url: URL?
    let end: String?
    /// Showing the placeholder, which the picture's accessibility value says.
    @State private var isMissing = false

    var body: some View {
        Color(red: 0x0B / 255, green: 0x0D / 255, blue: 0x10 / 255)
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay {
                if let url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                                .onAppear { isMissing = false }
                        case .failure:
                            placeholder
                        default:
                            ProgressView()
                        }
                    }
                } else {
                    placeholder
                }
            }
            .clipped()
            .overlay(alignment: .topLeading) {
                badge(instrument)
            }
            .overlay(alignment: .topTrailing) {
                if let ended {
                    // Amber: the app colour for "away from rest", as on the status chip.
                    badge(ended).foregroundStyle(Color.panelAmber)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([instrument, label, ended].compactMap(\.self).joined(separator: ", "))
            .accessibilityValue(isMissing ? "No preview" : "")
            .accessibilityAddTraits(.isImage)
    }

    /// "Ended 2022-10-12", of a layer that stopped.
    private var ended: String? {
        end.map { "Ended \($0)" }
    }

    /// In place of a picture there is none of, or the provider refused.
    private var placeholder: some View {
        VStack(spacing: 4) {
            Image(systemName: "photo")
            Text("No preview")
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
        .onAppear { isMissing = true }
    }

    /// A label on a corner of the picture, legible on any of it.
    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(.black.opacity(0.7), in: .capsule)
            .padding(6)
    }
}
