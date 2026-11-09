import Foundation
import SatvisCore

/// As the web app's `SweepStep`, held to it by a parity fixture.
public struct SweepStep: Sendable, Equatable, Codable {
    /// The first this many of the catalog.
    public var satelliteCount: Int
    /// `SatelliteComponents.named`.
    public var components: [String]
    /// The clock rate asked for.
    public var clockMultiplier: Double
    /// The closing re-run of the first step, left out of every derived table.
    public var `repeat`: Bool
    /// As the panel lists it, a repeat marked.
    public var label: String

    /// A step as `SweepPlan.steps` builds it.
    public init(satelliteCount: Int, components: [String], clockMultiplier: Double, repeat: Bool, label: String) {
        self.satelliteCount = satelliteCount
        self.components = components
        self.clockMultiplier = clockMultiplier
        self.repeat = `repeat`
        self.label = label
    }
}

/// Counts that are not whole and non-negative, and rates that are not positive,
/// are dropped.
public struct SweepSpec: Sendable, Equatable, Codable {
    /// Doubles as typed into the panel; `steps` keeps the whole ones.
    public var satelliteCounts: [Double]
    /// One series each, by `SatelliteComponents.named` name.
    public var componentSets: [[String]]
    /// Nil runs ×1 alone.
    public var clockMultipliers: [Double]?
    /// Nil re-runs the first step at the end, as true does.
    public var repeatFirstStep: Bool?

    /// Defaults to ×1 and a closing repeat.
    public init(satelliteCounts: [Double], componentSets: [[String]], clockMultipliers: [Double]? = nil, repeatFirstStep: Bool? = nil) {
        self.satelliteCounts = satelliteCounts
        self.componentSets = componentSets
        self.clockMultipliers = clockMultipliers
        self.repeatFirstStep = repeatFirstStep
    }
}

/// What a sweep measures, count × components × clock: the web's `benchmarkPlan.ts`.
public enum SweepPlan {
    /// 0, the globe alone, is every row's baseline.
    public static let satelliteCounts: [Double] = [0, 100, 500, 1000, 5000]
    /// A harness sanity check, not a measurement.
    public static let quickSatelliteCounts: [Double] = [0, 100, 1000]
    /// Propagation is paid per simulated quarter orbit, so a faster clock separates it from drawing.
    public static let clockMultipliers: [Double] = [1, 10, 100, 1000]
    /// Orbit is rebuilt on every trajectory window refresh, so a faster clock shows most there.
    public static let clockComponentSets: [[String]] = [["Point", "Orbit"]]
    /// Milliseconds, shorter than a scene's.
    public static let warmupMilliseconds = 2000.0
    /// Milliseconds a step is measured.
    public static let sampleMilliseconds = 4000.0

    /// The station a sweep adds to switch pass prediction on for every satellite.
    public static let groundStation = (latitude: 48.1772, longitude: 11.7476)

    /// The web console's `bench.<name>()`, `SATVIS_SWEEP` here.
    public static let named: [String: SweepSpec] = [
        "quick": SweepSpec(satelliteCounts: quickSatelliteCounts, componentSets: isolatedComponentSets),
        "run": SweepSpec(satelliteCounts: satelliteCounts, componentSets: isolatedComponentSets),
        "cumulative": SweepSpec(satelliteCounts: satelliteCounts, componentSets: cumulativeComponentSets),
        "clock": SweepSpec(satelliteCounts: satelliteCounts, componentSets: clockComponentSets, clockMultipliers: clockMultipliers),
    ]

    /// Each set adds one component, so consecutive rows differ by its cost.
    public static let cumulativeComponentSets: [[String]] = SatelliteComponents.named.map(\.0).reduce(into: [[]]) { sets, name in
        sets.append(sets[sets.count - 1] + [name])
    }

    /// Point is the baseline, as a satellite exists even without one.
    public static let isolatedComponentSets: [[String]] = [["Point"]] + SatelliteComponents.named.map(\.0).filter { $0 != "Point" }.map { ["Point", $0] }

    /// Component sets outermost, so a cancelled sweep leaves whole series.
    public static func steps(_ spec: SweepSpec) -> [SweepStep] {
        var counts: [Int] = []
        // `Int(exactly:)`: a whole Double past Int's range would trap, typed into the panel.
        for count in spec.satelliteCounts {
            if count >= 0, let count = Int(exactly: count), !counts.contains(count) {
                counts.append(count)
            }
        }
        counts.sort()
        var multipliers: [Double] = []
        for value in spec.clockMultipliers ?? [1] where value.isFinite && value > 0 && !multipliers.contains(value) {
            multipliers.append(value)
        }
        var steps: [SweepStep] = []
        func push(_ count: Int, _ components: [String], _ clock: Double, repeat: Bool) {
            let label = "\(count) sats · \(series(components, clock: clock))\(`repeat` ? " (repeat)" : "")"
            steps.append(SweepStep(satelliteCount: count, components: components, clockMultiplier: clock, repeat: `repeat`, label: label))
        }
        for components in spec.componentSets {
            for clock in multipliers {
                for count in counts {
                    push(count, components, clock, repeat: false)
                }
            }
        }
        if let first = steps.first, steps.count > 1, spec.repeatFirstStep ?? true {
            push(first.satelliteCount, first.components, first.clockMultiplier, repeat: true)
        }
        return steps
    }

    /// Milliseconds; 400 a step approximates the build.
    public static func estimatedMilliseconds(_ steps: Int, perStep: Double) -> Double {
        Double(steps) * (perStep + 400)
    }

    /// As the report's `components` column writes a set.
    public static func components(_ components: [String]) -> String {
        components.isEmpty ? "(none)" : components.joined(separator: " + ")
    }

    /// A scaling series' name: the clock only where it is not ×1.
    public static func series(_ components: [String], clock: Double) -> String {
        clock == 1 ? Self.components(components) : "\(Self.components(components)) @ ×\(jsNumber(clock))"
    }
}

/// `value` rounded to `digits` decimals as JavaScript's `toFixed` rounds it: to
/// the nearest decimal of its exact binary value, and away from zero on an
/// exact tie, where `%f` would round to even (0.125 to 0.12, not 0.13).
func jsRound(_ value: Double, _ digits: Int) -> Double {
    let scale = pow(10, Double(digits))
    let magnitude = abs(value)
    let scaled = magnitude * scale
    // Exact only where the product lost nothing; a tie is then representable.
    if fma(magnitude, scale, -scaled) == 0, scaled - scaled.rounded(.down) == 0.5 {
        return (scaled.rounded(.down) + 1) / scale * (value < 0 ? -1 : 1)
    }
    return Double(String(format: "%.\(digits)f", value)) ?? value
}

/// As JavaScript's `String(number)`: whole numbers without a point, no negative zero.
public func jsNumber(_ value: Double) -> String {
    if value == 0 {
        return "0"
    }
    if value == value.rounded(), abs(value) < 1e21 {
        return String(format: "%.0f", value)
    }
    return "\(value)"
}
