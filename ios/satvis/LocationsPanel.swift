import SatvisCore
import SwiftUI

/// The ground station list, the web app's Locations panel: each station's name and
/// coordinates editable in place on a card, removed by its cross and moved by
/// dragging its grip, then the stations a link brought, and the two ways to add one.
/// A panel rather than a sheet, as both ways out of it are on the globe.
struct LocationsPanel: View {
    let passes: PassModel
    let onPick: () -> Void
    let onSelect: (UUID) -> Void
    @State private var locating = false
    @State private var locationFailed = false

    var body: some View {
        PanelSection("Saved") {
            if passes.saved.isEmpty {
                Note("None yet. Pick one on the globe, or use your own position.")
            } else {
                PanelCard {
                    ForEach(passes.saved) { station in
                        StationRow(station: station) { edited in
                            passes.setStations(passes.saved.map { $0.id == edited.id ? edited : $0 })
                        } onShow: {
                            onSelect(station.id)
                        } onRemove: {
                            passes.setStations(passes.saved.filter { $0.id != station.id })
                        } onMove: { moved, offset in
                            move(moved, by: offset)
                        } onDrop: { dropped in
                            move(dropped, to: station.id)
                        }
                    }
                }
            }
        }
        // Stations a link brought: shown with its view, kept only when saved.
        if !passes.visiting.isEmpty {
            PanelSection("From the link") {
                PanelCard {
                    ForEach(passes.visiting) { station in
                        VisitingRow(station: station) {
                            onSelect(station.id)
                        } onSave: {
                            passes.save(station.id)
                        }
                    }
                }
            }
        }
        PanelSection("Add") {
            PanelCard {
                Place(Text("Pick on globe"), image: .lucideCrosshair, action: onPick)
                Place(Text("My location"), image: .lucideLocateFixed, waitingFor: locating ? "Finding your location" : nil) {
                    Task {
                        locating = true
                        defer { locating = false }
                        if let location = await currentLocation() {
                            passes.setGeolocation(latitude: location.latitude, longitude: location.longitude)
                        } else {
                            locationFailed = true
                        }
                    }
                }
                .disabled(locating)
            }
        }
        .alert("Location unavailable", isPresented: $locationFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("No position came back. Check that Satvis may use your location in Settings.")
        }
    }

    /// One place up or down the list, as the grip's VoiceOver actions say.
    private func move(_ id: UUID, by offset: Int) {
        guard let from = passes.saved.firstIndex(where: { $0.id == id }) else {
            return
        }
        let to = from + offset
        guard passes.saved.indices.contains(to) else {
            return
        }
        move(id, to: passes.saved[to].id)
    }

    /// Into the place of the station it was dropped on, which moves aside.
    private func move(_ id: UUID, to target: UUID) {
        guard let from = passes.saved.firstIndex(where: { $0.id == id }),
            let to = passes.saved.firstIndex(where: { $0.id == target }), from != to
        else {
            return
        }
        var stations = passes.saved
        stations.move(fromOffsets: [from], toOffset: to > from ? to + 1 : to)
        passes.setStations(stations)
    }
}

/// One station: a grip to drag it by, its name, latitude and longitude, each
/// committed when the field is left and refused when what was typed is not a
/// coordinate, its passes and a cross that removes it, as the web app's row.
private struct StationRow: View {
    let station: GroundStation
    let onEdit: (GroundStation) -> Void
    let onShow: () -> Void
    let onRemove: () -> Void
    /// By one place, up (-1) or down (1).
    let onMove: (UUID, Int) -> Void
    /// Another station dropped on this one.
    let onDrop: (UUID) -> Void
    @State private var name = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @FocusState private var focused: Field?
    @ScaledMetric(relativeTo: .body) private var markWidth = PanelRowMetrics.markWidth
    /// What -17.5516 and -149.5585 take side by side, as halves of the row.
    @ScaledMetric(relativeTo: .caption) private var coordinatesWidth: CGFloat = 132
    @State private var stacksCoordinates = false

    private enum Field {
        case name, latitude, longitude
    }

    var body: some View {
        HStack(spacing: PanelRowMetrics.spacing) {
            grip
            VStack(alignment: .leading, spacing: 2) {
                TextField("unnamed", text: $name)
                    .focused($focused, equals: .name)
                    .submitLabel(.done)
                    .accessibilityLabel("Name")
                // Latitude over longitude where halves would cut -149.5585 short, as on
                // a 375 pt phone's card. By the room, not the text, so that no field
                // moves while it is typed in.
                let layout = stacksCoordinates ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout())
                layout {
                    coordinate("Latitude", text: $latitude, field: .latitude)
                    coordinate("Longitude", text: $longitude, field: .longitude)
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            .onGeometryChange(for: Bool.self) {
                $0.size.width < coordinatesWidth
            } action: {
                stacksCoordinates = $0
            }
            Button("Show passes", systemImage: "chevron.right", action: onShow)
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
            Button("Remove \(station.displayName)", systemImage: "xmark", action: onRemove)
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, PanelRowMetrics.inset)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .dropDestination(for: String.self) { items, _ in
            guard let id = items.first.flatMap(UUID.init(uuidString:)), id != station.id else {
                return false
            }
            onDrop(id)
            return true
        }
        .onAppear(perform: reset)
        .onChange(of: station) { reset() }
        .onChange(of: focused) { previous, _ in
            if let previous {
                commit(previous)
            }
        }
        .onSubmit { focused = nil }
        // The panel closes for the globe, Show passes and Pick on globe alike,
        // before the field is left.
        .onDisappear {
            if let focused {
                commit(focused)
            }
        }
    }

    /// Dragged to reorder, in the selection circle's column; VoiceOver moves the
    /// station a place at a time instead, as the web app's arrow keys do.
    private var grip: some View {
        Image(systemName: "line.3.horizontal")
            .foregroundStyle(.secondary)
            .frame(width: markWidth, height: 44)
            .contentShape(.rect)
            .draggable(station.id.uuidString) {
                Text(verbatim: station.displayName)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .panel()
            }
            .accessibilityElement()
            .accessibilityLabel("Reorder \(station.displayName)")
            .accessibilityAction(named: "Move up") { onMove(station.id, -1) }
            .accessibilityAction(named: "Move down") { onMove(station.id, 1) }
    }

    /// A latitude or longitude field, typed with a sign.
    private func coordinate(_ label: String, text: Binding<String>, field: Field) -> some View {
        TextField(label, text: text)
            .keyboardType(.numbersAndPunctuation)
            .focused($focused, equals: field)
            .submitLabel(.done)
            .accessibilityLabel(label)
    }

    /// Puts back what the list holds, which is the rounded value, or the old one
    /// where an edit was refused.
    private func reset() {
        name = station.name ?? ""
        latitude = javaScriptString(station.latitude)
        longitude = javaScriptString(station.longitude)
    }

    /// Keeps what `field` holds, if it changed and, for a coordinate, is one.
    private func commit(_ field: Field) {
        var edited = station
        switch field {
        case .name:
            edited.name = name
        case .latitude:
            guard let value = GroundStations.coordinate(latitude, limit: GroundStations.maxLatitude) else {
                return reset()
            }
            edited.latitude = value
        case .longitude:
            guard let value = GroundStations.coordinate(longitude, limit: GroundStations.maxLongitude) else {
                return reset()
            }
            edited.longitude = value
        }
        if edited != station {
            onEdit(edited)
        }
        reset()
    }
}

/// A station a link brought: its name and coordinates, which open its panel, and
/// Save, which keeps it.
private struct VisitingRow: View {
    let station: GroundStation
    let onShow: () -> Void
    let onSave: () -> Void
    @ScaledMetric(relativeTo: .body) private var iconSize = 20.0
    @ScaledMetric(relativeTo: .body) private var markWidth = PanelRowMetrics.markWidth

    var body: some View {
        HStack(spacing: PanelRowMetrics.spacing) {
            Button(action: onShow) {
                HStack(spacing: PanelRowMetrics.spacing) {
                    Image(.lucideMapPin)
                        .resizable()
                        .scaledToFit()
                        .frame(width: iconSize, height: iconSize)
                        .frame(width: markWidth)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: station.displayName)
                            .lineLimit(1)
                        // An unnamed one is shown by its coordinates already.
                        if station.name != nil {
                            Text("\(toFixed2(station.latitude))°, \(toFixed2(station.longitude))°")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Button("Save", action: onSave)
                .buttonStyle(.borderless)
                .tint(Color.panelAccent)
        }
        .padding(.horizontal, PanelRowMetrics.inset)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
    }
}
