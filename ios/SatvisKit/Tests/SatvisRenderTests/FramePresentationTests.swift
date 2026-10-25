import Testing

@testable import SatvisRender

@Suite struct FramePresentationTests {
    static let refresh = 1 / 60.0

    static func predict(
        now: Double, span: Double, gpu: Double? = nil, gpuDone: Double = -.infinity, queued: [Double] = [], vsync: Double = 0, interval: Double = refresh,
        previous: Double? = nil
    ) -> Double {
        PresentationTime.predict(
            now: now, cpu: 0.002, gpu: .init(span: span, perFrame: gpu ?? span, done: gpuDone, queued: queued),
            screen: .init(refresh: refresh, vsync: vsync, interval: interval), previous: previous)
    }

    // Done within the refresh it began in: shown on the next, one ahead.
    @Test func showsACheapFrameOnTheNextRefresh() {
        #expect(abs(Self.predict(now: 0.001, span: 0.004) - Self.refresh) < 1e-9)
        // On the screen's own phase.
        #expect(abs(Self.predict(now: 0.006, span: 0.004, vsync: 0.005) - (0.005 + Self.refresh)) < 1e-9)
    }

    // Every active orbit on an iPad mini: 28.5 ms from commit to done on an idle
    // GPU, done 22 ms apart behind another.
    @Test func waitsBehindTheFramesOnTheGPU() {
        // Begun with the GPU idle: done at 30.5 ms, shown on the second refresh.
        #expect(abs(Self.predict(now: 0, span: 0.0285, gpu: 0.022, gpuDone: -0.01) - 2 * Self.refresh) < 1e-9)
        // Behind one done at 28.5 ms: done at 50.5, shown on the fourth.
        #expect(abs(Self.predict(now: 0.005, span: 0.0285, gpu: 0.022, gpuDone: -0.01, queued: [0]) - 4 * Self.refresh) < 1e-9)
        // Behind one done at 12 ms: done at 35.5, shown on the third.
        #expect(abs(Self.predict(now: 0.005, span: 0.0285, gpu: 0.022, gpuDone: -0.01, queued: [-0.019]) - 3 * Self.refresh) < 1e-9)
        // Done within the latch before the second refresh: the third.
        #expect(abs(Self.predict(now: 0.002, span: 0.0285, gpu: 0.022, gpuDone: -0.01) - 3 * Self.refresh) < 1e-9)
    }

    // A frame stays on the screen for the interval asked for: 30 fps on 60 Hz.
    @Test func keepsTheIntervalAfterTheFrameBefore() {
        #expect(abs(Self.predict(now: 0.02, span: 0.004, interval: 2 * Self.refresh, previous: 2 * Self.refresh) - 4 * Self.refresh) < 1e-9)
        #expect(abs(Self.predict(now: 0.02, span: 0.004, previous: 2 * Self.refresh) - 3 * Self.refresh) < 1e-9)
    }

    // Frames 28.5 ms from commit to done on an idle GPU, done 22 ms apart behind
    // another, measured frame by frame: the instants follow when each is shown, a
    // refresh or two apart.
    @Test func timesFramesShownOneOrTwoRefreshesApart() {
        let frames = FramePresentation()
        var (now, gpuDone) = (0.0, -1.0)
        var shown: [Double] = []
        for id in 1...40 {
            let instant = frames.predict(at: now, refresh: Self.refresh, interval: Self.refresh)
            let committed = now + 0.001
            #expect(frames.began(committed: committed, cpu: 0.001, shown: instant) == id)
            let start = committed + 0.0005
            gpuDone = max(committed + 0.0285, gpuDone + 0.022)
            frames.done(id, start: start, end: gpuDone)
            frames.shown(at: instant)
            shown.append(instant)
            now += 0.022
        }
        let steps = zip(shown.dropFirst(), shown).map { (($0 - $1) / Self.refresh).rounded() }.suffix(20)
        #expect(Set(steps) == [1, 2])
        #expect(abs(steps.reduce(0, +) * Self.refresh / Double(steps.count) - 0.022) < 0.002)
    }

    // A frame begun is timed a refresh after the one before, whatever the screen
    // reports meanwhile; one only foretold, turned away or skipped, holds back none.
    @Test func neverRunsBackwards() {
        let frames = FramePresentation()
        let first = frames.predict(at: 1, refresh: Self.refresh, interval: Self.refresh)
        _ = frames.began(committed: 1, cpu: 0, shown: first)
        frames.shown(at: 0.5)
        #expect(frames.predict(at: 0.99, refresh: Self.refresh, interval: Self.refresh) >= first + Self.refresh - 1e-9)
        // Skipped since: the next refresh from now.
        let later = frames.predict(at: 5.002, refresh: Self.refresh, interval: Self.refresh)
        #expect(later > 5.002 && later <= 5.002 + Self.refresh)
        #expect(frames.predict(at: 5.004, refresh: Self.refresh, interval: Self.refresh) == later)
    }
}
