import SatvisRender
import SwiftUI

/// The benchmark (`Benchmark`): every scene it runs, what each measured as it
/// ends, and a button to send the results. One layout from start to end, every
/// row and column there from the first, so nothing moves as results arrive.
/// Measures frames while it is open, as the performance overlay does, which it
/// stands in for.
struct BenchmarkPanel: View {
    let session: Session
    let renderer: GlobeRenderer

    private var benchmark: Benchmark { session.benchmark }

    /// The metric columns, wide enough for their widest figure ("43.7", "655").
    private static let columns: [(title: String, width: CGFloat)] = [("fps", 30), ("p95", 38), ("CPU", 36), ("GPU", 38), ("MB", 34)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ProgressView(value: progress)
            table
            footer
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

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Benchmark").font(.headline)
            Text(status)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button("Close", systemImage: "xmark") { session.setShowsBenchmark(false) }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
        }
    }

    private var status: String {
        let count = Benchmark.plan.count
        switch benchmark.phase {
        case .idle: return "\(count) scenes"
        case .cancelled: return "Cancelled"
        case .loading(let index): return "\(index + 1) of \(count) · Loading"
        case .settling(let index): return "\(index + 1) of \(count) · Settling"
        case .measuring(let index): return "\(index + 1) of \(count) · Measuring"
        // Rounded first, and plus zero, so a drift of −0.04 % reads +0.0 %, not −0.0 %.
        case .done: return benchmark.drift.map { String(format: "Done · drift %+.1f %%", ($0 * 10).rounded() / 10 + 0) } ?? "Done"
        }
    }

    private var progress: Double {
        switch benchmark.phase {
        case .idle, .cancelled: 0
        case .loading(let index), .settling(let index), .measuring(let index): Double(index) / Double(Benchmark.plan.count)
        case .done: 1
        }
    }

    private var current: Int? {
        switch benchmark.phase {
        case .loading(let index), .settling(let index), .measuring(let index): index
        default: nil
        }
    }

    /// Every scene of the plan, measured or not.
    private var table: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text("Scene").frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Self.columns, id: \.title) { column in
                    Text(column.title).frame(width: column.width, alignment: .trailing)
                }
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            ForEach(Array(Benchmark.plan.enumerated()), id: \.offset) { index, scene in
                row(scene, result: benchmark.results.indices.contains(index) ? benchmark.results[index] : nil, isCurrent: index == current)
            }
        }
    }

    private func row(_ scene: Benchmark.Scene, result: Benchmark.Result?, isCurrent: Bool) -> some View {
        let values: [String] =
            result.map {
                [
                    number($0.recording.framesPerSecond, digits: 0), number($0.recording.percentile(0.95), digits: 1),
                    number($0.recording.meanCPU, digits: 1), number($0.recording.meanGPU, digits: 1),
                    $0.memoryMegabytes.map(String.init) ?? "–",
                ]
            } ?? Array(repeating: isCurrent ? "…" : "–", count: Self.columns.count)
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                Text(scene.title)
                    .font(.caption.weight(isCurrent ? .semibold : .regular))
                    .foregroundStyle(isCurrent ? Color.accentColor : .primary)
                // The count once measured, where the subtitle stood before.
                Group {
                    if let result {
                        Text("^[\(result.satellites) satellite](inflect: true)\(result.timedOut ? ", still loading" : "")")
                    } else {
                        Text(scene.subtitle)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(zip(Self.columns, values)), id: \.0.title) { column, value in
                Text(value).frame(width: column.width, alignment: .trailing)
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(result == nil ? .secondary : .primary)
        }
    }

    /// The same height whatever the phase: one row of buttons, two lines of text.
    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                switch benchmark.phase {
                case .idle, .cancelled:
                    Button("Start") { benchmark.start(on: session) }
                        .buttonStyle(.glassProminent)
                case .loading, .settling, .measuring:
                    Button("Cancel", role: .cancel) { benchmark.cancel() }
                        .buttonStyle(.glass)
                case .done:
                    Button(benchmark.submitted ? "Sent" : "Send results") { benchmark.submit(with: session.analytics) }
                        .buttonStyle(.glassProminent)
                        .disabled(benchmark.submitted || !session.analytics.isSharing)
                    Button("Run again") { benchmark.start(on: session) }
                        .buttonStyle(.glass)
                }
            }
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
        }
    }

    private var caption: String {
        switch benchmark.phase {
        case .idle, .cancelled:
            "Measures each scene for \(Int(Benchmark.measure.components.seconds)) s once loaded. Times in ms, memory in MB."
        case .loading, .settling, .measuring:
            "Keep the app in front. Your view comes back at the end."
        case .done:
            session.analytics.isSharing
                ? "Sends the results with your device model, iOS version, screen and temperature state."
                : Analytics.isAvailable ? "Turn on Share usage data under Attribution to send the results." : "This build does not send usage data."
        }
    }

    private func number(_ value: Double?, digits: Int) -> String {
        value.map { String(format: "%.\(digits)f", $0) } ?? "–"
    }
}
