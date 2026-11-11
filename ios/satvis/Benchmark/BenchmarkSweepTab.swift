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

    @State private var countsText = SweepPlan.satelliteCounts.map(jsNumber).joined(separator: ", ")
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
        BenchmarkTable(caption: "Steps", columns: stepColumns(rows), rows: stepRows(rows))
        if run.results.count > 1 {
            let fits = SweepReport.scalingFits(run)
            if !fits.isEmpty {
                BenchmarkTable(
                    caption: "Scaling: CPU ms per 1,000 satellites; the floor is the GPU or the refresh",
                    columns: [
                        .init(key: "series", label: "series", numeric: false), .init(key: "slope", label: "ms/1k"), .init(key: "base", label: "base"),
                        .init(key: "r2", label: "r²"), .init(key: "floor", label: "floor"), .init(key: "at60", label: "sats@60"),
                    ],
                    rows: fits.enumerated().map { index, fit in
                        .init(
                            id: index,
                            cells: [
                                "series": fit.series, "slope": BenchmarkFormat.number(fit.cpuMsPer1000, 2), "base": BenchmarkFormat.number(fit.baseCpuMs, 2),
                                "r2": BenchmarkFormat.number(fit.r2, 3), "floor": BenchmarkFormat.number(fit.floorMs, 2),
                                "at60": fit.satsAt60fps.map { $0.formatted() } ?? "–",
                            ], tones: fit.r2 < 0.9 ? ["r2": .warn] : [:])
                    })
            }
            let memory = SweepReport.memoryFits(run)
            if !memory.isEmpty {
                BenchmarkTable(
                    caption: "Memory per 1,000 satellites: the absolute footprint's growth",
                    columns: [
                        .init(key: "series", label: "series", numeric: false), .init(key: "mb", label: "MB/1k"), .init(key: "kb", label: "KB/sat"),
                        .init(key: "r2", label: "r²"),
                    ],
                    rows: memory.enumerated().map { index, fit in
                        .init(
                            id: index,
                            cells: [
                                // The footprint's fit: this app has no heap figure to fit.
                                "series": fit.series, "mb": BenchmarkFormat.number(fit.absoluteKbPerSatellite.map { $0 * 1000 / 1024 }, 1),
                                "kb": BenchmarkFormat.number(fit.absoluteKbPerSatellite, 1), "r2": BenchmarkFormat.number(fit.absoluteR2, 3),
                            ], tones: fit.absoluteR2 == nil ? [:] : ["r2": fit.absoluteTrustworthy ? .good : .bad])
                    })
            }
        }
        // An empty table would read as "propagation is free".
        let propagation = SweepReport.propagationCosts(run)
        if !propagation.isEmpty {
            BenchmarkTable(
                caption: "Propagation: against the same scene at ×1",
                columns: [
                    .init(key: "sats", label: "sats"), .init(key: "clock", label: "clock"), .init(key: "main", label: "CPU ms"), .init(key: "delta", label: "Δ CPU"),
                    .init(key: "perSat", label: "µs/sat"), .init(key: "total", label: "Δ total %"), .init(key: "components", label: "components", numeric: false),
                ],
                rows: propagation.enumerated().map { index, cost in
                    .init(
                        id: index,
                        cells: [
                            "sats": cost.sats.formatted(), "clock": "×\(jsNumber(cost.clock))", "main": BenchmarkFormat.number(cost.cpuMs, 2),
                            "delta": BenchmarkFormat.number(cost.deltaCpuMs, 2), "perSat": BenchmarkFormat.number(cost.usPerSatellite, 1),
                            "total": BenchmarkFormat.number(cost.deltaCpuTotalPct, 1), "components": cost.components,
                        ])
                })
        }
        let marginal = SweepReport.marginalCosts(run)
        if !marginal.isEmpty {
            BenchmarkTable(
                caption: "Marginal: what each component adds to CPU ms",
                columns: [
                    .init(key: "sats", label: "sats"), .init(key: "clock", label: "clock"), .init(key: "added", label: "added", numeric: false),
                    .init(key: "delta", label: "Δ CPU"), .init(key: "perSat", label: "µs/sat"), .init(key: "over", label: "over", numeric: false),
                ],
                rows: marginal.enumerated().map { index, cost in
                    .init(
                        id: index,
                        cells: [
                            "sats": cost.sats.formatted(), "clock": "×\(jsNumber(cost.clock))", "added": cost.added,
                            "delta": BenchmarkFormat.number(cost.deltaCpuMs, 2), "perSat": BenchmarkFormat.number(cost.usPerSatellite, 1), "over": cost.over,
                        ])
                })
        }
        let drift = SweepReport.repeatChecks(run)
        if !drift.isEmpty {
            BenchmarkTable(
                caption: "Drift: the first step again at the end",
                columns: [
                    .init(key: "sats", label: "sats"), .init(key: "first", label: "CPU 1st"), .init(key: "again", label: "again"), .init(key: "drift", label: "drift"),
                    .init(key: "buildFirst", label: "build 1st"), .init(key: "buildAgain", label: "again"), .init(key: "buildDrift", label: "drift"),
                ],
                rows: drift.enumerated().map { index, check in
                    .init(
                        id: index,
                        cells: [
                            "sats": check.sats.formatted(), "first": BenchmarkFormat.number(check.firstCpuMs, 2), "again": BenchmarkFormat.number(check.repeatCpuMs, 2),
                            "drift": BenchmarkFormat.signedPercent(check.cpuDriftPct), "buildFirst": BenchmarkFormat.number(check.firstBuildMs, 0),
                            "buildAgain": BenchmarkFormat.number(check.repeatBuildMs, 0), "buildDrift": BenchmarkFormat.signedPercent(check.buildDriftPct),
                        ], tones: ["drift": check.drifted ? .bad : .good])
                })
        }
    }

    /// The performance panel's figures, in its order.
    private func stepColumns(_ rows: [ReportRecord]) -> [BenchmarkTable.Column] {
        let clockSwept = rows.contains { $0["clock"] != .number(1) }
        let gpuShown = rows.contains { if case .number = $0["gpuMs"] { true } else { false } }
        return [.init(key: "sats", label: "sats"), .init(key: "visible", label: "drawn")]
            + (clockSwept ? [.init(key: "clock", label: "clock")] : [])
            + [.init(key: "fps", label: "fps"), .init(key: "cpu", label: "CPU")]
            + (gpuShown ? [.init(key: "gpu", label: "GPU")] : [])
            + [.init(key: "load", label: "load %"), .init(key: "mb", label: "MB"), .init(key: "cpuP95", label: "p95 CPU")]
            + (gpuShown ? [.init(key: "gpuP95", label: "p95 GPU")] : [])
            + [
                .init(key: "over", label: "over %"), .init(key: "total", label: "total CPU %"), .init(key: "build", label: "build"),
                .init(key: "components", label: "components", numeric: false),
            ]
    }

    private func stepRows(_ rows: [ReportRecord]) -> [BenchmarkTable.Row] {
        rows.enumerated().map { index, row in
            let fps = if case .number(let value) = row["fps"] { value } else { 0.0 }
            let frames = if case .number(let value) = row["frames"] { Int(value) } else { 0 }
            let drawn = BenchmarkFormat.string(row["drawn"])
            let repeated = row["repeat"] == .bool(true)
            let load = BenchmarkFormat.load(BenchmarkFormat.double(row["loadPct"]), cpuBusy: BenchmarkFormat.double(row["cpuBusyPct"]))
            return .init(
                id: index,
                cells: [
                    "sats": BenchmarkFormat.number(row["sats"], 0), "visible": BenchmarkFormat.number(row["visible"], 0), "clock": "×\(BenchmarkFormat.string(row["clock"]))",
                    "fps": BenchmarkFormat.number(fps, 1), "cpu": BenchmarkFormat.number(row["cpuMs"], 2), "gpu": BenchmarkFormat.number(row["gpuMs"], 2), "load": load,
                    "mb": BenchmarkFormat.number(row["footprintMb"], 0), "cpuP95": BenchmarkFormat.number(row["cpuP95Ms"], 2),
                    "gpuP95": BenchmarkFormat.number(row["gpuP95Ms"], 2), "over": BenchmarkFormat.number(row["overBudgetPct"], 0),
                    "total": BenchmarkFormat.number(row["cpuTotalPct"], 0), "build": BenchmarkFormat.number(row["buildMs"], 0),
                    "components": BenchmarkFormat.string(row["components"]) + (repeated ? " (repeat)" : "") + (drawn.isEmpty ? "" : " → drew \(drawn)"),
                ], tones: fps < Self.fpsBad ? ["fps": .bad] : fps < Self.fpsWarn ? ["fps": .warn] : [:], struck: frames < SweepReport.minimumTrustworthyFrames)
        }
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
