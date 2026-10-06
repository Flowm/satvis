import Darwin
import SatvisRender
import SwiftUI

/// The web app's FPS readout (Render menu → FPS, `fps=true`), with what a frame
/// costs either side of the GPU and the memory iOS holds against the app.
/// Measured only while shown; touches go through it to the globe.
struct PerformanceOverlay: View {
    let renderer: GlobeRenderer

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
            let stats = renderer.frameStats
            VStack(alignment: .leading, spacing: 1) {
                Text(stats.map { "\(Int($0.framesPerSecond.rounded())) fps" } ?? "– fps")
                    .fontWeight(.semibold)
                Text("CPU \(milliseconds(stats?.cpuMilliseconds)) · GPU \(milliseconds(stats?.gpuMilliseconds))")
                Text("\((stats?.satellites ?? 0).formatted()) satellites · \(MemoryFootprint.megabytes().map { "\($0) MB" } ?? "–")")
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .glassEffect(in: .rect(cornerRadius: 10))
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Performance")
        .onAppear { renderer.measuresFrames = true }
        .onDisappear { renderer.measuresFrames = false }
    }

    private func milliseconds(_ value: Double?) -> String {
        value.map { String(format: "%.1f ms", $0) } ?? "–"
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
