import SatvisCore
import SwiftUI

/// The bottom controls, as the web app's clock deck: a control row over a scale
/// row that is either the timeline or the speed ladder (CONTEXT.md, Clock deck).
/// Tapping the time folds it to the control row. The selected satellite's passes
/// are marked on the timeline.
struct ClockDeck: View {
    let clock: ViewerClock
    var passes: [Pass] = []
    @State private var isOpen = false
    @State private var onLadder = false

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                Button(clock.clock.isPlaying ? "Pause" : "Play", systemImage: clock.clock.isPlaying ? "pause.fill" : "play.fill") {
                    clock.togglePlaying()
                }
                .labelStyle(.iconOnly)
                Button {
                    withAnimation(.snappy) {
                        isOpen.toggle()
                        if !isOpen {
                            onLadder = false
                        }
                    }
                } label: {
                    TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                        Stamp(time: clock.now(), isLive: !clock.clock.isOffPresent(at: ViewerClock.real()), rate: clock.clock.multiplier)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isOpen ? "Hide clock controls" : "Show clock controls")
                Spacer(minLength: 0)
                if isOpen {
                    Button(onLadder ? "Timeline" : "Playback speed", systemImage: onLadder ? "clock" : "gauge.with.dots.needle.67percent") {
                        onLadder.toggle()
                    }
                    .labelStyle(.iconOnly)
                }
                if resettable {
                    Button(onLadder ? "Back to real time" : "Back to now", systemImage: "arrow.uturn.backward") {
                        if onLadder {
                            clock.setMultiplier(1)
                        } else {
                            clock.goLive()
                        }
                    }
                    .labelStyle(.iconOnly)
                }
            }
            .font(.body)
            if isOpen {
                Group {
                    if onLadder {
                        Ladder(clock: clock)
                    } else {
                        TimelineScale(clock: clock, passes: passes)
                    }
                }
                .frame(height: 44)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .glassEffect(in: .rect(cornerRadius: 24))
    }

    /// Whether the scale showing is away from where it rests.
    private var resettable: Bool {
        if onLadder {
            return clock.clock.multiplier != 1
        }
        return clock.clock.isOffPresent(at: ViewerClock.real()) || clock.clock.isPinned
    }
}

private struct Stamp: View {
    let time: Double
    let isLive: Bool
    let rate: Double

    var body: some View {
        let date = Date(timeIntervalSince1970: time / 1000)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("\(date, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)) UTC")
                    .font(.headline.monospacedDigit())
                    .environment(\.timeZone, .gmt)
                if isLive {
                    Circle().fill(.red).frame(width: 7, height: 7).accessibilityLabel("Live")
                }
            }
            Text("\(date, format: .dateTime.weekday().day().month())\(rate == 1 ? "" : " · \(SimulationClock.rateLabel(rate))")")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .environment(\.timeZone, .gmt)
        }
    }
}

/// Wall-clock time under a fixed needle: 24 s a point, ten-minute ticks, hours
/// labelled. Dragging scrubs, and a flick runs on and slows as on the web.
private struct TimelineScale: View {
    let clock: ViewerClock
    let passes: [Pass]
    @State private var dragStart: Double?
    @State private var flick: Task<Void, Never>?

    private static let msPerPoint = 24_000.0
    private static let minor = 600_000.0
    private static let major = 3_600_000.0

    var body: some View {
        TimelineView(.animation) { _ in
            Canvas { context, size in
                let centre = clock.now()
                let half = size.width / 2 * Self.msPerPoint
                // Marks, not ranges: the scale moves under a fixed needle. In the
                // passes table's blue, at a weight that reads as a region.
                for pass in passes where pass.end >= centre - half && pass.start <= centre + half {
                    let left = max(0, (pass.start - centre) / Self.msPerPoint + size.width / 2)
                    let right = min(size.width, (pass.end - centre) / Self.msPerPoint + size.width / 2)
                    let mark = CGRect(x: left, y: 0, width: max(1, right - left), height: size.height)
                    context.fill(Path(mark), with: .color(.timelineHigh.opacity(0.15)))
                    context.fill(Path(CGRect(x: mark.minX, y: 0, width: 1, height: size.height)), with: .color(.timelineHigh.opacity(0.4)))
                    context.fill(Path(CGRect(x: mark.maxX - 1, y: 0, width: 1, height: size.height)), with: .color(.timelineHigh.opacity(0.4)))
                }
                var at = ((centre - half) / Self.minor).rounded(.down) * Self.minor
                while at <= centre + half {
                    let x = (at - centre) / Self.msPerPoint + size.width / 2
                    let isMajor = at.truncatingRemainder(dividingBy: Self.major) == 0
                    let tick = Path(CGRect(x: x, y: isMajor ? 4 : 10, width: 1, height: isMajor ? 14 : 8))
                    context.fill(tick, with: .color(.secondary.opacity(isMajor ? 0.9 : 0.5)))
                    if isMajor {
                        let date = Date(timeIntervalSince1970: at / 1000)
                        let isMidnight = at.truncatingRemainder(dividingBy: 86_400_000) == 0
                        let utc = Date.FormatStyle(timeZone: .gmt)
                        let label = date.formatted(isMidnight ? utc.day().month(.abbreviated) : utc.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
                        context.draw(Text(label).font(.caption2).foregroundStyle(.secondary), at: CGPoint(x: x, y: 32))
                    }
                    at += Self.minor
                }
                context.fill(Path(CGRect(x: size.width / 2 - 1, y: 0, width: 2, height: 22)), with: .color(.accentColor))
            }
            .environment(\.timeZone, .gmt)
        }
        .contentShape(.rect)
        .gesture(
            DragGesture(minimumDistance: 2)
                .onChanged { value in
                    flick?.cancel()
                    let start = dragStart ?? clock.now()
                    dragStart = start
                    clock.scrub(to: start - value.translation.width * Self.msPerPoint)
                }
                .onEnded { value in
                    dragStart = nil
                    run(velocity: -value.velocity.width)
                }
        )
        .accessibilityLabel("Timeline")
        .accessibilityAdjustableAction { direction in
            clock.scrub(to: clock.now() + (direction == .increment ? 1 : -1) * Self.minor)
        }
    }

    /// The web app's flick: the velocity decays by 0.94 every 16.7 ms.
    private func run(velocity pointsPerSecond: Double) {
        var velocity = min(max(pointsPerSecond, -4000), 4000)
        guard abs(velocity) > 20 else {
            return
        }
        flick = Task {
            while !Task.isCancelled, abs(velocity) > 20 {
                try? await Task.sleep(for: .milliseconds(16))
                clock.scrub(to: clock.now() + velocity * 0.0167 * Self.msPerPoint)
                velocity *= 0.94
            }
        }
    }
}

/// The playback rates as rungs to scroll between: the ladder rests on a rung,
/// never between two.
private struct Ladder: View {
    let clock: ViewerClock
    @State private var rung: Int?

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(SimulationClock.ladder.indices, id: \.self) { index in
                        let multiplier = SimulationClock.ladder[index]
                        Text("\(multiplier < 0 ? "−" : "")\(Int(abs(multiplier)))×")
                            .font(.caption.monospacedDigit().weight(index == rung ? .bold : .regular))
                            .foregroundStyle(index == rung ? Color.primary : .secondary)
                            .frame(width: 64, height: 44)
                            .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $rung, anchor: .center)
            .contentMargins(.horizontal, (proxy.size.width - 64) / 2, for: .scrollContent)
            .overlay {
                RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: 1.5).frame(width: 64, height: 32)
                    .allowsHitTesting(false)
            }
        }
        .onAppear { rung = clock.clock.rung }
        .onChange(of: rung) { _, rung in
            if let rung {
                clock.setMultiplier(SimulationClock.ladder[rung])
            }
        }
        .onChange(of: clock.clock.multiplier) { _, multiplier in
            if let index = SimulationClock.ladder.firstIndex(of: multiplier), index != rung {
                withAnimation { rung = index }
            }
        }
        .accessibilityLabel("Playback speed")
        .accessibilityValue(SimulationClock.rateLabel(clock.clock.multiplier))
    }
}
