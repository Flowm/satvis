import SatvisCore
import SatvisRender
import SwiftUI

/// The sweep (ADR 0016): the first N of the whole catalog with a set of components,
/// past every budget, at a clock rate, then what the steps add up to. The web
/// app's BenchmarkSweep.
struct BenchmarkSweepTab: View {
    enum Mode: String, CaseIterable {
        case current, isolated, cumulative
    }

    let session: Session

    @State private var countsText = SweepPlan.satelliteCounts.map(jsNumberString).joined(separator: ", ")
    @State private var mode = Mode.current
    @State private var clocksText = "1"
    @State private var copied: String?

    private var benchmark: Benchmark { session.benchmark }
    private var sweep: SweepBenchmark { benchmark.sweep }
    private var run: SweepRun? { sweep.run }
    /// Below `fpsBad` a row is red, below `fpsWarn` yellow: a 60 Hz display measures 59.8.
    private static let fpsBad = 30.0
    private static let fpsWarn = 55.0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            settings
            if sweep.isRunning {
                Button("Cancel", role: .cancel) { benchmark.cancel() }
                    .buttonStyle(PanelButtonStyle())
            } else {
                let steps = SweepPlan.steps(benchmark.sweepSpec).count
                Button("Run ^[\(steps) step](inflect: true)") { benchmark.startSweep(benchmark.sweepSpec, on: session) }
                    .buttonStyle(PanelButtonStyle(emphasis: .filled))
                    .disabled(steps == 0 || benchmark.isRunning)
            }
            if let run {
                tables(run)
            }
            footer
        }
        .onChange(of: [countsText, clocksText, mode.rawValue], initial: true) { applyForm() }
        .onChange(of: session.catalog.components) { applyForm() }
    }

    // MARK: Settings

    private var settings: some View {
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
            GridRow {
                label("Counts")
                TextField("Counts", text: $countsText).signedNumberKeyboard().textFieldStyle(.roundedBorder)
            }
            GridRow {
                label("Components")
                Picker("Components", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            GridRow {
                label("Clock ×")
                TextField("Clock ×", text: $clocksText).signedNumberKeyboard().textFieldStyle(.roundedBorder)
            }
        }
        .font(.caption)
        .disabled(benchmark.isRunning)
    }

    private func label(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary).gridColumnAlignment(.leading)
    }

    private static func numbers(_ text: String) -> [Double] {
        text.split(whereSeparator: { " ,x×".contains($0) }).compactMap { Double($0) }
    }

    private func applyForm() {
        let sets: [[String]] =
            switch mode {
            case .isolated: SweepPlan.isolatedComponentSets
            case .cumulative: SweepPlan.cumulativeComponentSets
            case .current: [session.catalog.components.names]
            }
        benchmark.sweepSpec = SweepSpec(satelliteCounts: Self.numbers(countsText), componentSets: sets, clockMultipliers: Self.numbers(clocksText))
    }

    // MARK: Tables

    @ViewBuilder
    private func tables(_ run: SweepRun) -> some View {
        let rows = SweepReport.rows(run)
        let thin = SweepReport.thinRows(run).count
        // Above the tables: every derived table inherits a thin row's noise.
        if thin > 0 {
            Text(
                "\(thin) of \(rows.count) steps sampled under \(SweepReport.minimumTrustworthyFrames) frames: those rows, and everything derived from them, are noise. Keep the app in front."
            )
            .font(.caption2)
            .foregroundStyle(Color.panelAmber)
        }
        BenchmarkTable(caption: "Steps", items: rows, columns: stepColumns(rows)) {
            Int(BenchmarkFormat.double($0["frames"]) ?? 0) < SweepReport.minimumTrustworthyFrames
        }
        if run.results.count > 1 {
            let fits = SweepReport.scalingFits(run)
            if !fits.isEmpty {
                BenchmarkTable(
                    caption: "Scaling: CPU ms per 1,000 satellites; the floor is the GPU or the refresh", items: fits,
                    columns: [
                        .init("series", numeric: false) { $0.series }, .init("ms/1k") { BenchmarkFormat.number($0.cpuMsPer1000, 2) },
                        .init("base") { BenchmarkFormat.number($0.baseCpuMs, 2) },
                        .init("r²", tone: { $0.r2 < 0.9 ? .warn : nil }) { BenchmarkFormat.number($0.r2, 3) },
                        .init("floor") { BenchmarkFormat.number($0.floorMs, 2) }, .init("sats@60") { $0.satsAt60fps.map { $0.formatted() } ?? "–" },
                    ])
            }
            let memory = SweepReport.memoryFits(run)
            if !memory.isEmpty {
                // The footprint's fit: this app has no heap figure to fit.
                BenchmarkTable(
                    caption: "Memory per 1,000 satellites: the absolute footprint's growth", items: memory,
                    columns: [
                        .init("series", numeric: false) { $0.series },
                        .init("MB/1k") { BenchmarkFormat.number($0.absoluteKbPerSatellite.map { $0 * 1000 / 1024 }, 1) },
                        .init("KB/sat") { BenchmarkFormat.number($0.absoluteKbPerSatellite, 1) },
                        .init("r²", tone: { $0.absoluteR2 == nil ? nil : $0.absoluteTrustworthy ? .good : .bad }) {
                            BenchmarkFormat.number($0.absoluteR2, 3)
                        },
                    ])
            }
        }
        // An empty table would read as "propagation is free".
        let propagation = SweepReport.propagationCosts(run)
        if !propagation.isEmpty {
            BenchmarkTable(
                caption: "Propagation: against the same scene at ×1", items: propagation,
                columns: [
                    .init("sats") { $0.sats.formatted() }, .init("clock") { "×\(jsNumberString($0.clock))" },
                    .init("CPU ms") { BenchmarkFormat.number($0.cpuMs, 2) }, .init("Δ CPU") { BenchmarkFormat.number($0.deltaCpuMs, 2) },
                    .init("µs/sat") { BenchmarkFormat.number($0.usPerSatellite, 1) }, .init("Δ total %") { BenchmarkFormat.number($0.deltaCpuTotalPct, 1) },
                    .init("components", numeric: false) { $0.components },
                ])
        }
        let marginal = SweepReport.marginalCosts(run)
        if !marginal.isEmpty {
            BenchmarkTable(
                caption: "Marginal: what each component adds to CPU ms", items: marginal,
                columns: [
                    .init("sats") { $0.sats.formatted() }, .init("clock") { "×\(jsNumberString($0.clock))" }, .init("added", numeric: false) { $0.added },
                    .init("Δ CPU") { BenchmarkFormat.number($0.deltaCpuMs, 2) }, .init("µs/sat") { BenchmarkFormat.number($0.usPerSatellite, 1) },
                    .init("over", numeric: false) { $0.over },
                ])
        }
        let drift = SweepReport.repeatChecks(run)
        if !drift.isEmpty {
            BenchmarkTable(
                caption: "Drift: the first step again at the end", items: drift,
                columns: [
                    .init("sats") { $0.sats.formatted() }, .init("CPU 1st") { BenchmarkFormat.number($0.firstCpuMs, 2) },
                    .init("again") { BenchmarkFormat.number($0.repeatCpuMs, 2) },
                    .init("drift", tone: { $0.drifted ? .bad : .good }) { BenchmarkFormat.signedPercent($0.cpuDriftPct) },
                    .init("build 1st") { BenchmarkFormat.number($0.firstBuildMs, 0) }, .init("again") { BenchmarkFormat.number($0.repeatBuildMs, 0) },
                    .init("drift") { BenchmarkFormat.signedPercent($0.buildDriftPct) },
                ])
        }
    }

    /// The performance panel's figures, in its order.
    private func stepColumns(_ rows: [ReportRecord]) -> [BenchmarkTable<ReportRecord>.Column] {
        let clockSwept = rows.contains { $0["clock"] != .number(1) }
        let gpuShown = rows.contains { if case .number = $0["gpuMs"] { true } else { false } }
        return [.init("sats") { BenchmarkFormat.number($0["sats"], 0) }, .init("drawn") { BenchmarkFormat.number($0["visible"], 0) }]
            + (clockSwept ? [.init("clock") { "×\(BenchmarkFormat.string($0["clock"]))" }] : [])
            + [
                .init("fps", tone: Self.fpsTone) { BenchmarkFormat.number(BenchmarkFormat.double($0["fps"]) ?? 0, 1) },
                .init("CPU") { BenchmarkFormat.number($0["cpuMs"], 2) },
            ]
            + (gpuShown ? [.init("GPU") { BenchmarkFormat.number($0["gpuMs"], 2) }] : [])
            + [
                .init("load %") { BenchmarkFormat.load(BenchmarkFormat.double($0["loadPct"]), cpuBusy: BenchmarkFormat.double($0["cpuBusyPct"])) },
                .init("MB") { BenchmarkFormat.number($0["footprintMb"], 0) }, .init("p95 CPU") { BenchmarkFormat.number($0["cpuP95Ms"], 2) },
            ]
            + (gpuShown ? [.init("p95 GPU") { BenchmarkFormat.number($0["gpuP95Ms"], 2) }] : [])
            + [
                .init("over %") { BenchmarkFormat.number($0["overBudgetPct"], 0) }, .init("total CPU %") { BenchmarkFormat.number($0["cpuTotalPct"], 0) },
                .init("build") { BenchmarkFormat.number($0["buildMs"], 0) },
                .init("components", numeric: false) { row in
                    let drawn = BenchmarkFormat.string(row["drawn"])
                    return BenchmarkFormat.string(row["components"]) + (row["repeat"] == .bool(true) ? " (repeat)" : "")
                        + (drawn.isEmpty ? "" : " → drew \(drawn)")
                },
            ]
    }

    private static func fpsTone(_ row: ReportRecord) -> BenchmarkTable<ReportRecord>.Tone? {
        let fps = BenchmarkFormat.double(row["fps"]) ?? 0
        return fps < fpsBad ? .bad : fps < fpsWarn ? .warn : nil
    }

    // MARK: Exports

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Button("Log") {
                    if let run {
                        print(SweepReport.table(run))
                        copied = "Printed the table to the app's output."
                    }
                }
                Button("Copy CSV") { copy(run.map(SweepReport.csv), "CSV") }
                Button("Copy JSON") { copy(run.map(SweepReport.json), "JSON") }
                Button("Copy table") { copy(run.map(SweepReport.table), "table") }
            }
            .buttonStyle(PanelButtonStyle())
            .font(.caption)
            .disabled(run == nil)
            if let copied {
                Text(copied).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .clears($copied, after: .seconds(2))
    }

    private func copy(_ text: String?, _ what: String) {
        guard let text else {
            return
        }
        Platform.copy(text)
        copied = "Copied the \(what)."
    }
}
