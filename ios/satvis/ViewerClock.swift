import Foundation
import Observation
import SatvisCore

/// The clock everything is drawn at, for the views to read and steer.
@Observable
final class ViewerClock {
    private(set) var clock: SimulationClock

    /// `SATVIS_TIME` in the launch environment (ISO 8601, UTC) pins the clock at
    /// that instant, paused, for screenshots and tests.
    static let launchTime: Double? = ProcessInfo.processInfo.environment["SATVIS_TIME"]
        .flatMap { try? Date($0, strategy: .iso8601) }
        .map { ($0.timeIntervalSince1970 * 1000).rounded(.down) }

    init() {
        let real = Self.real()
        if let launchTime = Self.launchTime {
            var clock = SimulationClock(pinnedAt: launchTime, real: real)
            clock.setPlaying(false, at: real)
            self.clock = clock
        } else {
            clock = SimulationClock(real: real)
        }
    }

    static func real() -> Double {
        (Date().timeIntervalSince1970 * 1000).rounded(.down)
    }

    /// The instant to draw, now.
    func now() -> Double {
        clock.time(at: Self.real())
    }

    func togglePlaying() {
        clock.setPlaying(!clock.isPlaying, at: Self.real())
    }

    func setMultiplier(_ multiplier: Double) {
        clock.setMultiplier(multiplier, at: Self.real())
    }

    func scrub(to time: Double) {
        clock.scrub(to: time, at: Self.real())
    }

    func goLive() {
        clock.goLive(at: Self.real())
    }
}
