import SatvisCore
import SwiftUI

/// What the web app's EntityInfoPanel shows for a satellite: who it is, where it is
/// now, and the Details tab. The Passes tab arrives with ground stations (M3).
struct InfoPanel: View {
    let entry: CatalogEntry
    let clock: ViewerClock
    let isTracked: Bool
    let onTrack: (Bool) -> Void
    let onClose: () -> Void

    private var propagator: SGP4Propagator? { try? SGP4Propagator(entry.record.meanElements) }

    var body: some View {
        let propagator = propagator
        NavigationStack {
            List {
                Section {
                    chips
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LiveStrip(position: try? propagator?.livePosition(epochMilliseconds: clock.now()))
                    }
                }
                Section("Details") {
                    ForEach(Array(SatelliteDetails.facts(entry.record, propagator: propagator).enumerated()), id: \.offset) { _, row in
                        LabeledContent(row.0, value: row.1)
                    }
                }
                Section("Elsewhere") {
                    ForEach(WebTables.shared.externalLinks, id: \.self) { link in
                        if let url = link.url(satnum: entry.satnum) {
                            Link(destination: url) {
                                LabeledContent(link.label, value: link.title)
                            }
                        }
                    }
                }
                if let propagator {
                    ElementSetSection(elements: SatelliteDetails.elements(entry.record, epochJulianDate: propagator.epochJulianDate))
                }
            }
            .navigationTitle(entry.name)
            .navigationSubtitle("#\(entry.satnum)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button(isTracked ? "Stop tracking" : "Track", systemImage: isTracked ? "video.slash" : "video") {
                        onTrack(!isTracked)
                    }
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            }
        }
    }

    private var chips: some View {
        let metadata = entry.record.metadata
        let tables = WebTables.shared.satcat
        let owner = metadata["owner"]?.string.map { tables.owner[$0] ?? $0 }
        let status = metadata["opsStatus"]?.string.map { tables.opsStatus[$0] ?? $0 }
        return HStack {
            Chip(text: entry.record.orbitClass.rawValue, color: Color(orbitClass: entry.record.orbitClass))
            if let owner {
                Chip(text: owner, color: .secondary)
            }
            if let status {
                Chip(text: status, color: .secondary)
            }
        }
    }
}

private struct Chip: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
    }
}

/// Latitude, longitude, altitude and speed, to two decimals as on the web.
private struct LiveStrip: View {
    let position: LivePosition?

    var body: some View {
        HStack {
            value("Latitude", position.map { "\($0.latitude.formatted(.number.precision(.fractionLength(2))))°" })
            value("Longitude", position.map { "\($0.longitude.formatted(.number.precision(.fractionLength(2))))°" })
            value("Altitude", position.map { "\(($0.height / 1000).formatted(.number.precision(.fractionLength(2)))) km" })
            value("Velocity", position.map { "\($0.speed.formatted(.number.precision(.fractionLength(2)))) km/s" })
        }
    }

    private func value(_ label: String, _ text: String?) -> some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(text ?? "–")
                .font(.footnote.monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The element set as served: two TLE lines, or the OMM's orbital fields.
private struct ElementSetSection: View {
    let elements: SatelliteDetails.Elements

    var body: some View {
        switch elements {
        case .tle(let epoch, let lines):
            Section("Element set · epoch \(epoch) UTC") {
                Text(lines)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        case .omm(let epoch, let rows):
            Section("Element set · epoch \(epoch) UTC") {
                ForEach(rows, id: \.label) { row in
                    LabeledContent(row.label, value: row.value)
                        .font(.caption.monospaced())
                }
            }
        }
    }
}
