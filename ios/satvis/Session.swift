import CoreLocation
import Foundation
import OSLog
import Observation
import SatvisCore
import SatvisData
import SatvisRender
import UIKit

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

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
    /// What the session sets on the globe, kept for a renderer that arrives late;
    /// what it asks goes to `renderer`.
    @ObservationIgnored private let globe = GlobeBinding()
    @ObservationIgnored let satellites: SatelliteLayer
    @ObservationIgnored private let starMap: StarMap
    /// The demo bookmarks' pictures by their path on the site, kept once fetched.
    private(set) var demoPictures: [String: Data] = [:]
    /// Observed: it arrives once its shaders compile, possibly after a link has
    /// opened on the sky view, whose instruments wait for it.
    private(set) var renderer: GlobeRenderer?

    /// What is selected, followed and stood on, changed through the methods
    /// below, which take the globe and the catalog along.
    private var focus = Focus()
    /// What the info panel is about.
    var selection: Selection? { focus.selection }
    /// What the camera follows.
    var tracked: Selection? { focus.tracked }
    /// The next tap on the globe places a ground station.
    var isPicking: Bool { focus.isPicking }
    /// The station the sky view stands on, while it is open (`Focus.observer`).
    var observer: UUID? { focus.observer }
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR
    /// 0010). Kept in links as `unseen`.
    var unseen = UnseenMode.dim {
        didSet { globe.unseen = unseen }
    }
    /// The Globe panel's camera mode, kept in links as `camera`. The sky view
    /// holds the camera, and keeps the choice for the way back.
    var cameraFrame = CameraFrame.fixed {
        didSet { globe.cameraFrame = cameraFrame }
    }
    /// The compass and the camera's picture behind the sky view (ADR 0004, ADR 0013).
    let aim: SkyAim
    /// A word for the user that goes by itself: how switching the compass on went.
    private(set) var notice: String?
    /// The globe's base map, kept between launches.
    var baseLayer: BaseLayer = UserDefaults.standard.string(forKey: "baseLayer").flatMap(BaseLayer.init(rawValue:)) ?? .naturalEarth {
        didSet {
            UserDefaults.standard.set(baseLayer.rawValue, forKey: "baseLayer")
            globe.setImagery(baseLayer, site: site, frame: imageryFrame)
        }
    }
    /// Whether the globe follows Re:Earth's terrain: off by default, as on the web.
    var terrain = UserDefaults.standard.bool(forKey: "terrain") {
        didSet {
            UserDefaults.standard.set(terrain, forKey: "terrain")
            globe.terrain = terrain
        }
    }
    @ObservationIgnored private let tiles = TileFetcher.shared()
    @ObservationIgnored private let keptTiles = KeptTiles.applicationSupport()
    /// The days GIBS has VIIRS for, and when it was last asked.
    @ObservationIgnored private var viirsDays: [ClosedRange<String>]?
    @ObservationIgnored private var viirsDaysAsked: Date?
    /// A daily base map's day, as the globe was given it: the clock's, within
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
        satellites = SatelliteLayer(globe: globe)
        starMap = StarMap(globe: globe)
        aim = SkyAim(globe: globe)
        bindGlobe()
        aim.show = { [weak self] text in self?.show(text) }
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
    var selectedSatellite: String? { focus.selectedSatellite }

    /// Sets what the globe starts from; the properties' `didSet`s keep it in step.
    private func bindGlobe() {
        globe.clock = { [clock] in clock.now() }
        globe.tileLoader = { [tiles, keptTiles] request in
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
        globe.modelLoader = modelLoader
        globe.setImagery(baseLayer, site: site, frame: imageryFrame)
        globe.terrain = terrain
        globe.unseen = unseen
        globe.cameraFrame = cameraFrame
        globe.stations = shownMarkers
        globe.onGPUFault = { [weak self] fault in self?.reportGPUFault(fault) }
    }

    /// Takes over a renderer once it exists: it compiles its shaders first.
    func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        aim.renderer = renderer
        globe.attach(renderer)
    }

    /// Loads what there is to show and keeps it in step until cancelled.
    func run() async {
        let watchers = [
            Task { await watchActive() },
            Task { await watchStations() },
            Task { await watchMode() },
            Task { await watchEntries() },
            Task { await aim.watchAiming() },
            Task { await aim.watchCameraPlace { self.observer.flatMap(self.passes.station) } },
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
                    await globe.untilAttached()
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
            tracked: focus.trackedSatellite.flatMap { catalog.catalog.entries[$0]?.name },
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
        perform(focus.clear())
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
        editStations { $0.setVisiting(scene.stations.map { GroundStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name) }) }
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
            perform(focus.follow(.satellite(entry.id), selecting: false))
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

    /// Stands on a ground station and looks up (`Focus.enterSky`), if it is one.
    func enterSky(at id: UUID) {
        guard passes.station(id) != nil else {
            return
        }
        perform(focus.enterSky(at: id))
    }

    /// Back onto the globe, from the sky view.
    func leaveSky() {
        perform(focus.leaveSky())
    }

    /// The globe button (`Focus.goHome`).
    func goHome() {
        perform(focus.goHome())
    }

    /// Looks up from where the device is: the Sky panel's My location. Its other
    /// rows and a station's panel look up from a station instead.
    func lookUpFromHere() async {
        if let id = await stationHere() {
            enterSky(at: id)
        }
    }

    /// The "Geolocation" station, moved to where the device is; nil, and a word
    /// why, where no position comes back. Without one the sky view does not open:
    /// a sky at a place nobody chose looks like a working view and is not.
    private func stationHere() async -> UUID? {
        guard let location = await currentLocation(), let id = editStations({ $0.setGeolocation(latitude: location.latitude, longitude: location.longitude) }) else {
            show("The sky view needs your location. Allow it in Settings, or look up from one of your locations.")
            return nil
        }
        return id
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
        passes.markers.filter { marker in observer.map { marker.id != Selection.station($0).rendererID } ?? true }
    }

    /// Opens a satellite's or a station's panel, or closes it.
    func select(_ selection: Selection?) {
        focus.select(selection)
    }

    /// The next tap on the globe places a ground station, or no longer does.
    func setPicking(_ picking: Bool) {
        focus.setPicking(picking)
    }

    /// A tap on the globe (`Focus.tap`).
    func tap(at point: CGPoint, viewSize size: CGSize, keepingSelection: Bool = false) {
        guard let renderer else {
            return
        }
        let passes = passes
        focus.tap(Self.hits(renderer, at: point, viewSize: size), keepingSelection: keepingSelection) { latitude, longitude in
            passes.add(latitude: latitude, longitude: longitude)
        }
    }

    /// A double tap follows what it lands on.
    func doubleTap(at point: CGPoint, viewSize size: CGSize) {
        guard let renderer else {
            return
        }
        perform(focus.doubleTap(Self.hits(renderer, at: point, viewSize: size)))
    }

    /// What the renderer has under `point`, for a tap.
    private static func hits(_ renderer: GlobeRenderer, at point: CGPoint, viewSize size: CGSize) -> Focus.Tap {
        Focus.Tap(
            ground: { renderer.groundPoint(at: point, viewSize: size) },
            crosshair: { renderer.skyLock(viewSize: size)?.id },
            entity: { renderer.entity(at: point, viewSize: size) })
    }

    /// Follows a satellite or a station, and opens its panel (`Focus.follow`).
    func follow(_ target: Selection, animated: Bool = false) {
        perform(focus.follow(target, animated: animated))
    }

    /// Lets go of what is followed.
    func stopTracking(animated: Bool = false) {
        perform(focus.stopTracking(animated: animated))
    }

    /// Edits the stations, and lets go at once of what referred to one the edit
    /// dropped, rather than when `watchStations` next turns.
    private func editStations<Result>(_ edit: (PassModel) -> Result) -> Result {
        let result = edit(passes)
        perform(focus.stationsChanged(to: Set(passes.stations.map(\.id))))
        return result
    }

    /// Does what a change of focus asks of the renderer, and keeps the followed
    /// satellite active. Reduced motion cuts every flight.
    private func perform(_ commands: [Focus.Command]) {
        if catalog.tracked != focus.trackedSatellite {
            catalog.setTracked(focus.trackedSatellite)
        }
        let motion = !UIAccessibility.isReduceMotionEnabled
        for command in commands {
            switch command {
            case .track(let target, let animated):
                globe.track(target.rendererID, animated: animated && motion)
            case .stopTracking(let animated):
                globe.stopTracking(animated: animated && motion)
            case .enterSky(let id, let animated):
                if let station = passes.station(id) {
                    globe.enterSky(SkyCamera(latitude: station.latitude, longitude: station.longitude), animated: animated && motion)
                }
                globe.stations = shownMarkers
            case .leaveSky(let animated):
                aim.stop()
                globe.leaveSky(animated: animated && motion)
                globe.stations = shownMarkers
            case .flyHome(let animated):
                globe.flyHome(animated: animated && motion)
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
    /// notifications again, whenever the list changes. The edits the session does
    /// not make, the Locations sheet's and a station panel's, are let go of here.
    private func watchStations() async {
        for await stations in Observations({ self.passes.stations }) {
            globe.stations = shownMarkers
            perform(focus.stationsChanged(to: Set(stations.map(\.id))))
            // Alerts are for the saved stations only.
            alerts.forgetStations(except: Set(passes.saved.map(\.id)))
            await alerts.reschedule()
        }
    }

    /// Follows on, or lets go of, a satellite followed or open that a newer copy
    /// of its group no longer has (`Focus.catalogChanged`).
    private func watchEntries() async {
        for await lost in Observations({ self.focus.hasLost(in: self.catalog.catalog) }) where lost {
            perform(focus.catalogChanged(to: catalog.catalog))
        }
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
                    globe.setImagery(baseLayer, site: site, frame: frame)
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
                globe.links = showsLinks ? passes.links(for: active) : []
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

private struct LinksKey: Equatable {
    var revision: Int
    var satellites: [String]
}
