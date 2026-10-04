import Foundation
import Testing

@testable import SatvisCore

@Suite struct PassNotificationTests {
    private let now = 1_800_000_000_000.0
    private let station = UUID()

    private func pass(_ minutesAhead: Double, satellite: String = "1|SAT") -> Pass {
        let start = now + minutesAhead * 60_000
        return Pass(
            satellite: satellite, satelliteName: "SAT", station: "Home", stationID: station, start: start, end: start + 600_000,
            measure: .elevation(maxElevation: 40, azimuthStart: 0, azimuthApex: 90, azimuthEnd: 180, apex: nil))
    }

    // One notice five minutes before and one as it starts, the earliest first.
    @Test func noticesEachPassTwice() {
        let plan = PassNotificationPlan(passes: [pass(60), pass(30)], now: now, predictedUntil: now + 86_400_000)
        #expect(plan.notices.map(\.fire) == [25, 30, 55, 60].map { now + $0 * 60_000 })
        #expect(plan.passCount == 2)
        #expect(plan.coveredUntil == now + 86_400_000)
        #expect(!plan.isCutShort)
    }

    // A pass starting within the five minutes still gets its "starting now".
    @Test func keepsTheStartOfAPassTooCloseToWarnOf() {
        let plan = PassNotificationPlan(passes: [pass(2)], now: now, predictedUntil: now + 86_400_000)
        #expect(plan.notices.map(\.lead) == [0])
    }

    // More passes than iOS keeps notifications for: covered only until the last
    // one kept, and woken an hour before that.
    @Test func saysHowFarTheLimitReaches() {
        let passes = (1...50).map { pass(Double($0) * 5, satellite: "\($0)|SAT") }
        let plan = PassNotificationPlan(passes: passes, now: now, predictedUntil: now + 4 * 86_400_000)
        #expect(plan.notices.count == PassNotificationPlan.limit)
        #expect(plan.isCutShort)
        #expect(plan.coveredUntil == plan.notices.last?.fire)
        #expect(plan.refresh(after: now) == plan.coveredUntil - 3_600_000)
    }

    @Test func wakesWithinFourHoursAndNotWithinAQuarter() {
        let far = PassNotificationPlan(passes: [pass(60)], now: now, predictedUntil: now + 4 * 86_400_000)
        #expect(far.refresh(after: now) == now + 4 * 3_600_000)
        let soon = PassNotificationPlan(passes: (1...40).map { pass(Double($0), satellite: "\($0)|SAT") }, now: now, predictedUntil: now + 86_400_000)
        #expect(soon.refresh(after: now) == now + 15 * 60_000)
    }
}
