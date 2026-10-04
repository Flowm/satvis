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
    /// Where the compass tape sits, below the controls along the top.
    let tapeTop: CGFloat

    var body: some View {
        TimelineView(.animation) { context in
            GeometryReader { proxy in
                SkyInstruments(renderer: renderer, tapeTop: tapeTop, size: proxy.size, date: context.date)
            }
        }
        .allowsHitTesting(false)
    }
}

/// One frame of the instruments. The date is what makes it one: a view whose
/// inputs have not changed is not drawn again, and the lock would stand still.
private struct SkyInstruments: View {
    let renderer: GlobeRenderer
    let tapeTop: CGFloat
    let size: CGSize
    let date: Date

    private static let ink = Color(red: 0xED / 255, green: 1, blue: 1)
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
                compassTape(camera, size: size, in: &context)
                elevationTape(camera, size: size, in: &context)
                reticle(locked: lock != nil, size: size, in: &context)
            }
            if let lock {
                // Above the clock deck.
                card(lock)
                    .padding(.bottom, 124)
            }
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
        context.stroke(path, with: .color(locked ? Self.lockColor : Self.ink.opacity(0.55)), lineWidth: 2)
    }

    private func trace(_ runs: [[CGPoint]], in context: inout GraphicsContext) {
        for run in runs {
            var path = Path()
            path.addLines(run)
            context.stroke(path, with: .color(Self.traceColor.opacity(0.85)), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
        }
    }

    /// Headings across the top, spaced by the tangent of their angle from the
    /// view's, so the tape holds its scale whatever the pitch.
    private func compassTape(_ camera: SkyCamera, size: CGSize, in context: inout GraphicsContext) {
        let y = tapeTop
        let width = size.width
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
            let wrapped = ((value % 360) + 360) % 360
            ticks.append((x, wrapped, wrapped % (3 * step) == 0 || wrapped % 45 == 0))
        }
        var rule = Path()
        rule.move(to: CGPoint(x: 0, y: y + 12))
        rule.addLine(to: CGPoint(x: width, y: y + 12))
        context.stroke(rule, with: .color(Self.ink.opacity(0.25)), lineWidth: 1)
        for tick in Self.thinned(ticks, by: \.x, major: \.major) {
            var path = Path()
            path.move(to: CGPoint(x: tick.x, y: tick.major ? y : y + 6))
            path.addLine(to: CGPoint(x: tick.x, y: y + 12))
            context.stroke(path, with: .color(Self.ink.opacity(tick.major ? 0.9 : 0.5)), lineWidth: tick.major ? 1.5 : 1)
            if tick.major {
                let text = tick.value % 45 == 0 ? compassPoint(Double(tick.value)) : "\(tick.value)°"
                label(text, at: CGPoint(x: tick.x, y: y - 9), anchor: .center, in: &context)
            }
        }
        var pointer = Path()
        pointer.move(to: CGPoint(x: width / 2, y: y + 12))
        pointer.addLine(to: CGPoint(x: width / 2 + 7, y: y + 21))
        pointer.addLine(to: CGPoint(x: width / 2 - 7, y: y + 21))
        pointer.closeSubpath()
        context.fill(pointer, with: .color(Self.lockColor))
    }

    /// Elevations down the right edge, where the view draws them.
    private func elevationTape(_ camera: SkyCamera, size: CGSize, in context: inout GraphicsContext) {
        let left = size.width - 64
        let fieldOfView = camera.verticalFieldOfView * 180 / .pi
        let step = Self.step(span: fieldOfView)
        let pitch = camera.pitch * 180 / .pi
        let azimuth = camera.azimuth * 180 / .pi
        let low = max(pitch - (fieldOfView / 2 + Double(step)), -90)
        let high = min(pitch + fieldOfView / 2 + Double(step), 90)
        var ticks: [(y: CGFloat, value: Int, major: Bool)] = []
        for value in stride(from: Int((low / Double(step)).rounded(.up)) * step, through: Int(high), by: step) {
            if let point = renderer.skyPoint(azimuth: azimuth, elevation: Double(value), viewSize: size), (0...size.height).contains(point.y) {
                ticks.append((point.y, value, value % (3 * step) == 0))
            }
        }
        var rule = Path()
        rule.move(to: CGPoint(x: left + 46, y: 0))
        rule.addLine(to: CGPoint(x: left + 46, y: size.height))
        context.stroke(rule, with: .color(Self.ink.opacity(0.25)), lineWidth: 1)
        for tick in Self.thinned(ticks, by: \.y, major: \.major) {
            var path = Path()
            path.move(to: CGPoint(x: left + 46, y: tick.y))
            path.addLine(to: CGPoint(x: left + (tick.major ? 58 : 52), y: tick.y))
            context.stroke(path, with: .color(Self.ink.opacity(tick.major ? 0.9 : 0.5)), lineWidth: tick.major ? 1.5 : 1)
            if tick.major {
                label("\(tick.value)°", at: CGPoint(x: left + 41, y: tick.y), anchor: .trailing, in: &context)
            }
        }
    }

    private func card(_ target: SkyTarget) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(target.name).fontWeight(.semibold)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 2) {
                GridRow {
                    Text("Elevation \(target.elevation, format: .number.precision(.fractionLength(1)))°")
                    Text("Azimuth \(target.azimuth, format: .number.precision(.fractionLength(1)))° \(compassPoint(target.azimuth))")
                }
                GridRow {
                    Text("Range \(Int(target.range.rounded()), format: .number) km")
                    Text("Altitude \(Int(target.altitude.rounded()), format: .number) km")
                }
            }
            .monospacedDigit()
            Text("Tap to open").font(.caption2).opacity(0.7)
        }
        .font(.footnote)
        .foregroundStyle(Self.ink)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minWidth: 220, alignment: .leading)
        .background(Color(red: 0x30 / 255, green: 0x33 / 255, blue: 0x36 / 255).opacity(0.85), in: .rect(cornerRadius: 8))
    }

    private func label(_ text: String, at point: CGPoint, anchor: UnitPoint, in context: inout GraphicsContext) {
        let resolved = context.resolve(Text(text).font(.system(size: 11).monospacedDigit()).foregroundStyle(Self.ink))
        // An outline, so a label reads over bright ground and sky alike.
        var outline = context
        outline.addFilter(.shadow(color: .black, radius: 1.5))
        outline.draw(resolved, at: point, anchor: anchor)
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
