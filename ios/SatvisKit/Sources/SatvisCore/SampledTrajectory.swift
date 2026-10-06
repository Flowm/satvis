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
    /// NaN where SGP4 refused the instant, e.g. once a satellite has decayed.
    public let positions: [SIMD3<Double>]

    /// Samples the window around `epochMilliseconds`. A node SGP4 refuses is left
    /// out on its own, as the web app's sampler skips it, so a satellite is hidden
    /// only where its interpolation needs one. Nil when SGP4 refuses every node.
    public init?(_ propagator: SGP4Propagator, around epochMilliseconds: Double) {
        // As the web app's sgp4Worker grids it: one revolution of the mean motion
        // SGP4 recovered, over the sampling rate.
        let periodMilliseconds = Self.periodMilliseconds(propagator)
        guard periodMilliseconds.isFinite, periodMilliseconds > 0, epochMilliseconds.isFinite else {
            return nil
        }
        let anchor = (propagator.epochJulianDate - 2440587.5) * msPerDay
        let step = periodMilliseconds / Self.samplesPerOrbit
        let first = Int(((epochMilliseconds - Self.orbitsBack * periodMilliseconds - anchor) / step).rounded(.down)) - Self.stencil / 2
        let last = Int(((epochMilliseconds + Self.orbitsForward * periodMilliseconds - anchor) / step).rounded(.up)) + Self.stencil / 2
        var positions: [SIMD3<Double>] = []
        positions.reserveCapacity(last - first + 1)
        var propagated = false
        for index in first...last {
            let instant = anchor + Double(index) * step
            // Propagated at the whole millisecond a JavaScript Date holds, and rotated
            // from the truncated anchor, both as the web app does.
            guard let state = try? propagator.state(epochMilliseconds: instant.rounded(.towardZero)) else {
                positions.append(SIMD3(repeating: .nan))
                continue
            }
            propagated = true
            positions.append(temeToFixed(state.position * 1000, epochMilliseconds: anchor.rounded(.towardZero) + Double(index) * step))
        }
        guard propagated else {
            return nil
        }
        self.anchorMilliseconds = anchor
        self.stepMilliseconds = step
        self.firstIndex = first
        self.positions = positions
    }

    /// Where an interpolation at this instant starts in `positions`, and how far
    /// past that node it is, in steps (2 ≤ fraction < 3 for a centred stencil).
    /// Nil outside the samples, and where one of its nodes was refused.
    public func stencil(at epochMilliseconds: Double) -> (start: Int, offset: Double)? {
        guard
            let (start, offset) = Self.stencil(
                at: epochMilliseconds, anchor: anchorMilliseconds, step: stepMilliseconds, firstIndex: firstIndex, count: positions.count),
            positions[start..<start + Self.stencil].allSatisfy({ $0.x.isFinite })
        else {
            return nil
        }
        return (start, offset)
    }

    /// The stencil of a window with these bounds, its nodes' refusals aside: what
    /// a caller holding thousands of windows works out from a few numbers each,
    /// without reading the positions.
    public static func stencil(at epochMilliseconds: Double, anchor: Double, step: Double, firstIndex: Int, count: Int) -> (start: Int, offset: Double)? {
        let u = (epochMilliseconds - anchor) / step - Double(firstIndex)
        // Checked before it becomes an Int, which traps on a NaN or a huge value.
        guard u >= 0, u < Double(count) else {
            return nil
        }
        let start = Int(u.rounded(.down)) - (stencil / 2 - 1)
        guard start >= 0, start + stencil <= count else {
            return nil
        }
        return (start, u - Double(start))
    }

    /// Whether SGP4 gave every node: then no stencil needs its nodes checked.
    public var isComplete: Bool {
        positions.allSatisfy { $0.x.isFinite }
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

extension SampledTrajectory {
    /// One revolution of the mean motion SGP4 recovered.
    static func periodMilliseconds(_ propagator: SGP4Propagator) -> Double {
        2 * Double.pi / propagator.meanMotion * 60_000
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
