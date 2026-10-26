import SatvisCore
import SatvisRender
import SwiftUI

/// The sky view's instruments over the picture (SkyHud.vue): the crosshair, a
/// compass tape across the top and an elevation tape down the right, the locked
/// satellite's path across the sky, and its card. Drawn every frame from the
/// renderer's last one, and transparent to touches: the controls under it stay
/// usable, and a tap is the session's.
struct SkyHUD: View {
    let renderer: GlobeRenderer
    /// The controls along the top, which the tapes run round, never under. Nil
    /// until laid out, and the tapes with it.
    let controls: TopControls?
    /// The info card over the trailing side, in the HUD's frame, for the lock's
    /// card to stand clear of it where it reaches the lower half.
    var infoCard: CGRect?
    /// The session's word for the user, over the lock's card.
    var notice: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation) { context in
            GeometryReader { proxy in
                let settled = renderer.isSkySettled
                // Up as the ground arrives: projected against a camera still in
                // flight, the tapes would swim across the screen.
                SkyInstruments(renderer: renderer, controls: controls, infoCard: infoCard, notice: notice, size: proxy.size, date: context.date)
                    .opacity(settled ? 1 : 0)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.4), value: settled)
            }
        }
        .allowsHitTesting(false)
    }
}

/// The controls along the top, in the HUD's frame: the menu column at the
/// leading corner and the buttons at the trailing one.
struct TopControls: Equatable {
    /// The menu column, open or folded, without a panel beside it.
    var menu: CGRect
    /// The corner's buttons: the way home, the compass, the end of tracking.
    var buttons: CGRect
}

/// One frame of the instruments. The date is what makes it one: a view whose
/// inputs have not changed is not drawn again, and the lock would stand still.
private struct SkyInstruments: View {
    let renderer: GlobeRenderer
    let controls: TopControls?
    let infoCard: CGRect?
    let notice: String?
    let size: CGSize
    let date: Date

    private static let lockColor = Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
    private static let traceColor = Color(red: 0x7D / 255, green: 0xD3 / 255, blue: 0xFC / 255)

    var body: some View {
        let lock = renderer.skyLock(viewSize: size)
        ZStack(alignment: .bottom) {
            Canvas { context, size in
                guard let camera = renderer.skyCamera else {
                    return
                }
                if let lock {
                    trace(renderer.skyTrace(of: lock.id, viewSize: size), in: &context)
                }
                if let controls {
                    compassTape(camera, around: controls, size: size, in: &context)
                    elevationTape(camera, around: controls, size: size, in: &context)
                }
                reticle(locked: lock != nil, size: size, in: &context)
            }
            // Above the clock deck.
            VStack(spacing: 12) {
                if let notice {
                    NoticeBanner(text: notice)
                }
                if let lock {
                    card(lock)
                }
            }
            .padding(.bottom, 136)
            .padding(.trailing, infoCard.map { $0.maxY > size.height / 2 ? size.width - $0.minX + PanelMetrics.gap : 0 } ?? 0)
        }
    }

    // MARK: The pieces

    private func reticle(locked: Bool, size: CGSize, in context: inout GraphicsContext) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        var path = Path(ellipseIn: CGRect(x: c.x - 10, y: c.y - 10, width: 20, height: 20))
        for (dx, dy) in [(1.0, 0.0), (-1, 0), (0, 1), (0, -1)] {
            path.move(to: CGPoint(x: c.x + 14 * dx, y: c.y + 14 * dy))
            path.addLine(to: CGPoint(x: c.x + 26 * dx, y: c.y + 26 * dy))
        }
        context.stroke(path, with: .color(locked ? Self.lockColor : Color.panelInk.opacity(0.55)), lineWidth: 2)
    }

    private func trace(_ runs: [[CGPoint]], in context: inout GraphicsContext) {
        for run in runs {
            var path = Path()
            path.addLines(run)
            context.stroke(path, with: .color(Self.traceColor.opacity(0.85)), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
        }
    }

    /// Where the compass tape runs: its rule's height and its ends. Over the
    /// controls where they stand 60 pt down or more, as under a notch or the
    /// Dynamic Island, whose status bar keeps to the ears and leaves the band over
    /// them free. Else, on an iPad or in landscape, between the menu and the
    /// buttons, level with the buttons, where that leaves 200 pt about the middle.
    /// Else, on an iPhone with a Home button, under both.
    private static func compassTape(around controls: TopControls, width: CGFloat) -> (rule: CGFloat, from: CGFloat, to: CGFloat) {
        let (menu, buttons) = (controls.menu, controls.buttons)
        if buttons.minY >= 60 {
            return (buttons.minY - 4, 0, width)
        }
        let from = menu.maxX + 16
        let to = buttons.minX - 16
        if to - from >= 200, from < width / 2 - 60, to > width / 2 + 60 {
            return (buttons.minY + 30, from, to)
        }
        return (max(menu.maxY, buttons.maxY) + 22, 0, width)
    }

    /// Headings across the top, spaced by the tangent of their angle from the
    /// view's, so the tape holds its scale whatever the pitch.
    private func compassTape(_ camera: SkyCamera, around controls: TopControls, size: CGSize, in context: inout GraphicsContext) {
        let width = size.width
        let (rule, from, to) = Self.compassTape(around: controls, width: width)
        let horizontal = 2 * atan(tan(camera.verticalFieldOfView / 2) * width / size.height)
        let heading = camera.azimuth * 180 / .pi
        let step = Self.step(span: horizontal * 180 / .pi)
        var ticks: [(x: CGFloat, value: Int, major: Bool)] = []
        let first = Int((heading - 90) / Double(step)) * step - step
        for value in stride(from: first, through: Int(heading + 90) + step, by: step) {
            let offset = remainder(Double(value) - heading, 360)
            guard abs(offset) < 90 else {
                continue
            }
            let x = width / 2 + width / 2 * tan(offset * .pi / 180) / tan(horizontal / 2)
            // Room for a label either side of the tick.
            guard x >= from + 16, x <= to - 16 else {
                continue
            }
            let wrapped = ((value % 360) + 360) % 360
            ticks.append((x, wrapped, wrapped % (3 * step) == 0 || wrapped % 45 == 0))
        }
        var line = Path()
        line.move(to: CGPoint(x: from, y: rule))
        line.addLine(to: CGPoint(x: to, y: rule))
        context.stroke(line, with: .color(Color.panelInk.opacity(0.25)), lineWidth: 1)
        for tick in Self.thinned(ticks, by: \.x, major: \.major) {
            var path = Path()
            path.move(to: CGPoint(x: tick.x, y: rule - (tick.major ? 8 : 4)))
            path.addLine(to: CGPoint(x: tick.x, y: rule))
            context.stroke(path, with: .color(Color.panelInk.opacity(tick.major ? 0.9 : 0.5)), lineWidth: tick.major ? 1.5 : 1)
            if tick.major {
                let text = tick.value % 45 == 0 ? compassPoint(Double(tick.value)) : "\(tick.value)°"
                label(text, at: CGPoint(x: tick.x, y: rule - 15), anchor: .center, in: &context)
            }
        }
        // Under the rule, between the menu and the corner's buttons.
        var pointer = Path()
        pointer.move(to: CGPoint(x: width / 2, y: rule))
        pointer.addLine(to: CGPoint(x: width / 2 + 7, y: rule + 9))
        pointer.addLine(to: CGPoint(x: width / 2 - 7, y: rule + 9))
        pointer.closeSubpath()
        context.fill(pointer, with: .color(Self.lockColor))
    }

    /// Elevations down the margin right of the corner's buttons, from their top,
    /// labelled only below them and the compass tape, where a label has room.
    private func elevationTape(_ camera: SkyCamera, around controls: TopControls, size: CGSize, in context: inout GraphicsContext) {
        let buttons = controls.buttons
        let x = buttons.maxX + 4
        let labelsFrom = max(buttons.maxY, Self.compassTape(around: controls, width: size.width).rule + 9) + 8
        let fieldOfView = camera.verticalFieldOfView * 180 / .pi
        let step = Self.step(span: fieldOfView)
        let pitch = camera.pitch * 180 / .pi
        let azimuth = camera.azimuth * 180 / .pi
        let low = max(pitch - (fieldOfView / 2 + Double(step)), -90)
        let high = min(pitch + fieldOfView / 2 + Double(step), 90)
        var ticks: [(y: CGFloat, value: Int, major: Bool)] = []
        for value in stride(from: Int((low / Double(step)).rounded(.up)) * step, through: Int(high), by: step) {
            if let point = renderer.skyPoint(azimuth: azimuth, elevation: Double(value), viewSize: size), (buttons.minY...size.height).contains(point.y) {
                ticks.append((point.y, value, value % (3 * step) == 0))
            }
        }
        var line = Path()
        line.move(to: CGPoint(x: x, y: buttons.minY))
        line.addLine(to: CGPoint(x: x, y: size.height))
        context.stroke(line, with: .color(Color.panelInk.opacity(0.25)), lineWidth: 1)
        for tick in Self.thinned(ticks, by: \.y, major: \.major) {
            var path = Path()
            path.move(to: CGPoint(x: x, y: tick.y))
            path.addLine(to: CGPoint(x: x + (tick.major ? 8 : 4), y: tick.y))
            context.stroke(path, with: .color(Color.panelInk.opacity(tick.major ? 0.9 : 0.5)), lineWidth: tick.major ? 1.5 : 1)
            if tick.major, tick.y >= labelsFrom {
                label("\(tick.value)°", at: CGPoint(x: x - 5, y: tick.y), anchor: .trailing, in: &context)
            }
        }
    }

    /// Two lines on every device, as the web app's: the name and whether it could
    /// be seen, then where to look. The rest is the info panel's, which the lock
    /// opens; the chevron says so. As wide whatever it holds: sized to its text, it
    /// jumped as the crosshair went from one satellite to the next.
    private func card(_ target: SkyTarget) -> some View {
        let position = SkyCard.position(azimuth: target.azimuth, elevation: target.elevation, range: target.range)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(target.name).fontWeight(.semibold).lineLimit(1)
                Spacer(minLength: 0)
                chip(target.visibility)
            }
            HStack(spacing: 8) {
                // Two lines rather than an ellipsis at the largest text sizes.
                Text(position.text).lineLimit(2)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).opacity(0.6)
            }
        }
        .monospacedDigit()
        .font(.footnote)
        .foregroundStyle(Color.panelInk)
        .frame(width: min(cardWidth, size.width - 52), alignment: .leading)
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .panel()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(target.name)
        .accessibilityValue("\(target.visibility.label). \(position.spoken)")
        .accessibilityHint("Tap to open")
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// The verdict, green where the satellite could be seen.
    private func chip(_ visibility: SatvisCore.Visibility) -> some View {
        let seen = visibility == .visible
        return Text(visibility.label)
            .font(.caption2)
            .foregroundStyle(seen ? Self.lockColor : Color.panelInk)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(seen ? Self.lockColor.opacity(0.2) : Color.white.opacity(0.12), in: Capsule())
    }

    /// Points inside the padding: room for "359° NNW · 90° up · 38,362 km away"
    /// at the default text size, the web app's 280 px with its padding.
    @ScaledMetric(relativeTo: .footnote) private var cardWidth = 260.0

    private func label(_ text: String, at point: CGPoint, anchor: UnitPoint, in context: inout GraphicsContext) {
        // The image's margin is beyond the text's trailing edge.
        let x = point.x + (anchor == .trailing ? Self.labelMargin : 0)
        if let image = Self.labelImage(text, scale: context.environment.displayScale) {
            context.draw(image, at: CGPoint(x: x, y: point.y), anchor: anchor)
        }
    }

    /// Points round a label's text, for its outline.
    private static let labelMargin = 4.0
    /// The labels drawn so far, by scale and text.
    private static var labelImages: [String: Image] = [:]

    /// A tape's label with its outline, drawn once and kept: resolving the text and
    /// blurring the outline for every label, every frame, took an iPad mini 1.5 ms
    /// of the main thread a frame, a quarter of it in the sky view.
    private static func labelImage(_ text: String, scale: CGFloat) -> Image? {
        let key = "\(scale) \(text)"
        if let image = labelImages[key] {
            return image
        }
        let label = Text(text).font(.system(size: 11).monospacedDigit()).foregroundStyle(Color.panelInk)
        let measure = ImageRenderer(content: label)
        measure.scale = scale
        let size = measure.cgImage.map { CGSize(width: CGFloat($0.width) / scale, height: CGFloat($0.height) / scale) } ?? .zero
        let renderer = ImageRenderer(
            content: Canvas { context, size in
                // An outline, so a label reads over bright ground and sky alike.
                var outline = context
                outline.addFilter(.shadow(color: .black, radius: 1.5))
                outline.draw(context.resolve(label), at: CGPoint(x: size.width / 2, y: size.height / 2), anchor: .center)
            }
            .frame(width: size.width + 2 * labelMargin, height: size.height + 2 * labelMargin))
        renderer.scale = scale
        let image = renderer.cgImage.map { Image(decorative: $0, scale: scale) }
        labelImages[key] = image
        return image
    }

    /// The first spacing that puts at least three ticks across a span of degrees.
    private static func step(span: Double) -> Int {
        [15, 5, 3, 1].first { span / Double($0) >= 3 } ?? 1
    }

    /// No two ticks closer than 26 points, the major ones kept first.
    private static func thinned<Tick>(_ ticks: [Tick], by position: KeyPath<Tick, CGFloat>, major: KeyPath<Tick, Bool>) -> [Tick] {
        var kept: [Tick] = []
        for tick in ticks.filter({ $0[keyPath: major] }) + ticks.filter({ !$0[keyPath: major] })
        where kept.allSatisfy({ abs($0[keyPath: position] - tick[keyPath: position]) >= 26 }) {
            kept.append(tick)
        }
        return kept
    }
}
