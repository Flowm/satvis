import SatvisCore
import Testing

@testable import SatvisRender

/// `GlobeRenderer.chooseModelLevel`, with a satellite whose model has one copy up to 100 points.
@MainActor @Suite struct ModelLevelChoiceTests {
    private let lods = [ModelLod(file: "ISS-(ZARYA)-low.glb", maxPoints: 100)]

    /// The level drawn, and the levels asked for on the way.
    private func choose(
        current: Int?, tracked: Bool = false, failed: Set<Int> = [], points: [Int: Double] = [:], loaded: Set<Int> = []
    ) -> (level: Int, asked: [Int]) {
        var asked: [Int] = []
        let level = GlobeRenderer.chooseModelLevel(
            current: current, lods: lods, tracked: tracked, failed: { failed.contains($0) }, points: { points[$0] },
            loaded: {
                asked.append($0)
                return loaded.contains($0)
            })
        return (level, asked)
    }

    @Test func drawsTheCopyWhileTheModelIsSmall() {
        #expect(choose(current: nil, points: [1: 72], loaded: [1]) == (1, []))
    }

    @Test func asksForNothingMoreWhileTheCopyLoads() {
        #expect(choose(current: nil) == (1, []))
    }

    @Test func keepsTheCopyUntilTheFileHasLoaded() {
        #expect(choose(current: 1, points: [1: 150]) == (1, [0]))
        #expect(choose(current: 1, points: [1: 150], loaded: [0]) == (0, [0]))
    }

    @Test func goesBackToTheCopyOnlyWellBelowItsMaxPoints() {
        #expect(choose(current: 0, points: [0: 90], loaded: [0, 1]).level == 0)
        #expect(choose(current: 0, points: [0: 70], loaded: [0, 1]).level == 1)
    }

    @Test func drawsTheFileOfWhatIsTracked() {
        #expect(choose(current: 1, tracked: true, points: [1: 40], loaded: [0, 1]) == (0, [0]))
    }

    @Test func drawsTheFileWhenTheCopyCannotLoad() {
        #expect(choose(current: nil, failed: [1]).level == 0)
        #expect(choose(current: 1, failed: [1], points: [0: 40], loaded: [0]).level == 0)
    }
}
