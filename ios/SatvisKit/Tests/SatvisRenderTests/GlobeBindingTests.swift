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

    var clock: () -> Double = { 0 } {
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
    func setImagery(_ layer: BaseLayer, site: URL, frame: String?) { calls.append("imagery \(layer.rawValue) \(frame ?? "-")") }
    func setTerrain(_ enabled: Bool) { calls.append("terrain \(enabled)") }
    func setStations(_ stations: [StationMarker]) { calls.append("stations \(stations.map(\.id))") }
    func setLinks(_ links: [StationLink]) { calls.append("links \(links.map(\.satellite))") }
    func prepare(_ satellites: [PointSatellite]) async -> Int {
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
        binding.unseen = .hide
        binding.terrain = true
        binding.setImagery(.viirs, site: Self.site, frame: "2026-10-18")
        #expect(!drawn)

        let globe = RecordingGlobe()
        binding.attach(globe)
        await Self.waitFor("satellites 1", on: globe)
        #expect(
            Set(globe.calls) == [
                "clock", "tileLoader", "modelLoader", "imagery VIIRS 2026-10-18", "terrain true", "unseen hide",
                "cameraFrame Inertial", "stations [\"a\"]", "onGPUFault", "track 25544 false", "passthrough 0.5", "links [\"25544\"]",
                "components \(SatelliteComponents.point.rawValue)", "starMap 6", "prepare 1", "satellites 1",
            ])
        #expect(Set(globe.calls).count == globe.calls.count)
        #expect(Self.told("tileLoader", before: "imagery VIIRS 2026-10-18", on: globe))
        #expect(Self.told("modelLoader", before: "satellites 1", on: globe))
        #expect(Self.told("stations [\"a\"]", before: "track 25544 false", on: globe))
        #expect(Self.told("components \(SatelliteComponents.point.rawValue)", before: "satellites 1", on: globe))
        #expect(globe.calls.last == "satellites 1")
        #expect(drawn)
    }

    // Once attached, each change goes straight through, the satellites packed
    // before the setter returns.
    @Test func passesChangesThroughOnceAttached() async {
        let binding = GlobeBinding()
        let globe = RecordingGlobe()
        binding.attach(globe)
        globe.calls = []

        binding.terrain = true
        binding.enterSky(SkyCamera(latitude: 48, longitude: 11), animated: true)
        binding.stopTracking(animated: false)
        var drawn = false
        await binding.setSatellites([]) { drawn = true }
        #expect(globe.calls == ["terrain true", "enterSky 48.0 true", "stopTracking false", "prepare 1", "satellites 1"])
        #expect(drawn)
    }

    // Components that come with a new set reach the renderer with it, after its
    // packing: before, a 3D model asked for the set still drawn loaded every
    // model of it.
    @Test func givesComponentsWithTheirSatellites() async {
        let binding = GlobeBinding()
        let globe = RecordingGlobe()
        binding.attach(globe)
        globe.calls = []

        await binding.setSatellites([], components: [.point, .model]) {}
        #expect(globe.calls == ["prepare 1", "components \(SatelliteComponents([.point, .model]).rawValue)", "satellites 1"])
    }

    // A new renderer gets the state as it is now: the camera where the last
    // commands left it, not where it first was.
    @Test func givesASecondGlobeTheCurrentState() async {
        let binding = GlobeBinding()
        binding.track("25544", animated: false)
        let first = RecordingGlobe()
        binding.attach(first)
        await Self.waitFor("onGPUFault", on: first)

        binding.stopTracking(animated: true)
        binding.enterSky(SkyCamera(latitude: 48, longitude: 11), animated: true)
        binding.unseen = .show
        let second = RecordingGlobe()
        binding.attach(second)
        #expect(second.calls.contains("unseen show"))
        #expect(second.calls.contains("enterSky 48.0 false"))
        #expect(!second.calls.contains { $0.hasPrefix("track") })

        binding.leaveSky(animated: true)
        let third = RecordingGlobe()
        binding.attach(third)
        #expect(!third.calls.contains { $0.hasPrefix("enterSky") || $0.hasPrefix("track") })
    }

    // The launch benchmark waits for the renderer; once there, nobody waits.
    @Test func resumesThoseWaitingForAGlobe() async {
        let binding = GlobeBinding()
        let waiter = Task { await binding.untilAttached() }
        await Task.yield()
        #expect(!binding.isAttached)
        binding.attach(RecordingGlobe())
        await waiter.value
        await binding.untilAttached()
        #expect(binding.isAttached)
    }
}
