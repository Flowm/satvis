import Foundation
import Synchronization

/// Counts the view's drawables in use, so that while the frames fall behind a frame
/// begins only once one is free: `currentDrawable` blocked an iPad mini's main thread
/// 20 ms a frame. Gating every frame lost refreshes at 120 fps.
final class DrawableGate: Sendable {
    private struct State {
        /// Drawables taken and not yet handed back.
        var inUse = 0
        /// Whether a frame's work takes longer than a refresh.
        var behind = false
        /// Whether one is on the screen, which the next one shown hands back.
        var showing = false
        /// Since when frames have been turned away, in seconds of uptime.
        var shutSince: Double?
        /// Whether a frame was turned away since one was last let through.
        var turnedAway = false
        /// Whether the next frame is turned away to drain a frame queued too many.
        var drains = false
    }

    /// Seconds frames are turned away before one takes a drawable anyway, in case
    /// one came back uncounted.
    static let patience = 0.25
    private let state = Mutex(State())

    /// Whether a frame may take a drawable, of `maximum`, at `now` in seconds of
    /// uptime: one is free, or the frames keep up and one will be soon.
    func mayTake(maximum: Int, at now: Double) -> Bool {
        state.withLock { state in
            if state.drains {
                state.drains = false
                return false
            }
            guard state.inUse >= maximum, state.behind else {
                state.shutSince = nil
                state.turnedAway = false
                return true
            }
            state.turnedAway = true
            guard let shut = state.shutSince else {
                state.shutSince = now
                return false
            }
            guard now - shut > Self.patience else {
                return false
            }
            state.inUse = maximum - 1
            state.shutSince = nil
            state.turnedAway = false
            return true
        }
    }

    /// Whether a frame's work takes longer than a frame's interval.
    func setBehind(_ behind: Bool) {
        state.withLock { $0.behind = behind }
    }

    /// A drawable taken for a frame after waiting `waited` seconds, of frames asked
    /// for every `interval`. Over half an interval, a frame too many is queued, as
    /// an iPad mini kept after a moment behind: 16 ms a frame of its main thread.
    func drawableTaken(waited: Double, interval: Double) {
        state.withLock {
            $0.inUse += 1
            $0.drains = waited > interval / 2
        }
    }

    /// A drawable taken and left unpresented.
    func drawableUnused() {
        state.withLock { $0.inUse = max(0, $0.inUse - 1) }
    }

    /// A drawable presented, `shown` or dropped unshown; true where that frees one
    /// for a frame turned away, which then need not wait for the next refresh: an
    /// idle GPU meanwhile held every active orbit at 40 fps on an iPad mini, not 45.
    func beginsTurnedAwayFrame(afterPresenting shown: Bool) -> Bool {
        state.withLock { state in
            let freed = !shown || state.showing
            if freed {
                state.inUse = max(0, state.inUse - 1)
            }
            state.showing = state.showing || shown
            defer { state.turnedAway = false }
            return freed && state.turnedAway
        }
    }
}
