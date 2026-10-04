import SatvisCore
import SwiftUI

/// Whose passes a panel lists: one satellite's over every station, or every active
/// satellite's over one station.
enum PassSubject {
    case satellite(CatalogEntry)
    case station(GroundStation, [CatalogEntry])
}

/// The web app's Passes tab: the next pass as a headline, the timeline strip for a
/// satellite, the overpass mode, and the list. Tapping a pass moves the clock to
/// its start.
struct PassesSections: View {
    let subject: PassSubject
    let clock: ViewerClock
    let passes: PassModel
    @AppStorage("showPastPasses") private var showsPast = false
    @State private var now = ViewerClock.real()
    /// The pass picked off the strip, by start.
    @State private var picked: Double?

    var body: some View {
        let (all, settled) = list
        let visible = all.visible(at: now, past: showsPast)
        let next = visible.first { $0.end >= now }
        let subjects = Set(visible.map(subjectName))
        Section {
            if settled, !all.isEmpty, let next {
                Headline(pass: next, now: now, subject: subjectName(next))
            }
            if case .satellite = subject, settled, !all.isEmpty {
                TimelineStrip(passes: visible, now: now, mode: passes.mode, picked: $picked)
            }
            HStack {
                // Here even when the list is empty: swath mode over a station the
                // ground track misses lists nothing, and this is how to undo it.
                Picker(
                    "Overpass",
                    selection: Binding {
                        passes.mode
                    } set: {
                        passes.setMode($0)
                    }
                ) {
                    Text("Elevation").tag(OverpassMode.elevation)
                    Text("Swath").tag(OverpassMode.swath)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Toggle("Past", isOn: $showsPast)
                    .fixedSize()
            }
        }
        .task(id: clock.clock) {
            // The countdowns run on simulation time, so they stop with the clock.
            while !Task.isCancelled {
                now = clock.now()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        Section {
            if !settled {
                Label("Computing passes…", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            } else if all.isEmpty {
                Text(passes.hasStations ? "No passes in the prediction window" : "No ground station set")
                    .foregroundStyle(.secondary)
            } else if visible.isEmpty {
                Text("No upcoming passes")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(visible, id: \.self) { pass in
                    PassRow(
                        pass: pass, now: now, subject: subjects.count > 1 ? subjectName(pass) : nil, isNext: pass == next, isPicked: pass.start == picked
                    ) {
                        clock.scrub(to: pass.start.rounded(.down))
                    }
                }
            }
        } header: {
            if settled, !visible.isEmpty {
                Text(passes.mode == .swath ? "Start · end · off track · swath" : "Start · end · max elevation · azimuth at apex")
                    .font(.caption)
                    .textCase(nil)
            }
        }
        .onChange(of: subjectID) { picked = nil }
    }

    private var list: (passes: [Pass], settled: Bool) {
        switch subject {
        case .satellite(let entry):
            guard let passes = passes.passes(of: entry.id, at: now) else {
                return ([], false)
            }
            return (passes, true)
        case .station(let station, let entries):
            return passes.passes(over: station, of: entries, from: now)
        }
    }

    private var subjectID: String {
        switch subject {
        case .satellite(let entry): entry.id
        case .station(let station, _): station.id.uuidString
        }
    }

    /// The other side of the pass from the panel's subject.
    private func subjectName(_ pass: Pass) -> String {
        switch subject {
        case .satellite: pass.station
        case .station: pass.satelliteName
        }
    }
}

/// The ongoing or next pass: how long until it, and what it will be like.
private struct Headline: View {
    let pass: Pass
    let now: Double
    let subject: String

    var body: some View {
        let isOngoing = pass.start <= now
        VStack(alignment: .leading, spacing: 4) {
            Text("\(isOngoing ? "Overhead now" : "Next pass") · \(subject)")
                .font(.caption)
                .foregroundStyle(isOngoing ? .green : .secondary)
            Text(pass.countdown(at: now))
                .font(.title2.monospacedDigit().bold())
            Text(pass.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
            if isOngoing, pass.end > pass.start {
                ProgressView(value: min(1, max(0, (now - pass.start) / (pass.end - pass.start))))
                    .tint(.green)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct PassRow: View {
    let pass: Pass
    let now: Double
    let subject: String?
    let isNext: Bool
    let isPicked: Bool
    let onTap: () -> Void

    var body: some View {
        let columns = pass.columns
        Button(action: onTap) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    if let subject {
                        Text(subject)
                            .lineLimit(1)
                    }
                    Text("\(pass.startLabel) – \(pass.endLabel)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(pass.countdown(at: now))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(isNext ? .green : .primary)
                    Text("\(columns.primary) · \(columns.secondary)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(isPicked ? Color.timelineHigh.opacity(0.2) : nil)
        .accessibilityHint("Moves the clock to the start of the pass")
    }
}

/// The pass list as a strip, for one satellite: when the passes are and which are
/// worth going outside for, without reading a column of elevations.
private struct TimelineStrip: View {
    let passes: [Pass]
    let now: Double
    let mode: OverpassMode
    @Binding var picked: Double?

    var body: some View {
        let layout = PassTimelineLayout(passes: passes, now: now)
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let height = proxy.size.height
                ZStack(alignment: .topLeading) {
                    ForEach(layout.ticks, id: \.label) { tick in
                        Text(tick.label)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .fixedSize()
                            .offset(x: tick.position * width + 3, y: 0)
                        Rectangle()
                            .fill(.secondary.opacity(0.4))
                            .frame(width: 1, height: height)
                            .offset(x: tick.position * width)
                    }
                    ForEach(layout.blocks) { block in
                        let blockHeight = (height - 14) * block.height
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(band: block.band))
                            .opacity(block.isPast ? 0.35 : 1)
                            .overlay {
                                if block.start == picked || block.isLive {
                                    RoundedRectangle(cornerRadius: 2).stroke(.white, lineWidth: 1)
                                }
                            }
                            .frame(width: block.width * width, height: blockHeight)
                            .offset(x: block.left * width, y: height - blockHeight)
                            .onTapGesture { picked = picked == block.start ? nil : block.start }
                            .accessibilityLabel(passes.first { $0.start == block.start }?.summary ?? "")
                            .accessibilityAddTraits(.isButton)
                    }
                    Rectangle()
                        .fill(.green)
                        .frame(width: 2, height: height)
                        .offset(x: layout.now * width - 1)
                }
            }
            .frame(height: 56)
            HStack(spacing: 10) {
                ForEach(PassBand.allCases, id: \.self) { band in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2).fill(Color(band: band)).frame(width: 10, height: 10)
                        Text(label(band))
                    }
                }
                Spacer()
                if layout.beyond > 0 {
                    Text("+\(layout.beyond) past \(layout.horizonLabel)")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    /// Worded for what the mode measures.
    private func label(_ band: PassBand) -> String {
        switch (mode, band) {
        case (.swath, .high): "near centre"
        case (.swath, .mid): "mid"
        case (.swath, .low): "edge"
        case (.elevation, .high): "≥45°"
        case (.elevation, .mid): "20–45°"
        case (.elevation, .low): "<20°"
        }
    }
}

extension Color {
    /// The strip's colours: the common bands quiet, the good passes blue.
    init(band: PassBand) {
        switch band {
        case .high: self = .timelineHigh
        case .mid: self.init(.sRGB, red: 0xb8 / 255, green: 0xc4 / 255, blue: 0xc4 / 255)
        case .low: self.init(.sRGB, red: 0x8a / 255, green: 0x94 / 255, blue: 0x94 / 255)
        }
    }

    static let timelineHigh = Color(.sRGB, red: 0x56 / 255, green: 0xb4 / 255, blue: 0xe9 / 255)
}
