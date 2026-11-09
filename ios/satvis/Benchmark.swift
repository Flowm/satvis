import Foundation
import Observation
import SatvisCore
import SatvisRender

/// The web app's scene benchmark (ADR 0016), the first scene measured again at
/// the end for drift. The results stay on the device unless the user sends them
/// or a `bench=send` link or `SATVIS_BENCHMARK` launch asks to.
@Observable
final class Benchmark {
    /// Where a run is, by the step it is on; a sweep's too.
    enum Phase: Equatable {
        case idle
        case loading(Int)
        case settling(Int)
        case measuring(Int)
        case done
        case cancelled

        /// Nil outside a run.
        var scene: Int? {
            switch self {
            case .loading(let index), .settling(let index), .measuring(let index): index
            default: nil
            }
        }
    }

    /// The largest groups come from the worker on a first run.
    static let loadTimeout: Duration = .seconds(90)
    /// For the tiles, the model and the shader caches.
    static let settle: Duration = .seconds(3)
    /// Each scene's recording.
    static let measure: Duration = .seconds(5)
    /// `SATVIS_BENCHMARK` runs the benchmark at launch as a `bench=send` link does: it
    /// sends its results where usage is shared and prints them as JSON, for
    /// `devicectl device process launch --console`; `=print` only prints, as `bench=run`.
    static let runsAtLaunch = ProcessInfo.processInfo.environment["SATVIS_BENCHMARK"] != nil || SweepBenchmark.launchSpec != nil
    private static let sendsAtLaunch = ProcessInfo.processInfo.environment["SATVIS_BENCHMARK"].map { $0 != "print" } ?? false
    /// Scene ids by commas, as `benchscenes`.
    private static let launchScenes = (ProcessInfo.processInfo.environment["SATVIS_BENCHMARK_SCENES"] ?? "").split(separator: ",").map(String.init)
    /// Whether that run has begun: SwiftUI may run the session's task again.
    @ObservationIgnored private var ranAtLaunch = false

    private(set) var phase = Phase.idle
    /// As the index served them.
    private(set) var scenes: [BenchmarkScene] = []
    /// The drift check last; before a run, what a run would measure.
    private(set) var steps: [BenchmarkStep] = []
    private(set) var results: [BenchmarkResult] = []
    private(set) var environment: [String: Any] = [:]
    private(set) var submitted = false
    /// By id; every one served while nil.
    var selection: [String]?
    var sweepSpec = SweepSpec(satelliteCounts: SweepPlan.satelliteCounts, componentSets: [["Point", "Label"]])
    private(set) var stepStarted: Date?
    @ObservationIgnored private var run: Task<Void, Never>?
    /// The user's view while a run shows its scenes, opened again at its end.
    @ObservationIgnored private(set) var savedLink: Link?
    /// What the scenes' links change and the app keeps between launches.
    @ObservationIgnored private var savedSettings: (baseLayer: BaseLayer, terrain: Bool, mode: OverpassMode)?
    /// The clock's rate and play state, which each scene without a `time` sets live.
    @ObservationIgnored private var savedClock: (multiplier: Double, playing: Bool)?

    /// Shares this run's guard: one run at a time.
    let sweep = SweepBenchmark()

    /// A scene run or a sweep.
    var isRunning: Bool { phase.scene != nil || sweep.isRunning }

    /// The current preset's scenes, from the group index.
    static func served(on session: Session) -> [BenchmarkScene] {
        session.catalog.index?.benchmarkScenes(preset: session.catalog.presetName) ?? []
    }

    /// Runs the route's scenes, or `only` those without the drift check, then opens
    /// the view it found, or `restoring` where a link that starts the run is still
    /// being applied.
    func start(on session: Session, only: [String] = [], prints: Bool = false, sends: Bool = false, restoring: Link? = nil) {
        guard !isRunning, let renderer = session.renderer else {
            return
        }
        results = []
        submitted = false
        if !only.isEmpty {
            selection = only
        }
        phase = .loading(0)
        stepStarted = Date()
        environment = Self.environment(renderer: renderer, session: session)
        savedLink = restoring ?? session.link(sharing: false)
        savedSettings = (session.baseLayer, session.terrain, session.passes.mode)
        savedClock = (session.clock.clock.multiplier, session.clock.clock.isPlaying)
        run = Task {
            // The scenes come with the group index, which a first launch waits for.
            for _ in 0..<120 where Self.served(on: session).isEmpty && !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
            }
            scenes = Self.served(on: session)
            steps = BenchmarkScene.plan(scenes, only: only)
            renderer.measureFrames(true, for: "benchmark")
            for (index, step) in steps.enumerated() {
                guard !Task.isCancelled else {
                    break
                }
                if let result = await measure(step, index: index, session: session, renderer: renderer) {
                    results.append(result)
                }
            }
            renderer.drawsEveryFrame = false
            renderer.measureFrames(false, for: "benchmark")
            environment["device_thermal_state_end"] = Self.name(ProcessInfo.processInfo.thermalState)
            // Read again at the end: a run started at launch can begin before the
            // first frame at the link's pixel ratio has been drawn.
            if let size = renderer.drawableSize {
                environment["device_drawable_pixels"] = "\(Int(size.width))x\(Int(size.height))"
            }
            phase = Task.isCancelled || steps.isEmpty ? .cancelled : .done
            if let savedLink {
                session.open(savedLink)
            }
            restoreClock(on: session)
            savedLink = nil
            savedSettings = nil
            if phase == .done {
                if sends {
                    submit(with: session.analytics)
                }
                if prints, let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                    print(String(decoding: json, as: UTF8.self))
                }
            }
        }
    }

    /// Unless a scene run is going.
    func startSweep(_ spec: SweepSpec, on session: Session, prints: Bool = false) {
        guard !isRunning else {
            return
        }
        sweep.start(spec, on: session, prints: prints)
    }

    /// What `SATVIS_BENCHMARK` or `SATVIS_SWEEP` asks for, once.
    func startAtLaunch(on session: Session) {
        guard Self.runsAtLaunch, !ranAtLaunch else {
            return
        }
        ranAtLaunch = true
        if let spec = SweepBenchmark.launchSpec {
            startSweep(spec, on: session, prints: true)
        } else {
            start(on: session, only: Self.launchScenes, prints: true, sends: Self.sendsAtLaunch)
        }
    }

    /// `closing` as the panel closes: the view opened again is then without it.
    func cancel(closing: Bool = false) {
        if closing {
            savedLink?.query.items.removeAll { $0.key == "bench" }
        }
        run?.cancel()
        sweep.cancel(closing: closing)
    }

    /// Stops a run as the app leaves the foreground, where iOS draws no frames, and
    /// puts the user's settings back at once, as iOS may end the app before the
    /// run's own restore. Returns the user's view.
    func abandon(on session: Session) -> Link? {
        if sweep.isRunning {
            return sweep.abandon(on: session)
        }
        guard isRunning else {
            return nil
        }
        run?.cancel()
        session.renderer?.drawsEveryFrame = false
        if let savedSettings {
            session.baseLayer = savedSettings.baseLayer
            session.terrain = savedSettings.terrain
            session.passes.setMode(savedSettings.mode)
        }
        restoreClock(on: session)
        return savedLink
    }

    /// Once, at the run's end or as it is abandoned.
    private func restoreClock(on session: Session) {
        guard let savedClock else {
            return
        }
        self.savedClock = nil
        session.clock.setMultiplier(savedClock.multiplier)
        if session.clock.clock.isPlaying != savedClock.playing {
            session.clock.togglePlaying()
        }
    }

    /// Opens the scene, waits until it is drawn and steady, settles and records;
    /// nil once cancelled.
    private func measure(_ step: BenchmarkStep, index: Int, session: Session, renderer: GlobeRenderer) async -> BenchmarkResult? {
        phase = .loading(index)
        stepStarted = Date()
        let opened = ContinuousClock.now
        // At the pixel ratio the run began at and with the performance panel as
        // it is, which the scenes' links do not name.
        var link = step.scene.link
        if let ratio = environment["app_pixel_ratio"] as? String, ratio != "native" {
            link.query.items.append(LinkQuery.Item(key: "pixelratio", values: [ratio]))
        }
        if session.fpsPanel != .off {
            link.query.items.append(LinkQuery.Item(key: "fps", values: [session.fpsPanel.rawValue]))
        }
        // A paused or fast clock stays off `time` for its first minute, which `open`
        // would leave as it is: a scene without one is live, as on the web.
        if step.scene.query["time"] == nil {
            session.clock.goLive()
        }
        // Paced: measured idle, as outside the benchmark.
        renderer.drawsEveryFrame = !step.paced
        session.open(link)
        // Two seconds steady: groups arrive one by one, packed off the main thread.
        var steady: ContinuousClock.Instant?
        var last = -1
        var timedOut = false
        while true {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else {
                return nil
            }
            let drawn = renderer.satelliteCount
            let complete = session.satellites.draws(session.catalog.activeEntries)
            // From when it is complete and its count holds, which a set completed
            // without a change of count, a link shown again, starts as well.
            if !complete || drawn != last {
                steady = complete ? .now : nil
            } else if steady == nil {
                steady = .now
            }
            last = drawn
            if let steady, ContinuousClock.now - steady >= .seconds(2) {
                break
            }
            if ContinuousClock.now - opened > Self.loadTimeout {
                timedOut = true
                break
            }
        }
        let loaded = ContinuousClock.now - opened - (timedOut ? .zero : .seconds(2))
        // No scene measures the info panel: a link opens none, and one opened
        // since would cost its own frames.
        session.select(nil)
        phase = .settling(index)
        try? await Task.sleep(for: Self.settle)
        phase = .measuring(index)
        renderer.startRecordingFrames()
        try? await Task.sleep(for: Self.measure)
        let recording = renderer.stopRecordingFrames()
        guard !Task.isCancelled else {
            return nil
        }
        return BenchmarkResult(
            id: step.id, satellites: renderer.satelliteCount, loadSeconds: max(loaded / .seconds(1), 0),
            timedOut: timedOut, recording: recording, memoryMegabytes: MemoryFootprint.megabytes(), gpuMemoryMegabytes: renderer.gpuMemoryMegabytes,
            refreshMilliseconds: session.frameBudgetMilliseconds)
    }

    /// As the status line shows it.
    var drift: Double? {
        let steps = BenchmarkReport.driftSteps(results, planned: steps.count)
        return BenchmarkStatus.shownDrift(first: steps?.first.recording.meanCPU, repeated: steps?.repeated.recording.meanCPU)
    }

    /// To the web app's PostHog project, only on the user's word, a `bench=send`
    /// link's or a `SATVIS_BENCHMARK` launch's, and only where usage is counted at all.
    func submit(with analytics: Analytics) {
        guard phase == .done, !submitted else {
            return
        }
        submitted = analytics.send("benchmark", properties: report)
    }

    /// The event's properties, as the web app's `sceneRunProperties`.
    var report: [String: Any] {
        BenchmarkReport.properties(environment: environment, scenes: scenes, results: results, planned: steps.count, cancelled: phase == .cancelled)
    }

    /// The device and the app's settings, as the report's `device_` and `app_` keys.
    static func environment(renderer: GlobeRenderer, session: Session) -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        var environment: [String: Any] = [
            "app_version": info["CFBundleShortVersionString"] as? String ?? "",
            "app_build": info["CFBundleVersion"] as? String ?? "",
            "device_model_identifier": Platform.modelIdentifier,
            "device_kind": Platform.deviceKind,
            "device_os_version": Platform.systemVersion,
            "device_processor_count": ProcessInfo.processInfo.activeProcessorCount,
            "device_memory_gb": NSDecimalNumber(string: String(format: "%.1f", Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824)),
            "device_low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "app_pixel_ratio": session.pixelRatio,
            // The web app's words for it, and the budget it gives on this screen.
            "app_frame_rate": session.frameRate == Session.maximumFrameRate ? "max" : String(session.frameRate),
            "app_frame_budget_ms": NSDecimalNumber(string: String(format: "%.2f", session.frameBudgetMilliseconds)),
            "device_thermal_state_start": name(ProcessInfo.processInfo.thermalState),
        ]
        if let screen = Platform.screen {
            environment["device_screen_pixels"] = "\(Int(screen.pixels.width))x\(Int(screen.pixels.height))"
            environment["device_screen_scale"] = screen.scale
            environment["device_max_fps"] = screen.maximumFramesPerSecond
        }
        if let size = renderer.drawableSize {
            environment["device_drawable_pixels"] = "\(Int(size.width))x\(Int(size.height))"
        }
        return environment
    }

    /// As the report names it.
    static func name(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }
}
