import SatvisCore
import SwiftUI

/// The Instruments tab, the web app's InstrumentList: a table of the instruments with
/// figures to compare, each line its name and full name, then its finest resolution and
/// its bands, a strip with a column per class; the kind and the rest behind a press.
/// Those CEOS gives neither for, mostly space weather monitors and data relays, fold
/// into chips that open the same. An instrument with imagery has a button that opens
/// the Imagery tab at it.
struct InstrumentList: View {
    let instruments: [SatelliteDetails.Instrument]
    /// The instruments whose facts are unfolded.
    let open: Set<String>
    /// The panel is wide enough for the full names beside the short ones.
    let showsFullNames: Bool
    let onToggle: (String) -> Void
    let onImagery: (String) -> Void

    /// Has a resolution, bands or imagery: a line in the table.
    static func isMeasured(_ instrument: SatelliteDetails.Instrument) -> Bool {
        !instrument.bands.isEmpty || instrument.resolution != nil || !instrument.imagery.isEmpty
    }

    var body: some View {
        let measured = instruments.filter(Self.isMeasured)
        let folded = instruments.filter { !Self.isMeasured($0) }
        if !measured.isEmpty {
            InstrumentTable(instruments: measured, open: open, showsFullNames: showsFullNames, onToggle: onToggle, onImagery: onImagery)
        }
        if !folded.isEmpty {
            FoldedInstruments(instruments: folded, title: measured.isEmpty ? "Carries" : "Also carries", open: open, onToggle: onToggle)
        }
    }
}

/// The table: a header, then a line an instrument. Each column past the names is as wide
/// as its widest entry on any line, so the full names all end at the same edge.
private struct InstrumentTable: View {
    let instruments: [SatelliteDetails.Instrument]
    let open: Set<String>
    let showsFullNames: Bool
    let onToggle: (String) -> Void
    let onImagery: (String) -> Void

    /// Nine 8 pt cells and their gaps.
    private static let stripWidth = 88.0

    var body: some View {
        // Without one, a column and, for the bands, the legend would be empty.
        let anyBands = instruments.contains { !$0.bands.isEmpty }
        let anyRetired = instruments.contains { $0.isRetired }
        let anyImagery = instruments.contains { !$0.imagery.isEmpty }
        let resolutions = Set(instruments.map { $0.resolution ?? "—" }).sorted()
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                // Over the names, past the chevron.
                Text("Instrument")
                    .padding(.leading, 22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if anyRetired, showsFullNames {
                    retired(shown: false)
                }
                if anyImagery {
                    Color.clear.frame(width: 32, height: 0)
                }
                widest(Text("Res"), of: resolutions)
                if anyBands {
                    Text("Bands")
                        .frame(width: Self.stripWidth, alignment: .leading)
                        .padding(.leading, 10)
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .padding(.bottom, 4)
            .accessibilityHidden(true)
            Divider()
            ForEach(instruments, id: \.name) { instrument in
                line(instrument, anyBands: anyBands, anyRetired: anyRetired, anyImagery: anyImagery, resolutions: resolutions)
                if open.contains(instrument.name) {
                    InstrumentDetails(instrument: instrument, showsName: false)
                        .padding(.leading, 22)
                        .padding(.bottom, 10)
                }
                Divider().opacity(0.5)
            }
            if anyBands {
                BandLegend().padding(.top, 8)
            }
        }
    }

    /// `label` trailing, as wide as the widest of `resolutions` would be on a line.
    private func widest(_ label: Text, of resolutions: [String]) -> some View {
        ZStack(alignment: .trailing) {
            ForEach(resolutions, id: \.self) { resolution in
                Text(resolution).font(.subheadline).monospacedDigit().hidden()
            }
            label
        }
        .padding(.leading, 8)
    }

    /// The Retired column: the tag, or its room where `shown` is false.
    private func retired(shown: Bool) -> some View {
        // Amber: the app colour for "away from rest", as on the status chip.
        Text("Retired")
            .font(.caption)
            .foregroundStyle(Color.panelAmber)
            .opacity(shown ? 1 : 0)
            .padding(.leading, 8)
    }

    private func line(
        _ instrument: SatelliteDetails.Instrument, anyBands: Bool, anyRetired: Bool, anyImagery: Bool, resolutions: [String]
    ) -> some View {
        let isOpen = open.contains(instrument.name)
        let toggle = { onToggle(instrument.name) }
        return HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .frame(width: 14)
                    Text(instrument.name)
                        .fontWeight(.semibold)
                        .layoutPriority(1)
                    if showsFullNames, let fullName = instrument.fullName {
                        Text(fullName)
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                [
                    instrument.name, instrument.isRetired ? "Retired" : nil, instrument.resolution,
                    instrument.bands.isEmpty ? nil : "Bands: \(instrument.bands.joined(separator: ", "))",
                ]
                .compactMap(\.self).joined(separator: ", ")
            )
            .accessibilityHint(isOpen ? "Hides its facts" : "Shows its facts")
            // Where neither a full name nor Retired is shown, the name has Retired's room
            // too; with full names, they all end at its edge, as on the web.
            if instrument.isRetired || (anyRetired && showsFullNames) {
                retired(shown: instrument.isRetired)
                    .pressable(toggle)
            }
            if !instrument.imagery.isEmpty {
                // 32 pt: a finger's target on the phone.
                Button("Imagery of \(instrument.name)", systemImage: "photo") { onImagery(instrument.name) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.panelAccent)
                    .frame(width: 32, height: 32)
            } else if anyImagery {
                Color.clear.frame(width: 32, height: 0)
            }
            widest(Text(instrument.resolution ?? "—").foregroundStyle(.secondary), of: resolutions)
                .monospacedDigit()
                .lineLimit(1)
                .pressable(toggle)
            if anyBands {
                Group {
                    if instrument.bands.isEmpty {
                        Text("—").foregroundStyle(.tertiary)
                    } else {
                        BandStrip(bands: instrument.bands)
                    }
                }
                .frame(width: Self.stripWidth, alignment: .leading)
                .padding(.leading, 10)
                .pressable(toggle)
            }
        }
        .font(.subheadline)
    }
}

/// The instruments the table leaves out, a chip each, which unfolds its facts under the chips.
private struct FoldedInstruments: View {
    let instruments: [SatelliteDetails.Instrument]
    let title: String
    let open: Set<String>
    let onToggle: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            FlowLayout {
                ForEach(instruments, id: \.name) { instrument in
                    chip(instrument)
                }
            }
            ForEach(instruments.filter { open.contains($0.name) }, id: \.name) { instrument in
                InstrumentDetails(instrument: instrument, showsName: true)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.03), in: .rect(cornerRadius: 6))
            }
        }
    }

    private func chip(_ instrument: SatelliteDetails.Instrument) -> some View {
        let isOpen = open.contains(instrument.name)
        return Button {
            onToggle(instrument.name)
        } label: {
            HStack(spacing: 6) {
                Text(instrument.name)
                if instrument.isRetired {
                    Text("Retired")
                        .font(.caption)
                        .foregroundStyle(Color.panelAmber)
                }
            }
            .font(.footnote)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Color.white.opacity(isOpen ? 0.08 : 0), in: .capsule)
            .overlay(Capsule().strokeBorder(Color.white.opacity(isOpen ? 0.44 : 0.17)))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(instrument.isRetired ? "\(instrument.name), Retired" : instrument.name)
        .accessibilityHint(isOpen ? "Hides its facts" : "Shows its facts")
    }
}

/// An unfolded instrument: the full name, then its facts, label beside value.
private struct InstrumentDetails: View {
    let instrument: SatelliteDetails.Instrument
    /// A chip's, whose name is not on a line above.
    let showsName: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if showsName {
                Text(instrument.name).fontWeight(.semibold)
            }
            if let fullName = instrument.fullName {
                Text(fullName).foregroundStyle(.secondary)
            }
            ForEach(Array(instrument.rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.0)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 96, alignment: .leading)
                    Text(row.1)
                }
                // One element, "<label>, <value>", as the panel's fact rows read.
                .accessibilityElement(children: .combine)
            }
        }
        .font(.footnote)
        .textSelection(.enabled)
    }
}

/// An instrument's bands, a cell a column of `WebTables.wavebandColumns`, lit in its colour.
private struct BandStrip: View {
    let bands: [String]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(WebTables.shared.wavebandCells(bands).enumerated()), id: \.offset) { _, colour in
                RoundedRectangle(cornerRadius: 2)
                    .fill(colour.flatMap(Color.init(hex:)) ?? Color.white.opacity(0x12 / 255))
                    .frame(width: 8, height: 12)
            }
        }
        .accessibilityHidden(true)
    }
}

/// What each column's colour is, under the table.
private struct BandLegend: View {
    var body: some View {
        FlowLayout(spacing: 10) {
            ForEach(WebTables.shared.wavebandColumns, id: \.label) { column in
                HStack(spacing: 3) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: column.colour) ?? .clear)
                        .frame(width: 8, height: 8)
                    Text(column.label)
                }
            }
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
}

extension SatelliteDetails.Instrument {
    /// The Resolution row's value, the finest CEOS gives.
    fileprivate var resolution: String? {
        rows.first { $0.0 == "Resolution" }?.1
    }
}

extension View {
    /// A cell of a line that a press toggles as its name does, which VoiceOver reads on the name.
    fileprivate func pressable(_ action: @escaping () -> Void) -> some View {
        contentShape(.rect).onTapGesture(perform: action).accessibilityHidden(true)
    }
}

extension Color {
    /// "#rrggbb", as the web app's tables write a colour; nil for any other.
    init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else {
            return nil
        }
        self.init(red: Double(value >> 16 & 0xFF) / 255, green: Double(value >> 8 & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}
