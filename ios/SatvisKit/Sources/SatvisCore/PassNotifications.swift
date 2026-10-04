import Foundation

/// Which pass notifications to keep pending, out of every pass predicted for the
/// alerts: one before each pass and one as it starts, the earliest first, as many
/// as iOS keeps for an app. And how long that covers, so the app can ask to be
/// woken before it runs out.
public struct PassNotificationPlan: Sendable {
    public struct Notice: Sendable, Hashable {
        public var pass: Pass
        /// How long before the pass it fires, in milliseconds: 0 as it starts.
        public var lead: Double
        /// When it fires, in UTC milliseconds since 1970.
        public var fire: Double
    }

    /// Notifications iOS keeps pending for an app.
    public static let limit = 64
    public static let lead = 5 * 60_000.0

    /// By when they fire.
    public let notices: [Notice]
    /// Until when the notices cover every pass: the prediction's end, or sooner
    /// when there were more than iOS keeps. Nothing is pending after it.
    public let coveredUntil: Double
    /// Whether there were more notices than iOS keeps, so the passes after
    /// `coveredUntil` wait for the next plan.
    public let isCutShort: Bool

    /// How many passes the notices are for.
    public var passCount: Int {
        Set(notices.map(\.pass)).count
    }

    /// Every notice still to come. A pass starting within the lead keeps its
    /// notice for the start.
    public init(passes: some Sequence<Pass>, now: Double, predictedUntil: Double, limit: Int = Self.limit, lead: Double = Self.lead) {
        let all = Set(passes).flatMap { pass in
            [lead, 0].map { Notice(pass: pass, lead: $0, fire: pass.start - $0) }
        }.filter { $0.fire > now }.sorted { ($0.fire, $0.lead) < ($1.fire, $1.lead) }
        notices = Array(all.prefix(limit))
        isCutShort = all.count > limit
        coveredUntil = isCutShort ? notices.last?.fire ?? now : predictedUntil
    }

    /// When to ask to be woken to plan again: an hour before the notices run out,
    /// but not sooner than a quarter of an hour, nor later than four hours, from now.
    public func refresh(after now: Double) -> Double {
        min(max(coveredUntil - 3_600_000, now + 15 * 60_000), now + 4 * 3_600_000)
    }
}
