import CoreLocation
import Foundation
import OSLog
import Observation
import SatvisCore
import SatvisData
import SatvisRender
import UIKit

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

/// What the info panel is about.
enum Selection: Hashable {
    /// A catalog id.
    case satellite(String)
    /// A ground station, by its id.
    case station(UUID)
}

/// One open globe and everything it shows: the models, what is selected and
/// followed, and the work that keeps them in step. Owned by the app rather than a
/// view, so that whatever opens the app with a state of its own (a link, a
/// restored scene) can set it here. The views read it and call it.
@Observable
final class Session {
    /// The site the worker answers at, whose static files (the finer Natural
    /// Earth levels) the globe streams.
    let site: URL
    @ObservationIgnored private let repository: GroupRepository
    let alerts: PassAlerts
    let clock = ViewerClock()
    let catalog: CatalogModel
    let passes = PassModel()
    @ObservationIgnored let satellites = SatelliteLayer()
    @ObservationIgnored private let starMap = StarMap()
    /// The demo bookmarks' pictures by their path on the site, kept once fetched.
    private(set) var demoPictures: [String: Data] = [:]
    /// Observed: it arrives once its shaders compile, possibly after a link has
    /// opened on the sky view, whose instruments wait for it.
    private(set) var renderer: GlobeRenderer?

    var selection: Selection?
    /// What the camera follows: a satellite's catalog id or a station's marker id.
    private(set) var tracked: String?
    /// The next tap on the globe places a ground station.
    var isPicking = false
    /// The station the sky view stands on, while it is open (ADR 0003): where the
    /// device is, unless a link names one or a station's panel opened it.
    private(set) var observer: UUID?
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR
    /// 0010). Kept in links as `unseen`.
    var unseen = UnseenMode.dim {
        didSet { renderer?.unseen = unseen }
    }
    /// The Globe panel's camera mode, kept in links as `camera`. The sky view
    /// holds the camera, and keeps the choice for the way back.
    var cameraFrame = CameraFrame.fixed {
        didSet { renderer?.cameraFrame = cameraFrame }
    }
    let compass = SkyCompass()
    /// The camera's picture behind the sky view, aimed by the compass (ADR 0013).
    let passthrough = SkyPassthrough()
    /// From asking for the camera, the compass first, until it shows or not.
    private(set) var isStartingCamera = false
    /// Why the satellites may not be where the camera shows them, while it does:
    /// the sky is drawn for a place other than where the device is, or where the
    /// device is cannot be told. A clock away from now is no such reason: the sky
    /// to come over the place in the picture is a view of its own.
    private(set) var cameraWarning: String?
    /// A word for the user that goes by itself: how switching the compass on went.
    private(set) var notice: String?
    /// The globe's base map, kept between launches.
    var baseLayer: BaseLayer = UserDefaults.standard.string(forKey: "baseLayer").flatMap(BaseLayer.init(rawValue:)) ?? .naturalEarth {
        didSet {
            UserDefaults.standard.set(baseLayer.rawValue, forKey: "baseLayer")
            renderer?.setImagery(baseLayer, site: site, frame: imageryFrame)
        }
    }
    /// Whether the globe follows Re:Earth's terrain: off by default, as on the web.
    var terrain = UserDefaults.standard.bool(forKey: "terrain") {
        didSet {
            UserDefaults.standard.set(terrain, forKey: "terrain")
            renderer?.setTerrain(terrain)
        }
    }
    @ObservationIgnored private let tiles = TileFetcher.shared()
    @ObservationIgnored private let keptTiles = KeptTiles.applicationSupport()
    /// The days GIBS has VIIRS for, and when it was last asked.
    @ObservationIgnored private var viirsDays: [ClosedRange<String>]?
    @ObservationIgnored private var viirsDaysAsked: Date?
    /// A daily base map's day, as the renderer was given it: the clock's, within
    /// GIBS's days; nil, GIBS's latest, until they are known.
    @ObservationIgnored private var imageryFrame: String?
    let analytics = Analytics()
    let bookmarks: BookmarkModel = {
        #if DEBUG
            if let storage = TestCatalog.bookmarkStorage() {
                return BookmarkModel(storage: storage)
            }
        #endif
        return BookmarkModel()
    }()

    /// What the map is drawn from now, to credit: with the terrain the sky view
    /// always stands on, whatever the Map menu says.
    var mapCredits: [Credit] { Credit.map(baseLayer: baseLayer, terrain: terrain || observer != nil) }

    /// The site's privacy policy, which covers the app.
    var privacyPolicy: URL { site.appending(path: "data/privacy.html") }

    /// What the drawn links were built from.
    @ObservationIgnored private var linksKey: LinksKey?
    /// When the data was last asked for again, so that the scene turning active
    /// twice in a row does not ask twice.
    @ObservationIgnored private var revalidated = Date.distantPast
    /// A link that came before there was a catalog to open it on, and whether it
    /// is one to keep among the opened links.
    @ObservationIgnored private var pendingLink: (link: Link, records: Bool)?
    /// Counts the links applied, so that one superseded while it waited stops
    /// there rather than finish over the newer one.
    @ObservationIgnored private var linkGeneration = 0
    @ObservationIgnored private var started = false
    /// What the last link carried that the app does not show (ADR 0001's foreign
    /// parameters), written back into every link the app makes.
    private var foreign = SceneState.Foreign()
    /// The web app's FPS switch, which the app shows as its performance overlay.
    /// Kept where the web keeps it, in the link as `fps=true`: a link the app
    /// does not otherwise read, written back as it came.
    var showsPerformance: Bool { foreign.showsPerformance }
    /// Drawable pixels per point, the web app's `pixelratio`: `1`, `1.5`, or
    /// `native` for the screen's own. Fewer pixels for frames the GPU finishes in
    /// time; kept in links as on the web.
    var pixelRatio = "native"
    /// Frames a second the globe is drawn at, at most: 30, 60 or 120, where the
    /// screen has them. Not in links, which the web app has no parameter for,
    /// but kept between launches, as the device's own choice.
    var frameRate = UserDefaults.standard.object(forKey: frameRateKey) as? Int ?? 60 {
        didSet {
            UserDefaults.standard.set(frameRate, forKey: Self.frameRateKey)
        }
    }
    private static let frameRateKey = "frameRate"
    /// What the Graphics panel offers, of which a screen shows those up to its own.
    static let frameRates = [30, 60, 120]
    /// The benchmark panel, the web app's `bench=true`, kept in the link the same
    /// way; open through a run, whose scenes' links do not carry it, until the
    /// view it saved is open again.
    private(set) var showsBenchmark = false
    let benchmark = Benchmark()

    /// The view as it was left, as a link.
    private static let viewKey = "view"
    /// `SATVIS_LINK` in the launch environment opens on that link, a whole url or
    /// a path with its query (`/ot?tags=OT`): for screenshots and tests.
    private static let launchLink = ProcessInfo.processInfo.environment["SATVIS_LINK"].map(Link.init)

    init(loader: GroupLoader, site: URL, alerts: PassAlerts) {
        self.site = site
        repository = loader.repository
        self.alerts = alerts
        catalog = CatalogModel(loader: loader)
    }

    /// Fetches a 3D model by its path under /data/models/, for the globe and the info
    /// panel's close-up: the models the site serves for its own globe, cached as the tiles are.
    var modelLoader: @Sendable (String) async -> Data? {
        { [tiles, site = self.site] file in
            let url = site.appending(path: "data/models").appending(path: file)
            do {
                return try await tiles.tile(url, contentType: "model/gltf-binary")
            } catch {
                log.error("\(url, privacy: .public): \(error, privacy: .public)")
                return nil
            }
        }
    }

    /// A frame the GPU failed, the globe's or the close-up's, to analytics with the view it failed in.
    func reportGPUFault(_ fault: GPUFault) {
        analytics.gpuFault(fault, satellites: renderer?.satelliteCount ?? 0, view: link(sharing: false).url(site: site))
    }

    /// The close-up's model fetcher, frame rate and fault reporting.
    var closeUpContext: CloseUpContext {
        CloseUpContext(loader: modelLoader, frameRate: frameRate, onGPUFault: { [weak self] fault in self?.reportGPUFault(fault) })
    }

    /// The selected satellite, whose passes the clock deck marks.
    var selectedSatellite: String? {
        if case .satellite(let id) = selection {
            return id
        }
        return nil
    }

    /// Takes over a renderer once it exists: it compiles its shaders first.
    func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        renderer.clock = { [clock] in clock.now() }
        renderer.tileLoader = { [tiles, keptTiles] request in
            if request.keeps, let data = keptTiles.read(request.url) {
                return data
            }
            do {
                let data = try await tiles.tile(request.url, contentType: request.contentType, headers: request.headers)
                if request.keeps {
                    keptTiles.keep(data, for: request.url)
                }
                return data
            } catch is CancellationError {
                return nil
            } catch let error as URLError where error.code == .cancelled {
                return nil
            } catch {
                log.error("\(request.url, privacy: .public): \(error, privacy: .public)")
                return nil
            }
        }
        renderer.modelLoader = modelLoader
        renderer.setImagery(baseLayer, site: site, frame: imageryFrame)
        renderer.setTerrain(terrain)
        renderer.unseen = unseen
        renderer.cameraFrame = cameraFrame
        renderer.setStations(shownMarkers)
        renderer.onGPUFault = { [weak self] fault in self?.reportGPUFault(fault) }
        // What a link opened on before the renderer was there to be told: the
        // sky view, with no globe to fly from yet, or something followed.
        if let observer, let station = passes.station(observer) {
            renderer.enterSky(SkyCamera(latitude: station.latitude, longitude: station.longitude), animated: false)
        } else if let tracked {
            renderer.track(tracked)
        }
        // The links went to no renderer at all if they were built before it.
        linksKey = nil
        satellites.attach(renderer)
        starMap.attach(renderer)
    }

    /// Loads what there is to show and keeps it in step until cancelled.
    func run() async {
        let watchers = [
            Task { await watchActive() },
            Task { await watchStations() },
            Task { await watchMode() },
            Task { await watchEntries() },
            Task { await watchAiming() },
            Task { await watchCameraPlace() },
            Task { await starMap.load(from: repository) },
            Task { await loadDemoPictures() },
            Task { await predictPasses() },
            Task { await followImageryDay() },
            Task { await countViews() },
        ]
        await withTaskCancellationHandler {
            let waiting = String(localized: "No satellites yet. They load once Satvis is online.")
            await catalog.loadIndex { @MainActor in
                self.notice = waiting
            }
            if notice == waiting {
                notice = nil
            }
            started = true
            // The view a last run left is the user's own, as a reload is on the web:
            // not an opened link.
            if let (link, records) = pendingLink ?? Self.launchLink.map({ ($0, true) }) ?? UserDefaults.standard.string(forKey: Self.viewKey).map({ (Link($0), false) }) {
                pendingLink = nil
                await apply(link, settings: true)
                if records {
                    Task { await recordOpened() }
                }
            } else {
                // The first launch: the default preset, and the map as the
                // settings before links kept it.
                await apply(Link(), settings: false)
            }
            Task { await catalog.revalidate(refetching: false) }
            if Benchmark.runsAtLaunch {
                setShowsBenchmark(true)
                Task {
                    // The renderer is attached once the view has a size.
                    while renderer == nil {
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                    benchmark.startAtLaunch(on: self)
                }
            }
            await satellites.run(clock: clock)
        } onCancel: {
            for watcher in watchers {
                watcher.cancel()
            }
        }
    }

    /// Asks for everything again: a suspended app can sit on old element sets
    /// for days, and its notifications on old passes.
    func becameActive() {
        guard Date().timeIntervalSince(revalidated) > 60 else {
            return
        }
        revalidated = Date()
        Task {
            await catalog.revalidate()
            await alerts.reschedule()
        }
    }

    func enteredBackground() {
        alerts.requestRefresh()
        // Kept without its time: the app reopens on the present. Not a benchmark
        // scene: the view the run began from.
        var kept = benchmark.abandon(on: self) ?? link(sharing: false)
        kept.query.items.removeAll { $0.key == "time" }
        UserDefaults.standard.set(kept.url(site: site).absoluteString, forKey: Self.viewKey)
    }

    // MARK: Links

    func setShowsPerformance(_ shows: Bool) {
        foreign.showsPerformance = shows
    }

    func setShowsBenchmark(_ shows: Bool) {
        if !shows {
            benchmark.cancel(closing: true)
        }
        showsBenchmark = shows
        foreign.showsBenchmark = shows
    }

    /// Opens a link: what it shows replaces what is shown, as on the web. `records`
    /// keeps it among the opened links (ADR 0011): one the system hands over, or the
    /// about page's, as a visit starts with on the web.
    func open(_ link: Link, records: Bool = false) {
        guard started else {
            pendingLink = (link, records)
            return
        }
        Task {
            await apply(link, settings: true)
            if records {
                await recordOpened()
            }
        }
    }

    /// The view as a link, as the web app's address bar would hold it. Of the
    /// saved stations only the selected one goes into a link, and only one that
    /// is `sharing`: they are often where the user lives.
    func link(sharing: Bool, withTime: Bool = true) -> Link {
        var selected: GroundStation?
        if case .station(let id) = selection {
            selected = passes.station(id)
        }
        let scene = SceneState(
            activation: catalog.activation,
            components: catalog.components,
            stations: passes.visiting.map(LinkStation.init),
            selectedStation: selected.map(LinkStation.init),
            sky: observer != nil,
            observer: observer.flatMap(passes.station).map(LinkStation.init),
            tracked: catalog.tracked.flatMap { catalog.catalog.entries[$0]?.name },
            overpassMode: passes.mode,
            layers: [baseLayer.rawValue],
            terrain: terrain,
            unseen: unseen,
            cameraFrame: cameraFrame,
            pixelRatio: pixelRatio,
            time: withTime ? SceneState.pinnedTime(of: clock.clock, at: ViewerClock.real()) : nil,
            foreign: foreign)
        return scene.link(preset: catalog.presetName, presetDefaults: catalog.presetDefaults, overBudget: catalog.overBudget, sharing: sharing)
    }

    /// Shows what a link says, over its preset's defaults. `settings` false leaves
    /// the map, the overpass mode and the clock as they are.
    private func apply(_ link: Link, settings: Bool) async {
        linkGeneration += 1
        let generation = linkGeneration
        // A preset the kept index does not know, as the index shipped in the app
        // knows only the default: the worker's may, and the link is read against
        // that preset's defaults, so it waits for it.
        if let named = link.preset, catalog.index?.presets[named] == nil {
            await catalog.refreshIndex()
            guard generation == linkGeneration else {
                return
            }
        }
        let index = catalog.index
        let preset = link.preset.flatMap { index?.presets[$0] != nil ? $0 : nil }
        let (scene, named) = SceneState.read(link.query, presetDefaults: index?.presetDefaults(named: preset) ?? [:])
        foreign = scene.foreign
        showsBenchmark = foreign.showsBenchmark
        if benchmark.isRunning {
            showsBenchmark = true
        }
        if let tracked {
            track(tracked, false)
        }
        if observer != nil {
            leaveSky()
        }
        selection = nil
        if settings {
            if let base = scene.layers.compactMap(BaseLayer.init(rawValue:)).last {
                baseLayer = base
            }
            terrain = scene.terrain
            pixelRatio = scene.pixelRatio
            passes.setMode(scene.overpassMode)
            // A clock pinned for a screenshot stays where it was put.
            if ViewerClock.launchTime == nil {
                if let time = scene.time {
                    clock.pin(at: (time.timeIntervalSince1970 * 1000).rounded(.down))
                } else if clock.clock.isOffPresent(at: ViewerClock.real()) {
                    // However it left the present, as a link without `time` is live.
                    clock.goLive()
                }
            }
        }
        unseen = scene.unseen
        cameraFrame = scene.cameraFrame
        passes.setVisiting(scene.stations.map { GroundStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name) })
        await catalog.open(preset: preset, activation: scene.activation, components: scene.components, named: named)
        guard generation == linkGeneration else {
            return
        }
        if scene.sky {
            // On the link's first station, as it was listed; where the device is
            // when it names none, or none the globe can stand on.
            let first = scene.observer.flatMap {
                GroundStations.normalized([GroundStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name)]).first.map(GroundStations.Place.init)
            }
            if let station = first.flatMap({ place in passes.stations.first { GroundStations.Place($0) == place } }) {
                enterSky(at: station.id)
            } else if let here = await stationHere(), generation == linkGeneration {
                enterSky(at: here)
            }
        } else if let name = scene.tracked, let entry = await catalog.entry(named: name), generation == linkGeneration {
            track(entry.id, true, selects: false)
        }
    }

    /// A page view whenever the view changes, as the web app's address bar makes
    /// one, but not for the clock alone: a pinned clock moves on every minute.
    private func countViews() async {
        var counted: Link?
        for await view in Observations({ self.link(sharing: false, withTime: false) }) {
            // A benchmark's scenes are not the user's views.
            guard started, view != counted, !benchmark.isRunning else {
                continue
            }
            counted = view
            analytics.pageview(link(sharing: false).url(site: site))
        }
    }

    // MARK: Bookmarks

    /// The scene on screen as a bookmark would keep it: its preset's path and the
    /// parameters the web app's stores own.
    var here: SceneLink {
        SceneLink(path: Bookmarks.path(preset: catalog.presetName), query: Bookmarks.ownedQuery(of: link(sharing: false).query))
    }

    /// What a bookmark's card says, read against its own preset's defaults.
    func summary(_ scene: SceneLink) -> BookmarkSummary {
        Bookmarks.summarize(scene.query, presetDefaults: catalog.index?.presetDefaults(named: scene.preset) ?? [:])
    }

    /// Opens a bookmark's scene, carrying the link's parameters no store owns.
    /// Without a `time` it is live: a paused or fast clock at the present has none either.
    func open(_ scene: SceneLink) {
        let carried = Bookmarks.carriedItems(of: link(sharing: false).query)
        if scene.query["time"] == nil, ViewerClock.launchTime == nil {
            clock.goLive()
        }
        open(scene.link(carrying: carried))
    }

    /// The preset as it opens: every scene parameter dropped, the clock live.
    func openDefaultView() {
        open(SceneLink(path: here.path, query: [:]))
    }

    /// Saves the scene on screen, named after what it shows, with its picture.
    func saveHere() async -> Bookmark {
        let scene = here
        let picture = await renderer?.snapshot(width: Self.pictureWidth)
        return bookmarks.save(name: Bookmarks.defaultName(summary(scene)), scene: scene, picture: picture)
    }

    /// The demos' pictures as kept, then as the site has them: fetched once and
    /// kept for offline launches, as the star map is.
    private func loadDemoPictures() async {
        let paths = Bookmarks.demos.compactMap(\.thumbnail)
        for path in paths {
            demoPictures[path] = await repository.keptImage(path)
        }
        for path in paths {
            if let fetched = try? await repository.image(path).value, fetched != demoPictures[path] {
                demoPictures[path] = fetched
            }
        }
    }

    /// Pixels across a bookmark's picture: a card two columns wide at 3x, where
    /// the web app's 320 would be soft.
    private static let pictureWidth = 480

    /// Keeps the link just opened among the opened ones, unless it shows the
    /// preset as it opens or is among the demos and saved bookmarks, and pictures
    /// it once it has loaded: everything active drawn, the sky view landed, and
    /// three seconds for the tiles. Not if the user has moved on by then.
    private func recordOpened() async {
        let opened = here
        guard !opened.query.isEmpty, !(Bookmarks.demos + bookmarks.saved).contains(where: { $0.scene == opened }) else {
            return
        }
        let link = bookmarks.recordOpened(name: Bookmarks.defaultName(summary(opened)), scene: opened)
        let start = ContinuousClock.now
        try? await Task.sleep(for: .seconds(3))
        while ContinuousClock.now - start < .seconds(20) {
            let drawn = renderer.map { satellites.draws(catalog.activeEntries) && (observer == nil || $0.isSkySettled) } ?? false
            if drawn {
                break
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        let now = here
        guard now.path == opened.path, Bookmarks.withoutTime(now.query) == Bookmarks.withoutTime(opened.query),
            let picture = await renderer?.snapshot(width: Self.pictureWidth)
        else {
            return
        }
        bookmarks.setPicture(link.id, picture)
    }

    // MARK: Sky view

    /// Stands on a ground station and looks up; in the sky view already, moves
    /// there. Nothing is followed from the ground: a camera cannot both chase a
    /// satellite and stand still.
    func enterSky(at id: UUID) {
        guard let station = passes.station(id) else {
            return
        }
        if let tracked {
            track(tracked, false)
        }
        observer = id
        // Without a renderer yet, `attach` stands it there. Reduced motion cuts.
        renderer?.enterSky(SkyCamera(latitude: station.latitude, longitude: station.longitude), animated: !UIAccessibility.isReduceMotionEnabled)
        renderer?.setStations(shownMarkers)
    }

    /// Back onto the globe, the compass handing the aim back and the camera going
    /// with it.
    func leaveSky() {
        compass.stop(renderer)
        renderer?.leaveSky(animated: !UIAccessibility.isReduceMotionEnabled)
        observer = nil
        renderer?.setStations(shownMarkers)
    }

    /// The globe button: out of the sky view onto the globe, and from anywhere on
    /// the globe back to where the app opens, letting go of what is followed.
    func goHome() {
        if observer != nil {
            return leaveSky()
        }
        if let tracked {
            track(tracked, false, animated: true)
        }
        renderer?.flyHome(animated: !UIAccessibility.isReduceMotionEnabled)
    }

    /// Looks up from where the device is: the Sky panel's Look up. A station's
    /// panel looks up from that station instead.
    func lookUpFromHere() async {
        if let id = await stationHere() {
            enterSky(at: id)
        }
    }

    /// The "Geolocation" station, moved to where the device is; nil, and a word
    /// why, where no position comes back. Without one the sky view does not open:
    /// a sky at a place nobody chose looks like a working view and is not.
    private func stationHere() async -> UUID? {
        guard let location = await currentLocation(), let id = passes.setGeolocation(latitude: location.latitude, longitude: location.longitude) else {
            show("The sky view needs your location. Allow it in Settings, or look up from a location's panel.")
            return nil
        }
        return id
    }

    /// Aims the sky view with the device, or hands the aim back, and the camera's
    /// picture with it.
    func toggleCompass() {
        guard let renderer else {
            return
        }
        if compass.isAiming {
            return compass.stop(renderer)
        }
        Task {
            let outcome = await compass.start(renderer)
            show(outcome == .aiming ? "Aiming by compass. \(Self.dragHandsBack)" : Self.words(for: outcome))
        }
    }

    /// Shows the camera's picture behind the sky view, aiming by compass first,
    /// as it has to (ADR 0013), or takes it away and leaves the compass aiming.
    func togglePassthrough() {
        guard let renderer, !isStartingCamera else {
            return
        }
        if passthrough.isShowing {
            return passthrough.stop()
        }
        isStartingCamera = true
        Task {
            defer { isStartingCamera = false }
            if !compass.isAiming {
                let outcome = await compass.start(renderer)
                guard outcome == .aiming else {
                    return show(Self.words(for: outcome))
                }
            }
            switch await passthrough.start(renderer) {
            case .showing: show("Showing the camera, aimed by compass. \(Self.dragHandsBack)")
            case .noCamera: return show("This device has no camera to show the sky through.")
            case .denied: return show("Showing the sky through the camera needs access to it. Allow it in Settings.")
            case .stopped: return
            }
        }
    }

    /// How a drag ends the compass's aiming, and the camera's picture with it.
    private static let dragHandsBack = "Drag at any time to turn it off."

    /// Why the compass would not aim; nil where it did, or the user took the aim
    /// back meanwhile and needs telling nothing.
    private static func words(for outcome: SkyCompass.Outcome) -> String? {
        switch outcome {
        case .aiming, .takenBack: nil
        case .unsupported: "This device has no motion sensor to aim with."
        case .noHeading: "This device cannot tell where north is, so it cannot aim by compass."
        case .silent: "The motion sensor did not answer."
        }
    }

    /// Metres between the device and the place the sky is drawn for past which
    /// the camera's picture is warned about: at the ISS's height, 5 km moves a
    /// satellite overhead by under a degree.
    private static let cameraWarningDistance = 5_000.0

    /// The station the sky view stands on, while the camera shows: what the
    /// picture is judged against.
    private var cameraStation: GroundStation? {
        passthrough.isShowing ? observer.flatMap(passes.station) : nil
    }

    /// Judges the camera's place again whenever the station under it changes, it
    /// moves or the camera comes on: one judgement at a time, so a position that
    /// takes seconds to come never overwrites a newer one.
    private func watchCameraPlace() async {
        var judged: GroundStation?
        for await station in Observations({ self.cameraStation }) where station != judged {
            judged = station
            cameraWarning = nil
            guard let station else {
                continue
            }
            let warning = await Self.cameraWarning(at: station)
            // Moved on meanwhile: the next value is judged in turn.
            if cameraStation == station {
                cameraWarning = warning
            }
        }
    }

    /// Why the camera may not show `station`'s sky, by where the device is now; nil
    /// where it does.
    private static func cameraWarning(at station: GroundStation) async -> String? {
        guard let here = await currentLocation() else {
            return "Satvis cannot tell where you are, so the satellites may not be where the camera shows them."
        }
        let metres = CLLocation(latitude: here.latitude, longitude: here.longitude).distance(from: CLLocation(latitude: station.latitude, longitude: station.longitude))
        guard metres > cameraWarningDistance else {
            return nil
        }
        let distance = Measurement(value: metres / 1000, unit: UnitLength.kilometers).formatted(.measurement(width: .abbreviated, usage: .road))
        let place = station.name == StationList.geolocation ? "your last location" : station.name ?? "this location"
        return "The satellites are drawn for \(place), \(distance) from you, so they are not where the camera shows them."
    }

    /// Whether a drag of `translation` so far, with at most `fingers` down, may
    /// turn the view. While the compass aims, a drag by one finger past a tap's slop
    /// takes the aim back (ADR 0004), and the camera goes with it; within the slop,
    /// it is a tap's tremor. A drag more fingers have been part of never does: a
    /// pinch's fingers drift as they spread.
    func mayDrag(_ translation: CGSize, fingers: Int) -> Bool {
        guard compass.isAiming else {
            return true
        }
        guard fingers < 2, hypot(translation.width, translation.height) > 8 else {
            return false
        }
        compass.stop(renderer)
        return true
    }

    /// Takes a pinch of `scale` while the camera shows: it zooms the camera, and
    /// the view follows its picture. False where the pinch is the view's, as it is
    /// while the system has the camera and the sky is drawn without it.
    func takePinch(_ scale: Double) -> Bool {
        guard passthrough.isShowing, !passthrough.isInterrupted else {
            return false
        }
        passthrough.zoom(by: scale)
        return true
    }

    /// Shows `text` for a few seconds; nothing for nil.
    private func show(_ text: String?) {
        guard let text else {
            return
        }
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(4))
            if notice == text {
                notice = nil
            }
        }
    }

    /// The stations' pins, but for the one the sky view stands on, which would be
    /// underfoot.
    private var shownMarkers: [StationMarker] {
        passes.markers.filter { marker in observer.map { marker.id != PassModel.markerID($0) } ?? true }
    }

    /// A tap places a station while picking, and otherwise selects what it lands
    /// on, or nothing unless `keepingSelection`.
    func tap(at point: CGPoint, viewSize size: CGSize, keepingSelection: Bool = false) {
        guard let renderer else {
            return
        }
        if isPicking {
            if let place = renderer.groundPoint(at: point, viewSize: size), let added = passes.add(latitude: place.latitude, longitude: place.longitude) {
                selection = .station(added)
            }
            isPicking = false
            return
        }
        // From the ground the crosshair chooses, not the finger (ADR 0003).
        if observer != nil {
            if let lock = renderer.skyLock(viewSize: size) {
                selection = .satellite(lock.id)
            }
            return
        }
        let hit = renderer.entity(at: point, viewSize: size)
        if hit == nil, keepingSelection {
            return
        }
        selection = hit.map { id in
            PassModel.stationID(id).map(Selection.station) ?? .satellite(id)
        }
    }

    /// A double tap follows what it lands on.
    func doubleTap(at point: CGPoint, viewSize size: CGSize) {
        guard observer == nil else {
            return
        }
        if let id = renderer?.entity(at: point, viewSize: size) {
            track(id, true)
        }
    }

    /// Follows a satellite or a station, or lets it go. Tracking keeps a satellite
    /// active even when its group is switched off, as on the web. `animated`
    /// flies the camera, as the web app's Track button does, unless reduced
    /// motion is asked for; a link or a double tap cuts. `selects` opens its panel
    /// too; a link's `track` does not, as on the web, where it follows alone.
    func track(_ id: String, _ follow: Bool, animated: Bool = false, selects: Bool = true) {
        let animated = animated && !UIAccessibility.isReduceMotionEnabled
        let isStation = PassModel.stationID(id) != nil
        // Nothing is followed from the ground (ADR 0003).
        if follow, observer != nil {
            return
        }
        if follow {
            if !isStation {
                catalog.setTracked(id)
            } else if catalog.tracked != nil {
                catalog.setTracked(nil)
            }
            tracked = id
            if selects {
                selection = PassModel.stationID(id).map(Selection.station) ?? .satellite(id)
            }
            renderer?.track(id, animated: animated)
        } else {
            renderer?.stopTracking(animated: animated)
            tracked = nil
            if !isStation {
                catalog.setTracked(nil)
            }
        }
    }

    /// Draws what is active, as it is drawn, whenever either changes.
    private func watchActive() async {
        for await (entries, components) in Observations({ (self.catalog.activeEntries, self.catalog.components) }) {
            await satellites.show(entries, components: components, at: clock.now())
        }
    }

    /// Stands the stations on the globe, lets go of one that is gone (and leaves
    /// the sky view standing on it), drops its alerts, and predicts the
    /// notifications again, whenever the list changes.
    private func watchStations() async {
        for await stations in Observations({ self.passes.stations }) {
            renderer?.setStations(shownMarkers)
            let ids = Set(stations.map(\.id))
            if let tracked, let station = PassModel.stationID(tracked), !ids.contains(station) {
                track(tracked, false)
            }
            if case .station(let station) = selection, !ids.contains(station) {
                selection = nil
            }
            if let observer, !ids.contains(observer) {
                leaveSky()
            }
            // Alerts are for the saved stations only.
            alerts.forgetStations(except: Set(passes.saved.map(\.id)))
            await alerts.reschedule()
        }
    }

    /// Takes the camera's picture away whenever the compass stops aiming, however
    /// it stopped (ADR 0013): a picture the sky drawn over it does not follow
    /// looks right and is wrong.
    private func watchAiming() async {
        for await aiming in Observations({ self.compass.isAiming }) where !aiming {
            passthrough.stop()
        }
    }

    /// Follows on, or lets go of, a satellite followed or open whose entry a
    /// newer copy of its group no longer has: renamed since the copy kept on
    /// disk, the catalog number kept, or decayed. Left as it was, the camera
    /// would follow nothing and the gestures steer a camera not drawn.
    private func watchEntries() async {
        for await (tracked, selected) in Observations({ (self.missing(self.tracked), self.missing(self.selectedSatellite)) }) {
            if let tracked {
                if let next = successor(of: tracked) {
                    // Opened only if it was, below.
                    track(next, true, selects: false)
                } else {
                    track(tracked, false)
                }
            }
            if let selected, selectedSatellite == selected {
                selection = successor(of: selected).map(Selection.satellite)
            }
        }
    }

    /// A satellite's id, when the catalog no longer has it.
    private func missing(_ id: String?) -> String? {
        guard let id, PassModel.stationID(id) == nil, catalog.catalog.entries[id] == nil else {
            return nil
        }
        return id
    }

    /// The entry under the same catalog number, as a renamed satellite keeps.
    private func successor(of id: String) -> String? {
        let satnum = id.prefix { $0 != "|" }
        return catalog.catalog.entries.values.first { $0.satnum == satnum }?.id
    }

    /// Keeps a daily base map (VIIRS) on the clock's day, once a second, as the web
    /// app's GibsTimeLayer moves it with the clock, asking GIBS which days it has
    /// finished every half hour, as long as GIBS lets its answer be cached.
    private func followImageryDay() async {
        while !Task.isCancelled {
            if baseLayer.isDaily {
                if viirsDaysAsked.map({ Date().timeIntervalSince($0) >= 1800 }) ?? true {
                    viirsDaysAsked = Date()
                    if let (data, _) = try? await URLSession.shared.data(from: GIBS.viirsDomain),
                        let days = GIBS.days(inDomain: String(decoding: data, as: UTF8.self))
                    {
                        viirsDays = days
                    }
                }
                let frame = viirsDays.map { GIBS.frame(at: clock.now(), within: $0) }
                if frame != imageryFrame {
                    imageryFrame = frame
                    renderer?.setImagery(baseLayer, site: site, frame: frame)
                }
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func watchMode() async {
        for await _ in Observations({ self.passes.mode }).dropFirst() {
            await alerts.reschedule()
        }
    }

    /// Keeps the passes of what is shown predicted around the clock, once a second:
    /// the selected satellite's, and every active one's while a station is selected
    /// or their links are drawn.
    private func predictPasses() async {
        while !Task.isCancelled {
            let active = catalog.activeEntries
            // Past its budget only when switched back on, as on the web.
            let showsLinks = catalog.components.contains(.groundStationLink)
            // A satellite's panel and the links are over every station; a
            // station's panel over its own alone, which with thousands of
            // satellites and several stations is most of the work saved.
            var wanted: [String: CatalogEntry] = [:]
            if passes.hasStations {
                if case .satellite(let id) = selection, let entry = catalog.catalog.entries[id] {
                    wanted[id] = entry
                    await passes.refresh([entry], at: clock.now())
                }
                if case .station(let id) = selection, let station = passes.station(id) {
                    for entry in active {
                        wanted[entry.id] = entry
                    }
                    await passes.refresh(active, at: clock.now(), over: [station])
                }
                if showsLinks {
                    for entry in active {
                        wanted[entry.id] = entry
                    }
                    await passes.refresh(active, at: clock.now())
                }
            }
            await passes.keep(only: Array(wanted.values))
            // Rebuilt only when the passes or the satellites changed.
            let links = LinksKey(revision: passes.revision, satellites: showsLinks ? active.map(\.id) : [])
            if links != linksKey {
                linksKey = links
                renderer?.setLinks(showsLinks ? passes.links(for: active) : [])
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

private struct LinksKey: Equatable {
    var revision: Int
    var satellites: [String]
}
