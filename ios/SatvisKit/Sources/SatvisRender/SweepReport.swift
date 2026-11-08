import Foundation

/// A JSON value: a report's cells, its environment and options.
public enum ReportValue: Sendable, Equatable, Codable {
    /// Whole numbers encode without a point.
    case number(Double)
    /// Also the web's blank (`blank`).
    case string(String)
    case bool(Bool)
    /// Where the web writes null rather than a blank.
    case null
    /// No cell holds one, so its text is empty.
    case array([ReportValue])
    /// No cell holds one, so its text is empty.
    case object([String: ReportValue])

    /// A number, or the web's blank: an empty string.
    static func blank(_ value: Double?) -> ReportValue { value.map(ReportValue.number) ?? .string("") }

    /// Any JSON value; `report` turns a spec into one through it.
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ReportValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: ReportValue].self))
        }
    }

    /// Whole numbers without a point, as JavaScript writes them.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let value): try value == value.rounded() && abs(value) < 1e15 ? container.encode(Int64(value)) : container.encode(value)
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// As the web's `String(value)` writes it into a csv cell or a padded table.
    var text: String {
        switch self {
        case .number(let value): jsNumber(value)
        case .string(let value): value
        case .bool(let value): value ? "true" : "false"
        case .null: "null"
        case .array, .object: ""
        }
    }
}

/// Named values in the web's order, for a csv header and a row of it.
public struct ReportRecord: Sendable, Equatable {
    /// One named cell: a csv column and its value.
    public struct Field: Sendable, Equatable {
        /// The csv column and the JSON key.
        public var key: String
        /// Blank is an empty string, as on the web.
        public var value: ReportValue
    }

    /// In column order.
    public var fields: [Field]

    /// Keys and values in column order.
    init(_ fields: [(String, ReportValue)]) {
        self.fields = fields.map { Field(key: $0.0, value: $0.1) }
    }

    /// Nil where the row has no such column.
    public subscript(key: String) -> ReportValue? { fields.first { $0.key == key }?.value }

    /// As a JSON object, which drops the column order.
    public var json: ReportValue { .object(Dictionary(fields.map { ($0.key, $0.value) }, uniquingKeysWith: { $1 })) }
}

/// One sweep step as both apps measure it, the web's `SweepResult`. Times in
/// milliseconds; nil where the app cannot say.
public struct SweepResult: Sendable, Equatable, Codable {
    /// The count asked for.
    public var satelliteCount: Int
    /// The components asked for, by `SatelliteComponents.named` name.
    public var components: [String]
    /// The clock rate the app ran at.
    public var clock: Double
    /// The closing re-run of the first step, left out of every derived table.
    public var `repeat`: Bool
    /// Satellites drawn, which can differ from the count asked for.
    public var visible: Int
    /// The `drawn` column where it differs from `components`.
    public var componentsDrawn: [String]
    /// Instances drawn per component, the report's `componentInstances`.
    public var componentInstances: [String: Int]
    /// Wall time to a complete scene, spread over frames.
    public var buildMs: Double
    /// Wall time to take the previous scene down.
    public var clearMs: Double
    /// Frame intervals sampled, one fewer than the frames drawn.
    public var frames: Int
    /// 0 where no frame was timed.
    public var fps: Double
    /// The mean frame interval, for the scaling floor.
    public var frameMs: Double?
    /// The main thread's work on a frame, which sets the frame rate.
    public var cpuMs: Double?
    /// The 95th percentile of `cpuMs`.
    public var cpuP95Ms: Double?
    /// Nil without a GPU timer.
    public var gpuMs: Double?
    /// The 95th percentile of `gpuMs`.
    public var gpuP95Ms: Double?
    /// Percent of frames over the refresh budget, as the performance panel reads it.
    public var overBudgetPct: Double?
    /// The busier of CPU and GPU, in percent of the wall time.
    public var loadPct: Double?
    /// The CPU's share alone, the floor of load where the GPU's is unknown.
    public var cpuBusyPct: Double?
    /// Every thread's CPU time, in percent of one core.
    public var cpuTotalPct: Double?
    /// The web's heap floor over the step; nil here.
    public var heapMb: Double?
    /// The web's heap peak over the step; nil here.
    public var heapPeakMb: Double?
    /// Absolute: phys_footprint here.
    public var footprintMb: Double?
    /// The web's whole-page footprint; nil here.
    public var footprintTotalMb: Double?
    /// The web's worker scopes' footprint; nil here.
    public var footprintWorkerMb: Double?
    /// This app's own figures, as `x_<name>` columns.
    public var extras: [String: Double?]

    /// The step as asked, `clock` onward as the app ran it.
    public init(
        step: SweepStep, clock: Double, visible: Int, componentsDrawn: [String], componentInstances: [String: Int] = [:], buildMs: Double, clearMs: Double,
        summary: FrameSummary, recording: FrameRecording, footprintMb: Double?, extras: [String: Double?] = [:]
    ) {
        satelliteCount = step.satelliteCount
        components = step.components
        self.clock = clock
        self.repeat = step.repeat
        self.visible = visible
        self.componentsDrawn = componentsDrawn
        self.componentInstances = componentInstances
        self.buildMs = buildMs
        self.clearMs = clearMs
        frames = summary.frames
        fps = summary.framesPerSecond ?? 0
        frameMs = recording.intervals.isEmpty ? nil : recording.intervals.reduce(0, +) / Double(recording.intervals.count)
        cpuMs = summary.cpu
        cpuP95Ms = summary.cpuP95
        gpuMs = summary.gpu
        gpuP95Ms = summary.gpuP95
        overBudgetPct = summary.overBudget
        loadPct = summary.load
        cpuBusyPct = summary.cpuBusy
        cpuTotalPct = summary.cpuTotal
        self.footprintMb = footprintMb
        self.extras = extras
    }
}

/// A sweep as its tables read it.
public struct SweepRun: Sendable, Equatable, Codable {
    /// Every step in order, the closing repeat included.
    public var results: [SweepResult]
    /// When the sweep started, ISO 8601.
    public var startedAtIso: String
    /// The plan it ran; JSON null in the report without one.
    public var spec: SweepSpec?
    /// Device and build facts, the report's `environment`.
    public var environment: [String: ReportValue]
    /// What it ran with, such as `warmupMs` and `sampleMs`.
    public var options: [String: ReportValue]
    /// Distinct satellite names in the catalog the counts draw from.
    public var catalogSize: Int
    /// Stopped early; `results` holds the steps that finished.
    public var cancelled: Bool

    /// A run as both apps' reports read it.
    public init(
        results: [SweepResult], startedAtIso: String, spec: SweepSpec?, environment: [String: ReportValue], options: [String: ReportValue], catalogSize: Int,
        cancelled: Bool
    ) {
        self.results = results
        self.startedAtIso = startedAtIso
        self.spec = spec
        self.environment = environment
        self.options = options
        self.catalogSize = catalogSize
        self.cancelled = cancelled
    }

    /// Without the closing repeat, which would weight one scene twice and hide the drift.
    var measured: [SweepResult] { results.filter { !$0.repeat } }
}

/// A sweep's tables, the web app's (src/modules/benchmark/report.ts), held to it
/// by a parity fixture: change both together.
public enum SweepReport {
    /// Main-thread drift, in percent, past which a repeat check reads `drifted`.
    public static let maximumTrustworthyDriftPercent = 10.0
    /// At 0 satellites main-thread time is under 2 ms, so 10 % alone is noise.
    public static let minimumMeaningfulDriftMilliseconds = 1.0
    /// A linear series measured 0.999, one broken by a mid-series GC 0.002.
    public static let minimumTrustworthyMemoryR2 = 0.9
    /// Two points always give r² 1.
    public static let minimumMemoryFitPoints = 3
    /// Fewer frames make a row noise (`thinRows`).
    public static let minimumTrustworthyFrames = 20
    /// Milliseconds a frame at 60 fps.
    private static let frameBudget = 1000.0 / 60

    /// Main-thread ms against satellites drawn, a series at a time: the `scaling` table.
    public struct ScalingFit: Sendable, Equatable {
        /// Components and clock, as `SweepPlan.series` names them.
        public var series: String
        /// Steps behind the fit.
        public var points: Int
        /// Least-squares slope of main-thread ms, per 1,000 satellites.
        public var cpuMsPer1000: Double
        /// The fit's intercept: main-thread ms with no satellites.
        public var baseCpuMs: Double
        /// The fit's r².
        public var r2: Double
        /// GPU work plus the vsync wait.
        public var floorMs: Double
        /// Where the fit crosses 16.7 ms, assuming the GPU is not the limit; nil when the floor is past it.
        public var satsAt60fps: Int?

        /// The `scaling` table's row.
        public var record: ReportRecord {
            ReportRecord([
                ("series", .string(series)), ("points", .number(Double(points))), ("cpuMsPer1000", .number(cpuMsPer1000)), ("baseCpuMs", .number(baseCpuMs)),
                ("r2", .number(r2)), ("floorMs", .number(floorMs)), ("satsAt60fps", .blank(satsAt60fps.map(Double.init))),
            ])
        }
    }

    /// Memory per satellite within a series: the `memory` table.
    public struct MemoryFit: Sendable, Equatable {
        /// Components and clock, as `SweepPlan.series` names them.
        public var series: String
        /// Points behind the heap fit; 0, with the four fields below nil, when there was nothing to fit.
        public var points: Int
        /// Slope of the heap floor, MB per 1,000 satellites drawn.
        public var mbPer1000Sats: Double?
        /// The same slope in KB per satellite.
        public var kbPerSatellite: Double?
        /// Not a footprint: baseline plus standing garbage, kept only to expose a wild fit.
        public var baseMb: Double?
        /// The heap fit's r²; check it before trusting `kbPerSatellite`.
        public var r2: Double?
        /// KB per satellite from absolute footprints, the only memory slope here.
        public var absoluteKbPerSatellite: Double?
        /// Steps with a footprint.
        public var absolutePoints: Int
        /// The footprint fit's r².
        public var absoluteR2: Double?

        /// Checked on its own points and r²: a refused capture shrinks only this fit.
        public var absoluteTrustworthy: Bool {
            absoluteKbPerSatellite != nil && absolutePoints >= minimumMemoryFitPoints && (absoluteR2 ?? 0) >= minimumTrustworthyMemoryR2
        }

        /// The `memory` table's row.
        public var record: ReportRecord {
            ReportRecord([
                ("series", .string(series)), ("points", .number(Double(points))), ("mbPer1000Sats", .blank(mbPer1000Sats)), ("kbPerSatellite", .blank(kbPerSatellite)),
                ("baseMb", .blank(baseMb)), ("r2", .blank(r2)), ("absoluteKbPerSatellite", .blank(absoluteKbPerSatellite)),
                ("absolutePoints", .number(Double(absolutePoints))), ("absoluteR2", .blank(absoluteR2)),
            ])
        }
    }

    /// A component set against its largest strict subset at the same count and clock: the `marginal` table.
    public struct MarginalCost: Sendable, Equatable {
        /// Satellites asked for.
        public var sats: Int
        /// Clock multiplier.
        public var clock: Double
        /// The components the larger set adds.
        public var added: String
        /// The subset it is measured against.
        public var over: String
        /// Main-thread ms the added components cost.
        public var deltaCpuMs: Double
        /// The same in microseconds per satellite drawn; 0 when none was.
        public var usPerSatellite: Double

        /// The `marginal` table's row.
        public var record: ReportRecord {
            ReportRecord([
                ("sats", .number(Double(sats))), ("clock", .number(clock)), ("added", .string(added)), ("over", .string(over)), ("deltaCpuMs", .number(deltaCpuMs)),
                ("usPerSatellite", .number(usPerSatellite)),
            ])
        }
    }

    /// A clock rate against ×1 for the same scene: the `propagation` table.
    public struct PropagationCost: Sendable, Equatable {
        /// Satellites asked for.
        public var sats: Int
        /// As `SweepPlan.components` writes them.
        public var components: String
        /// Clock multiplier, never 1.
        public var clock: Double
        /// Main-thread ms at this clock.
        public var cpuMs: Double
        /// Over the same scene at ×1: what a faster clock costs the frame rate.
        public var deltaCpuMs: Double
        /// The same in microseconds per satellite drawn; 0 when none was.
        public var usPerSatellite: Double
        /// Every thread's CPU, in percent of one core.
        public var cpuTotalPct: Double?
        /// Over ×1, on every thread: where propagation shows here.
        public var deltaCpuTotalPct: Double?

        /// The `propagation` table's row.
        public var record: ReportRecord {
            ReportRecord([
                ("sats", .number(Double(sats))), ("components", .string(components)), ("clock", .number(clock)), ("cpuMs", .number(cpuMs)),
                ("deltaCpuMs", .number(deltaCpuMs)), ("usPerSatellite", .number(usPerSatellite)), ("cpuTotalPct", .blank(cpuTotalPct)),
                ("deltaCpuTotalPct", .blank(deltaCpuTotalPct)),
            ])
        }
    }

    /// The first step against its re-run at the end: the `repeat` table.
    public struct RepeatCheck: Sendable, Equatable {
        /// Satellites asked for.
        public var sats: Int
        /// As `SweepPlan.components` writes them.
        public var components: String
        /// Clock multiplier.
        public var clock: Double
        /// Main-thread ms on the first run.
        public var firstCpuMs: Double
        /// Main-thread ms on the re-run.
        public var repeatCpuMs: Double
        /// Positive means the app got slower over the run.
        public var cpuDriftPct: Double
        /// Build ms on the first run.
        public var firstBuildMs: Double
        /// Build ms on the re-run.
        public var repeatBuildMs: Double
        /// Usually strongly negative: the first build pays for warmup.
        public var buildDriftPct: Double

        /// Past both the percent and the millisecond threshold.
        public var drifted: Bool {
            abs(cpuDriftPct) > maximumTrustworthyDriftPercent && abs(repeatCpuMs - firstCpuMs) >= minimumMeaningfulDriftMilliseconds
        }

        /// The `repeat` table's row.
        public var record: ReportRecord {
            ReportRecord([
                ("sats", .number(Double(sats))), ("components", .string(components)), ("clock", .number(clock)), ("firstCpuMs", .number(firstCpuMs)),
                ("repeatCpuMs", .number(repeatCpuMs)), ("cpuDriftPct", .number(cpuDriftPct)), ("firstBuildMs", .number(firstBuildMs)),
                ("repeatBuildMs", .number(repeatBuildMs)), ("buildDriftPct", .number(buildDriftPct)),
            ])
        }
    }

    /// Rounded to `digits`, or blank for nil.
    private static func blankOr(_ value: Double?, _ digits: Int = 2) -> ReportValue { .blank(value.map { jsRound($0, digits) }) }
    /// Main-thread ms, 0 where unknown.
    private static func cpu(_ result: SweepResult) -> Double { result.cpuMs ?? 0 }
    /// The series a step belongs to.
    private static func series(_ result: SweepResult) -> String { SweepPlan.series(result.components, clock: result.clock) }

    /// One row a step, in the web's columns, this app's own figures as `x_<name>`.
    public static func rows(_ run: SweepRun) -> [ReportRecord] {
        return run.results.map { result in
            let requested = SweepPlan.components(result.components)
            let drawn = SweepPlan.components(result.componentsDrawn)
            var fields: [(String, ReportValue)] = [
                ("sats", .number(Double(result.satelliteCount))), ("components", .string(requested)), ("clock", .number(result.clock)), ("repeat", .bool(result.repeat)),
                ("drawn", .string(drawn == requested ? "" : drawn)), ("visible", .number(Double(result.visible))), ("frames", .number(Double(result.frames))),
                ("fps", .number(jsRound(result.fps, 1))), ("cpuMs", blankOr(result.cpuMs)), ("gpuMs", blankOr(result.gpuMs)),
                ("loadPct", blankOr(result.loadPct, 1)), ("cpuBusyPct", blankOr(result.cpuBusyPct, 1)), ("cpuP95Ms", blankOr(result.cpuP95Ms)),
                ("gpuP95Ms", blankOr(result.gpuP95Ms)), ("overBudgetPct", blankOr(result.overBudgetPct, 1)),
                ("cpuTotalPct", blankOr(result.cpuTotalPct, 1)), ("buildMs", .number(jsRound(result.buildMs, 2))),
                ("clearMs", .number(jsRound(result.clearMs, 2))), ("heapMb", blankOr(result.heapMb, 1)), ("heapPeakMb", blankOr(result.heapPeakMb, 1)),
                ("footprintMb", blankOr(result.footprintMb, 1)), ("footprintTotalMb", blankOr(result.footprintTotalMb, 1)),
                ("footprintWorkerMb", blankOr(result.footprintWorkerMb, 1)),
            ]
            for name in result.extras.keys.sorted() {
                fields.append(("x_\(name)", blankOr(result.extras[name] ?? nil)))
            }
            return ReportRecord(fields)
        }
    }

    /// A least-squares line.
    private struct Fit {
        /// Y per unit of x.
        var slope: Double
        /// Y at x = 0.
        var intercept: Double
        /// 1 where every y is equal.
        var r2: Double
    }

    /// Nil for fewer than two points or a single x.
    private static func leastSquares(_ points: [(x: Double, y: Double)]) -> Fit? {
        guard points.count >= 2 else {
            return nil
        }
        let n = Double(points.count)
        let meanX = points.reduce(0) { $0 + $1.x } / n
        let meanY = points.reduce(0) { $0 + $1.y } / n
        let sxx = points.reduce(0) { $0 + ($1.x - meanX) * ($1.x - meanX) }
        let sxy = points.reduce(0) { $0 + ($1.x - meanX) * ($1.y - meanY) }
        guard sxx != 0 else {
            return nil
        }
        let slope = sxy / sxx
        let intercept = meanY - slope * meanX
        let ssTot = points.reduce(0) { $0 + ($1.y - meanY) * ($1.y - meanY) }
        let ssRes = points.reduce(0) { $0 + ($1.y - (slope * $1.x + intercept)) * ($1.y - (slope * $1.x + intercept)) }
        return Fit(slope: slope, intercept: intercept, r2: ssTot == 0 ? 1 : 1 - ssRes / ssTot)
    }

    /// Measured steps by series, in the order each first appears.
    private static func bySeries(_ run: SweepRun) -> [(String, [SweepResult])] {
        grouped(run.measured, by: series)
    }

    /// Groups in the order each key first appears.
    private static func grouped(_ results: [SweepResult], by key: (SweepResult) -> String) -> [(String, [SweepResult])] {
        var order: [String] = []
        var groups: [String: [SweepResult]] = [:]
        for result in results {
            let name = key(result)
            if groups[name] == nil {
                order.append(name)
            }
            groups[name, default: []].append(result)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    /// Main-thread ms against the satellites drawn, a series at a time.
    public static func scalingFits(_ run: SweepRun) -> [ScalingFit] {
        bySeries(run).compactMap { series, results in
            guard let fit = leastSquares(results.map { (Double($0.visible), cpu($0)) }) else {
                return nil
            }
            let floor = results.map { $0.frameMs ?? .infinity }.min() ?? .infinity
            let headroom = frameBudget - fit.intercept
            let reachable = floor.isFinite && floor < frameBudget
            return ScalingFit(
                series: series, points: results.count, cpuMsPer1000: jsRound(fit.slope * 1000, 3), baseCpuMs: jsRound(fit.intercept, 2), r2: jsRound(fit.r2, 3),
                floorMs: floor.isFinite ? jsRound(floor, 2) : 0,
                satsAt60fps: reachable && fit.slope > 0 && headroom > 0 ? Int((headroom / fit.slope + 0.5).rounded(.down)) : nil)
        }
    }

    /// Memory per satellite within a series: the heap's slope where there is one,
    /// and the absolute footprint's.
    public static func memoryFits(_ run: SweepRun) -> [MemoryFit] {
        bySeries(run).compactMap { series, results in
            // (Satellites drawn, value) for each step that has one.
            func points(_ pick: (SweepResult) -> Double?) -> [(x: Double, y: Double)] {
                results.compactMap { result in pick(result).map { (Double(result.visible), $0) } }
            }
            let heapPoints = points(\.heapMb)
            let heap = leastSquares(heapPoints)
            let absolutePoints = points(\.footprintMb)
            let absolute = leastSquares(absolutePoints)
            guard heap != nil || absolute != nil else {
                return nil
            }
            return MemoryFit(
                series: series, points: heap == nil ? 0 : heapPoints.count, mbPer1000Sats: heap.map { jsRound($0.slope * 1000, 1) },
                kbPerSatellite: heap.map { jsRound($0.slope * 1024, 1) }, baseMb: heap.map { jsRound($0.intercept, 1) }, r2: heap.map { jsRound($0.r2, 3) },
                absoluteKbPerSatellite: absolute.map { jsRound($0.slope * 1024, 1) }, absolutePoints: absolutePoints.count, absoluteR2: absolute.map { jsRound($0.r2, 3) })
        }
    }

    /// Each set against its largest strict subset at the same count and clock.
    public static func marginalCosts(_ run: SweepRun) -> [MarginalCost] {
        let buckets = grouped(run.measured) { "\($0.satelliteCount)@\(jsNumber($0.clock))" }.map(\.1).sorted { ($0.first?.satelliteCount ?? 0) < ($1.first?.satelliteCount ?? 0) }
        var costs: [MarginalCost] = []
        for results in buckets {
            for result in results {
                let own = Set(result.components)
                var baseline: SweepResult?
                for candidate in results where candidate.components.count < own.count && candidate.components.allSatisfy(own.contains) {
                    if baseline == nil || candidate.components.count > baseline!.components.count {
                        baseline = candidate
                    }
                }
                guard let baseline else {
                    continue
                }
                let base = Set(baseline.components)
                let delta = cpu(result) - cpu(baseline)
                costs.append(
                    MarginalCost(
                        sats: result.satelliteCount, clock: result.clock, added: SweepPlan.components(result.components.filter { !base.contains($0) }),
                        over: SweepPlan.components(baseline.components), deltaCpuMs: jsRound(delta, 2),
                        usPerSatellite: result.visible > 0 ? jsRound(delta * 1000 / Double(result.visible), 1) : 0))
            }
        }
        return costs
    }

    /// Each clock rate against ×1 for the same scene, on main-thread time and on
    /// every thread's, which is where propagation shows here.
    public static func propagationCosts(_ run: SweepRun) -> [PropagationCost] {
        var costs: [PropagationCost] = []
        for (_, results) in grouped(run.measured, by: { "\($0.satelliteCount)|\(SweepPlan.components($0.components))" }) {
            guard results.count >= 2, let index = results.firstIndex(where: { $0.clock == 1 }) else {
                continue
            }
            let baseline = results[index]
            for (other, result) in results.enumerated() where other != index {
                let delta = cpu(result) - cpu(baseline)
                let total: Double? =
                    if let mine = result.cpuTotalPct, let base = baseline.cpuTotalPct { jsRound(mine - base, 1) } else { nil }
                costs.append(
                    PropagationCost(
                        sats: result.satelliteCount, components: SweepPlan.components(result.components), clock: result.clock, cpuMs: jsRound(cpu(result), 2),
                        deltaCpuMs: jsRound(delta, 2), usPerSatellite: result.visible > 0 ? jsRound(delta * 1000 / Double(result.visible), 1) : 0,
                        cpuTotalPct: result.cpuTotalPct.map { jsRound($0, 1) }, deltaCpuTotalPct: total))
            }
        }
        return costs.sorted { ($0.sats, $0.clock) < ($1.sats, $1.clock) }
    }

    /// The first step against its re-run at the end.
    public static func repeatChecks(_ run: SweepRun) -> [RepeatCheck] {
        // In percent, 0 against a zero first value.
        func drift(_ first: Double, _ repeated: Double) -> Double { first == 0 ? 0 : jsRound((repeated - first) / first * 100, 1) }
        return run.results.filter(\.repeat).compactMap { repeated in
            guard
                let first = run.measured.first(where: {
                    $0.satelliteCount == repeated.satelliteCount && $0.clock == repeated.clock
                        && SweepPlan.components($0.components) == SweepPlan.components(repeated.components)
                })
            else {
                return nil
            }
            return RepeatCheck(
                sats: repeated.satelliteCount, components: SweepPlan.components(repeated.components), clock: repeated.clock, firstCpuMs: jsRound(cpu(first), 2),
                repeatCpuMs: jsRound(cpu(repeated), 2), cpuDriftPct: drift(cpu(first), cpu(repeated)), firstBuildMs: jsRound(first.buildMs, 2),
                repeatBuildMs: jsRound(repeated.buildMs, 2), buildDriftPct: drift(first.buildMs, repeated.buildMs))
        }
    }

    /// Steps sampled over too few frames to read.
    public static func thinRows(_ run: SweepRun) -> [ReportRecord] {
        rows(run).filter { (row: ReportRecord) -> Bool in
            if case .number(let frames) = row["frames"] { return frames < Double(minimumTrustworthyFrames) }
            return false
        }
    }

    /// For pasting into an issue, the web's text character for character.
    public static func table(_ run: SweepRun) -> String {
        let rows = rows(run)
        let showFootprint = rows.contains { $0["footprintMb"] != .string("") }
        let header =
            ["sats", "visible", "clock", "frames", "fps", "cpuMs", "gpuMs", "load%", "cpuP95", "gpuP95", "over%", "total%", "build"]
            + (showFootprint ? ["footprint"] : []) + ["components"]
        let widths = [6, 8, 7, 7, 7, 8, 8, 7, 8, 8, 7, 7, 8] + (showFootprint ? [10] : [])
        // Right-aligned, as JavaScript's `padStart`.
        func pad(_ text: String, _ width: Int) -> String { String(repeating: " ", count: max(0, width - text.count)) + text }
        // A blank cell reads as an em dash.
        func cell(_ key: String) -> (ReportRecord) -> String {
            { row in
                let value = row[key] ?? .string("")
                return value == .string("") ? "—" : value.text
            }
        }
        var lines = [header.enumerated().map { index, name in index < widths.count ? pad(name, widths[index]) : " \(name)" }.joined()]
        for row in rows {
            var values = [row["sats"]?.text ?? "", row["visible"]?.text ?? "", "x\(row["clock"]?.text ?? "")", row["frames"]?.text ?? "", row["fps"]?.text ?? ""]
            values += ["cpuMs", "gpuMs"].map { cell($0)(row) }
            let busy = row["cpuBusyPct"] ?? .string("")
            values.append(row["loadPct"] == .string("") && busy != .string("") ? "≥\(busy.text)" : cell("loadPct")(row))
            values += ["cpuP95Ms", "gpuP95Ms", "overBudgetPct", "cpuTotalPct"].map { cell($0)(row) }
            values.append(row["buildMs"]?.text ?? "")
            if showFootprint {
                values.append(cell("footprintMb")(row))
            }
            let drawn = row["drawn"]?.text ?? ""
            let suffix = (row["repeat"] == .bool(true) ? " (repeat)" : "") + (drawn.isEmpty ? "" : " (drew \(drawn))")
            lines.append(values.enumerated().map { pad($1, widths[$0]) }.joined() + " \(row["components"]?.text ?? "")\(suffix)")
        }
        return lines.joined(separator: "\n")
    }

    /// Every row's columns, the first row's keys as the header.
    public static func csv(_ run: SweepRun) -> String {
        let rows = rows(run)
        guard let first = rows.first else {
            return ""
        }
        let keys = first.fields.map(\.key)
        func escape(_ value: ReportValue?) -> String {
            guard let value else {
                return ""
            }
            if case .string(let text) = value, text.contains(",") || text.contains("\"") {
                return "\"\(text.replacingOccurrences(of: "\"", with: "\"\""))\""
            }
            return value.text
        }
        return ([keys.joined(separator: ",")] + rows.map { row in keys.map { escape(row[$0]) }.joined(separator: ",") }).joined(separator: "\n")
    }

    /// The run and every table, as both apps export it.
    public static func report(_ run: SweepRun) -> ReportValue {
        var spec: ReportValue = .null
        if let given = run.spec, let data = try? JSONEncoder().encode(given), let decoded = try? JSONDecoder().decode(ReportValue.self, from: data) {
            spec = decoded
        }
        return .object([
            "startedAtIso": .string(run.startedAtIso), "spec": spec, "environment": .object(run.environment), "options": .object(run.options),
            "catalogSize": .number(Double(run.catalogSize)), "cancelled": .bool(run.cancelled), "rows": .array(rows(run).map(\.json)),
            "scaling": .array(scalingFits(run).map(\.record.json)), "memory": .array(memoryFits(run).map(\.record.json)),
            "marginal": .array(marginalCosts(run).map(\.record.json)), "propagation": .array(propagationCosts(run).map(\.record.json)),
            "repeat": .array(repeatChecks(run).map(\.record.json)),
            "componentInstances": .array(
                run.results.map {
                    .object([
                        "sats": .number(Double($0.satelliteCount)), "components": .string(SweepPlan.components($0.components)), "clock": .number($0.clock),
                        "instances": .object($0.componentInstances.mapValues { .number(Double($0)) }),
                    ])
                }),
        ])
    }

    /// `report` as indented JSON.
    public static func json(_ run: SweepRun) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(report(run))).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}
