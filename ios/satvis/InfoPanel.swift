import SatvisCore
import SwiftUI

/// What the web app's EntityInfoPanel shows for a satellite: who it is, then its
/// orbit, the spacecraft and its passes, a tab each.
struct InfoPanel: View {
    let entry: CatalogEntry
    let clock: ViewerClock
    let passes: PassModel
    let alerts: PassAlerts
    let closeUp: CloseUpContext
    let isTracked: Bool
    /// Nil in the sky view, which follows nothing: the web app hides Track there.
    let onTrack: ((Bool) -> Void)?
    let onClose: () -> Void
    /// The tab chosen last, kept across selections and shared with the station panel, as on the web.
    @AppStorage("infoPanelTab") private var tab = InfoTab.orbit

    private var propagator: SGP4Propagator? { try? SGP4Propagator(entry.record.meanElements) }

    var body: some View {
        let propagator = propagator
        let spacecraftFacts = SatelliteDetails.spacecraftFacts(entry.record)
        let links = WebTables.shared.externalLinks.compactMap { link in link.url(satnum: entry.satnum).map { (link, $0) } }
        // Only satellites a model manifest lists have one (ADR 0007).
        let modelFile = entry.record.model?.file
        let tabs: [InfoTab] = modelFile == nil && spacecraftFacts.isEmpty && links.isEmpty ? [.orbit, .passes] : [.orbit, .spacecraft, .passes]
        NavigationStack {
            List {
                Section {
                    // One row: the notice's TimelineView took a row of its own even while it was empty.
                    VStack(alignment: .leading, spacing: 0) {
                        // The web app's notice, amber as the deck's way back to rest.
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            if let propagator,
                                let notice = SatelliteDetails.staleElementsNotice(
                                    epochMilliseconds: SatelliteDetails.epochMilliseconds(julianDate: propagator.epochJulianDate), time: clock.now())
                            {
                                Label(notice, systemImage: "exclamationmark.triangle")
                                    .font(.footnote)
                                    .foregroundStyle(Color.deckAmber)
                                    .accessibilityHint("Only the latest element set is kept, so positions far from its epoch drift by kilometres to thousands of kilometres.")
                                    // The cards' text inset, 16 pt on an iPad Air and an iPhone, which a zero-inset row loses.
                                    .padding(.horizontal, 16)
                                    .padding(.bottom, 12)
                            }
                        }
                        TabPicker(tabs: tabs, tab: $tab)
                    }
                    .bareRow()
                }
                .tabHeader()
                switch InfoTab.resolved(tab, among: tabs) {
                case .orbit:
                    orbit(propagator)
                case .spacecraft:
                    spacecraft(modelFile: modelFile, facts: spacecraftFacts, links: links)
                default:
                    PassesSections(subject: .satellite(entry), clock: clock, passes: passes)
                }
            }
            // Here, where the alert was switched: on a phone the panel is a sheet
            // over the bottom of the screen, where the session's notices are.
            .overlay(alignment: .bottom) {
                if let message = alerts.message {
                    NoticeBanner(text: message).padding(.bottom, 12)
                }
            }
            .navigationTitle(entry.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Drawn here: a navigationSubtitle shows one line, and drops the chips' second.
                ToolbarItem(placement: .title) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.name)
                            .font(.headline)
                            // The buttons leave the title less room than the system title had.
                            .minimumScaleFactor(0.8)
                        Text("#\(entry.satnum)")
                            .foregroundStyle(.secondary)
                        subheading(propagator)
                    }
                    .font(.footnote)
                    .lineLimit(1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        "\(entry.name), catalog number \(entry.satnum), \(SatelliteDetails.chips(entry.record, propagator: propagator).joined(separator: ", "))"
                    )
                    // A menu rather than text selection, which would copy whichever of the three lines a press lands on.
                    .contextMenu {
                        Button("Copy Name", systemImage: "doc.on.doc") { UIPasteboard.general.string = entry.name }
                        Button("Copy Catalog Number", systemImage: "number") { UIPasteboard.general.string = entry.satnum }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    AlertButton(subject: .satellite(entry.id), satellites: [entry], passes: passes, alerts: alerts)
                }
                if let onTrack {
                    ToolbarSpacer(.fixed, placement: .topBarTrailing)
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(isTracked ? "Stop tracking" : "Track", systemImage: isTracked ? "video.slash" : "video") {
                            onTrack(!isTracked)
                        }
                    }
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            }
        }
    }

    /// Where it flies, where it is now, and the element set it is propagated from.
    @ViewBuilder private func orbit(_ propagator: SGP4Propagator?) -> some View {
        Section {
            ForEach(Array(SatelliteDetails.orbitFacts(entry.record, propagator: propagator).enumerated()), id: \.offset) { _, row in
                FactRow(label: row.0, value: row.1)
            }
        }
        PositionSection(satnum: entry.satnum, propagator: propagator, clock: clock)
        if let propagator {
            ElementSetSection(elements: SatelliteDetails.elements(entry.record, epochJulianDate: propagator.epochJulianDate))
        }
    }

    /// What it is, and where else to read about it.
    @ViewBuilder private func spacecraft(modelFile: String?, facts: [(String, String)], links: [(WebTables.Link, URL)]) -> some View {
        if let modelFile {
            Section {
                SatelliteModelView(modelFile: modelFile, name: entry.name, context: closeUp)
                    .listRowInsets(EdgeInsets())
            } footer: {
                Text("Drag to turn · pinch to zoom")
            }
        }
        if !facts.isEmpty {
            Section {
                ForEach(Array(facts.enumerated()), id: \.offset) { _, row in
                    FactRow(label: row.0, value: row.1)
                }
            }
        }
        if !links.isEmpty {
            Section("Links") {
                ForEach(links, id: \.0) { link, url in
                    Link(destination: url) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(link.label)
                                Text(link.title)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                    }
                    // A Link paints its label in the tint, through the styles set inside it.
                    .tint(.primary)
                }
            }
        }
    }

    /// The web app's chips as one line: the orbit in its class's colour, then the
    /// country, then a status other than Operational in amber.
    private func subheading(_ propagator: SGP4Propagator?) -> Text {
        let status = SatelliteDetails.status(entry.record)
        let chips = SatelliteDetails.chips(entry.record, propagator: propagator)
        return chips.enumerated().reduce(Text(verbatim: "")) { line, item in
            let (index, chip) = item
            let color: Color = index == 0 ? Color(orbitClass: entry.record.orbitClass) : chip == status ? .deckAmber : .secondary
            let text = Text(chip).foregroundStyle(color)
            return index == 0 ? text : Text("\(line)\(Text(verbatim: " · ").foregroundStyle(.tertiary))\(text)")
        }
    }
}

/// The panels' tabs, kept by their raw values.
enum InfoTab: String {
    case orbit, spacecraft, passes, location

    /// `tab` where `tabs` has it, else the first: the one chosen last may be one this selection lacks.
    static func resolved(_ tab: InfoTab, among tabs: [InfoTab]) -> InfoTab {
        tabs.contains(tab) ? tab : tabs[0]
    }
}

/// The web app's tab row, over the tabs a selection has.
private struct TabPicker: View {
    let tabs: [InfoTab]
    @Binding var tab: InfoTab

    var body: some View {
        Picker(
            "Tab",
            selection: Binding {
                InfoTab.resolved(tab, among: tabs)
            } set: {
                tab = $0
            }
        ) {
            ForEach(tabs, id: \.self) { Text($0.rawValue.capitalized) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

extension View {
    /// A section close under the title and over the tab's cards, as the web app's tab row is.
    fileprivate func tabHeader() -> some View {
        listSectionMargins(.top, 0).listSectionSpacing(.compact)
    }

    /// A row on the panel's background rather than in a card, edge to edge: the tab row heads the cards below.
    fileprivate func bareRow() -> some View {
        listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets())
    }
}

/// The Orbit tab's live position, worked out once a second for all four rows, so they
/// are of one instant. A TimelineView in a List takes a row, so each row had its own.
private struct PositionSection: View {
    let satnum: String
    let propagator: SGP4Propagator?
    let clock: ViewerClock
    @State private var position: LivePosition?

    var body: some View {
        Section("Position") {
            ForEach(PositionRow.allCases, id: \.self) { row in
                FactRow(label: row.label, value: position.map(row.value) ?? "–")
                    .monospacedDigit()
            }
        }
        .task(id: satnum) {
            while !Task.isCancelled {
                position = try? propagator?.livePosition(epochMilliseconds: clock.now())
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

/// The Orbit tab's live position, to two decimals as on the web.
private enum PositionRow: CaseIterable {
    case latitude, longitude, altitude, velocity

    var label: String {
        switch self {
        case .latitude: "Latitude"
        case .longitude: "Longitude"
        case .altitude: "Altitude"
        case .velocity: "Velocity"
        }
    }

    func value(_ position: LivePosition) -> String {
        switch self {
        case .latitude: "\(toFixed2(position.latitude))°"
        case .longitude: "\(toFixed2(position.longitude))°"
        case .altitude: "\(toFixed2(position.height / 1000)) km"
        case .velocity: "\(toFixed2(position.speed)) km/s"
        }
    }
}

/// A ground station's panel: every active satellite's passes over it, and where it
/// is, a tab each. Passes come first, so a station opens on them.
struct StationPanel: View {
    let station: GroundStation
    let clock: ViewerClock
    let passes: PassModel
    let alerts: PassAlerts
    let catalog: CatalogModel
    let isTracked: Bool
    /// Nil in the sky view, which follows nothing: the web app hides Track there.
    let onTrack: ((Bool) -> Void)?
    let onSky: () -> Void
    let onClose: () -> Void
    @AppStorage("infoPanelTab") private var tab = InfoTab.orbit
    @State private var renaming = false
    @State private var draftName = ""

    private static let tabs: [InfoTab] = [.passes, .location]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TabPicker(tabs: Self.tabs, tab: $tab)
                        .bareRow()
                }
                .tabHeader()
                switch InfoTab.resolved(tab, among: Self.tabs) {
                case .location:
                    Section {
                        FactRow(label: "Name", value: station.displayName)
                        FactRow(label: "Latitude", value: "\(toFixed2(station.latitude))°")
                        FactRow(label: "Longitude", value: "\(toFixed2(station.longitude))°")
                    }
                default:
                    PassesSections(subject: .station(station, catalog.activeEntries), clock: clock, passes: passes)
                }
            }
            .overlay(alignment: .bottom) {
                if let message = alerts.message {
                    NoticeBanner(text: message).padding(.bottom, 12)
                }
            }
            .navigationTitle(station.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // By what they do: the station itself, where to look from, and away.
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // A station a link brought is the link's until saved: alerts and
                    // names are for the user's own, which persist.
                    if passes.isVisiting(station.id) {
                        Button("Save station", systemImage: "plus.circle") { passes.save(station.id) }
                    } else {
                        Button("Rename", systemImage: "pencil") {
                            draftName = station.name ?? ""
                            renaming = true
                        }
                        AlertButton(subject: .station(station.id), satellites: catalog.activeEntries, passes: passes, alerts: alerts)
                    }
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("View the sky from here", systemImage: "binoculars", action: onSky)
                    if let onTrack {
                        Button(isTracked ? "Stop tracking" : "Track", systemImage: isTracked ? "video.slash" : "video") {
                            onTrack(!isTracked)
                        }
                    }
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            }
            .alert("Rename station", isPresented: $renaming) {
                TextField("unnamed", text: $draftName)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    var stations = passes.saved
                    guard let index = stations.firstIndex(where: { $0.id == station.id }) else {
                        return
                    }
                    stations[index].name = draftName
                    passes.setStations(stations)
                }
            }
        }
    }
}

/// Notifications for the passes the panel lists, on or off.
private struct AlertButton: View {
    let subject: PassAlert.Subject
    let satellites: [CatalogEntry]
    let passes: PassModel
    let alerts: PassAlerts
    @State private var needsStation = false

    var body: some View {
        let isOn = alerts.isOn(subject)
        Button(isOn ? "Stop notifying" : "Notify for upcoming passes", systemImage: isOn ? "bell.fill" : "bell") {
            // Notifications are predicted over the saved stations alone.
            guard !passes.saved.isEmpty else {
                needsStation = true
                return
            }
            Task {
                if isOn {
                    await alerts.turnOff(subject)
                } else {
                    await alerts.turnOn(subject, satellites: satellites)
                }
            }
        }
        .alert("Ground station required", isPresented: $needsStation) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Add a ground station to be notified of passes over it.")
        }
    }
}

/// Two decimals with a point, as the web app writes them, and as an unnamed
/// station's name has them.
func toFixed2(_ value: Double) -> String {
    String(format: "%.2f", value)
}

/// A fact as the web app's tables show one: the label, and the value right-aligned
/// beside it, wrapping there. LabeledContent stacked a value too long for its line under
/// the label, flush left.
private struct FactRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            // Fixed: a layout priority alone still let a long value squeeze the label away.
            Text(label)
                .fixedSize()
            Spacer(minLength: 0)
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        // One element, "<label>, <value>", as LabeledContent read.
        .accessibilityElement(children: .combine)
    }
}

/// The element set as served: two TLE lines, or the OMM's orbital fields.
private struct ElementSetSection: View {
    let elements: SatelliteDetails.Elements

    var body: some View {
        switch elements {
        // The epoch is a row: in the header it wrapped onto a second line.
        case .tle(let epoch, let lines):
            Section("Element set") {
                FactRow(label: "Epoch", value: "\(epoch) UTC")
                Text(lines)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        case .omm(let epoch, let rows):
            Section("Element set") {
                FactRow(label: "Epoch", value: "\(epoch) UTC")
                ForEach(rows, id: \.label) { row in
                    FactRow(label: row.label, value: row.value)
                        .font(.caption.monospaced())
                }
            }
        }
    }
}
