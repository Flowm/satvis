import SatvisCore
import SwiftUI

/// What the web app's EntityInfoPanel shows for a satellite: who it is and where it
/// is now, then its passes or its details, a tab each.
struct InfoPanel: View {
    let entry: CatalogEntry
    let clock: ViewerClock
    let passes: PassModel
    let isTracked: Bool
    let onTrack: (Bool) -> Void
    let onClose: () -> Void
    /// The tab chosen last, kept across selections, as on the web.
    @AppStorage("infoPanelTab") private var tab = InfoTab.details

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
                    Picker("Tab", selection: $tab) {
                        ForEach(InfoTab.allCases, id: \.self) { Text($0.rawValue.capitalized) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                switch tab {
                case .passes:
                    PassesSections(subject: .satellite(entry), clock: clock, passes: passes)
                case .details:
                    details(propagator)
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

    @ViewBuilder private func details(_ propagator: SGP4Propagator?) -> some View {
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

enum InfoTab: String, CaseIterable {
    case passes, details
}

/// A ground station's panel: where it is, and every active satellite's passes over
/// it. A station has no details, so it has no tabs.
struct StationPanel: View {
    let index: Int
    let station: GroundStation
    let clock: ViewerClock
    let passes: PassModel
    let catalog: CatalogModel
    let isTracked: Bool
    let onTrack: (Bool) -> Void
    let onClose: () -> Void
    @State private var renaming = false
    @State private var draftName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        value("Latitude", "\(toFixed2(station.latitude))°")
                        value("Longitude", "\(toFixed2(station.longitude))°")
                    }
                }
                PassesSections(subject: .station(station, catalog.activeEntries), clock: clock, passes: passes)
            }
            .navigationTitle(station.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("Rename", systemImage: "pencil") {
                        draftName = station.name ?? ""
                        renaming = true
                    }
                    Button(isTracked ? "Stop tracking" : "Track", systemImage: isTracked ? "video.slash" : "video") {
                        onTrack(!isTracked)
                    }
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            }
            .alert("Rename station", isPresented: $renaming) {
                TextField("unnamed", text: $draftName)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    var stations = passes.stations
                    guard stations.indices.contains(index) else {
                        return
                    }
                    stations[index].name = draftName
                    passes.setStations(stations)
                }
            }
        }
    }

    private func value(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.footnote.monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Two decimals with a point, as the web app writes them, and as an unnamed
/// station's name has them.
func toFixed2(_ value: Double) -> String {
    String(format: "%.2f", value)
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
            value("Latitude", position.map { "\(toFixed2($0.latitude))°" })
            value("Longitude", position.map { "\(toFixed2($0.longitude))°" })
            value("Altitude", position.map { "\(toFixed2($0.height / 1000)) km" })
            value("Velocity", position.map { "\(toFixed2($0.speed)) km/s" })
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
