import SatvisCore
import SatvisRender
import SwiftUI

/// A numeric table under its caption, scrolling sideways where the panel is
/// narrower than its columns: the web app's BenchmarkTable.
struct BenchmarkTable: View {
    struct Column: Identifiable {
        var key: String
        var label: String
        var numeric = true
        var id: String { key }
    }

    struct Row: Identifiable {
        enum Tone {
            case good, warn, bad
        }

        var id: Int
        var cells: [String: String]
        /// A cell's colour, by its column's key.
        var tones: [String: Tone] = [:]
        /// Noise, kept to show it: struck through rather than dropped.
        var struck = false
    }

    let caption: String
    let columns: [Column]
    let rows: [Row]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(caption)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal) {
                Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 2) {
                    GridRow {
                        ForEach(columns) { column in
                            Text(column.label)
                                .gridColumnAlignment(column.numeric ? .trailing : .leading)
                        }
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    ForEach(rows) { row in
                        GridRow {
                            ForEach(columns) { column in
                                Text(row.cells[column.key] ?? "")
                                    .foregroundStyle(Self.colour(row.tones[column.key], struck: row.struck))
                                    .strikethrough(row.struck)
                            }
                        }
                        .font(.caption.monospacedDigit())
                    }
                }
                .fixedSize()
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }

    private static func colour(_ tone: Row.Tone?, struck: Bool) -> Color {
        if struck {
            return .secondary
        }
        return switch tone {
        case .good: .panelGreen
        case .warn: .panelAmber
        case .bad: .red
        case nil: .primary
        }
    }
}

/// The figures of a report row as the tables show them: blanks as a dash.
enum BenchmarkFormat {
    /// To `digits` places.
    static func number(_ value: Double?, _ digits: Int) -> String {
        value.map { Formats.fixed($0, digits) } ?? "–"
    }

    /// A report cell to `digits` places; a dash for anything but a number.
    static func number(_ value: ReportValue?, _ digits: Int) -> String {
        Self.number(double(value), digits)
    }

    /// A report cell's number.
    static func double(_ value: ReportValue?) -> Double? {
        if case .number(let number) = value {
            return number
        }
        return nil
    }

    /// Load in whole percent, or at least the CPU's share where the GPU's is unknown,
    /// as in the simulator; `unit` follows a figure, not the dash.
    static func load(_ load: Double?, cpuBusy: Double?, unit: String = "") -> String {
        if let load {
            return "\(Formats.fixed(load, 0))\(unit)"
        }
        return cpuBusy.map { "≥ \(Formats.fixed($0, 0))\(unit)" } ?? "–"
    }

    /// Text as it is, a number to 2 places unless whole; blank otherwise.
    static func string(_ value: ReportValue?) -> String {
        switch value {
        case .string(let text): text
        case .number(let figure): number(figure, figure == figure.rounded() ? 0 : 2)
        default: ""
        }
    }

    /// A change in percent, with its sign.
    static func signedPercent(_ value: Double) -> String {
        "\(value > 0 ? "+" : "")\(Formats.fixed(value, 1)) %"
    }
}

extension View {
    /// Sets `message` back to nil `delay` after each time it is set, as the tabs'
    /// "Copied" captions.
    func clears(_ message: Binding<String?>, after delay: Duration) -> some View {
        task(id: message.wrappedValue) {
            if message.wrappedValue != nil {
                try? await Task.sleep(for: delay)
                message.wrappedValue = nil
            }
        }
    }
}
