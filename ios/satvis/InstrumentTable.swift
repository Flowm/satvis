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
    let unfolded: Set<String>
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
            InstrumentTable(instruments: measured, unfolded: unfolded, onToggle: onToggle, onImagery: onImagery)
        }
        if !folded.isEmpty {
            FoldedInstruments(instruments: folded, title: measured.isEmpty ? "Carries" : "Also carries", unfolded: unfolded, onToggle: onToggle)
        }
    }
}

/// The table: a header, then a line an instrument. Each column past the names is as wide
/// as its widest entry on any line, so the full names all end at the same edge.
private struct InstrumentTable: View {
    let instruments: [SatelliteDetails.Instrument]
    let unfolded: Set<String>
    let onToggle: (String) -> Void
    let onImagery: (String) -> Void
    /// Points; nil until the first layout.
    @State private var width: Double?

    /// The web app's container query: a 440 px panel less its sides, under which a full
    /// name would show a word or two; the unfolded line has it whole.
    private static let fullNamesWidth = 415.0
    /// Nine 8 pt cells and their gaps.
    private static let stripWidth = 88.0
    /// A finger's target on the phone.
    private static let imageryWidth = 32.0

    var body: some View {
        let columns = Columns(instruments, fullNames: (width ?? 0) >= Self.fullNamesWidth)
        VStack(alignment: .leading, spacing: 0) {
            header(columns)
            Divider()
            ForEach(instruments, id: \.name) { instrument in
                line(instrument, columns)
                if unfolded.contains(instrument.name) {
                    InstrumentDetails(instrument: instrument, showsName: false)
                        .padding(.leading, 22)
                        .padding(.bottom, 10)
                }
                Divider().opacity(0.5)
            }
            if columns.bands {
                BandLegend().padding(.top, 8)
            }
        }
        .onGeometryChange(for: Double.self) {
            $0.size.width
        } action: {
            width = $0
        }
    }

    /// What every line shares: the columns any of them fills, and whether the full names show.
    private struct Columns {
        let bands: Bool
        let retired: Bool
        let imagery: Bool
        let fullNames: Bool
        /// Every line's resolution or dash, which size the Res column.
        let resolutions: [String]

        init(_ instruments: [SatelliteDetails.Instrument], fullNames: Bool) {
            bands = instruments.contains { !$0.bands.isEmpty }
            retired = instruments.contains { $0.isRetired }
            imagery = instruments.contains { !$0.imagery.isEmpty }
            self.fullNames = fullNames
            resolutions = Set(instruments.map { $0.resolution ?? "—" }).sorted()
        }

        /// Where neither a full name nor Retired is shown, a name has Retired's room too;
        /// with full names, they all end at its edge, as on the web.
        func hasRetiredCell(_ instrument: SatelliteDetails.Instrument) -> Bool {
            instrument.isRetired || (retired && fullNames)
        }
    }

    /// The column heads, over the names past the chevron and over their columns.
    private func header(_ columns: Columns) -> some View {
        HStack(spacing: 0) {
            Text("Instrument")
                .padding(.leading, 22)
                .frame(maxWidth: .infinity, alignment: .leading)
            if columns.retired, columns.fullNames {
                RetiredTag().hidden().padding(.leading, 8)
            }
            if columns.imagery {
                Color.clear.frame(width: Self.imageryWidth, height: 0)
            }
            widest(Text("Res"), of: columns.resolutions)
            if columns.bands {
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

    /// An instrument's line, which a press on its name, resolution or bands unfolds.
    private func line(_ instrument: SatelliteDetails.Instrument, _ columns: Columns) -> some View {
        let isOpen = unfolded.contains(instrument.name)
        let toggle = { onToggle(instrument.name) }
        let fullName = columns.fullNames ? instrument.fullName : nil
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
                    if let fullName {
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
                    instrument.name, fullName, instrument.isRetired ? "Retired" : nil, instrument.resolution,
                    instrument.bands.isEmpty ? nil : "Bands: \(instrument.bands.joined(separator: ", "))",
                ]
                .compactMap(\.self).joined(separator: ", ")
            )
            .accessibilityHint(foldHint(isOpen))
            if columns.hasRetiredCell(instrument) {
                RetiredTag()
                    .opacity(instrument.isRetired ? 1 : 0)
                    .padding(.leading, 8)
                    .pressable(toggle)
            }
            if !instrument.imagery.isEmpty {
                Button("Imagery of \(instrument.name)", systemImage: "photo") { onImagery(instrument.name) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.panelAccent)
                    .frame(width: Self.imageryWidth, height: Self.imageryWidth)
            } else if columns.imagery {
                Color.clear.frame(width: Self.imageryWidth, height: 0)
            }
            widest(Text(instrument.resolution ?? "—").foregroundStyle(.secondary), of: columns.resolutions)
                .monospacedDigit()
                .lineLimit(1)
                .pressable(toggle)
            if columns.bands {
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
    let unfolded: Set<String>
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
            ForEach(instruments.filter { unfolded.contains($0.name) }, id: \.name) { instrument in
                InstrumentDetails(instrument: instrument, showsName: true)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.03), in: .rect(cornerRadius: 6))
            }
        }
    }

    /// An instrument's name in a capsule, lit while its facts are unfolded.
    private func chip(_ instrument: SatelliteDetails.Instrument) -> some View {
        let isOpen = unfolded.contains(instrument.name)
        return Button {
            onToggle(instrument.name)
        } label: {
            HStack(spacing: 6) {
                Text(instrument.name)
                if instrument.isRetired {
                    RetiredTag()
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
        .accessibilityHint(foldHint(isOpen))
    }
}

/// An instrument's mission is over, as a line and a chip say it.
private struct RetiredTag: View {
    var body: some View {
        // Amber: the app colour for "away from rest", as on the status chip.
        Text("Retired")
            .font(.caption)
            .foregroundStyle(Color.panelAmber)
    }
}

/// What a press on an instrument's line or chip does.
private func foldHint(_ isOpen: Bool) -> String {
    isOpen ? "Hides its facts" : "Shows its facts"
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
