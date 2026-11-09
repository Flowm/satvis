import SatvisCore
import SatvisRender
import SwiftUI

/// The route's benchmark scenes (ADR 0016): each a row from the start, ticked to
/// run, filled as it is measured, and opened in place for the rest of its figures.
/// The web app's BenchmarkScenes.
struct BenchmarkScenesTab: View {
    let session: Session

    /// One row open at a time.
    @State private var expanded: String?
    @State private var copied: String?

    private var benchmark: Benchmark { session.benchmark }

    /// The metric columns, wide enough for their widest figure ("43.7", "655").
    /// Load, not a frame time, beside the frame rate: a paced scene's frame rate
    /// is low by design, and only its load says what it costs.
    private static let columns: [(title: String, width: CGFloat)] = [("fps", 34), ("CPU", 32), ("GPU", 32), ("Load", 40), ("MB", 34)]

    /// The route's, or where an index without them has replaced the one a run
    /// took them from, the run's.
    private var served: [BenchmarkScene] {
        let route = Benchmark.served(on: session)
        return route.isEmpty ? benchmark.scenes : route
    }
    private var selected: [String] { benchmark.selection ?? served.map(\.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            table
            Text("Each scene is loaded, settled for 3 s and measured for 5 s. Times in ms a frame, load in % busy, memory in MB.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            footer
        }
    }

    private var table: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Toggle(
                    "All scenes",
                    isOn: Binding {
                        !served.isEmpty && selected.count == served.count
                    } set: {
                        benchmark.selection = $0 ? nil : []
                    }
                )
                .toggleStyle(CheckboxStyle(identifier: "All scenes", mixed: !selected.isEmpty && selected.count < served.count))
                .disabled(benchmark.isRunning || served.isEmpty)
                Text("Scene").frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Self.columns, id: \.title) { column in
                    Text(column.title).frame(width: column.width, alignment: .trailing)
                }
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            ForEach(rows, id: \.id) { row in
                sceneRow(row)
                if let result = row.result, expanded == row.id {
                    details(result)
                }
            }
        }
    }

    private struct SceneRow {
        var id: String
        var name: String
        var isRepeat: Bool
        var result: BenchmarkResult?
        var phase: String?
    }

    private var rows: [SceneRow] {
        let results = Dictionary(benchmark.results.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let current = benchmark.phase.scene.flatMap { benchmark.steps.indices.contains($0) ? benchmark.steps[$0].id : nil }
        let phase: String? =
            switch benchmark.phase {
            case .loading: "Loading…"
            case .settling: "Settling…"
            case .measuring: "Measuring…"
            default: nil
            }
        var listed = served.map { SceneRow(id: $0.id, name: $0.name, isRepeat: false) }
        if let step = benchmark.steps.first(where: \.repeat) {
            listed.append(SceneRow(id: step.id, name: "\(step.scene.name) (repeat)", isRepeat: true))
        }
        return listed.map { row in
            var row = row
            row.result = results[row.id]
            row.phase = row.id == current ? phase : nil
            return row
        }
    }

    private func sceneRow(_ row: SceneRow) -> some View {
        let values: [String] =
            row.result.map {
                let summary = $0.summary
                return [
                    BenchmarkFormat.number(summary.framesPerSecond, 1), BenchmarkFormat.number(summary.cpu, 1), BenchmarkFormat.number(summary.gpu, 1),
                    load(summary), $0.memoryMegabytes.map(String.init) ?? "–",
                ]
            } ?? Array(repeating: "–", count: Self.columns.count)
        let subtitle =
            row.phase
            ?? [row.result.map { "\($0.satellites.formatted()) satellites" }, row.result?.timedOut == true ? "timed out" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        return HStack(spacing: 6) {
            if row.isRepeat {
                Color.clear.frame(width: CheckboxStyle.side)
            } else {
                Toggle(
                    row.name,
                    isOn: Binding {
                        selected.contains(row.id)
                    } set: { on in
                        let next = on ? selected + [row.id] : selected.filter { $0 != row.id }
                        // In the served order, which a run takes them in.
                        benchmark.selection = served.map(\.id).filter(next.contains)
                    }
                )
                .toggleStyle(CheckboxStyle(identifier: row.id))
                .disabled(benchmark.isRunning)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(row.name)
                    .font(.caption.weight(row.phase == nil ? .regular : .semibold))
                    .foregroundStyle(row.phase == nil ? Color.primary : .panelAccent)
                Text(subtitle.isEmpty ? " " : subtitle)
                    .font(.caption2)
                    .foregroundStyle(row.result?.timedOut == true ? Color.panelAmber : .secondary)
            }
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(zip(Self.columns, values)), id: \.0.title) { column, value in
                Text(value).frame(width: column.width, alignment: .trailing)
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(row.result == nil ? .secondary : .primary)
        }
        .padding(.vertical, 2)
        .background(row.phase != nil ? Color.panelAccent.opacity(0.12) : expanded == row.id ? Color.panelSelected : .clear, in: .rect(cornerRadius: 6))
        .contentShape(.rect)
        .onTapGesture {
            if row.result != nil {
                expanded = expanded == row.id ? nil : row.id
            }
        }
    }

    /// Everything the row does not show, the app's own figures last.
    private func details(_ result: BenchmarkResult) -> some View {
        let summary = result.summary
        let percent = { (value: Double?) in value.map { "\(Formats.fixed($0, 0)) %" } ?? "–" }
        var items: [(String, String)] = [
            ("p95 CPU", "\(BenchmarkFormat.number(summary.cpuP95, 1)) ms"), ("p95 GPU", "\(BenchmarkFormat.number(summary.gpuP95, 1)) ms"),
            ("over budget", percent(summary.overBudget)), ("total CPU", percent(summary.cpuTotal)),
            ("frames", "\(summary.frames)"), ("load time", "\(BenchmarkFormat.number(result.loadSeconds, 1)) s"),
        ]
        for (key, value) in result.metrics.sorted(by: { $0.key < $1.key }) where key.hasPrefix("x_") {
            items.append((key, (value as? NSNumber).map { BenchmarkFormat.number($0.doubleValue, 2) } ?? "–"))
        }
        let pairs = stride(from: 0, to: items.count, by: 2).map { Array(items[$0..<min($0 + 2, items.count)]) }
        return Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 1) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                GridRow {
                    ForEach(pair, id: \.0) { label, value in
                        Text(label).foregroundStyle(.secondary)
                        Text(value).monospacedDigit().gridColumnAlignment(.trailing)
                    }
                }
            }
        }
        .font(.caption2)
        .padding(.leading, CheckboxStyle.side + 6)
        .padding(.bottom, 4)
        .accessibilityIdentifier("Scene details")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if benchmark.phase.scene != nil {
                    Button("Cancel", role: .cancel) { benchmark.cancel() }
                        .buttonStyle(PanelButtonStyle())
                } else {
                    Button("Run ^[\(Benchmark.plan(served, selection: benchmark.selection).count) scene](inflect: true)") {
                        let selection = benchmark.selection
                        benchmark.start(on: session, only: selection == nil || selection?.count == served.count ? [] : selection ?? [])
                    }
                    .buttonStyle(PanelButtonStyle(emphasis: .filled))
                    .disabled(Benchmark.plan(served, selection: benchmark.selection).isEmpty || benchmark.isRunning)
                }
                Button("Copy report") {
                    if let json = try? JSONSerialization.data(withJSONObject: benchmark.report, options: [.prettyPrinted, .sortedKeys]) {
                        Platform.copy(String(decoding: json, as: UTF8.self))
                        copied = "Copied the report."
                    }
                }
                .buttonStyle(PanelButtonStyle())
                .disabled(benchmark.isRunning || benchmark.results.isEmpty)
                // Sent only on a tap, never by a run a link started.
                Button(benchmark.submitted ? "Sent" : "Send results") { benchmark.submit(with: session.analytics) }
                    .buttonStyle(PanelButtonStyle())
                    .disabled(benchmark.phase != .done || benchmark.submitted || !session.analytics.isSharing)
            }
            .font(.subheadline)
            .lineLimit(1)
            Text(copied ?? caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
        }
        .clears($copied, after: .seconds(2))
    }

    private var caption: String {
        if benchmark.submitted {
            return "Sent, with the device and build they depend on."
        }
        if !session.analytics.isSharing {
            return Analytics.isAvailable ? "Turn on Share usage data under About to send results." : "This build does not send usage data."
        }
        if benchmark.phase == .cancelled, !benchmark.results.isEmpty {
            return "A cancelled run is kept to read, not sent."
        }
        return benchmark.phase == .done ? "Sends the results with the device and build they depend on." : "Run the scenes to send their results."
    }

    /// The busier side's share.
    private func load(_ summary: FrameSummary) -> String {
        BenchmarkFormat.load(summary.load, cpuBusy: summary.cpuBusy, unit: " %")
    }
}

/// A square checkbox, as the web app's; `mixed` for some of a list ticked.
struct CheckboxStyle: ToggleStyle {
    static let side: CGFloat = 20
    /// For UI tests, as "checkbox <identifier>".
    var identifier: String
    var mixed = false

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            Image(systemName: mixed ? "minus.square.fill" : configuration.isOn ? "checkmark.square.fill" : "square")
                .foregroundStyle(configuration.isOn || mixed ? Color.panelAccent : .secondary)
                .frame(width: Self.side, height: Self.side)
        }
        .buttonStyle(.plain)
        .accessibilityLabel { _ in configuration.label }
        .accessibilityValue(configuration.isOn ? "1" : "0")
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("checkbox \(identifier)")
    }
}
