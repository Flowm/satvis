import Foundation

/// A satellite's positions on a uniform time grid anchored to its element set's
/// epoch, 120 an orbit, from half an orbit back to one and a half forward: the
/// web app's sampled trajectory (`SampledTrajectory`, `trajectoryWindow.ts`).
/// Positions are in the pseudo-fixed frame, in metres, and are read back by a
/// six-node Lagrange interpolation, as `GridPositionProperty` reads them.
public struct SampledTrajectory: Sendable {
    public static let samplesPerOrbit = 120.0
    public static let orbitsBack = 0.5
    public static let orbitsForward = 1.5
    /// Nodes per interpolation: a quintic, which the web app chose because a cubic
    /// was kilometres out on long, eccentric orbits.
    public static let stencil = 6

    /// The instant grid index 0 falls on: the element set's epoch.
    public let anchorMilliseconds: Double
    public let stepMilliseconds: Double
    /// The grid index of `positions[0]`.
    public let firstIndex: Int
    public let positions: [SIMD3<Double>]

    /// Samples the window around `epochMilliseconds`. Nil when SGP4 fails anywhere
    /// in it, e.g. for a satellite that has decayed.
    public init?(_ propagator: SGP4Propagator, around epochMilliseconds: Double) {
        // As the web app's sgp4Worker grids it: one revolution of the mean motion
        // SGP4 recovered, over the sampling rate.
        let periodMilliseconds = 2 * Double.pi / propagator.meanMotion * 60_000
        guard periodMilliseconds.isFinite, periodMilliseconds > 0 else {
            return nil
        }
        let anchor = (propagator.epochJulianDate - 2440587.5) * msPerDay
        let step = periodMilliseconds / Self.samplesPerOrbit
        let first = Int(((epochMilliseconds - Self.orbitsBack * periodMilliseconds - anchor) / step).rounded(.down)) - Self.stencil / 2
        let last = Int(((epochMilliseconds + Self.orbitsForward * periodMilliseconds - anchor) / step).rounded(.up)) + Self.stencil / 2
        var positions: [SIMD3<Double>] = []
        positions.reserveCapacity(last - first + 1)
        for index in first...last {
            let instant = anchor + Double(index) * step
            // Propagated at the whole millisecond a JavaScript Date holds, and rotated
            // from the truncated anchor, both as the web app does.
            guard let state = try? propagator.state(epochMilliseconds: instant.rounded(.towardZero)) else {
                return nil
            }
            positions.append(temeToFixed(state.position * 1000, epochMilliseconds: anchor.rounded(.towardZero) + Double(index) * step))
        }
        self.anchorMilliseconds = anchor
        self.stepMilliseconds = step
        self.firstIndex = first
        self.positions = positions
    }

    /// Where an interpolation at this instant starts in `positions`, and how far
    /// past that node it is, in steps (2 ≤ fraction < 3 for a centred stencil).
    /// Nil outside the samples.
    public func stencil(at epochMilliseconds: Double) -> (start: Int, offset: Double)? {
        let u = (epochMilliseconds - anchorMilliseconds) / stepMilliseconds - Double(firstIndex)
        let node = Int(u.rounded(.down))
        let start = node - (Self.stencil / 2 - 1)
        guard start >= 0, start + Self.stencil <= positions.count else {
            return nil
        }
        return (start, u - Double(start))
    }

    public func position(at epochMilliseconds: Double) -> SIMD3<Double>? {
        guard let (start, offset) = stencil(at: epochMilliseconds) else {
            return nil
        }
        let weights = lagrangeWeights(offset)
        var sum = SIMD3<Double>()
        for node in 0..<Self.stencil {
            sum += weights[node] * positions[start + node]
        }
        return sum
    }

    /// Whether the window still has a full half orbit behind and an orbit ahead of
    /// this instant. Refill it when not.
    public func isFresh(at epochMilliseconds: Double) -> Bool {
        let period = stepMilliseconds * Self.samplesPerOrbit
        let start = anchorMilliseconds + Double(firstIndex) * stepMilliseconds
        let end = start + Double(positions.count - 1) * stepMilliseconds
        return epochMilliseconds >= start + 0.25 * period && epochMilliseconds <= end - period
    }
}

/// The Lagrange basis on nodes 0...5 at `u`. The Metal shader computes the same.
func lagrangeWeights(_ u: Double) -> [Double] {
    (0..<SampledTrajectory.stencil).map { j in
        var weight = 1.0
        for m in 0..<SampledTrajectory.stencil where m != j {
            weight *= (u - Double(m)) / Double(j - m)
        }
        return weight
    }
}
