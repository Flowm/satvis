import Foundation
import Observation
import SatvisCore
import SatvisRender
import UIKit

/// The app's benchmark, the web app's (`?bench=true`, src/modules/benchmark) cut
/// to what a phone answers: a fixed list of scenes, each opened by its link,
/// waited for, settled and measured, and the first measured again at the end to
/// show whether the device warmed up or the app drifted under the run. The view
/// comes back as it was. The results stay on the device unless the user sends
/// them.
@Observable
final class Benchmark {
    enum Phase: Equatable {
        case idle
        case loading(Int)
        case settling(Int)
        case measuring(Int)
        case done
        case cancelled
    }

    /// The scenes the device runs, cheap to heavy: the web app's axes of count and
    /// component, the 3D model close up and the sky view, which the tests on an
    /// iPad mini found to differ most (ios/docs/manual-verification.md), and two
    /// idle.
    static let scenes = [
        BenchmarkScene(
            id: "default_view", title: "Default view", subtitle: "Points and labels", detail: "The default preset's satellites, points and labels, on the globe",
            link: "/"),
        BenchmarkScene(
            id: "default_view_idle", title: "Default view", subtitle: "Idle",
            detail: "The default preset idle at x1, each frame drawn only once something can have moved half a pixel", link: "/", idle: true),
        BenchmarkScene(
            id: "starlink_points", title: "Starlink", subtitle: "Points", detail: "The Starlink group, points only", link: "/?tags=Starlink&elements=Point"),
        BenchmarkScene(
            id: "active_points", title: "All active", subtitle: "Points", detail: "Every active satellite, points only", link: "/?tags=Active&elements=Point"),
        BenchmarkScene(
            id: "weather_all_components", title: "Weather", subtitle: "Every component",
            detail: "Weather satellites with points, labels, orbits, orbit and ground tracks, and sensor cones",
            link: "/?tags=Weather&elements=Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone"),
        BenchmarkScene(
            id: "weather_all_components_idle", title: "Weather", subtitle: "Idle",
            detail: "Weather satellites with every component idle at x1, each frame drawn only once something can have moved half a pixel",
            link: "/?tags=Weather&elements=Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone", idle: true),
        BenchmarkScene(
            id: "active_orbits", title: "All active", subtitle: "Orbits", detail: "Every active satellite with its orbit, 121 nodes each",
            link: "/?tags=Active&elements=Point,Orbit"),
        BenchmarkScene(
            id: "iss_model_tracked", title: "ISS", subtitle: "3D model, tracked", detail: "The ISS alone, its 3D model followed close up, with its orbit",
            link: "/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model"),
        BenchmarkScene(
            id: "iss_model_tracked_panel", title: "ISS", subtitle: "Tracked, panel open",
            detail: "The ISS alone, its 3D model followed close up, with its orbit and its info panel open",
            link: "/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model", keepsPanel: true),
        BenchmarkScene(
            id: "sky_view", title: "Sky view", subtitle: "Lauterbrunnen", detail: "Looking up from Lauterbrunnen, on terrain, the default preset's satellites",
            link: "/?scene=Sky&gs=46.5935,7.9091,Lauterbrunnen"),
        BenchmarkScene(
            id: "sky_active", title: "Sky view", subtitle: "All active", detail: "Looking up from Lauterbrunnen, on terrain, every active satellite",
            link: "/?scene=Sky&gs=46.5935,7.9091,Lauterbrunnen&tags=Active"),
    ]
    /// Changed when the scenes or the metrics change, so results can be told apart.
    static let version = 7

    /// How long a scene may take to load before it is measured anyway: the
    /// largest groups come from the worker on a first run.
    static let loadTimeout: Duration = .seconds(90)
    /// After loading, for the tiles, the model and the shader caches to settle.
    static let settle: Duration = .seconds(3)
    static let measure: Duration = .seconds(5)
    /// The scenes and the drift check (`BenchmarkScene.plan`), or only those
    /// `SATVIS_BENCHMARK_SCENES` in the launch environment names.
    static var plan: [BenchmarkScene] {
        BenchmarkScene.plan(scenes, only: ProcessInfo.processInfo.environment["SATVIS_BENCHMARK_SCENES"])
    }

    /// `SATVIS_BENCHMARK` in the launch environment runs the benchmark at once,
    /// sends its results where usage is shared and prints them as JSON to
    /// standard output: for a device driven from the Mac (`xcrun devicectl device
    /// process launch --console`). `SATVIS_BENCHMARK=print` only prints them.
    static let runsAtLaunch = ProcessInfo.processInfo.environment["SATVIS_BENCHMARK"] != nil
    private static let sendsAtLaunch = runsAtLaunch && ProcessInfo.processInfo.environment["SATVIS_BENCHMARK"] != "print"
    /// Whether that run has begun: SwiftUI may run the session's task again.
    @ObservationIgnored private var ranAtLaunch = false

    private(set) var phase = Phase.idle
    private(set) var results: [BenchmarkResult] = []
    /// What the device was doing when the run began and ended.
    private(set) var environment: [String: Any] = [:]
    private(set) var submitted = false
    @ObservationIgnored private var run: Task<Void, Never>?
    /// The user's view while a run shows its scenes, opened again at its end.
    @ObservationIgnored private(set) var savedLink: Link?
    /// The settings the scenes' links change and the app keeps between launches.
    @ObservationIgnored private var savedSettings: (baseLayer: BaseLayer, terrain: Bool, mode: OverpassMode)?

    var isRunning: Bool {
        switch phase {
        case .loading, .settling, .measuring: true
        default: false
        }
    }

    /// Runs every scene in turn on `session`, then opens the view it found. A run
    /// `SATVIS_BENCHMARK` started sends its results itself.
    func start(on session: Session) {
        guard !isRunning, let renderer = session.renderer else {
            return
        }
        results = []
        submitted = false
        // Running from here on, so a second start finds it so.
        phase = .loading(0)
        environment = Self.environment(renderer: renderer, session: session)
        savedLink = session.link(sharing: false)
        savedSettings = (session.baseLayer, session.terrain, session.passes.mode)
        run = Task {
            renderer.measuresFrames = true
            for (index, scene) in Self.plan.enumerated() {
                guard !Task.isCancelled else {
                    break
                }
                if let result = await measure(scene, index: index, session: session, renderer: renderer) {
                    results.append(result)
                }
            }
            environment["device_thermal_state_end"] = Self.name(ProcessInfo.processInfo.thermalState)
            // Read again at the end: a run started at launch can begin before the
            // first frame at the link's pixel ratio has been drawn.
            if let size = renderer.drawableSize {
                environment["device_drawable_pixels"] = "\(Int(size.width))x\(Int(size.height))"
            }
            phase = Task.isCancelled ? .cancelled : .done
            if let savedLink {
                session.open(savedLink)
            }
            savedLink = nil
            savedSettings = nil
            if Self.runsAtLaunch, phase == .done {
                if Self.sendsAtLaunch {
                    submit(with: session.analytics)
                }
                if let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                    print(String(decoding: json, as: UTF8.self))
                }
            }
        }
    }

    /// The run `SATVIS_BENCHMARK` asks for, once.
    func startAtLaunch(on session: Session) {
        guard Self.runsAtLaunch, !ranAtLaunch else {
            return
        }
        ranAtLaunch = true
        start(on: session)
    }

    /// `closing` as the panel closes: the view opened again is then without it.
    func cancel(closing: Bool = false) {
        if closing {
            savedLink?.query.items.removeAll { $0.key == "bench" }
        }
        run?.cancel()
    }

    /// Stops a run as the app leaves the foreground, where iOS draws no frames to
    /// measure, and puts the user's settings back at once: iOS may end the app
    /// before the run's own restore, which left the last scene's base map,
    /// terrain and pass mode kept as the user's. The user's view, to keep.
    func abandon(on session: Session) -> Link? {
        guard isRunning else {
            return nil
        }
        run?.cancel()
        if let savedSettings {
            session.baseLayer = savedSettings.baseLayer
            session.terrain = savedSettings.terrain
            session.passes.setMode(savedSettings.mode)
        }
        return savedLink
    }

    private func measure(_ scene: BenchmarkScene, index: Int, session: Session, renderer: GlobeRenderer) async -> BenchmarkResult? {
        phase = .loading(index)
        let opened = ContinuousClock.now
        // At the pixel ratio the run began at, which the scenes' links do not name.
        var link = Link(scene.link)
        if let ratio = environment["app_pixel_ratio"] as? String, ratio != "native" {
            link.query.items.append(LinkQuery.Item(key: "pixelratio", values: [ratio]))
        }
        session.open(link)
        // Loaded once everything active is drawn and has stayed so for two
        // seconds: groups arrive one by one, and are handed to the renderer
        // packed, off the main thread.
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
        // A tracking link selects what it follows; its panel would cover the
        // scene measured and cost its own frames, unless that is what is measured.
        if !scene.keepsPanel {
            session.select(nil)
        }
        phase = .settling(index)
        try? await Task.sleep(for: Self.settle)
        phase = .measuring(index)
        let (cpuBefore, wallBefore) = (Self.processCPUSeconds(), ContinuousClock.now)
        renderer.startRecordingFrames(idle: scene.idle)
        try? await Task.sleep(for: Self.measure)
        let recording = renderer.stopRecordingFrames()
        let processCPU = Self.processCPUSeconds() - cpuBefore
        let wall = (ContinuousClock.now - wallBefore) / .seconds(1)
        guard !Task.isCancelled else {
            return nil
        }
        let maximumRate = GlobeRenderer.displayMaximumFramesPerSecond
        return BenchmarkResult(
            id: scene.id, title: scene.title, detail: scene.detail,
            satellites: renderer.satelliteCount, loadSeconds: max(loaded / .seconds(1), 0),
            timedOut: timedOut, recording: recording, memoryMegabytes: MemoryFootprint.megabytes(), gpuMemoryMegabytes: renderer.gpuMemoryMegabytes,
            processCPUPercent: wall > 0 ? processCPU / wall * 100 : nil, refreshMilliseconds: 1000 / Double(min(session.frameRate, maximumRate)),
            idle: scene.idle)
    }

    /// The CPU time every thread of the app has used, in seconds.
    private static func processCPUSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func seconds(_ time: timeval) -> Double { Double(time.tv_sec) + Double(time.tv_usec) / 1e6 }
        return seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    /// The first scene against its repeat at the end (`BenchmarkReport.drift`).
    var drift: Double? {
        BenchmarkReport.drift(results, planned: Self.plan.count)
    }

    /// Sends the results to the web app's PostHog project, with what they depend
    /// on: the device, the system, the build and the screen. Only on the user's
    /// word, or a `SATVIS_BENCHMARK` launch's, and only where usage is counted at
    /// all.
    func submit(with analytics: Analytics) {
        guard phase == .done, !submitted else {
            return
        }
        submitted = analytics.send("benchmark", properties: report)
    }

    /// The results as they are sent (`BenchmarkReport.properties`).
    var report: [String: Any] {
        BenchmarkReport.properties(environment: environment, version: Self.version, results: results, planned: Self.plan.count)
    }

    /// What the frame times depend on beyond the app.
    private static func environment(renderer: GlobeRenderer, session: Session) -> [String: Any] {
        var system = utsname()
        uname(&system)
        let identifier = withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        let info = Bundle.main.infoDictionary ?? [:]
        let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen
        var environment: [String: Any] = [
            "app_version": info["CFBundleShortVersionString"] as? String ?? "",
            "app_build": info["CFBundleVersion"] as? String ?? "",
            "device_model_identifier": identifier,
            "device_kind": UIDevice.current.model,
            "device_os_version": UIDevice.current.systemVersion,
            "device_processor_count": ProcessInfo.processInfo.activeProcessorCount,
            "device_memory_gb": NSDecimalNumber(string: String(format: "%.1f", Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824)),
            "device_low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "app_pixel_ratio": session.pixelRatio,
            "app_frame_rate": session.frameRate,
            "device_thermal_state_start": name(ProcessInfo.processInfo.thermalState),
        ]
        if let screen {
            environment["device_screen_pixels"] = "\(Int(screen.nativeBounds.width))x\(Int(screen.nativeBounds.height))"
            environment["device_screen_scale"] = screen.nativeScale
            environment["device_max_fps"] = screen.maximumFramesPerSecond
        }
        if let size = renderer.drawableSize {
            environment["device_drawable_pixels"] = "\(Int(size.width))x\(Int(size.height))"
        }
        return environment
    }

    private static func name(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }
}
