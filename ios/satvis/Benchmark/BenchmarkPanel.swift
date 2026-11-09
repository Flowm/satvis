import SatvisCore
import SatvisRender
import SwiftUI

/// The benchmark panel (ADR 0016): the route's scenes and the sweep, with the same
/// options and wording as the web app's (src/components/benchmark/). A header with
/// the status line, a progress bar, and tabs locked while a run is going.
struct BenchmarkPanel: View {
    enum Tab: String, CaseIterable {
        case scenes = "Scenes"
        case sweep = "Sweep"
    }

    let session: Session

    @State private var tab = Tab.scenes
    /// How tall the body is laid out, for its scroll view to take no more; nil until measured.
    @State private var bodyHeight: CGFloat?

    private var benchmark: Benchmark { session.benchmark }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Once a second, for the time left.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let (status, progress) = benchmark.status(tab: tab, on: session, at: context.date)
                VStack(alignment: .leading, spacing: 8) {
                    header(status)
                    ProgressView(value: progress ?? 0)
                        .opacity(progress == nil ? 0 : 1)
                }
            }
            Picker("Benchmark", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .disabled(benchmark.isRunning)
            // Scrolls where the screen is shorter than the tab, as an iPhone Duo
            // open or a phone lying down is.
            ScrollView {
                switch tab {
                case .scenes: BenchmarkScenesTab(session: session)
                case .sweep: BenchmarkSweepTab(session: session)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.contentSize.height
            } action: { _, height in
                bodyHeight = height
            }
            .frame(maxHeight: bodyHeight)
        }
        .padding(14)
        .frame(maxWidth: 440)
        .panel()
        // A run, from a launch too, shows on its own tab.
        .onChange(of: benchmark.sweep.isRunning, initial: true) { _, sweeping in
            if sweeping {
                tab = .sweep
            }
        }
        .onChange(of: benchmark.phase.scene != nil, initial: true) { _, running in
            if running {
                tab = .scenes
            }
        }
    }

    private func header(_ status: BenchmarkStatus) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Benchmark").font(.headline)
                Text(status.line)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("Benchmark status")
            }
            Spacer(minLength: 0)
            Button("Close", systemImage: "xmark") { session.setShowsBenchmark(false) }
                .labelStyle(.iconOnly)
                .buttonStyle(PanelButtonStyle())
        }
    }
}

extension Benchmark {
    /// The status line's state, as the web app's panel works it out
    /// (src/components/benchmark/benchmarkPanel.ts): the run going, or this tab's
    /// last run, or what a run would take; and how far the bar goes, nil before a run.
    func status(tab: BenchmarkPanel.Tab, on session: Session, at now: Date) -> (BenchmarkStatus, progress: Double?) {
        let sweepStepMs = SweepPlan.estimatedMilliseconds(1, perStep: SweepPlan.warmupMilliseconds + SweepPlan.sampleMilliseconds)
        func running(_ kind: BenchmarkStatus.Kind, _ phase: Phase, total: Int, stepMs: Double, started: Date?) -> (BenchmarkStatus, progress: Double?) {
            let index = phase.scene ?? 0
            let elapsed = started.map { now.timeIntervalSince($0) * 1000 } ?? 0
            let name: BenchmarkStatus.Phase =
                switch phase {
                case .settling: .settling
                case .measuring: .measuring
                default: .loading
                }
            let status = BenchmarkStatus(phase: name, kind: kind, index: index, total: total, remainingMs: max(0, Double(total - index) * stepMs - elapsed))
            return (status, (Double(index) + min(0.95, elapsed / stepMs)) / Double(max(total, 1)))
        }
        if sweep.isRunning {
            return running(.sweep, sweep.phase, total: sweep.steps.count, stepMs: sweepStepMs, started: sweep.stepStarted)
        }
        if phase.scene != nil {
            return running(.scenes, phase, total: steps.count, stepMs: BenchmarkStatus.sceneStepEstimateMs, started: stepStarted)
        }
        switch tab {
        case .scenes:
            switch phase {
            case .done: return BenchmarkStatus(phase: .done, kind: .scenes, total: steps.count, remainingMs: 0, driftPct: drift).ended
            case .cancelled: return BenchmarkStatus(phase: .cancelled, kind: .scenes, total: steps.count, remainingMs: 0, measured: results.count).ended
            default:
                let total = plannedScenes(on: session).count
                return (BenchmarkStatus(phase: .idle, kind: .scenes, total: total, remainingMs: Double(total) * BenchmarkStatus.sceneStepEstimateMs), nil)
            }
        case .sweep:
            let run = sweep.run
            switch sweep.phase {
            case .done:
                let check = run.flatMap { SweepReport.repeatChecks($0).first }
                let drift = BenchmarkStatus.shownDrift(first: check?.firstCpuMs, repeated: check?.repeatCpuMs)
                return BenchmarkStatus(phase: .done, kind: .sweep, total: sweep.steps.count, remainingMs: 0, driftPct: drift).ended
            case .cancelled:
                return BenchmarkStatus(phase: .cancelled, kind: .sweep, total: sweep.steps.count, remainingMs: 0, measured: run?.results.count ?? 0).ended
            default:
                let total = SweepPlan.steps(sweepSpec).count
                return (BenchmarkStatus(phase: .idle, kind: .sweep, total: total, remainingMs: Double(total) * sweepStepMs), nil)
            }
        }
    }

    /// The scenes a run takes from the panel: all, with the drift repeat, or the
    /// ones ticked, without.
    func plannedScenes(on session: Session) -> [BenchmarkStep] {
        if isRunning || phase == .done {
            return steps
        }
        return Self.plan(Self.served(on: session), selection: selection)
    }

    static func plan(_ scenes: [BenchmarkScene], selection: [String]?) -> [BenchmarkStep] {
        guard let selection else {
            return BenchmarkScene.plan(scenes)
        }
        // `plan` reads no ids as every scene.
        if selection.isEmpty {
            return []
        }
        return selection.count == scenes.count ? BenchmarkScene.plan(scenes) : BenchmarkScene.plan(scenes, only: selection)
    }
}

extension BenchmarkStatus {
    /// A run's end, with its bar: whole, or as far as it got.
    fileprivate var ended: (BenchmarkStatus, progress: Double?) {
        (self, phase == .done ? 1 : Double(measured ?? 0) / Double(max(total, 1)))
    }
}
