import Foundation
import SatvisCore
import Testing

@testable import SatvisRender

/// A globe that writes down what it is told, in order.
@MainActor
private final class RecordingGlobe: Globe {
    var calls: [String] = []
    /// How many sets were packed, which each packed set carries.
    private var packed = 0

    var clock: (_ ahead: Double) -> Double = { _ in 0 } {
        didSet { calls.append("clock") }
    }
    var tileLoader: (@Sendable (TileRequest) async -> Data?)? {
        didSet { calls.append("tileLoader") }
    }
    var modelLoader: (@Sendable (String) async -> Data?)? {
        didSet { calls.append("modelLoader") }
    }
    var onGPUFault: (@MainActor @Sendable (GPUFault) -> Void)? {
        didSet { calls.append("onGPUFault") }
    }
    var unseen = UnseenMode.dim {
        didSet { calls.append("unseen \(unseen.rawValue)") }
    }
    var cameraFrame = CameraFrame.fixed {
        didSet { calls.append("cameraFrame \(cameraFrame.rawValue)") }
    }
    var components: SatelliteComponents = [] {
        didSet { calls.append("components \(components.rawValue)") }
    }
    var passthrough: CameraLens? {
        didSet { calls.append("passthrough \(passthrough.map { "\($0.tanHalfLongSide)" } ?? "-")") }
    }
    var chasing: Set<String> = [] {
        didSet {
            if chasing != oldValue {
                calls.append("chasing \(chasing.sorted())")
            }
        }
    }
    func setImagery(_ layer: BaseLayer, site: URL) { calls.append("imagery \(layer.rawValue)") }
    func setInstrumentImagery(_ overlays: [ImageryOverlay]) {
        if !overlays.isEmpty {
            calls.append("instrument imagery \(overlays.map(\.layer.token))")
        }
    }
    func setTerrain(_ enabled: Bool) { calls.append("terrain \(enabled)") }
    func setStations(_ stations: [StationMarker]) { calls.append("stations \(stations.map(\.id))") }
    func setLinks(_ links: [StationLink]) { calls.append("links \(links.map(\.satellite))") }
    func setGranules(_ granules: [GranuleDrawing], fans: Set<String>) {
        if !granules.isEmpty || !fans.isEmpty {
            calls.append("granules \(granules.map(\.id)) \(fans.sorted())")
        }
    }
    func prepare(_ satellites: [PointSatellite], labelled: Bool) async -> Int {
        packed += 1
        calls.append("prepare \(packed)")
        return packed
    }
    func setSatellites(_ prepared: Int) { calls.append("satellites \(prepared)") }
    func setStarMap(faces: [Data]) { calls.append("starMap \(faces.count)") }
    func enterSky(_ camera: SkyCamera, animated: Bool) { calls.append("enterSky \(camera.latitude) \(animated)") }
    func leaveSky(animated: Bool) { calls.append("leaveSky \(animated)") }
    func track(_ id: String, animated: Bool) { calls.append("track \(id) \(animated)") }
    func stopTracking(animated: Bool) { calls.append("stopTracking \(animated)") }
    func flyHome(animated: Bool) { calls.append("flyHome \(animated)") }
    func setProjection(_ projection: GlobeProjection, animated: Bool) { calls.append("projection \(projection.rawValue) \(animated)") }
    func startBroadcast(satellite: String, station: GroundPoint, fallback: CameraView, animated: Bool) {
        calls.append("startBroadcast \(satellite) \(Int((fallback.globe.latitude * 180 / .pi).rounded())) \(animated)")
    }
    func stopBroadcast() { calls.append("stopBroadcast") }
    func currentView() -> CameraView? { .over(latitude: 1, longitude: 2, height: 3_000_000) }
    func fly(to view: CameraView, animated: Bool) { calls.append("fly \(Int((view.globe.latitude * 180 / .pi).rounded())) \(animated)") }
}

@MainActor
@Suite struct GlobeBindingTests {
    private static let site = URL(string: "https://satvis.space")!

    /// Waits for the satellites an attach hands over in a task of its own.
    private static func waitFor(_ call: String, on globe: RecordingGlobe) async {
        while !globe.calls.contains(call) {
            await Task.yield()
        }
    }

    /// Whether `globe` was told `first` before `then`.
    private static func told(_ first: String, before then: String, on globe: RecordingGlobe) -> Bool {
        guard let firstIndex = globe.calls.firstIndex(of: first), let thenIndex = globe.calls.firstIndex(of: then) else {
            return false
        }
        return firstIndex < thenIndex
    }

    // Whatever was set before the renderer compiled its shaders reaches it once,
    // the camera cutting to where the commands left it. Of the order, only what
    // `attach` promises is held to.
    @Test func appliesWhatWasSetBeforeOnAttach() async {
        let binding = GlobeBinding()
        var drawn = false
        binding.starMap = [Data(), Data(), Data(), Data(), Data(), Data()]
        binding.components = [.point]
        binding.links = [StationLink(satellite: "25544", latitude: 0, longitude: 0, start: 0, end: 1)]
        binding.track("25544", animated: true)
        binding.passthrough = CameraLens(tanHalfLongSide: 0.5, aspectRatio: 16 / 9, longSideVertical: true)
        await binding.setSatellites([]) { drawn = true }
        binding.stations = [StationMarker(id: "a", latitude: 1, longitude: 2)]
        binding.cameraFrame = .inertial
        binding.setProjection(.twoD, animated: true)
        binding.unseen = .hide
        binding.terrain = true
        binding.setImagery(.blackMarble, site: Self.site)
        #expect(!drawn)

        let globe = RecordingGlobe()
        binding.attach(globe: globe)
        await Self.waitFor("satellites 1", on: globe)
        #expect(
            Set(globe.calls) == [
                "clock", "tileLoader", "modelLoader", "imagery BlackMarble", "terrain true", "unseen hide",
                "cameraFrame Inertial", "projection 2D false", "stations [\"a\"]", "onGPUFault", "track 25544 false", "passthrough 0.5", "links [\"25544\"]",
                "components \(SatelliteComponents.point.rawValue)", "starMap 6", "prepare 1", "satellites 1",
            ])
        #expect(Set(globe.calls).count == globe.calls.count)
        #expect(Self.told("tileLoader", before: "imagery BlackMarble", on: globe))
        #expect(Self.told("modelLoader", before: "satellites 1", on: globe))
        #expect(Self.told("stations [\"a\"]", before: "track 25544 false", on: globe))
        // The camera is placed in the projection it is drawn in.
        #expect(Self.told("projection 2D false", before: "track 25544 false", on: globe))
        #expect(Self.told("components \(SatelliteComponents.point.rawValue)", before: "satellites 1", on: globe))
        #expect(globe.calls.last == "satellites 1")
        #expect(drawn)
    }

    // Once attached, each change goes straight through, the satellites packed
    // before the setter returns.
    @Test func passesChangesThroughOnceAttached() async {
        let binding = GlobeBinding()
        let globe = RecordingGlobe()
        binding.attach(globe: globe)
        globe.calls = []

        binding.terrain = true
        binding.enterSky(SkyCamera(latitude: 48, longitude: 11), animated: true)
        binding.stopTracking(animated: false)
        binding.setProjection(.twoD, animated: true)
        var drawn = false
        await binding.setSatellites([]) { drawn = true }
        #expect(globe.calls == ["terrain true", "enterSky 48.0 true", "stopTracking false", "projection 2D true", "prepare 1", "satellites 1"])
        #expect(drawn)
    }

    // Components that come with a new set reach the renderer with it, after its
    // packing: before, a 3D model asked for the set still drawn loaded every
    // model of it.
    @Test func givesComponentsWithTheirSatellites() async {
        let binding = GlobeBinding()
        let globe = RecordingGlobe()
        binding.attach(globe: globe)
        globe.calls = []

        await binding.setSatellites([], components: [.point, .model]) {}
        #expect(globe.calls == ["prepare 1", "components \(SatelliteComponents([.point, .model]).rawValue)", "satellites 1"])
    }

    // The granules set before the renderer compiled its shaders reach it, and once
    // attached each set goes straight through, to a second renderer as it is now.
    @Test func replaysTheGranules() async {
        let binding = GlobeBinding()
        let outline = [(0.0, 0.0), (1, 0), (1, 1), (0, 0)].map { GroundPoint(latitude: $0.0, longitude: $0.1) }
        let granule = GranuleDrawing(id: "g", satellite: "43013", start: 0, end: 360_000, outline: outline, state: .waiting)
        binding.setGranules([granule], fans: ["43013"])
        let first = RecordingGlobe()
        binding.attach(globe: first)
        #expect(first.calls.contains("granules [\"g\"] [\"43013\"]"))
        #expect(Self.told("components \(binding.components.rawValue)", before: "granules [\"g\"] [\"43013\"]", on: first))

        first.calls = []
        binding.setGranules([], fans: ["43013"])
        #expect(first.calls == ["granules [] [\"43013\"]"])
        let second = RecordingGlobe()
        binding.attach(globe: second)
        #expect(second.calls.contains("granules [] [\"43013\"]"))
    }

    // The chased satellites set before the renderer arrived reach it before the
    // camera tracks one, so the track starts in the chase; once attached each
    // change goes straight through, and a second renderer gets them as they are.
    @Test func replaysTheChasedSatellites() async {
        let binding = GlobeBinding()
        binding.chasing = ["43013"]
        binding.track("43013", animated: true)
        let first = RecordingGlobe()
        binding.attach(globe: first)
        #expect(Self.told("chasing [\"43013\"]", before: "track 43013 false", on: first))

        first.calls = []
        binding.chasing = []
        #expect(first.calls == ["chasing []"])
        binding.chasing = ["25544", "43013"]
        let second = RecordingGlobe()
        binding.attach(globe: second)
        #expect(second.calls.contains("chasing [\"25544\", \"43013\"]"))
    }

    // A replay's camera: the view flown to is where a later renderer starts, a
    // broadcast only starts on a renderer, one asked for before it starts over the
    // station, and taking it over lets go of what was tracked.
    @Test func replaysTheViewFlownTo() async throws {
        let binding = GlobeBinding()
        #expect(binding.currentView() == nil)
        binding.startBroadcast(satellite: "43013", station: GroundPoint(latitude: 30, longitude: 11), fallbackHeight: 5_000_000, animated: true)
        let early = RecordingGlobe()
        binding.attach(globe: early)
        #expect(early.calls.contains("fly 30 false"))
        binding.flyOver(latitude: 48, longitude: 11, height: 5_000_000, animated: true)
        let first = RecordingGlobe()
        binding.attach(globe: first)
        #expect(first.calls.contains("fly 48 false"))

        binding.track("25544", animated: false)
        first.calls = []
        binding.startBroadcast(satellite: "43013", station: GroundPoint(latitude: 48, longitude: 11), fallbackHeight: 5_000_000, animated: true)
        binding.stopBroadcast()
        #expect(first.calls == ["startBroadcast 43013 48 true", "stopBroadcast"])
        let view = try #require(binding.currentView())
        let second = RecordingGlobe()
        binding.attach(globe: second)
        #expect(!second.calls.contains { $0.hasPrefix("track") })
        #expect(second.calls.contains("fly 48 false"))

        binding.fly(to: view, animated: true)
        #expect(second.calls.last == "fly 1 true")
    }

    // A new renderer gets the state as it is now: the camera where the last
    // commands left it, not where it first was.
    @Test func givesASecondGlobeTheCurrentState() async {
        let binding = GlobeBinding()
        binding.track("25544", animated: false)
        let first = RecordingGlobe()
        binding.attach(globe: first)
        await Self.waitFor("onGPUFault", on: first)

        binding.stopTracking(animated: true)
        binding.enterSky(SkyCamera(latitude: 48, longitude: 11), animated: true)
        binding.unseen = .show
        let second = RecordingGlobe()
        binding.attach(globe: second)
        #expect(second.calls.contains("unseen show"))
        #expect(second.calls.contains("enterSky 48.0 false"))
        #expect(!second.calls.contains { $0.hasPrefix("track") })

        binding.leaveSky(animated: true)
        let third = RecordingGlobe()
        binding.attach(globe: third)
        #expect(!third.calls.contains { $0.hasPrefix("enterSky") || $0.hasPrefix("track") })
    }
}
