import Testing

@testable import SatvisRender

@Suite struct DrawableGateTests {
    // Three taken: the next waits until one shown replaces another, or a dropped
    // one comes back.
    @Test func letsAFrameBeginOnceADrawableIsFree() {
        let gate = DrawableGate()
        gate.setBehind(true)
        for _ in 0..<3 {
            #expect(gate.mayTake(maximum: 3, at: 0))
            gate.drawableTaken(waited: 0, interval: 1.0 / 60)
        }
        #expect(!gate.mayTake(maximum: 3, at: 0))
        // The first on the screen hands nothing back; the second shown, the first,
        // and the frame turned away begins at once.
        #expect(!gate.beginsTurnedAwayFrame(afterPresenting: true))
        #expect(!gate.mayTake(maximum: 3, at: 0.01))
        #expect(gate.beginsTurnedAwayFrame(afterPresenting: true))
        #expect(gate.mayTake(maximum: 3, at: 0.02))
        gate.drawableTaken(waited: 0, interval: 1.0 / 60)
        // Nothing turned away meanwhile: nothing to begin.
        #expect(!gate.beginsTurnedAwayFrame(afterPresenting: false))
        #expect(gate.mayTake(maximum: 3, at: 0.03))
        // The frames keeping up: taken, one coming back soon.
        gate.setBehind(false)
        gate.drawableTaken(waited: 0, interval: 1.0 / 60)
        gate.drawableTaken(waited: 0, interval: 1.0 / 60)
        #expect(gate.mayTake(maximum: 3, at: 0.04))
        #expect(!gate.beginsTurnedAwayFrame(afterPresenting: true))
    }

    // Waiting a refresh for a drawable, a frame too many is queued: the next call is
    // turned away once, without beginning it early.
    @Test func drainsAFrameQueuedTooMany() {
        let gate = DrawableGate()
        gate.drawableTaken(waited: 0.016, interval: 1.0 / 60)
        #expect(!gate.mayTake(maximum: 3, at: 0))
        #expect(gate.mayTake(maximum: 3, at: 0.017))
        #expect(!gate.beginsTurnedAwayFrame(afterPresenting: true))
    }

    // A drawable that came back uncounted shuts the gate only for a while.
    @Test func opensAfterItsPatience() {
        let gate = DrawableGate()
        gate.setBehind(true)
        for _ in 0..<3 {
            gate.drawableTaken(waited: 0, interval: 1.0 / 60)
        }
        #expect(!gate.mayTake(maximum: 3, at: 1))
        #expect(!gate.mayTake(maximum: 3, at: 1.2))
        #expect(gate.mayTake(maximum: 3, at: 1.3))
    }
}
