import SwiftUI

/// The launch screen's logo come to life as the app opens: the boosters light
/// and the shuttle climbs out of the top of the screen. Its first frame is the
/// launch screen itself (`UILaunchScreen` in `Info.plist`), the logo's layers
/// stacked where the system centred the whole logo, so nothing jumps as the app
/// takes over. The background is black, as space behind the globe is, and
/// clears once the shuttle has almost left the screen, so the globe comes up out
/// of it with no change of colour. The globe takes every touch meanwhile.
struct LaunchAnimation: View {
    /// Whether the animation is over, and the view gone.
    @State private var isOver = Self.isSkipped
    @State private var hasStarted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A launch that is driven or measured shows the globe alone: the UI tests
    /// and the screenshots, which pin the clock, and a benchmark run.
    private static let isSkipped =
        ProcessInfo.processInfo.environment["SATVIS_TEST_CATALOG"] != nil || ViewerClock.launchTime != nil || Benchmark.runsAtLaunch

    /// The launch image's side, in points: `space-shuttle.svg`'s size.
    private static let side: CGFloat = 240
    /// Points to a unit of the logo's 576-unit drawing.
    private static let unit = side / 576
    /// The logo's exhaust colour.
    private static let exhaust = Color(red: 1, green: 0.922, blue: 0.82)
    /// The exhaust under the two boosters: each cloud's picture and the centre
    /// of the column above it, in the logo's units.
    private static let plumes: [(cloud: ImageResource, centre: CGFloat)] = [(.launchExhaustLeft, 234.35), (.launchExhaustRight, 341.65)]
    /// The columns' width, the boosters' nozzles and the top of the clouds, in
    /// the logo's units.
    private static let columnWidth: CGFloat = 15.5
    private static let nozzles: CGFloat = 442
    private static let cloudTop: CGFloat = 476
    /// Seconds from the first frame to the last of the smoke.
    private static let duration = 1.5

    private struct Frame {
        /// How far the shuttle has climbed, from the pad to out of sight.
        var climb: CGFloat = 0
        /// The shuttle's sideways rumble, in points.
        var rumble: CGFloat = 0
        /// The exhaust clouds' scale.
        var cloud: CGFloat = 1
        /// The opacity of the background, the sky and the exhaust over the globe.
        var veil: CGFloat = 1
    }

    var body: some View {
        // Reduce Motion goes from the launch screen straight to the globe.
        if !isOver, !reduceMotion {
            GeometryReader { geometry in
                KeyframeAnimator(initialValue: Frame(), trigger: hasStarted) { frame in
                    picture(frame, height: geometry.size.height)
                } keyframes: { _ in
                    KeyframeTrack(\.climb) {
                        LinearKeyframe(0, duration: 0.3)
                        LinearKeyframe(1, duration: 0.9, timingCurve: .easeIn)
                        LinearKeyframe(1, duration: 1)
                    }
                    KeyframeTrack(\.rumble) {
                        LinearKeyframe(0, duration: 0.1)
                        for step in 0..<12 {
                            LinearKeyframe(step.isMultiple(of: 2) ? 1.2 : -1.2, duration: 0.05)
                        }
                        LinearKeyframe(0, duration: 0.05)
                    }
                    KeyframeTrack(\.cloud) {
                        LinearKeyframe(1, duration: 0.1)
                        LinearKeyframe(1.35, duration: 0.2, timingCurve: .easeOut)
                        LinearKeyframe(2.2, duration: 0.9, timingCurve: .easeOut)
                        LinearKeyframe(2.2, duration: 1)
                    }
                    // Clears once the shuttle is most of the way up.
                    KeyframeTrack(\.veil) {
                        LinearKeyframe(1, duration: 1)
                        LinearKeyframe(0, duration: Self.duration - 1.05)
                        LinearKeyframe(0, duration: 1)
                    }
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .task {
                hasStarted = true
                // Before the tracks end, which hold their last values until then: an
                // animator that has run out goes back to its first frame.
                try? await Task.sleep(for: .seconds(Self.duration))
                isOver = true
            }
        }
    }

    private func picture(_ frame: Frame, height: CGFloat) -> some View {
        // From the pad to the whole shuttle past the top edge.
        let rise = frame.climb * (height / 2 + Self.side / 2)
        return ZStack {
            Color(.launchBackground)
                .opacity(frame.veil)
            ZStack {
                Image(.launchSky)
                    .opacity(frame.veil)
                ZStack {
                    ForEach(Self.plumes, id: \.centre) { plume in
                        // The cloud alone grows, cut from its picture below the column,
                        // and from the column's foot, to stay under it.
                        Image(plume.cloud)
                            .mask(alignment: .bottom) {
                                Rectangle().frame(height: (576 - Self.cloudTop) * Self.unit)
                            }
                            .scaleEffect(frame.cloud, anchor: UnitPoint(x: plume.centre / 576, y: 1))
                        // The column, drawn out from the cloud to the climbing nozzle.
                        let length = (Self.cloudTop - Self.nozzles) * Self.unit + rise
                        Rectangle()
                            .fill(Self.exhaust)
                            .frame(width: Self.columnWidth * Self.unit, height: length)
                            .position(x: plume.centre * Self.unit, y: Self.cloudTop * Self.unit - length / 2)
                    }
                }
                // As one picture, or the clouds show through each other as they fade.
                .compositingGroup()
                .opacity(frame.veil)
                Image(.launchShuttle)
                    .offset(x: frame.rumble, y: -rise)
            }
            .frame(width: Self.side, height: Self.side)
        }
    }
}
