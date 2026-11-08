import Foundation

/// The benchmark panel's status line, held to the web app's by a parity fixture.
public struct BenchmarkStatus: Sendable, Equatable, Codable {
    /// Where a run stands, as the status line names it.
    public enum Phase: String, Sendable, Codable {
        case idle, loading, settling, measuring, done, cancelled
    }

    /// What a run measures: the preset's benchmark scenes, or a sweep's steps.
    public enum Kind: String, Sendable, Codable {
        case scenes, sweep
    }

    /// Idle until a run of `kind` starts.
    public var phase: Phase
    /// Names the loading phase and the count.
    public var kind: Kind
    /// From 0.
    public var index: Int
    /// Before a run, the steps a run would take.
    public var total: Int
    /// Before a run, its estimate; during one, what is left.
    public var remainingMs: Double
    /// Once a run is done.
    public var driftPct: Double?
    /// Once a run is cancelled, the steps it finished.
    public var measured: Int?

    public init(phase: Phase, kind: Kind, index: Int = 0, total: Int, remainingMs: Double, driftPct: Double? = nil, measured: Int? = nil) {
        self.phase = phase
        self.kind = kind
        self.index = index
        self.total = total
        self.remainingMs = remainingMs
        self.driftPct = driftPct
        self.measured = measured
    }

    /// The load, a 3 s settle and a 5 s measure.
    public static let sceneStepEstimateMs = 12_000.0

    /// As the web app's `shownDrift`.
    public static func shownDrift(first: Double?, repeated: Double?) -> Double? {
        guard let first, let repeated, first > 0, abs(repeated - first) >= SweepReport.minimumMeaningfulDriftMilliseconds else {
            return nil
        }
        return (repeated - first) / first * 100
    }

    /// Whole seconds under 90 s, rounded minutes from there.
    public static func duration(_ ms: Double) -> String {
        let seconds = max(0, jsRound(ms / 1000, 0))
        return seconds < 90 ? "\(jsNumber(seconds)) s" : "\(jsNumber(jsRound(seconds / 60, 0))) min"
    }

    /// "10 scenes · ≈ 2 min", "4 of 7 · Measuring · 1 min left", "Done · drift +0.4 %", "Cancelled · 3 of 7".
    public var line: String {
        let noun = kind == .scenes ? (total == 1 ? "scene" : "scenes") : (total == 1 ? "step" : "steps")
        switch phase {
        case .idle:
            return total == 0 ? "No \(noun)" : "\(total) \(noun) · ≈ \(Self.duration(remainingMs))"
        case .done:
            guard let driftPct else {
                return "Done"
            }
            return "Done · drift \(driftPct > 0 ? "+" : "")\(String(format: "%.1f", jsRound(driftPct, 1))) %"
        case .cancelled:
            return "Cancelled · \(measured ?? 0) of \(total)"
        case .loading, .settling, .measuring:
            let name =
                switch phase {
                case .loading: kind == .scenes ? "Loading" : "Building"
                case .settling: "Settling"
                default: "Measuring"
                }
            return "\(index + 1) of \(total) · \(name) · \(Self.duration(remainingMs)) left"
        }
    }
}
