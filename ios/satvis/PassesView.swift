import SatvisCore
import SwiftUI

/// Whose passes a panel lists: one satellite's over every station, or every active
/// satellite's over one station.
enum PassSubject {
    case satellite(CatalogEntry)
    case station(GroundStation, [CatalogEntry])
}

extension PassSubject {
    /// The passes so far, whether that is all of them, and for a station, how
    /// many of its satellites are done.
    func passes(in model: PassModel, at now: Double) -> (passes: [Pass], settled: Bool, progress: (done: Int, total: Int)?) {
        switch self {
        case .satellite(let entry):
            guard let passes = model.passes(of: entry.id, at: now) else {
                return ([], false, nil)
            }
            return (passes, true, nil)
        case .station(let station, let entries):
            let answer = model.passes(over: station, of: entries, from: now)
            return (answer.passes, answer.settled, (answer.predicted, entries.count))
        }
    }
}

/// The web app's Passes tab: the next pass as a headline, the timeline strip for a
/// satellite, the newest overpass imaged, the overpass mode, and the list, with what a
/// granule layer recorded of each pass (ADR 0023). Tapping a pass replays it.
struct PassesSections: View {
    let subject: PassSubject
    let clock: ViewerClock
    let passes: PassModel
    let recorded: RecordedOverpasses
    let replay: OverpassReplayModel
    @AppStorage("showPastPasses") private var showsPast = false
    /// Only the passes recorded with a granule layer by day.
    @State private var onlyImaged = false
    @State private var now = ViewerClock.real()
    /// The pass picked off the strip, by start.
    @State private var picked: Double?
    /// The last settled passes, which `top` stands in while new ones are predicted.
    @State private var held = Held()
    /// Regular on an iPad and a Mac, where the list is a table, as the web app's.
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let (all, settled, progress) = subject.passes(in: passes, at: now)
        let visible = all.visible(at: now, past: showsPast)
        let next = visible.first { $0.end >= now }
        let subjects = Set(visible.map(subjectName))
        let top = top(all, settled: settled)
        let topVisible = top?.passes.visible(at: now, past: showsPast) ?? []
        let overpasses = recorded.recorded
        let table = PassTableRow.table(visible, recorded: overpasses, now: now, past: showsPast).filter { !onlyImaged || $0.recorded?.isDay == true }
        // Columns under headings, as the web app's table, where there is room for them and
        // no column of names: on an iPad and a Mac, for one satellite.
        let columns = sizeClass == .regular && subjects.count <= 1 && !isStation ? PassColumns(mode: passes.mode, marks: !overpasses.isEmpty) : nil
        Section {
            Group {
                if let top, !top.passes.isEmpty, let next = topVisible.first(where: { $0.end >= now }) {
                    Headline(pass: next, now: now, subject: subjectName(next))
                }
                if case .satellite = subject, let top, !top.passes.isEmpty {
                    TimelineStrip(passes: topVisible, now: now, mode: top.mode, picked: $picked)
                }
            }
            .opacity(settled ? 1 : 0.4)
            if let latest = recorded.latest {
                LastImaged(entry: latest) { replay.replay(latest, among: overpasses) }
            }
            // Its switches beside it where there is room, else on a row of their own: on a
            // phone they squeezed it to "El… S…".
            let controls = sizeClass == .regular ? AnyLayout(HStackLayout(spacing: 16)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            controls {
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
                .panelSegmented()
                HStack(spacing: 16) {
                    Toggle("Past", isOn: $showsPast)
                        .fixedSize()
                    if !overpasses.isEmpty {
                        Toggle("Imaged", isOn: $onlyImaged)
                            .fixedSize()
                    }
                }
            }
        }
        // Imaged passes are past ones.
        .onChange(of: onlyImaged) {
            if onlyImaged {
                showsPast = true
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
                // With thousands of satellites this takes a while: what is found so
                // far is listed below as it comes, and here how far it has got.
                Label(
                    progress.map { "Computing passes… \($0.done.formatted()) of \($0.total.formatted()) satellites" } ?? "Computing passes…",
                    systemImage: "hourglass"
                )
                .foregroundStyle(.secondary)
            } else if all.isEmpty {
                Text(passes.hasStations ? "No passes in the prediction window" : "No ground station set")
                    .foregroundStyle(.secondary)
            } else if table.isEmpty {
                Text(onlyImaged ? "No imaged passes" : "No upcoming passes")
                    .foregroundStyle(.secondary)
            }
            ForEach(table) { row in
                let mark = row.recorded.map { PassImageryMark(imagery: recorded.imagery(of: $0), replays: $0.isDay) }
                switch row {
                case .pass(let pass, let entry):
                    PassRow(
                        pass: pass, now: now, subject: subjects.count > 1 ? subjectName(pass) : nil, isNext: pass == next, isPicked: pass.start == picked,
                        mark: mark, columns: columns
                    ) {
                        replay.replay(pass, recorded: entry, among: overpasses)
                    }
                    .task(id: entry?.id) {
                        if let entry {
                            await recorded.ask(entry)
                        }
                    }
                case .recorded(let entry):
                    RecordedRow(entry: entry, now: now, subject: subjects.count > 1 || isStation ? recordedName(entry) : nil, mark: mark, columns: columns) {
                        replay.replay(entry, among: overpasses)
                    }
                    .task(id: entry.id) {
                        await recorded.ask(entry)
                    }
                }
            }
        } header: {
            if let columns, !table.isEmpty {
                columns.header
            } else if !table.isEmpty {
                Text(passes.mode == .swath ? "Start · end · off track · swath" : "Start · end · max elevation · azimuth at apex")
                    .font(.panelCaption)
                    .textCase(nil)
            }
        }
        .onChange(of: subjectID) { picked = nil }
    }

    /// What the headline and the strip show: the settled passes, or until they
    /// settle, the last settled ones for the same subject. Without them a change
    /// of mode emptied the section, and the picker under it jumped up and back.
    private func top(_ passes: [Pass], settled: Bool) -> (passes: [Pass], mode: OverpassMode)? {
        if settled {
            held.subject = subjectID
            held.mode = self.passes.mode
            held.passes = passes
            return (passes, self.passes.mode)
        }
        return held.subject == subjectID ? (held.passes, held.mode) : nil
    }

    private var isStation: Bool {
        if case .station = subject { true } else { false }
    }

    /// The other side of a recorded overpass from the panel's subject.
    private func recordedName(_ entry: RecordedOverpass) -> String {
        switch subject {
        case .satellite: entry.station
        case .station: entry.satellite
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

/// The last settled passes. A class, so keeping them from `body` redraws nothing.
private final class Held {
    var subject: String?
    var mode = OverpassMode.elevation
    var passes: [Pass] = []
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
                .font(.panelCaption)
                .foregroundStyle(isOngoing ? Color.panelGreen : .secondary)
            Text(pass.countdown(at: now))
                .font(.title2.monospacedDigit().bold())
            // One line in either mode, or the picker under it moves on a change.
            Text(pass.summary)
                .font(.panelCaption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(.secondary)
            // Held for the next pass too, so the headline is one height either way.
            ProgressView(value: isOngoing && pass.end > pass.start ? min(1, max(0, (now - pass.start) / (pass.end - pass.start))) : 0)
                .tint(Color.panelGreen)
                .opacity(isOngoing ? 1 : 0)
                .accessibilityHidden(!isOngoing)
        }
        .accessibilityElement(children: .combine)
        // Green only while the pass is under way, as the web app's card.
        .listRowBackground(
            Color.panelRaised.overlay {
                if isOngoing {
                    LinearGradient(colors: [Color.panelGreen.opacity(0.2), Color.panelGreen.opacity(0.06)], startPoint: .top, endPoint: .bottom)
                }
            })
    }
}

private struct PassRow: View {
    let pass: Pass
    let now: Double
    let subject: String?
    let isNext: Bool
    let isPicked: Bool
    /// What a granule layer recorded of it, where one did.
    let mark: PassImageryMark?
    /// The table's columns, where the list is one.
    let columns: PassColumns?
    let onTap: () -> Void

    var body: some View {
        let measures = pass.columns
        Button(action: onTap) {
            if let columns {
                columns.row(
                    into: Text(pass.countdown(at: now)).foregroundStyle(isNext ? .green : .primary), start: pass.startLabel, end: pass.endLabel,
                    primary: measures.primary, secondary: measures.secondary, mark: mark)
            } else {
                twoLines(measures)
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(isPicked ? Color.timelineHigh.opacity(0.2) : Color.panelRaised)
        .accessibilityHint(mark?.replays == true ? "Replays the pass, with its granules" : "Replays the pass")
    }

    /// A phone's row: who and when, then how long until it and how it measures.
    private func twoLines(_ columns: (primary: String, secondary: String)) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                if let subject {
                    Text(subject)
                        .lineLimit(1)
                }
                Text("\(pass.startLabel) – \(pass.endLabel)")
                    .font(.panelCaption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(pass.countdown(at: now))
                    .font(.panelLabel.monospacedDigit())
                    .foregroundStyle(isNext ? .green : .primary)
                Text("\(columns.primary) · \(columns.secondary)")
                    .font(.panelCaption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let mark {
                mark
            }
        }
        .contentShape(.rect)
    }
}

/// A recorded overpass by day the predictor no longer has, which looks back a day: no
/// elevation or azimuth.
private struct RecordedRow: View {
    let entry: RecordedOverpass
    let now: Double
    let subject: String?
    let mark: PassImageryMark?
    let columns: PassColumns?
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            if let columns {
                columns.row(
                    into: Text(entry.overpass.end < now ? "ended" : "ongoing"), start: entry.overpass.startLabel, end: entry.overpass.endLabel,
                    primary: "–", secondary: "–", mark: mark)
            } else {
                twoLines
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Replays the pass, with its granules")
    }

    /// A phone's row, as a pass's.
    private var twoLines: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                if let subject {
                    Text(subject)
                        .lineLimit(1)
                }
                Text("\(entry.overpass.startLabel) – \(entry.overpass.endLabel)")
                    .font(.panelCaption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.overpass.end < now ? "ended" : "ongoing")
                    .font(.panelLabel.monospacedDigit())
                Text("– · –")
                    .font(.panelCaption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let mark {
                mark
            }
        }
        .contentShape(.rect)
    }
}

/// The web app's pass table: In, Start, End and the mode's two measures, and a column
/// for what a granule layer recorded where any did.
struct PassColumns {
    let mode: OverpassMode
    /// Whether there is a column for the recorded imagery.
    let marks: Bool

    /// The headings, as the web app's.
    var header: some View {
        row(
            into: Text("In"), start: "Start", end: "End", primary: mode == .swath ? "Dist" : "El", secondary: mode == .swath ? "Swath" : "Az",
            mark: nil, heading: true
        )
        .foregroundStyle(.secondary)
        .textCase(nil)
        .accessibilityHidden(true)
    }

    /// A row's cells, at the headings' widths.
    func row(into: Text, start: String, end: String, primary: String, secondary: String, mark: PassImageryMark?, heading: Bool = false) -> some View {
        PassColumnsRow(into: into, cells: [start, end, primary, secondary], mark: mark, marks: marks, heading: heading)
    }
}

/// A row of `PassColumns`.
private struct PassColumnsRow: View {
    let into: Text
    /// Start, end and the two measures.
    let cells: [String]
    let mark: PassImageryMark?
    let marks: Bool
    let heading: Bool
    @ScaledMetric(relativeTo: .caption) private var scale = 1.0

    var body: some View {
        HStack(spacing: 6) {
            into.frame(width: 64 * scale, alignment: .leading)
            Text(cells[0]).frame(width: 100 * scale, alignment: .leading)
            Text(cells[1]).frame(width: 60 * scale, alignment: .leading)
            Spacer(minLength: 0)
            Text(cells[2]).frame(width: 40 * scale, alignment: .trailing)
            Text(cells[3]).frame(width: 60 * scale, alignment: .trailing)
            if marks {
                if heading {
                    Image(systemName: "photo").frame(width: 22)
                } else if let mark {
                    mark
                } else {
                    Color.clear.frame(width: 22, height: 1)
                }
            }
        }
        .font(heading ? .panelCaption.weight(.semibold) : .panelCaption.monospacedDigit())
        .lineLimit(1)
        .contentShape(.rect)
    }
}

/// A recorded pass's mark: an icon, its accessibility label the words.
struct PassImageryMark: View {
    let imagery: PassImagery
    /// Recorded by day, so its row replays its granules.
    let replays: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.panelNote)
            .foregroundStyle(color)
            .frame(width: 22)
            .accessibilityLabel(imagery.title)
    }

    private var symbol: String {
        switch imagery {
        case .asking: "ellipsis"
        case .image, .part: "photo"
        case .outline: "square.dashed"
        case .night: "moon"
        }
    }

    private var color: Color {
        switch imagery {
        case .image: .primary
        case .part: .panelAmber
        case .asking, .outline, .night: .secondary
        }
    }
}

/// The newest overpass a granule layer recorded by day, one press from its replay.
private struct LastImaged: View {
    let entry: RecordedOverpass
    let onReplay: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(Color.panelAccent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Last imaged")
                    .font(.panelCaption)
                    .foregroundStyle(.secondary)
                Text("\(entry.satellite) over \(entry.station) · \(entry.overpass.minuteLabel) UTC")
                    .font(.panelNote)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            // Green, the colour of what is overhead and of a replay, as the web app's.
            Button("Replay", systemImage: "play", action: onReplay)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(Color.panelGreen)
                .accessibilityHint("Replays it, with its granules")
        }
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
                            .font(.panelCaption2)
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
            .font(.panelCaption2)
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
