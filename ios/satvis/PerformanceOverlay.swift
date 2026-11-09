import Darwin
import SatvisCore
import SatvisRender
import SwiftUI

/// The web app's performance panel (`fps`, ADR 0016), laid out alike: the frame rate,
/// meters for CPU and GPU time against the frame budget and for load; a tap opens the
/// last five seconds frame by frame (`fps=graph`). Measured only while shown, it never
/// changes how frames are paced, and reads each frame's work against the frame budget,
/// as the gaps between paced frames are idle by design. Idle, GPU time reads at the
/// GPU's lowered clock, marked and left out of the budget. Both widths are fixed, so
/// changing figures never move it.
struct PerformanceOverlay: View {
    /// Holds `fpsPanel` and the frame budget.
    let session: Session
    /// Measures frames only while the panel is shown.
    let renderer: GlobeRenderer

    /// Points, padding included, as the web's.
    private static let compactWidth: CGFloat = 208
    /// Points, with the graph.
    private static let expandedWidth: CGFloat = 264
    /// Points.
    private static let graphHeight: CGFloat = 84
    /// Room above the bars for the legend.
    private static let graphTop: CGFloat = 12
    /// The y axis runs to the longest frame, between these many frame budgets;
    /// longer work is clipped and marked.
    private static let graphFloor = 1.25
    /// Frame budgets.
    private static let graphCeiling = 3.0
    /// Seconds. Paced at ×1 the default view draws about four frames a second; none
    /// for this long, as with the clock paused, reads as no frames rather than the
    /// last half second's figures.
    private static let stallSeconds = 2.0
    /// The CPU and GPU meters run to this many budgets, so the budget's tick sits at two thirds.
    private static let meterScale = 1.5
    /// Over budget, or a share from 90 %.
    private static let overColor = Color(red: 0.90, green: 0.33, blue: 0.29)
    /// A share from 60 to 90 %.
    private static let warnColor = Color(red: 0.88, green: 0.70, blue: 0.25)
    /// The CPU's, and a share under 60 %.
    private static let cpuColor = Color(red: 0.34, green: 0.77, blue: 0.71)
    /// The GPU's.
    private static let gpuColor = Color(red: 0.84, green: 0.55, blue: 0.94)
    /// The graph's budget line.
    private static let budgetColor = Color.white.opacity(0.55)
    /// Labels, units and the graph's legend.
    private static let dimColor = Color.white.opacity(0.6)

    /// Times the stall while no frame has come since the panel opened.
    @State private var opened = ProcessInfo.processInfo.systemUptime

    /// `fps=graph`.
    private var expanded: Bool { session.fpsPanel == .graph }

    var body: some View {
        Button {
            session.fpsPanel = expanded ? .compact : .graph
        } label: {
            TimelineView(.periodic(from: .now, by: expanded ? 0.1 : 0.5)) { _ in
                content(renderer.frameStats)
                    .frame(width: (expanded ? Self.expandedWidth : Self.compactWidth) - 18, alignment: .leading)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.top, 6)
                    .padding(.bottom, 7)
                    .panel(cornerRadius: 10)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Performance")
        .accessibilityValue(expanded ? "Graph" : "Compact")
        .accessibilityHint(expanded ? "Closes the frame-time graph" : "Opens the frame-time graph")
        .onAppear {
            opened = ProcessInfo.processInfo.systemUptime
            renderer.measureFrames(true, for: "panel")
        }
        .onDisappear { renderer.measureFrames(false, for: "panel") }
    }

    /// The meters, and expanded the graph, splits and footer; no figures while frames have stalled.
    private func content(_ stats: FrameStats?) -> some View {
        let budget = session.frameBudgetMilliseconds
        let now = ProcessInfo.processInfo.systemUptime
        // The meter prunes only as a frame is drawn: paced and paused, nothing is, for longer than the window.
        let recent = renderer.recentFrames
        let frames = expanded ? recent.filter { $0.at >= now - GlobeRenderer.recentWindow } : []
        let since = now - (recent.last?.at ?? opened)
        let stalled = since > Self.stallSeconds ? since : nil
        // The last figures would stand for nothing while no frame is drawn.
        let live = stalled == nil ? stats : nil
        let cpu = frames.map(\.cpu)
        // Idle frames' GPU times stand in only where no other frame was timed, and never count against the budget.
        let busy = frames.filter { !$0.idle }.compactMap(\.gpu)
        let gpu = busy.isEmpty ? frames.compactMap(\.gpu) : busy
        let gpuIdle = busy.isEmpty && !gpu.isEmpty
        // As a benchmark step reports them (`FrameRecording.summary`).
        let over = FrameRecording.overBudget(cpu: cpu, gpu: busy, budget: budget)
        return VStack(alignment: .leading, spacing: 4) {
            header(stats, stalled: stalled != nil)
            Grid(alignment: .leading, horizontalSpacing: 4, verticalSpacing: 3) {
                meters(live, budget: budget)
                if expanded {
                    graph(
                        frames, now: now, budget: budget, gpuIdle: gpuIdle, stalled: stalled, cpuP95: FrameRecording.percentile(cpu, 0.95),
                        gpuP95: FrameRecording.percentile(gpu, 0.95)
                    )
                    .frame(height: Self.graphHeight)
                    .padding(.top, 4)
                    .gridCellColumns(4)
                    Text("last \(Int(GlobeRenderer.recentWindow)) s · frames by share of budget")
                        .font(.system(size: 9))
                        .foregroundStyle(.white.opacity(0.5))
                        .padding(.top, 2)
                        .gridCellColumns(4)
                    split("CPU", cpu, color: Self.cpuColor, budget: budget, idle: false)
                    split("GPU", gpu, color: Self.gpuColor, budget: budget, idle: gpuIdle)
                }
            }
            if expanded {
                footer(live, over: over, gpuIdle: gpuIdle)
            }
        }
    }

    /// The frame rate, with a dot coloured by load; the footprint and satellites beside it.
    private func header(_ stats: FrameStats?, stalled: Bool) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Self.severity(stalled ? nil : loadShare(stats))).frame(width: 8, height: 8)
            Text(stalled ? "0" : stats.map { "\(Int($0.framesPerSecond.rounded()))" } ?? "–")
                .font(.system(size: 22, weight: .bold).monospacedDigit())
                .frame(minWidth: 40, alignment: .trailing)
            VStack(alignment: .leading, spacing: 0) {
                Text("fps")
                Text(stalled ? "no frames" : stats?.paced == true ? "paced" : " ")
            }
            .font(.system(size: 9.5))
            .foregroundStyle(.white.opacity(0.65))
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 0) {
                Text(MemoryFootprint.megabytes().map { "\($0.formatted()) MB" } ?? "– MB")
                Text("\((stats?.satellites ?? 0).formatted()) sats")
            }
            .font(.system(size: 9.5).monospacedDigit())
            .foregroundStyle(.white.opacity(0.65))
            .lineLimit(1)
        }
    }

    /// CPU and GPU against the budget, in the graph's colours and red over it; load against the device.
    @ViewBuilder
    private func meters(_ stats: FrameStats?, budget: Double) -> some View {
        let idle = stats?.idle == true && stats?.gpuMilliseconds != nil
        let cpuShare = (stats?.cpuMilliseconds ?? 0) / budget
        let gpuShare = (stats?.gpuMilliseconds ?? 0) / budget
        row(
            "CPU", fill: cpuShare / Self.meterScale, color: cpuShare > 1 ? Self.overColor : Self.cpuColor, budget: true, idle: false,
            value: BenchmarkFormat.number(stats?.cpuMilliseconds, 1), unit: "ms")
        row(
            "GPU", fill: gpuShare / Self.meterScale, color: gpuShare > 1 && !idle ? Self.overColor : Self.gpuColor, budget: true, idle: idle,
            value: BenchmarkFormat.number(stats?.gpuMilliseconds, 1), unit: idle ? "idle" : "ms")
        let load = BenchmarkFormat.load(stats?.load, cpuBusy: stats?.cpuBusy)
        row("Load", fill: loadShare(stats) ?? 0, color: Self.severity(loadShare(stats)), budget: false, idle: false, value: load, unit: "%")
    }

    /// A meter: its label, bar, value and unit; `budget` ticks the budget on the bar.
    private func row(_ label: String, fill: Double, color: Color, budget: Bool, idle: Bool, value: String, unit: String) -> some View {
        GridRow {
            Self.label(label)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Self.track(idle: idle)
                    RoundedRectangle(cornerRadius: 2).fill(color).opacity(idle ? 0.5 : 1)
                        .frame(width: geometry.size.width * min(max(fill, 0), 1))
                    if budget {
                        Rectangle().fill(.white).frame(width: 1, height: 12).offset(x: geometry.size.width / Self.meterScale)
                    }
                }
            }
            .frame(height: 8)
            Self.value(value, bold: true)
            Self.unit(unit)
        }
    }

    /// Each side's frames by share of the budget, counted on its own as `overBudget`
    /// does, so the red share is over budget.
    private func split(_ label: String, _ values: [Double], color: Color, budget: Double, idle: Bool) -> some View {
        let total = Double(max(values.count, 1))
        let share = { (test: (Double) -> Bool) in Double(values.filter(test).count) / total }
        let parts = [
            (share { $0 <= budget / 2 }, color, 0.4),
            (share { $0 > budget / 2 && $0 <= budget }, color, 1.0),
            (share { $0 > budget }, idle ? color : Self.overColor, 1.0),
        ].filter { $0.0 > 0 }
        return GridRow {
            Self.label(label)
            GeometryReader { geometry in
                let width = geometry.size.width - CGFloat(max(parts.count - 1, 0))
                ZStack(alignment: .leading) {
                    Self.track(idle: idle)
                    HStack(spacing: 1) {
                        ForEach(parts.indices, id: \.self) { index in
                            Rectangle().fill(parts[index].1).opacity(idle ? 0.35 : parts[index].2).frame(width: width * parts[index].0)
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 2))
            }
            .frame(height: 8)
            Self.value(BenchmarkFormat.number(FrameRecording.percentile(values, 0.95), 1), bold: false)
            Self.unit("p95")
        }
    }

    /// Each frame where it was drawn: a bar of its CPU time over a pale column of its
    /// GPU time, capped, so the GPU's height reads under a taller CPU bar. Paced or not
    /// alike: a paced scene shows few bars, and a hitch shows as a gap. The p95s are
    /// marked at the right.
    private func graph(
        _ frames: [MeteredFrame], now: Double, budget: Double, gpuIdle: Bool, stalled: Double?, cpuP95: Double?, gpuP95: Double?
    ) -> some View {
        Canvas { context, size in
            let work = { (frame: MeteredFrame) in max(frame.cpu, frame.gpu ?? 0) }
            let ceiling = min(budget * Self.graphCeiling, max(budget * Self.graphFloor, frames.map(work).max() ?? 0))
            func y(_ value: Double) -> CGFloat { size.height - CGFloat(min(value, ceiling) / ceiling) * (size.height - Self.graphTop) }
            func fill(_ rect: CGRect, _ color: Color, _ opacity: Double = 1) { context.fill(Path(rect), with: .color(color.opacity(opacity))) }
            for frame in frames {
                let x = size.width - CGFloat((now - frame.at) / GlobeRenderer.recentWindow) * size.width
                if let gpu = frame.gpu {
                    fill(CGRect(x: x - 3, y: y(gpu), width: 3, height: size.height - y(gpu)), Self.gpuColor, frame.idle ? 0.15 : 0.35)
                    fill(CGRect(x: x - 3, y: y(gpu) - 1, width: 3, height: 2), gpu > budget && !frame.idle ? Self.overColor : Self.gpuColor, frame.idle ? 0.5 : 1)
                }
                fill(CGRect(x: x - 2, y: y(frame.cpu), width: 1.5, height: size.height - y(frame.cpu)), frame.cpu > budget ? Self.overColor : Self.cpuColor)
                if work(frame) > ceiling {
                    fill(CGRect(x: x - 3, y: Self.graphTop - 3, width: 3, height: 3), Self.overColor)
                }
            }
            var line = Path()
            line.move(to: CGPoint(x: 0, y: y(budget) + 0.5))
            line.addLine(to: CGPoint(x: size.width, y: y(budget) + 0.5))
            context.stroke(line, with: .color(Self.budgetColor), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            for (p95, color) in [(cpuP95, Self.cpuColor), (gpuP95, Self.gpuColor)] {
                if let p95 {
                    var mark = Path()
                    mark.move(to: CGPoint(x: size.width - 10, y: y(p95)))
                    mark.addLine(to: CGPoint(x: size.width, y: y(p95)))
                    context.stroke(mark, with: .color(color), lineWidth: 1.5)
                }
            }
            let small = Font.system(size: 9).monospacedDigit()
            let budgetLabel = context.resolve(Text("\(Formats.fixed(budget, 1)) ms").font(small).foregroundStyle(.white.opacity(0.75)))
            let measured = budgetLabel.measure(in: size)
            fill(CGRect(x: 0, y: y(budget) - 11, width: measured.width + 4, height: 10), Color(red: 0.05, green: 0.05, blue: 0.07), 0.85)
            context.draw(budgetLabel, at: CGPoint(x: 1, y: y(budget) - 1.5), anchor: .bottomLeading)
            fill(CGRect(x: 0, y: 1, width: 2, height: 7), Self.cpuColor)
            context.draw(Text("CPU").font(small).foregroundStyle(Self.cpuColor), at: CGPoint(x: 5, y: 0), anchor: .topLeading)
            fill(CGRect(x: 30, y: 1, width: 3, height: 7), Self.gpuColor, 0.35)
            fill(CGRect(x: 30, y: 1, width: 3, height: 2), Self.gpuColor)
            context.draw(Text(gpuIdle ? "GPU idle" : "GPU").font(small).foregroundStyle(Self.gpuColor), at: CGPoint(x: 36, y: 0), anchor: .topLeading)
            context.draw(
                Text("\(Int(GlobeRenderer.recentWindow)) s · p95 at right").font(small).foregroundStyle(Self.dimColor), at: CGPoint(x: size.width, y: 0),
                anchor: .topTrailing)
            if let stalled {
                context.draw(
                    Text("no frames for \(Int(stalled)) s").font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.75)),
                    at: CGPoint(x: size.width / 2, y: (size.height + Self.graphTop) / 2))
            }
        }
    }

    /// Over budget, the CPU's alone while idle, and the process's CPU over every thread.
    private func footer(_ stats: FrameStats?, over: Double?, gpuIdle: Bool) -> some View {
        VStack(spacing: 3) {
            Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
            HStack(spacing: 0) {
                Text(gpuIdle ? "over, CPU " : "over budget ").foregroundStyle(.white.opacity(0.65))
                Text(Self.overPercent(over)).fontWeight(.semibold).foregroundStyle((over ?? 0) > 0 ? Self.overColor : .white)
                Spacer(minLength: 0)
                Text("total CPU ").foregroundStyle(.white.opacity(0.65))
                Text(Self.percent(stats?.cpuTotal)).fontWeight(.semibold)
            }
            .lineLimit(1)
        }
        .padding(.top, 1)
    }

    /// Load, or the CPU's side alone where the GPU's is unknown, as a share.
    private func loadShare(_ stats: FrameStats?) -> Double? {
        stats.map { ($0.load ?? $0.cpuBusy) / 100 }
    }

    /// Green, amber, red by share of the budget or of the device.
    private static func severity(_ share: Double?) -> Color {
        guard let share else {
            return .white.opacity(0.5)
        }
        return share < 0.6 ? cpuColor : share < 0.9 ? warnColor : overColor
    }

    /// Hatched while idle, as the GPU's lowered clock.
    @ViewBuilder
    private static func track(idle: Bool) -> some View {
        if idle {
            Canvas { context, size in
                var stripes = Path()
                for x in stride(from: -size.height, to: size.width, by: 6) {
                    stripes.move(to: CGPoint(x: x, y: size.height))
                    stripes.addLine(to: CGPoint(x: x + size.height, y: 0))
                }
                context.stroke(stripes, with: .color(.white.opacity(0.1)), lineWidth: 2.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 2))
        } else {
            RoundedRectangle(cornerRadius: 2).fill(.white.opacity(0.1))
        }
    }

    /// A row's first column.
    private static func label(_ text: String) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(dimColor).frame(width: 30, alignment: .leading)
    }

    /// A row's last column.
    private static func unit(_ text: String) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(dimColor).frame(width: 26, alignment: .leading)
    }

    /// Right-aligned, so changing figures never move the unit.
    private static func value(_ text: String, bold: Bool) -> some View {
        Text(text).fontWeight(bold ? .semibold : .regular).lineLimit(1).frame(width: 38, alignment: .trailing)
    }

    /// Whole percent, or a dash without a figure.
    private static func percent(_ value: Double?) -> String {
        value.map { "\(Formats.fixed($0, 0)) %" } ?? "–"
    }

    /// A share that rounds to 0 % but is not, which the colour marks, reads as under 1 %.
    private static func overPercent(_ value: Double?) -> String {
        value.map { $0 > 0 && $0 < 0.5 } == true ? "< 1 %" : percent(value)
    }
}

/// What iOS counts against the app's memory limit, as Xcode's gauge shows it.
enum MemoryFootprint {
    /// `phys_footprint` in MiB, rounded down; nil where the kernel does not answer.
    static func megabytes() -> Int? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Int(info.phys_footprint / 1_048_576) : nil
    }
}
