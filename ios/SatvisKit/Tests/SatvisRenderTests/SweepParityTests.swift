import Foundation
import Testing

@testable import SatvisRender

/// A sweep's plans and tables against the web app's own (src/modules/benchmark/
/// benchmarkPlan.ts and report.ts, through scripts/parity/generate.mjs), so both
/// apps plan the same steps and read, copy and paste the same tables.
struct SweepParityTests {
    struct Fixture: Decodable {
        struct Defaults: Decodable {
            var satelliteCounts: [Double]
            var quickSatelliteCounts: [Double]
            var clockMultipliers: [Double]
            var cumulativeComponentSets: [[String]]
            var isolatedComponentSets: [[String]]
            var clockComponentSets: [[String]]
            var warmupMs: Double
            var sampleMs: Double
            var minTrustworthyFrames: Int
            var named: [String: SweepSpec]
            var groundStation: [String: Double]
        }

        struct Plan: Decodable {
            var spec: SweepSpec
            var steps: [SweepStep]
            var estimateMs: Double
        }

        struct Run: Decodable {
            var name: String
            var run: SweepRun
            var report: ReportValue
            var thin: Int
            var table: String
            var csv: String
        }

        struct Drift: Decodable {
            var first: Double?
            var repeated: Double?
            var shown: Double?
        }

        struct Status: Decodable {
            var status: BenchmarkStatus
            var line: String
        }

        var defaults: Defaults
        var statuses: [Status]
        var drifts: [Drift]
        var plans: [Plan]
        var runs: [Run]
    }

    private static func fixture() throws -> Fixture {
        let url = try #require(Bundle.module.url(forResource: "sweep", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test func sharesTheWebAppsDefaults() throws {
        let defaults = try Self.fixture().defaults
        #expect(SweepPlan.satelliteCounts == defaults.satelliteCounts)
        #expect(SweepPlan.quickSatelliteCounts == defaults.quickSatelliteCounts)
        #expect(SweepPlan.clockMultipliers == defaults.clockMultipliers)
        #expect(SweepPlan.cumulativeComponentSets == defaults.cumulativeComponentSets)
        #expect(SweepPlan.isolatedComponentSets == defaults.isolatedComponentSets)
        #expect(SweepPlan.clockComponentSets == defaults.clockComponentSets)
        #expect(SweepPlan.warmupMilliseconds == defaults.warmupMs)
        #expect(SweepPlan.sampleMilliseconds == defaults.sampleMs)
        #expect(SweepReport.minimumTrustworthyFrames == defaults.minTrustworthyFrames)
        #expect(SweepPlan.named == defaults.named)
        #expect([SweepPlan.groundStation.latitude, SweepPlan.groundStation.longitude] == [defaults.groundStation["lat"], defaults.groundStation["lon"]])
    }

    // Typed into the panel, a count past Int's range is left out rather than trapping.
    @Test func dropsCountsNoIntHolds() {
        let steps = SweepPlan.steps(SweepSpec(satelliteCounts: [1e20, 5, 5.5, -1], componentSets: [["Point"]], repeatFirstStep: false))
        #expect(steps.map(\.satelliteCount) == [5])
    }

    @Test func plansTheWebAppsSteps() throws {
        for plan in try Self.fixture().plans {
            let steps = SweepPlan.steps(plan.spec)
            #expect(steps == plan.steps, "\(plan.spec)")
            #expect(SweepPlan.estimatedMilliseconds(steps.count, perStep: 6000) == plan.estimateMs)
        }
    }

    @Test func readsEachSweepAsTheWebAppDoes() throws {
        for test in try Self.fixture().runs {
            let run = test.run
            #expect(SweepReport.report(run) == test.report, "\(test.name): report")
            #expect(SweepReport.thinRows(run).count == test.thin, "\(test.name): thin")
            #expect(SweepReport.table(run) == test.table, "\(test.name): table")
            #expect(SweepReport.csv(run) == test.csv, "\(test.name): csv")
        }
    }

    @Test func wordsTheStatusAsTheWebAppDoes() throws {
        for test in try Self.fixture().statuses {
            #expect(test.status.line == test.line)
        }
        for test in try Self.fixture().drifts {
            let shown = BenchmarkStatus.shownDrift(first: test.first, repeated: test.repeated)
            #expect(shown.map { abs($0 - (test.shown ?? .nan)) < 1e-9 } ?? (test.shown == nil), "\(String(describing: test.first)) → \(String(describing: test.repeated))")
        }
    }

    // `toFixed` rounds an exact tie away from zero, where `%f` rounds it to even.
    @Test func roundsAsJavaScriptDoes() {
        #expect(jsRound(0.125, 2) == 0.13)
        #expect(jsRound(2.675, 2) == 2.67)
        #expect(jsRound(-0.125, 2) == -0.13)
        #expect(jsRound(1.005, 2) == 1)
        #expect(jsNumber(-0.0) == "0")
        #expect(jsNumber(145) == "145")
        #expect(jsNumber(0.83) == "0.83")
    }
}
