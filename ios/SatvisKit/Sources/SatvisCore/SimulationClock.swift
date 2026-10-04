import Foundation

/// The viewer's clock: the instant everything is drawn at, advancing at a chosen
/// rate while it plays. Times are UTC milliseconds since 1970; `real` is the wall
/// clock's, passed in so the clock itself stays a value (`useViewerClock`,
/// `clockDeck.ts`).
///
/// Live vs pinned (CONTEXT.md): the clock starts live, following the present, and
/// is pinned only by a deliberate act, scrubbing to a moment, after which it stays
/// pinned and keeps advancing from there.
public struct SimulationClock: Sendable, Equatable {
    /// Cesium's shuttle-ring ticks, the ladder's rungs on either side of zero.
    public static let speedTicks: [Double] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400]
    public static let ladder: [Double] = speedTicks.reversed().map { -$0 } + speedTicks
    /// Closer than this to the present counts as at it: a minute, the granularity
    /// a link records.
    public static let presentTolerance = 60_000.0

    public private(set) var multiplier = 1.0
    public private(set) var isPlaying = true
    /// Set by scrubbing; cleared only by going back to the present.
    public private(set) var isPinned = false
    private var anchorTime: Double
    private var anchorReal: Double

    public init(real: Double) {
        anchorTime = real
        anchorReal = real
    }

    /// Pinned at an instant from the start, as a link with a time opens.
    public init(pinnedAt time: Double, real: Double) {
        anchorTime = time
        anchorReal = real
        isPinned = true
    }

    public func time(at real: Double) -> Double {
        isPlaying ? anchorTime + (real - anchorReal) * multiplier : anchorTime
    }

    /// Whether the clock shows another moment than the present, pinned or not:
    /// at 60× it leaves the present within a second with nothing touched.
    public func isOffPresent(at real: Double) -> Bool {
        abs(time(at: real) - real) > Self.presentTolerance
    }

    public var rung: Int {
        Self.ladder.indices.min { abs(Self.ladder[$0] - multiplier) < abs(Self.ladder[$1] - multiplier) } ?? 0
    }

    public mutating func setPlaying(_ playing: Bool, at real: Double) {
        reanchor(at: real)
        isPlaying = playing
    }

    public mutating func setMultiplier(_ multiplier: Double, at real: Double) {
        reanchor(at: real)
        self.multiplier = multiplier
    }

    /// Moves to a moment, which pins the clock.
    public mutating func scrub(to time: Double, at real: Double) {
        anchorTime = time
        anchorReal = real
        isPinned = true
    }

    /// Back to the present, and to live. The rate is left as it is.
    public mutating func goLive(at real: Double) {
        anchorTime = real
        anchorReal = real
        isPinned = false
    }

    private mutating func reanchor(at real: Double) {
        anchorTime = time(at: real)
        anchorReal = real
    }

    /// How a rate reads: seconds, minutes, hours or days per second.
    public static func rateLabel(_ multiplier: Double) -> String {
        let magnitude = abs(multiplier)
        let sign = multiplier < 0 ? "−" : ""
        func trim(_ value: Double) -> String {
            let rounded = (value * 100).rounded() / 100
            return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
        }
        switch magnitude {
        case ..<60: return "\(sign)\(trim(magnitude)) s/s"
        case ..<3600: return "\(sign)\(trim(magnitude / 60)) min/s"
        case ..<86400: return "\(sign)\(trim(magnitude / 3600)) h/s"
        default: return "\(sign)\(trim(magnitude / 86400)) d/s"
        }
    }
}
