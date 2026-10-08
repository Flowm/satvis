import Testing

@testable import SatvisCore

@Suite struct SimulationClockTests {
    private let start = 1_790_000_000_000.0

    @Test func followsThePresentUntilTouched() {
        let clock = SimulationClock(real: start)
        #expect(clock.time(at: start + 5000) == start + 5000)
        #expect(!clock.isOffPresent(at: start + 5000))
        #expect(!clock.isPinned)
    }

    @Test func leavesThePresentAtSpeedWithoutPinning() {
        var clock = SimulationClock(real: start)
        clock.setMultiplier(60, at: start + 1000)
        #expect(clock.time(at: start + 3000) == start + 1000 + 2000 * 60)
        #expect(clock.isOffPresent(at: start + 3000))
        #expect(!clock.isPinned)
        #expect(SimulationClock.ladder[clock.rung] == 60)
    }

    @Test func holdsWhilePausedAndResumesFromThere() {
        var clock = SimulationClock(real: start)
        clock.setPlaying(false, at: start + 1000)
        #expect(clock.time(at: start + 9000) == start + 1000)
        clock.setPlaying(true, at: start + 9000)
        #expect(clock.time(at: start + 10000) == start + 2000)
    }

    @Test func scrubbingPinsAndGoingLiveUnpins() {
        var clock = SimulationClock(real: start)
        clock.scrub(to: start - 3_600_000, at: start)
        #expect(clock.isPinned)
        #expect(clock.time(at: start + 1000) == start - 3_599_000)
        clock.goLive(at: start + 2000)
        #expect(!clock.isPinned)
        #expect(clock.time(at: start + 2000) == start + 2000)
    }

    // As the web app's Back to now: paused at 600x it would leave the present again.
    @Test func goingLivePlaysAtRealTime() {
        var clock = SimulationClock(real: start)
        clock.setMultiplier(600, at: start)
        clock.setPlaying(false, at: start + 1000)
        clock.goLive(at: start + 5000)
        #expect(clock.multiplier == 1)
        #expect(clock.isPlaying)
        #expect(!clock.isOffPresent(at: start + 65_000))
    }

    @Test func labelsRatesAsTheWebAppDoes() {
        #expect(SimulationClock.rateLabel(1) == "1 s/s")
        #expect(SimulationClock.rateLabel(-120) == "−2 min/s")
        #expect(SimulationClock.rateLabel(21600) == "6 h/s")
        #expect(SimulationClock.rateLabel(86400) == "1 d/s")
        #expect(SimulationClock.ladder.count == 36)
    }
}
