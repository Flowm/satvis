import SatvisRender
import SwiftUI

/// The benchmark (`Benchmark`): what it will do, how far it has got, and what it
/// measured, with a button to send that. Measures frames while it is open, as
/// the performance overlay does, which it stands in for.
struct BenchmarkPanel: View {
    let session: Session
    let renderer: GlobeRenderer

    private var benchmark: Benchmark { session.benchmark }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Benchmark").font(.headline)
                Spacer()
                Button("Close", systemImage: "xmark") { session.setShowsBenchmark(false) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
            }
            switch benchmark.phase {
            case .idle, .cancelled:
                introduction
            case .loading(let index), .settling(let index), .measuring(let index):
                progress(index)
                if !benchmark.results.isEmpty {
                    table
                }
            case .done:
                table
                actions
            }
        }
        .padding(14)
        .frame(maxWidth: 440)
        .background {
            // No glass while measuring: blurring the globe behind it costs the
            // GPU about 2 ms a frame on an iPad mini, which the scenes would carry.
            if benchmark.isRunning {
                RoundedRectangle(cornerRadius: 20).fill(.black.opacity(0.75))
            }
        }
        .glassEffect(benchmark.isRunning ? .identity : .regular, in: .rect(cornerRadius: 20))
        .onAppear { renderer.measuresFrames = true }
        .onDisappear { renderer.measuresFrames = session.showsPerformance }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(
                "Opens \(Benchmark.scenes.count) scenes in turn and measures each for \(Int(Benchmark.measure.components.seconds)) s once it has loaded, then the first again. Keep the app in front; your view comes back at the end."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            ForEach(Benchmark.scenes) { scene in
                VStack(alignment: .leading, spacing: 0) {
                    Text(scene.title).font(.caption)
                    Text(scene.detail).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if benchmark.phase == .cancelled {
                Text("Cancelled.").font(.caption)
            }
            Button("Start") { benchmark.start(on: session) }
                .buttonStyle(.glassProminent)
        }
    }

    private func progress(_ index: Int) -> some View {
        let plan = Benchmark.plan
        let step: String =
            switch benchmark.phase {
            case .loading: "Loading"
            case .settling: "Settling"
            default: "Measuring"
            }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(index + 1) of \(plan.count) · \(plan[index].title)\(index == plan.count - 1 ? ", again" : "")")
                    .font(.subheadline)
                Spacer()
                Button("Cancel", role: .cancel) { benchmark.cancel() }
                    .buttonStyle(.glass)
            }
            Text("\(step): \(plan[index].detail)").font(.caption).foregroundStyle(.secondary)
            ProgressView(value: Double(index), total: Double(plan.count))
        }
    }

    /// Every scene measured so far, with what it drew.
    private var table: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView {
                Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 6) {
                    GridRow {
                        Text("Scene").gridColumnAlignment(.leading)
                        Text("fps")
                        Text("p95")
                        Text("CPU")
                        Text("GPU")
                        Text("MB")
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    ForEach(benchmark.results) { result in
                        GridRow {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(result.title).lineLimit(1)
                                Text("^[\(result.satellites) satellite](inflect: true)\(result.timedOut ? ", still loading" : "")")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .gridColumnAlignment(.leading)
                            Text(number(result.recording.framesPerSecond, digits: 0))
                            Text(number(result.recording.percentile(0.95), digits: 1))
                            Text(number(result.recording.meanCPU, digits: 1))
                            Text(number(result.recording.meanGPU, digits: 1))
                            Text(result.memoryMegabytes.map(String.init) ?? "–")
                        }
                        .font(.caption.monospacedDigit())
                    }
                }
            }
            .frame(maxHeight: 260)
            .scrollBounceBehavior(.basedOnSize)
            Text("Frame times and per-frame CPU and GPU work in milliseconds; memory as iOS counts it against the app.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let drift = benchmark.drift {
                Text(String(format: "Frame rate on the repeat: %+.1f %%", drift))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button(benchmark.submitted ? "Sent" : "Send results") { benchmark.submit(with: session.analytics) }
                    .buttonStyle(.glassProminent)
                    .disabled(benchmark.submitted || !session.analytics.isSharing)
                Button("Run again") { benchmark.start(on: session) }
                    .buttonStyle(.glass)
            }
            // Sent with the usage data, and only where that is counted.
            Text(
                session.analytics.isSharing
                    ? "Sends these results with your device model, iOS version, app build, screen size and temperature state to satvis's usage data."
                    : Analytics.isAvailable
                        ? "Turn on Share usage data in Settings to send these results." : "This build does not send usage data."
            )
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private func number(_ value: Double?, digits: Int) -> String {
        value.map { String(format: "%.\(digits)f", $0) } ?? "–"
    }
}
