import SatvisCore
import SwiftUI

/// The bottom controls, as the web app's clock deck: a control row over a scale
/// row that is either the timeline or the speed ladder (CONTEXT.md, Clock deck).
/// The clock sits over the needle, with play on its left and the scale switch
/// and reset on its right, on a tab that grows out of the scale row; the row runs
/// the width of the deck and down to the bottom edge. Tapping the time folds the
/// deck to the clock alone, at the same height. The selected satellite's passes
/// are marked on the timeline. `accessory` stands at the left end of the control
/// row, off the deck's surface, where the web app has its credit line at widths
/// with room for it.
struct ClockDeck<Accessory: View>: View {
    let clock: ViewerClock
    let passes: PassModel
    /// The selected satellite, by catalog id.
    let satellite: String?
    @ViewBuilder let accessory: Accessory
    @State private var isOpen = false
    @State private var onLadder = false

    var body: some View {
        // Once a second, for what follows the wall clock rather than the deck's
        // own state: a paused clock falls behind the present, and "Back to now"
        // has to come up, and the tab widen to take it.
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            deck
        }
    }

    private var deck: some View {
        VStack(spacing: 0) {
            controlRow
            if isOpen {
                Group {
                    if onLadder {
                        Ladder(clock: clock)
                    } else {
                        TimelineScale(clock: clock, passes: passes, satellite: satellite)
                    }
                }
                .frame(height: Metrics.scaleHeight)
            }
        }
        // Held when the row goes, so the clock does not drop as the deck folds.
        .padding(.bottom, isOpen ? 0 : Metrics.scaleHeight)
        .foregroundStyle(Color.deckInk)
        .background {
            DeckShape(left: leftExtent, right: rightExtent, tabHeight: Metrics.rowHeight, radius: Metrics.radius, isOpen: isOpen)
                .fill(Color.deckSurface)
                .shadow(color: .black.opacity(isOpen ? 0.5 : 0.65), radius: 10, y: isOpen ? -2 : 4)
                .padding(.bottom, isOpen ? 0 : Metrics.scaleHeight)
                .ignoresSafeArea(edges: isOpen ? [.bottom, .horizontal] : [])
        }
        .frame(maxWidth: 560)
    }

    /// Three columns, the outer two of a width, so the clock stays on the needle
    /// whatever comes and goes beside it.
    private var controlRow: some View {
        HStack(spacing: Metrics.gap) {
            HStack(spacing: 0) {
                accessory
                Spacer(minLength: Metrics.gap)
                if isOpen {
                    Button {
                        clock.togglePlaying()
                    } label: {
                        Image(systemName: clock.clock.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.deckNight)
                            .frame(width: Metrics.playDisc, height: Metrics.playDisc)
                            .background(Color.deckInk, in: .circle)
                            .frame(width: Metrics.playBox, height: Metrics.playBox)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel(clock.clock.isPlaying ? "Pause" : "Play")
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

            Button {
                withAnimation(.snappy) {
                    isOpen.toggle()
                    // Coming back to the ladder is coming back to the wrong instrument.
                    if !isOpen {
                        onLadder = false
                    }
                }
            } label: {
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    Stamp(time: clock.now(), isLive: !clock.clock.isOffPresent(at: ViewerClock.real()))
                }
                .frame(width: Metrics.stampWidth, height: Metrics.playBox)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(isOpen ? "Hides the clock controls" : "Shows the clock controls")

            HStack(spacing: Metrics.gap) {
                if isOpen {
                    // Before the reset, so it holds still as the reset comes and goes.
                    chip(
                        onLadder ? "Show timeline" : "Set playback speed", symbol: onLadder ? "clock" : "gauge.with.dots.needle.67percent",
                        fill: .white.opacity(onLadder ? 0.18 : 0.08), tint: Color.deckInk
                    ) {
                        onLadder.toggle()
                    }
                    if resettable {
                        chip(onLadder ? "Back to real time" : "Back to now", symbol: "arrow.counterclockwise", fill: Color.deckAmber.opacity(0.12), tint: Color.deckAmber) {
                            if onLadder {
                                clock.setMultiplier(1)
                            } else {
                                clock.goLive()
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Metrics.pad)
        .padding(.top, Metrics.rowHeight - Metrics.playBox)
    }

    private func chip(_ title: String, symbol: String, fill: Color, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: Metrics.chipDisc, height: Metrics.chipDisc)
                .background(fill, in: .circle)
                .frame(width: Metrics.chipBox, height: Metrics.playBox)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    /// Whether the scale showing is away from where it rests.
    private var resettable: Bool {
        if onLadder {
            return clock.clock.multiplier != 1
        }
        return clock.clock.isOffPresent(at: ViewerClock.real()) || clock.clock.isPinned
    }

    /// How far the surface reaches either side of the middle: around the clock,
    /// and the play disc and the chips beside it when open.
    private var leftExtent: Double {
        Metrics.stampWidth / 2 + Metrics.pad + (isOpen ? Metrics.gap + Metrics.playDisc + (Metrics.playBox - Metrics.playDisc) / 2 : 0)
    }

    private var rightExtent: Double {
        let chips = isOpen ? (resettable ? 2.0 : 1.0) : 0
        return Metrics.stampWidth / 2 + Metrics.pad + (chips > 0 ? Metrics.gap + chips * Metrics.chipBox + (chips - 1) * Metrics.gap : 0)
    }
}

/// The deck's surface: a tab around the controls, flush on a row the width of
/// the deck, filleted where the two meet so they read as one shape. Folded, the
/// tab alone, closed into a card.
nonisolated private struct DeckShape: Shape {
    /// Points either side of the middle.
    var left: Double
    var right: Double
    var tabHeight: Double
    var radius: Double
    var isOpen: Bool

    func path(in rect: CGRect) -> Path {
        let tab = CGRect(x: rect.midX - left, y: rect.minY, width: left + right, height: isOpen ? tabHeight : rect.height)
        guard isOpen else {
            return Path(roundedRect: tab, cornerRadius: radius)
        }
        let top = rect.minY + tabHeight
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        // Corner by corner, clockwise from the bottom left; each arc is tangent to
        // the edges either side, which makes the two under the tab concave.
        let corners = [
            CGPoint(x: rect.minX, y: top), CGPoint(x: tab.minX, y: top), CGPoint(x: tab.minX, y: tab.minY),
            CGPoint(x: tab.maxX, y: tab.minY), CGPoint(x: tab.maxX, y: top), CGPoint(x: rect.maxX, y: top),
        ]
        for (corner, next) in zip(corners, corners.dropFirst() + [CGPoint(x: rect.maxX, y: rect.maxY)]) {
            path.addArc(tangent1End: corner, tangent2End: next, radius: radius)
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct Stamp: View {
    let time: Double
    let isLive: Bool

    var body: some View {
        let date = Date(timeIntervalSince1970: time / 1000)
        let utc = Date.FormatStyle(timeZone: .gmt)
        VStack(spacing: 0) {
            Text(UTCClock.time(date))
                .font(.system(size: 20, weight: .semibold).monospacedDigit())
            Text("\(date.formatted(utc.weekday(.abbreviated).day(.twoDigits).month(.abbreviated))) UTC")
                .font(.system(size: 11).monospacedDigit())
                .opacity(0.55)
        }
        .lineLimit(1)
        .fixedSize()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // At the present, as a dot in the corner.
        .overlay(alignment: .topTrailing) {
            if isLive {
                Circle()
                    .fill(Color(red: 0x7E / 255, green: 0xE7 / 255, blue: 0x87 / 255))
                    .frame(width: 6, height: 6)
                    .shadow(color: Color(red: 0x7E / 255, green: 0xE7 / 255, blue: 0x87 / 255).opacity(0.4), radius: 3)
                    .offset(x: -2, y: 2)
                    .accessibilityLabel("Live")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Wall-clock time under a fixed needle: 24 s a point, ten-minute ticks rising
/// from the bottom, hours labelled over them. Dragging scrubs, and a flick runs
/// on and slows as on the web.
private struct TimelineScale: View {
    let clock: ViewerClock
    let passes: PassModel
    let satellite: String?
    @State private var dragStart: Double?
    @State private var flick: Task<Void, Never>?

    private static let msPerPoint = 24_000.0
    private static let minor = 600_000.0
    private static let major = 3_600_000.0

    var body: some View {
        // Read here, so that a scrub, a flick, a pause or a new rate redraws the
        // scale at once; between those, it moves only as fast as the clock does.
        let state = clock.clock
        TimelineView(.animation(minimumInterval: Self.redrawInterval(multiplier: state.multiplier), paused: !state.isPlaying)) { _ in
            Canvas { context, size in
                let centre = clock.now()
                let half = size.width / 2 * Self.msPerPoint
                // Marks, not ranges: the scale moves under a fixed needle. In the
                // passes table's blue, at a weight that reads as a region, and
                // under the ticks so the scale stays readable across one.
                let marked = satellite.flatMap { passes.passes(of: $0, at: centre) } ?? []
                for pass in marked where pass.end >= centre - half && pass.start <= centre + half {
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
                    let height = isMajor ? 17.0 : 9.0
                    context.fill(Path(CGRect(x: x, y: size.height - height, width: 1, height: height)), with: .color(.white.opacity(isMajor ? 0.55 : 0.25)))
                    if isMajor {
                        let date = Date(timeIntervalSince1970: at / 1000)
                        let isMidnight = at.truncatingRemainder(dividingBy: 86_400_000) == 0
                        let label =
                            isMidnight
                            ? date.formatted(Date.FormatStyle(timeZone: .gmt).weekday(.abbreviated).day(.twoDigits).month(.abbreviated))
                            : UTCClock.hourMinute(date)
                        context.draw(
                            Text(label).font(.system(size: 10)).foregroundStyle(Color.deckInk.opacity(0.6)),
                            at: CGPoint(x: x, y: size.height - 19), anchor: .bottom)
                    }
                    at += Self.minor
                }
            }
            .environment(\.timeZone, .gmt)
        }
        // The needle runs on down to the bottom edge, with the surface.
        .overlay {
            Rectangle()
                .fill(Color.deckAmber)
                .frame(width: 2)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
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
        .accessibilityElement()
        .accessibilityLabel("Timeline")
        .accessibilityAdjustableAction { direction in
            clock.scrub(to: clock.now() + (direction == .increment ? 1 : -1) * Self.minor)
        }
    }

    /// Seconds between redraws: as long as the scale takes to move a third of a
    /// point, a pixel, and no longer than a second. At real time that is a
    /// redraw a second rather than one every frame.
    private static func redrawInterval(multiplier: Double) -> Double {
        let pointsPerSecond = abs(multiplier) * 1000 / msPerPoint
        return min(max(1 / (3 * max(pointsPerSecond, 1e-9)), 1.0 / 60), 1)
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
/// never between two. Each shows its multiplier over the rate it amounts to;
/// brightness alone marks the one in force.
private struct Ladder: View {
    let clock: ViewerClock
    @State private var rung: Int?

    private static let rungWidth = 64.0

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(SimulationClock.ladder.indices, id: \.self) { index in
                        let multiplier = SimulationClock.ladder[index]
                        VStack(spacing: 0) {
                            Text("\(multiplier < 0 ? "−" : "")\(Int(abs(multiplier)))×")
                                .font(.system(size: 15, weight: .semibold).monospacedDigit())
                            Text(SimulationClock.rateLabel(multiplier))
                                .font(.system(size: 10).monospacedDigit())
                                .opacity(0.75)
                        }
                        .lineLimit(1)
                        .opacity(index == rung ? 1 : 0.55)
                        .frame(width: Self.rungWidth, height: proxy.size.height)
                        .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $rung, anchor: .center)
            .contentMargins(.horizontal, (proxy.size.width - Self.rungWidth) / 2, for: .scrollContent)
            // Rungs cut off mid-glyph at either end read as damage, not as more ladder.
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0), .init(color: .black, location: 24 / proxy.size.width),
                        .init(color: .black, location: 1 - 24 / proxy.size.width), .init(color: .clear, location: 1),
                    ], startPoint: .leading, endPoint: .trailing)
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

extension Color {
    fileprivate static let deckInk = Color(red: 0xED / 255, green: 1, blue: 1)
    /// The app's colour for "not where it rests": the needle and the reset.
    fileprivate static let deckAmber = Color(red: 1, green: 0xD4 / 255, blue: 0x79 / 255)
    fileprivate static let deckNight = Color(red: 0x14 / 255, green: 0x18 / 255, blue: 0x1C / 255)
    fileprivate static let deckSurface = deckNight.opacity(0.92)
}

/// The web app's sizes (ClockDeck.vue), shared by the layout and the surface.
private enum Metrics {
    static let radius = 16.0
    static let rowHeight = 46.0
    static let scaleHeight = 42.0
    static let gap = 6.0
    static let stampWidth = 96.0
    /// A 34 pt disc in a 44 pt box: 5 pt of the box either side is not surface.
    static let playBox = 44.0
    static let playDisc = 34.0
    /// A 30 pt disc in a 34 pt box.
    static let chipBox = 34.0
    static let chipDisc = 30.0
    /// The surface's margin around the controls.
    static let pad = 8.0
}

/// UTC on a 24-hour clock whatever the locale's: asked of the locale with its
/// AM and PM left out, a 12-hour one reads 19:00 as 07:00.
private enum UTCClock {
    private static let calendar = Calendar(identifier: .gregorian)

    static func time(_ date: Date) -> String {
        date.formatted(
            Date.VerbatimFormatStyle(
                format: "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits)", timeZone: .gmt,
                calendar: calendar))
    }

    static func hourMinute(_ date: Date) -> String {
        date.formatted(
            Date.VerbatimFormatStyle(
                format: "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)", timeZone: .gmt, calendar: calendar))
    }
}
