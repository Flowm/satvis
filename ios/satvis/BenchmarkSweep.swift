import Foundation
import Observation
import SatvisCore
import SatvisRender

/// The web app's sweep (ADR 0016), read by the same tables (`SweepReport`). The
/// view and the clock come back as they were.
@Observable
final class SweepBenchmark {
    /// `SATVIS_SWEEP`, a `SweepPlan.named` name, runs it at launch and prints its JSON.
    static let launchSpec = ProcessInfo.processInfo.environment["SATVIS_SWEEP"].flatMap { SweepPlan.named[$0] }
    static let buildTimeout: Duration = .seconds(90)

    private(set) var phase = Benchmark.Phase.idle
    private(set) var steps: [SweepStep] = []
    private(set) var run: SweepRun?
    private(set) var stepStarted: Date?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var savedLink: Link?
    /// Put back at the end or as the app leaves the foreground.
    @ObservationIgnored private var savedClock: (multiplier: Double, playing: Bool)?

    var isRunning: Bool { phase.scene != nil }

    /// Unless one is going; `prints` writes its JSON to stdout at the end.
    func start(_ spec: SweepSpec, on session: Session, prints: Bool) {
        let steps = SweepPlan.steps(spec)
        guard !isRunning, !steps.isEmpty, let renderer = session.renderer else {
            return
        }
        self.steps = steps
        phase = .loading(0)
        stepStarted = Date()
        let clock = session.clock.clock
        savedLink = session.link(sharing: false)
        savedClock = (clock.multiplier, clock.isPlaying)
        let environment = Benchmark.environment(renderer: renderer, session: session).mapValues(Self.value)
        let options: [String: ReportValue] = ["warmupMs": .number(SweepPlan.warmupMilliseconds), "sampleMs": .number(SweepPlan.sampleMilliseconds)]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let startedAt = iso.string(from: Date())
        run = SweepRun(results: [], startedAtIso: startedAt, spec: spec, environment: environment, options: options, catalogSize: 0, cancelled: false)
        task = Task {
            // Otherwise the first steps measure group downloads.
            await session.catalog.loadAll()
            // `loadAll` returns with the kept copies, the worker's answer still on its way; the
            // web app waits for the worker, and a kept copy a day old gave the iPad one name more.
            await session.catalog.revalidate()
            // Sorted as JavaScript sorts, by UTF-16 code unit, so both apps take the same
            // first N; once each, since activation matches by name.
            let names = Set(session.catalog.catalog.entries.values.map(\.name)).sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            run?.catalogSize = names.count
            // Abandoned during the load: the clock is already back, and must not start again.
            if !Task.isCancelled {
                // A stopped clock would measure idleness.
                if !session.clock.clock.isPlaying {
                    session.clock.togglePlaying()
                }
                renderer.measureFrames(true, for: "sweep")
                renderer.drawsEveryFrame = true
            }
            for (index, step) in steps.enumerated() {
                guard !Task.isCancelled,
                    let result = await measure(step, index: index, names: names, session: session, renderer: renderer)
                else {
                    break
                }
                run?.results.append(result)
            }
            run?.environment["device_thermal_state_end"] = .string(Benchmark.name(ProcessInfo.processInfo.thermalState))
            restore(on: session)
            let complete = run?.results.count == steps.count
            run?.cancelled = !complete
            phase = complete ? .done : .cancelled
            if prints, let run {
                print(SweepReport.json(run))
            }
        }
    }

    /// `closing` as the panel closes: the view opened again is then without it.
    func cancel(closing: Bool) {
        if closing {
            savedLink?.query.items.removeAll { $0.key == "bench" }
        }
        task?.cancel()
    }

    /// Puts the clock and the pacing back at once, in case iOS ends the app first.
    /// Returns the user's view; the run's own end still opens it, should iOS keep the app.
    func abandon(on session: Session) -> Link? {
        task?.cancel()
        restoreClock(on: session)
        return savedLink
    }

    /// The clock, then the user's view.
    private func restore(on session: Session) {
        restoreClock(on: session)
        if let savedLink {
            self.savedLink = nil
            // Its stations, activation and components, as they were.
            session.open(savedLink)
        }
    }

    /// The clock and the pacing, once.
    private func restoreClock(on session: Session) {
        session.renderer?.drawsEveryFrame = false
        session.renderer?.measureFrames(false, for: "sweep")
        guard let savedClock else {
            return
        }
        self.savedClock = nil
        session.clock.setMultiplier(savedClock.multiplier)
        if session.clock.clock.isPlaying != savedClock.playing {
            session.clock.togglePlaying()
        }
    }

    /// Clears, builds, warms up and records one step; nil once cancelled.
    private func measure(_ step: SweepStep, index: Int, names: [String], session: Session, renderer: GlobeRenderer) async -> SweepResult? {
        phase = .loading(index)
        stepStarted = Date()
        let components = SatelliteComponents(names: step.components)
        // Real time during the build, or it would carry propagation at ×1000.
        session.clock.setMultiplier(1)
        // Links draw only to a station, and predict every pass of the satellites they show.
        session.setSweepStation(
            components.contains(.groundStationLink)
                ? GroundStation(latitude: SweepPlan.groundStation.latitude, longitude: SweepPlan.groundStation.longitude, name: "Benchmark") : nil)
        // Cleared first, or the build measures the change from the last step.
        let cleared = ContinuousClock.now
        await session.showSweep(names: [], components: components)
        guard await untilDrawn(session) else {
            return nil
        }
        let clearMs = Self.milliseconds(since: cleared)
        let built = ContinuousClock.now
        await session.showSweep(names: Set(names.prefix(step.satelliteCount)), components: components)
        guard await untilDrawn(session) else {
            return nil
        }
        let buildMs = Self.milliseconds(since: built)
        // Only now, so the warmup absorbs the first refreshes at the new rate.
        session.clock.setMultiplier(step.clockMultiplier)
        phase = .settling(index)
        try? await Task.sleep(for: .milliseconds(SweepPlan.warmupMilliseconds))
        phase = .measuring(index)
        renderer.startRecordingFrames()
        try? await Task.sleep(for: .milliseconds(SweepPlan.sampleMilliseconds))
        let recording = renderer.stopRecordingFrames()
        guard !Task.isCancelled else {
            return nil
        }
        let visible = renderer.satelliteCount
        let drawn = session.catalog.components
        let (cones, models) = renderer.conesAndModels
        var instances: [String: Int] = [:]
        for (name, component) in SatelliteComponents.named where drawn.contains(component) {
            instances[name] = component == .sensorCone ? cones : component == .model ? models : visible
        }
        return SweepResult(
            step: step, clock: session.clock.clock.multiplier, visible: visible, componentsDrawn: drawn.names, componentInstances: instances,
            buildMs: buildMs, clearMs: clearMs, summary: recording.summary(refresh: session.frameBudgetMilliseconds), recording: recording,
            footprintMb: MemoryFootprint.megabytes().map(Double.init),
            extras: ["gpu_memory_mb": Double(renderer.gpuMemoryMegabytes)])
    }

    /// Waits until the renderer draws what is active; false if cancelled meanwhile.
    /// A step past `buildTimeout` is measured as it stands.
    private func untilDrawn(_ session: Session) async -> Bool {
        let start = ContinuousClock.now
        while !session.satellites.draws(session.catalog.activeEntries), ContinuousClock.now - start < Self.buildTimeout {
            try? await Task.sleep(for: .milliseconds(5))
            if Task.isCancelled {
                return false
            }
        }
        return !Task.isCancelled
    }

    /// Since `start`, in milliseconds.
    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        (ContinuousClock.now - start) / .milliseconds(1)
    }

    /// An environment value as the report's JSON holds it.
    private static func value(_ any: Any) -> ReportValue {
        // The decimal first: as an NSNumber, it would also pass for a Bool.
        switch any {
        case let value as NSDecimalNumber: .number(value.doubleValue)
        case let value as Bool: .bool(value)
        case let value as Int: .number(Double(value))
        case let value as Double: .number(value)
        case let value as String: .string(value)
        default: .string("\(any)")
        }
    }
}
