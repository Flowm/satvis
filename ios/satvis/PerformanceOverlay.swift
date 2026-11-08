import Darwin
import SatvisCore
import SatvisRender
import SwiftUI

/// The web app's performance panel (`fps`, ADR 0016); a tap opens the last five
/// seconds frame by frame (`fps=graph`). Measured only while shown, it never changes
/// how frames are paced, and reads each frame's work against the frame budget, as
/// the gaps between paced frames are idle by design. Idle, GPU time reads at the
/// GPU's lowered clock, marked and left out of the budget.
struct PerformanceOverlay: View {
    let session: Session
    let renderer: GlobeRenderer

    private static let graphWidth: CGFloat = 220
    private static let graphHeight: CGFloat = 64
    /// The y axis runs to the longest frame, between these many frame budgets;
    /// longer work is clipped and marked.
    private static let graphFloor = 1.25
    private static let graphCeiling = 3.0
    /// Points: wide enough to see at a few frames a second.
    private static let maximumBarWidth: CGFloat = 2
    private static let overColor = Color(red: 0.90, green: 0.33, blue: 0.29)
    private static let cpuColor = Color(red: 0.34, green: 0.77, blue: 0.71)
    private static let gpuColor = Color(red: 0.84, green: 0.55, blue: 0.94)
    private static let budgetColor = Color.white.opacity(0.55)

    private var expanded: Bool { session.fpsPanel == .graph }

    var body: some View {
        Button {
            session.fpsPanel = expanded ? .compact : .graph
        } label: {
            TimelineView(.periodic(from: .now, by: expanded ? 0.1 : 0.5)) { _ in
                let stats = renderer.frameStats
                VStack(alignment: .leading, spacing: 1) {
                    Text(fps(stats))
                        .fontWeight(.semibold)
                    Text("CPU \(milliseconds(stats?.cpuMilliseconds)) · GPU \(gpu(stats))")
                    Text("Load \(load(stats)) · \(MemoryFootprint.megabytes().map { "\($0) MB" } ?? "– MB") · \((stats?.satellites ?? 0).formatted()) sats")
                    if expanded {
                        graph(stats)
                    }
                }
                // As wide as the graph, which every line fits inside.
                .frame(width: expanded ? Self.graphWidth : nil, alignment: .leading)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .panel(cornerRadius: 10)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Performance")
        .accessibilityValue(expanded ? "Graph" : "Compact")
        .accessibilityHint(expanded ? "Closes the frame-time graph" : "Opens the frame-time graph")
        .onAppear { renderer.measureFrames(true, for: "panel") }
        .onDisappear { renderer.measureFrames(false, for: "panel") }
    }

    private func fps(_ stats: FrameStats?) -> String {
        guard let stats else {
            return "– fps"
        }
        return "\(Int(stats.framesPerSecond.rounded())) fps\(stats.paced ? " · paced" : "")"
    }

    /// Idle, at the GPU's lowered clock (`FrameRecording.idle`).
    private func gpu(_ stats: FrameStats?) -> String {
        let time = milliseconds(stats?.gpuMilliseconds)
        return stats?.idle == true && stats?.gpuMilliseconds != nil ? "\(time) (idle)" : time
    }

    /// At least the CPU's share where the GPU's is unknown, as in the simulator.
    private func load(_ stats: FrameStats?) -> String {
        guard let stats else {
            return "–"
        }
        return stats.load.map { String(format: "%.0f %%", $0) } ?? String(format: "≥ %.0f %%", stats.cpuBusy)
    }

    private func percent(_ value: Double?) -> String {
        value.map { String(format: "%.0f %%", $0) } ?? "–"
    }

    private func milliseconds(_ value: Double?) -> String {
        value.map { String(format: "%.1f ms", $0) } ?? "–"
    }

    /// A bar of CPU time a frame, its GPU time marked: a paced scene shows few bars,
    /// and a hitch shows as a gap.
    private func graph(_ stats: FrameStats?) -> some View {
        let now = ProcessInfo.processInfo.systemUptime
        // The meter prunes only as a frame is drawn: paced and paused, nothing is, for longer than the window.
        let frames = renderer.recentFrames.filter { $0.at >= now - GlobeRenderer.recentWindow }
        let budget = session.frameBudgetMilliseconds
        let work = { (frame: MeteredFrame) in max(frame.cpu, frame.gpu ?? 0) }
        // As a benchmark step reports them (`FrameRecording.summary`).
        let cpu = frames.map(\.cpu)
        let gpu = frames.compactMap(\.gpu)
        let over = FrameRecording.overBudget(cpu: cpu, gpu: stats?.idle == true ? [] : gpu, budget: budget)
        return VStack(alignment: .leading, spacing: 1) {
            Canvas { context, size in
                let ceiling = min(budget * Self.graphCeiling, max(budget * Self.graphFloor, frames.map(work).max() ?? 0))
                func y(_ value: Double) -> CGFloat { size.height - CGFloat(min(value, ceiling) / ceiling) * size.height }
                var line = Path()
                line.move(to: CGPoint(x: 0, y: y(budget)))
                line.addLine(to: CGPoint(x: size.width, y: y(budget)))
                context.stroke(line, with: .color(Self.budgetColor), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                // The lines below cover this window, the header only its last half second.
                context.draw(
                    Text("last \(Int(GlobeRenderer.recentWindow)) s").font(.system(size: 9).monospacedDigit()).foregroundStyle(.white.opacity(0.6)),
                    at: CGPoint(x: 2, y: 1), anchor: .topLeading)
                var previous: CGFloat?
                for frame in frames {
                    let right = size.width - CGFloat((now - frame.at) / GlobeRenderer.recentWindow) * size.width
                    // Touching its neighbour at full rate, a thin bar where frames are few.
                    let width = min(Self.maximumBarWidth, max(1, previous.map { right - $0 } ?? Self.maximumBarWidth))
                    previous = right
                    let left = right - width
                    context.fill(Path(CGRect(x: left, y: y(frame.cpu), width: width, height: size.height - y(frame.cpu))), with: .color(Self.cpuColor))
                    if let gpu = frame.gpu {
                        context.fill(Path(CGRect(x: left, y: y(gpu) - 1, width: width, height: 2)), with: .color(Self.gpuColor))
                    }
                    if work(frame) > ceiling {
                        context.fill(Path(CGRect(x: left, y: 0, width: width, height: 3)), with: .color(Self.overColor))
                    }
                }
            }
            .frame(width: Self.graphWidth, height: Self.graphHeight)
            .padding(.vertical, 3)
            HStack(spacing: 3) {
                key(Self.cpuColor)
                Text("CPU ")
                key(Self.gpuColor, height: 2)
                Text("GPU ")
                key(Self.budgetColor, width: 9, height: 1)
                Text(String(format: "%.1f ms budget", budget))
            }
            .foregroundStyle(.white.opacity(0.7))
            Text("p95 CPU \(milliseconds(FrameRecording.percentile(cpu, 0.95))) · GPU \(milliseconds(FrameRecording.percentile(gpu, 0.95)))")
            Text("over budget \(percent(over)) · total CPU \(percent(stats?.cpuTotal))")
        }
    }

    private func key(_ color: Color, width: CGFloat = 7, height: CGFloat = 7) -> some View {
        Rectangle().fill(color).frame(width: width, height: height)
    }
}

/// What iOS counts against the app's memory limit, as Xcode's gauge shows it.
enum MemoryFootprint {
    static func megabytes() -> Int? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Int(info.phys_footprint / 1_048_576) : nil
    }
}
