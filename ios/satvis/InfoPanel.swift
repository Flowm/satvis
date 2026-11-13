import SatvisCore
import SatvisRender
import SwiftUI

/// What the web app's EntityInfoPanel shows for a satellite: who it is, then its
/// orbit, the spacecraft, its instruments, their imagery and its passes, a tab each.
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
    /// The instruments whose facts are unfolded.
    @State private var openInstruments: Set<String> = []
    /// The instrument whose imagery button opened the Imagery tab, scrolled to there.
    @State private var imageryFocus: String?
    /// Where the Imagery tab's pictures are centred: under the satellite as it was
    /// selected, so that they do not reload as it moves.
    @State private var imageryCentre: LivePosition?
    /// The panel's width, in points.
    @State private var panelWidth = 0.0

    private var propagator: SGP4Propagator? { try? SGP4Propagator(entry.record.meanElements) }

    var body: some View {
        let propagator = propagator
        let spacecraftFacts = SatelliteDetails.spacecraftFacts(entry.record)
        let links = WebTables.shared.externalLinks.compactMap { link in link.url(satnum: entry.satnum).map { (link, $0) } }
        // Only satellites a model manifest lists have one (ADR 0007).
        let modelFile = entry.record.model?.file
        // Only the few hundred satellites CEOS lists have any (ADR 0018).
        let instruments = SatelliteDetails.instruments(entry.record)
        let imagery = instruments.flatMap { instrument in instrument.imagery.map { ImageryLayer(instrument: instrument.name, imagery: $0) } }
        let hasSpacecraft = modelFile != nil || !spacecraftFacts.isEmpty || !links.isEmpty
        let tabs: [InfoTab] =
            [.orbit] + (hasSpacecraft ? [.spacecraft] : []) + (instruments.isEmpty ? [] : [.instruments]) + (imagery.isEmpty ? [] : [.imagery]) + [.passes]
        NavigationStack {
            ScrollViewReader { scroller in
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
                                        .foregroundStyle(Color.panelAmber)
                                        .accessibilityHint("Only the latest element set is kept, so positions far from its epoch drift by kilometres to thousands of kilometres.")
                                        // The cards' text inset, 16 pt on an iPad Air and an iPhone, which a zero-inset row loses.
                                        .padding(.horizontal, 16)
                                        .padding(.bottom, 12)
                                }
                            }
                            TabPicker(
                                tabs: tabs,
                                // An Imagery tab opened any other way than an instrument's button starts at the top.
                                tab: Binding {
                                    tab
                                } set: {
                                    tab = $0
                                    imageryFocus = nil
                                }, subject: .satellite(entry), clock: clock, passes: passes, imageryCount: imagery.count)
                        }
                        .bareRow()
                    }
                    .tabHeader()
                    Group {
                        switch InfoTab.resolved(tab, among: tabs) {
                        case .orbit:
                            orbit(propagator)
                        case .spacecraft:
                            spacecraft(modelFile: modelFile, facts: spacecraftFacts, links: links)
                        case .instruments:
                            instrumentList(instruments)
                        case .imagery:
                            ImageryCards(
                                layers: imagery, centre: imageryCentre, halfWidthDeg: entry.record.orbitClass == .geo ? 72 : 32)
                        default:
                            PassesSections(subject: .satellite(entry), clock: clock, passes: passes)
                        }
                    }
                    .raisedRows()
                }
                .onChange(of: imageryFocus) { reveal(imageryFocus, with: scroller) }
                .onGeometryChange(for: Double.self) {
                    $0.size.width
                } action: {
                    panelWidth = $0
                }
            }
            .panelList()
            .alertNotice(alerts)
            .task(id: entry.id) {
                openInstruments = []
                imageryFocus = nil
                imageryCentre = try? propagator?.livePosition(epochMilliseconds: clock.now())
            }
            #if os(macOS)
                .cardHeader {
                    title(propagator)
                } actions: {
                    AlertButton(subject: .satellite(entry.id), satellites: [entry], passes: passes, alerts: alerts)
                    if let onTrack {
                        Button.track(isTracked, onTrack: onTrack)
                    }
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            #else
                .navigationTitle(entry.name)
                .toolbarTitleDisplayMode(.inline)
                .toolbar {
                    // Drawn here: a navigationSubtitle shows one line, and drops the chips' second.
                    ToolbarItem(placement: .barTitle) {
                        title(propagator)
                    }
                    ToolbarItem(placement: .primaryAction) {
                        AlertButton(subject: .satellite(entry.id), satellites: [entry], passes: passes, alerts: alerts)
                    }
                    if let onTrack {
                        ToolbarSpacer(.fixed, placement: .primaryAction)
                        ToolbarItem(placement: .primaryAction) {
                            Button.track(isTracked, onTrack: onTrack)
                        }
                    }
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                    ToolbarItem(placement: .primaryAction) {
                        Button("Close", systemImage: "xmark", action: onClose)
                    }
                }
            #endif
        }
    }

    /// The name, over its catalog number and chips.
    private func title(_ propagator: SGP4Propagator?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.name)
                .font(.headline)
                // The buttons leave the title less room than the system title had.
                .minimumScaleFactor(0.8)
            subheading(propagator)
        }
        .font(.footnote)
        .lineLimit(1)
        .leadingTitle()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(entry.name), catalog number \(entry.satnum), \(SatelliteDetails.chips(entry.record, propagator: propagator).joined(separator: ", "))"
        )
        // A menu rather than text selection, which would copy whichever of the two lines a press lands on.
        .contextMenu {
            Button("Copy Name", systemImage: "doc.on.doc") { Platform.copy(entry.name) }
            Button("Copy Catalog Number", systemImage: "number") { Platform.copy(entry.satnum) }
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
                Text("Drag to turn, pinch to zoom")
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
            // One row, opening a menu of the sites: a row each, with its title, took a phone's sheet 320 pt.
            Section {
                Menu {
                    ForEach(links, id: \.0) { link, url in
                        Link(destination: url) {
                            Label(link.label, systemImage: "arrow.up.right")
                            Text(link.title)
                        }
                    }
                } label: {
                    HStack {
                        Text("Links")
                        Spacer(minLength: 8)
                        Text("\(links.count) sites")
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(.rect)
                }
                // A Menu paints its label in the tint, through the styles set inside it.
                .tint(.primary)
                .accessibilityLabel("Links")
                .accessibilityValue("\(links.count) sites")
            }
        }
    }

    /// What it observes with, and under it whose list it is.
    private func instrumentList(_ instruments: [SatelliteDetails.Instrument]) -> some View {
        Section {
            InstrumentList(
                instruments: instruments, open: openInstruments, showsFullNames: panelWidth >= Self.fullNamesWidth,
                onToggle: { name in
                    withAnimation(.snappy) {
                        if openInstruments.remove(name) == nil {
                            openInstruments.insert(name)
                        }
                    }
                },
                onImagery: { name in
                    tab = .imagery
                    imageryFocus = name
                })
        } footer: {
            // CC BY 4.0 asks for the credit where the data is shown.
            Link(Credit.instruments.text, destination: Credit.instruments.link!)
                .font(.footnote)
        }
    }

    /// The web app's 440 px panel, under which a full name would show a word or two
    /// beside the short one; the unfolded line has it whole.
    private static let fullNamesWidth = 440.0

    /// The Imagery tab's first card of `instrument` in view, once the tab has its cards:
    /// the least scroll that shows it, as the web app's, which keeps the first under the tabs.
    private func reveal(_ instrument: String?, with scroller: ScrollViewProxy) {
        guard let instrument, tab == .imagery else {
            return
        }
        // The rows the tab switch adds are laid out a pass after it.
        Task { @MainActor in
            withAnimation { scroller.scrollTo(ImageryCards.anchor(instrument)) }
        }
    }

    /// The web app's subtitle line: the catalog number, then the chips, the orbit in
    /// its class's colour, the country, and a status other than Operational in amber.
    private func subheading(_ propagator: SGP4Propagator?) -> Text {
        let status = SatelliteDetails.status(entry.record)
        let chips = SatelliteDetails.chips(entry.record, propagator: propagator)
        return chips.enumerated().reduce(Text(verbatim: "#\(entry.satnum)").foregroundStyle(.secondary)) { line, item in
            let (index, chip) = item
            let color: Color = index == 0 ? Color(orbitClass: entry.record.orbitClass) : chip == status ? .panelAmber : .secondary
            return Text("\(line)\(Text(verbatim: " · ").foregroundStyle(.tertiary))\(Text(chip).foregroundStyle(color))")
        }
    }
}

/// The panels' tabs, kept by their raw values.
enum InfoTab: String {
    case orbit, spacecraft, instruments, imagery, passes, location

    /// `tab` where `tabs` has it, else the first: the one chosen last may be one this selection lacks.
    static func resolved(_ tab: InfoTab, among tabs: [InfoTab]) -> InfoTab {
        tabs.contains(tab) ? tab : tabs[0]
    }
}

/// The web app's tab row, over the tabs a selection has, the Passes tab with the
/// count its list shows.
private struct TabPicker: View {
    let tabs: [InfoTab]
    @Binding var tab: InfoTab
    let subject: PassSubject
    let clock: ViewerClock
    let passes: PassModel
    /// The Imagery tab's count, of its cards.
    var imageryCount = 0
    @AppStorage("showPastPasses") private var showsPast = false

    var body: some View {
        // Once a second, as the list it counts.
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = clock.now()
            let count = subject.passes(in: passes, at: now).passes.visible(at: now, past: showsPast).count
            SegmentedTabs(
                selection: Binding {
                    InfoTab.resolved(tab, among: tabs)
                } set: {
                    tab = $0
                },
                tabs: tabs.map { ($0, $0.rawValue.capitalized, $0 == .passes ? count : $0 == .imagery ? imageryCount : 0) })
        }
    }
}

extension View {
    /// A bar's title at its leading edge, as the web app's, where the bar centres
    /// a title narrower than the room it has: asking for more than there is, it
    /// is given all of it, and is cut short within it.
    fileprivate func leadingTitle() -> some View {
        frame(minWidth: 0, idealWidth: 10_000, maxWidth: .infinity, alignment: .leading)
    }

    #if os(macOS)
        /// The card's title and buttons in a bar of its own, where an iPhone's
        /// navigation bar has them: a Mac's navigation stack has no bar, and hands
        /// both to the window's.
        fileprivate func cardHeader(@ViewBuilder title: () -> some View, @ViewBuilder actions: () -> some View) -> some View {
            safeAreaBar(edge: .top, spacing: 0) {
                // The tool panels' title row: their close button, and a rule under it.
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        title()
                        Group {
                            actions()
                        }
                        .titleRowButton(side: PanelMetrics.row)
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 4)
                    .padding(.vertical, 4)
                    Divider()
                }
            }
        }
    #endif

    /// A section close under the title and over the tab's cards, as the web app's tab row is.
    fileprivate func tabHeader() -> some View {
        #if os(macOS)
            self
        #else
            listSectionMargins(.top, 0).listSectionSpacing(.compact)
        #endif
    }

    /// A row on the panel's background rather than in a card, edge to edge: the tab row heads the cards below.
    fileprivate func bareRow() -> some View {
        listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets())
    }

    /// The tab's cards raised off the panel, as a sheet's are: the iPad's card is
    /// not a sheet, and its rows were the panel's own colour.
    fileprivate func raisedRows() -> some View {
        listRowBackground(Color.panelRaised)
    }

    /// What switching an alert said, here where it was switched: on a phone the
    /// panel is a sheet over the bottom of the screen, where the session's notices are.
    fileprivate func alertNotice(_ alerts: PassAlerts) -> some View {
        overlay(alignment: .bottom) {
            if let message = alerts.message {
                NoticeBanner(text: message).padding(.bottom, 12)
            }
        }
    }
}

extension Button<Label<Text, Image>> {
    /// A panel's Track, or Stop tracking while it is followed.
    fileprivate static func track(_ isTracked: Bool, onTrack: @escaping (Bool) -> Void) -> Self {
        Button(isTracked ? "Stop tracking" : "Track", systemImage: isTracked ? "video.slash" : "video") {
            onTrack(!isTracked)
        }
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
        case .latitude: "\(Formats.fixed(position.latitude, 2))°"
        case .longitude: "\(Formats.fixed(position.longitude, 2))°"
        case .altitude: "\(Formats.fixed(position.height / 1000, 2)) km"
        case .velocity: "\(Formats.fixed(position.speed, 2)) km/s"
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
                    TabPicker(tabs: Self.tabs, tab: $tab, subject: .station(station, catalog.activeEntries), clock: clock, passes: passes)
                        .bareRow()
                }
                .tabHeader()
                Group {
                    switch InfoTab.resolved(tab, among: Self.tabs) {
                    case .location:
                        Section {
                            FactRow(label: "Name", value: station.displayName)
                            FactRow(label: "Latitude", value: "\(Formats.fixed(station.latitude, 2))°")
                            FactRow(label: "Longitude", value: "\(Formats.fixed(station.longitude, 2))°")
                        }
                    default:
                        PassesSections(subject: .station(station, catalog.activeEntries), clock: clock, passes: passes)
                    }
                }
                .raisedRows()
            }
            .panelList()
            .alertNotice(alerts)
            #if os(macOS)
                .cardHeader {
                    title
                } actions: {
                    stationActions
                    skyActions
                    Button("Close", systemImage: "xmark", action: onClose)
                }
            #else
                .navigationTitle(station.displayName)
                .toolbarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .barTitle) {
                        title
                    }
                    // By what they do: the station itself, where to look from, and away.
                    ToolbarItemGroup(placement: .primaryAction) {
                        stationActions
                    }
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                    ToolbarItemGroup(placement: .primaryAction) {
                        skyActions
                    }
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                    ToolbarItem(placement: .primaryAction) {
                        Button("Close", systemImage: "xmark", action: onClose)
                    }
                }
            #endif
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

    /// The station's name.
    private var title: some View {
        Text(station.displayName)
            .font(.headline)
            .lineLimit(1)
            .leadingTitle()
    }

    /// The station itself: a station a link brought is the link's until saved, and
    /// alerts and names are for the user's own, which persist.
    @ViewBuilder private var stationActions: some View {
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

    /// Where to look from.
    @ViewBuilder private var skyActions: some View {
        Button("View the sky from here", image: .lucideTelescope, action: onSky)
        if let onTrack {
            Button.track(isTracked, onTrack: onTrack)
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

/// One layer the Imagery tab shows, and the instrument it shows.
struct ImageryLayer: Hashable {
    let instrument: String
    let imagery: SatelliteDetails.Imagery
}

/// The Imagery tab, the web app's ImageryGallery: a card a layer, with a picture of its
/// latest frame around the satellite, what it is, and a link to it in its provider's
/// viewer. The globe draws none of them, so the cards have no switch for it.
private struct ImageryCards: View {
    let layers: [ImageryLayer]
    /// Nil until the satellite's position is known, or where it has none.
    let centre: LivePosition?
    let halfWidthDeg: Double

    /// The id of `instrument`'s first card, which its imagery button scrolls to.
    static func anchor(_ instrument: String) -> String {
        "imagery:\(instrument)"
    }

    var body: some View {
        ForEach(Array(layers.enumerated()), id: \.offset) { index, layer in
            let imagery = layer.imagery
            Section {
                ImageryPicture(instrument: layer.instrument, label: imagery.label, url: url(imagery.preview), end: imagery.preview?.end)
                    .listRowInsets(EdgeInsets())
                    .id(layers.firstIndex { $0.instrument == layer.instrument } == index ? Self.anchor(layer.instrument) : "imagery:\(index)")
                VStack(alignment: .leading, spacing: 2) {
                    Text(imagery.label)
                        .font(.headline)
                    if let detail = imagery.detail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                if let href = URL(string: imagery.href) {
                    Link(destination: href) {
                        HStack {
                            Text("Open in \(imagery.viewer)")
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .tint(.primary)
                    // Without the arrow's own name.
                    .accessibilityLabel("Open in \(imagery.viewer)")
                }
            }
        }
    }

    /// Nil for a layer with no preview, and until the centre is known.
    private func url(_ preview: SatelliteDetails.ImageryPreview?) -> URL? {
        guard let preview, let centre else {
            return nil
        }
        return URL(
            string: SatelliteDetails.imageryPreviewUrl(
                preview, latitude: centre.latitude, longitude: centre.longitude, halfWidthDeg: halfWidthDeg, now: Date.now.timeIntervalSince1970 * 1000))
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
                if let end {
                    // Amber: the app colour for "away from rest", as on the status chip.
                    badge("Ended \(end)").foregroundStyle(Color.panelAmber)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([instrument, label, end.map { "Ended \($0)" }].compactMap(\.self).joined(separator: ", "))
            .accessibilityValue(isMissing ? "No preview" : "")
            .accessibilityAddTraits(.isImage)
    }

    private var placeholder: some View {
        VStack(spacing: 4) {
            Image(systemName: "photo")
            Text("No preview")
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
        .onAppear { isMissing = true }
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(.black.opacity(0.7), in: .capsule)
            .padding(6)
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
