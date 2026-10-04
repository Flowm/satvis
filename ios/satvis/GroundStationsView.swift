import SatvisCore
import SwiftUI

/// The ground station list, as the web app's: each station's name and coordinates
/// editable in place, in an order the user sets, added by picking a place on the
/// globe or from where the device is.
struct GroundStationsView: View {
    let passes: PassModel
    let onPick: () -> Void
    let onSelect: (UUID) -> Void
    @State private var locating = false
    @State private var locationFailed = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if passes.stations.isEmpty {
                        Text("None yet. Pick one on the globe, or use your own position.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(passes.stations) { station in
                        StationRow(station: station) { edited in
                            passes.setStations(passes.stations.map { $0.id == edited.id ? edited : $0 })
                        } onShow: {
                            onSelect(station.id)
                            dismiss()
                        }
                    }
                    .onDelete { offsets in
                        var stations = passes.stations
                        stations.remove(atOffsets: offsets)
                        passes.setStations(stations)
                    }
                    .onMove { offsets, destination in
                        var stations = passes.stations
                        stations.move(fromOffsets: offsets, toOffset: destination)
                        passes.setStations(stations)
                    }
                }
                Section {
                    Button("Pick on globe", systemImage: "hand.tap") {
                        onPick()
                        dismiss()
                    }
                    Button {
                        Task {
                            locating = true
                            defer { locating = false }
                            if let location = await currentLocation() {
                                passes.add(latitude: location.latitude, longitude: location.longitude, name: "Geolocation")
                            } else {
                                locationFailed = true
                            }
                        }
                    } label: {
                        HStack {
                            Label("My location", systemImage: "location")
                            if locating {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(locating)
                }
            }
            .navigationTitle("Ground stations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Location unavailable", isPresented: $locationFailed) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("No position came back. Check that SatVis may use your location in Settings.")
            }
        }
    }
}

/// One station: its name, latitude and longitude, each committed when the field is
/// left, and refused when what was typed is not a coordinate.
private struct StationRow: View {
    let station: GroundStation
    let onEdit: (GroundStation) -> Void
    let onShow: () -> Void
    @State private var name = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @FocusState private var focused: Field?

    private enum Field {
        case name, latitude, longitude
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                TextField("unnamed", text: $name)
                    .focused($focused, equals: .name)
                    .submitLabel(.done)
                HStack {
                    coordinate("Latitude", text: $latitude, field: .latitude)
                    coordinate("Longitude", text: $longitude, field: .longitude)
                }
                .font(.caption.monospacedDigit())
            }
            Button("Show passes", systemImage: "chevron.right", action: onShow)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
        }
        .onAppear(perform: reset)
        .onChange(of: station) { reset() }
        .onChange(of: focused) { previous, _ in
            if let previous {
                commit(previous)
            }
        }
        .onSubmit { focused = nil }
    }

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
