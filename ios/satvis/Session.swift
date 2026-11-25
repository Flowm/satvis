import CoreLocation
import Foundation
import OSLog
import Observation
import SatvisCore
import SatvisData
import SatvisRender

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
    @ObservationIgnored private let satellites: SatelliteLayer
    @ObservationIgnored private let starMapLoader: StarMap
    /// The featured bookmarks' pictures by their path on the site, kept once fetched.
    private(set) var featuredPictures: [String: Data] = [:]
    /// Observed: it arrives once its shaders compile, possibly after a link has
    /// opened on the sky view, whose instruments wait for it.
    private(set) var renderer: GlobeRenderer?
    /// Whether the renderer draws what is active (`SatelliteLayer.draws`).
    var drawsActive: Bool { satellites.draws(catalog.activeEntries) }

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
    /// The Globe panel's projection, kept in links as `scene`: the globe, or the
    /// flat map, the web app's 2D. In the sky view, which is drawn in 3D, the one
    /// it goes back to, which a link does not carry (ADR 0003).
    private(set) var projection = GlobeProjection.threeD
    /// The compass and the camera's picture behind the sky view (ADR 0004, ADR 0013).
    let aim: SkyAim
    /// A word for the user that goes by itself: how switching the compass on went.
    private(set) var notice: String?
    /// The globe's base map, kept in links as `layers`.
    var baseLayer: BaseLayer = launchMap.layers.compactMap(BaseLayer.init(rawValue:)).last ?? .naturalEarth {
        didSet { globe.setImagery(baseLayer, site: site) }
    }
    /// The instrument imagery drawn over the base map (ADR 0020), kept in links as `imagery`.
    let instrumentImagery = InstrumentImagery()
    /// The drawn granule layers' granules behind the clock (ADR 0023).
    @ObservationIgnored let granuleImagery = GranuleImagery()
    /// What the granule pictures on screen owe.
    private var granuleCredits: [Credit] = []
    /// The overpass replay on, kept in links as `replay` (ADR 0023).
    @ObservationIgnored private(set) lazy var replay = OverpassReplayModel(session: self)
    /// Where the camera was when the replay on started, which its end goes back to.
    @ObservationIgnored private var viewBeforeReplay: CameraView?
    /// Whether the globe follows Re:Earth's terrain, kept in links as `terrain`:
    /// off by default, as on the web.
    var terrain = launchMap.terrain {
        didSet { globe.terrain = terrain }
    }
    /// The star map, kept in links as `stars`: the web app's default, Tycho1K,
    /// until one is chosen, which the app draws as DeepStar1K.
    /// A map that cannot be had falls back to DeepStar1K, as the web app's falls back
    /// to its default, so the link and the Map panel name what is drawn.
    var starMap = launchMap.starMap {
        didSet { starMapLoader.show(starMap) }
    }
    @ObservationIgnored private let tiles = TileFetcher.shared
    @ObservationIgnored private let keptTiles = KeptTiles.applicationSupport()
    let analytics: Analytics
    let bookmarks: BookmarkModel = {
        #if DEBUG
            if let storage = TestCatalog.bookmarkStorage() {
                return BookmarkModel(storage: storage)
            }
        #endif
        return BookmarkModel()
    }()

    /// What the map is drawn from now, to credit.
    var mapCredits: [Credit] {
        Credit.map(
            baseLayer: baseLayer, terrain: terrain,
            instrumentImagery: instrumentImagery.tiledProviders,
            mosaic: instrumentImagery.mosaic.credit, pictures: granuleCredits)
    }

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
    /// The performance panel, the web app's: in the link as `fps=true`, or
    /// `fps=graph` with its frame-time graph open.
    var showsPerformance: Bool {
        get { foreign.showsPerformance }
        set { foreign.showsPerformance = newValue }
    }
    var fpsPanel: SceneState.FPSPanel {
        get { foreign.fpsPanel }
        set { foreign.fpsPanel = newValue }
    }
    /// Drawable pixels per point, the web app's `pixelratio`: a number, or `native`
    /// for the screen's own (`PixelRatioLadder`).
    /// Fewer pixels for frames the GPU finishes in time; kept in links as on the web.
    var pixelRatio = "native"
    /// Frames a second the globe is drawn at, at most. Not read from links, where
    /// the web app keeps its own as `framerate`, but kept between launches, as the
    /// device's own choice.
    var frameRate = UserDefaults.standard.object(forKey: frameRateKey) as? Int ?? 60 {
        didSet {
            UserDefaults.standard.set(frameRate, forKey: Self.frameRateKey)
        }
    }
    private static let frameRateKey = "frameRate"
    /// What the Graphics panel offers, as the web app does.
    static let frameRates = [30, 60, maximumFrameRate]
    /// "Max": no screen is faster, so `preferredFramesPerSecond` gives the screen's own.
    static let maximumFrameRate = 120
    /// The frame budget, past which a frame is over budget: the interval the frame
    /// rate asks for, never shorter than the screen's.
    var frameBudgetMilliseconds: Double { 1000 / Double(min(frameRate, GlobeRenderer.displayMaximumFramesPerSecond)) }
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
    /// The view a last run left, the user's own, as a reload is on the web: not
    /// an opened link.
    private static var keptView: Link? { UserDefaults.standard.string(forKey: viewKey).map(Link.init) }
    /// The map, terrain and stars of the link the app opens on, for the globe to
    /// start on before `run` applies it: that waits for the group index, and the
    /// renderer can arrive first. Read without its preset's defaults, which come
    /// with the index.
    private static let launchMap = SceneState.read((launchLink ?? keptView ?? Link()).query, presetDefaults: [:]).scene

    init(loader: GroupLoader, site: URL, alerts: PassAlerts) {
        self.site = site
        analytics = Analytics(site: site)
        repository = loader.repository
        self.alerts = alerts
        catalog = CatalogModel(loader: loader)
        satellites = SatelliteLayer(globe: globe)
        starMapLoader = StarMap(globe: globe, repository: repository)
        aim = SkyAim(globe: globe)
        bindGlobe()
        aim.show = { [weak self] text in self?.show(text) }
        starMapLoader.onUnavailable = { [weak self] in self?.starMap = .deepStar1K }
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
        globe.clock = { [clock] in clock.instant(ahead: $0) }
        globe.tileLoader = { [tiles, keptTiles] request in
            if request.keeps, let data = keptTiles.read(request.url) {
                return data
            }
            do {
                let data = try await tiles.tile(request.url, contentType: request.contentType, headers: request.headers, bytes: request.bytes, isDated: request.isDated)
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
        globe.setImagery(baseLayer, site: site)
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

    /// Returns once a renderer is attached, at once if one is. `Observations`
    /// reports it once `attach` has returned, so the binding has set it up by then.
    private func untilRendererAttached() async {
        for await attached in Observations({ self.renderer != nil }) where attached {
            return
        }
    }

    /// Loads what there is to show and keeps it in step until cancelled.
    func run() async {
        starMapLoader.show(starMap)
        let watchers: [Task<Void, Never>] = [
            Task { await watchActive() },
            Task { await watchStations() },
            Task { await watchMode() },
            Task { await watchEntries() },
            Task { await aim.watchAiming() },
            Task { await aim.watchCameraPlace { self.observer.flatMap(self.passes.station) } },
            Task { await loadFeaturedPictures() },
            Task { await predictPasses() },
            Task { await watchInstrumentImagery() },
            Task { await replay.watch() },
            Task { await replay.watchSensed() },
            Task {
                await instrumentImagery.follow(now: { self.clock.now() }) { self.globe.instrumentImagery = $0 }
            },
            Task {
                await granuleImagery.follow(
                    now: { self.clock.now() }, isDrawn: { id in self.catalog.activeEntries.contains { $0.id == id } },
                    apply: { granules, fans, pictures in
                        self.globe.setGranules(granules, fans: fans)
                        let credits = pictures.map { Credit.picture($0, at: self.clock.now()) }
                        if credits != self.granuleCredits {
                            self.granuleCredits = credits
                        }
                    })
            },
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
            // The first launch opens on the default preset.
            let (link, records) = pendingLink ?? Self.launchLink.map { ($0, true) } ?? (Self.keptView ?? Link(), false)
            pendingLink = nil
            await apply(link)
            if records {
                Task { await recordOpened() }
            }
            Task { await catalog.revalidate(refetching: false) }
            if Benchmark.runsAtLaunch {
                setShowsBenchmark(true)
                Task {
                    // The renderer is attached once the view has a size.
                    await untilRendererAttached()
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
        // Fresh records mid-run would rebuild the scene under measurement.
        guard Date().timeIntervalSince(revalidated) > 60, !benchmark.isRunning else {
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
        keepView()
        // iOS ends the largest apps in the background first, and the tiles kept
        // for coming back were most of a few hundred megabytes.
        renderer?.trimMemory()
    }

    /// Keeps the view for the next launch, without its time: the app reopens on
    /// the present. Not a benchmark scene: the view the run began from.
    func keepView() {
        var kept = benchmark.abandon(on: self) ?? link(sharing: false)
        kept.query.items.removeAll { $0.key == "time" }
        UserDefaults.standard.set(kept.url(site: site).absoluteString, forKey: Self.viewKey)
    }

    // MARK: Benchmark sweeps

    /// Shows the satellites `names`, by name, with `components` past every
    /// budget and nothing followed or selected: a sweep step, which no link can say.
    func showSweep(names: Set<String>, components: SatelliteComponents) async {
        perform(focus.clear())
        await catalog.open(preset: catalog.presetName, activation: Activation(enabledSatellites: names), components: components, named: components)
    }

    /// The sweep's ground station as the only visiting one, or none.
    func setSweepStation(_ station: GroundStation?) {
        passes.setVisiting(station.map { [$0] } ?? [])
    }

    // MARK: Links

    func setShowsBenchmark(_ shows: Bool) {
        if !shows {
            benchmark.cancel(closing: true)
        }
        showsBenchmark = shows
        foreign.showsBenchmark = shows
    }

    /// Opens a link: what it shows replaces what is shown, as on the web. `records`
    /// keeps it among the opened links (ADR 0011): one the system hands over, or the
    /// about page's, as a visit starts with on the web. `picturing` is a bookmark
    /// to picture once it has loaded.
    func open(_ link: Link, records: Bool = false, picturing bookmark: String? = nil) {
        guard started else {
            pendingLink = (link, records)
            return
        }
        Task {
            await apply(link)
            if records {
                await recordOpened()
            } else if let bookmark {
                await picture(bookmark)
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
            projection: projection,
            observer: observer.flatMap(passes.station).map(LinkStation.init),
            tracked: focus.trackedSatellite.flatMap { catalog.catalog.entries[$0]?.name },
            overpassMode: passes.mode,
            layers: [baseLayer.rawValue],
            imagery: instrumentImagery.tokens,
            replayStation: replay.station,
            terrain: terrain,
            starMap: starMap,
            unseen: unseen,
            cameraFrame: cameraFrame,
            pixelRatio: pixelRatio,
            time: withTime ? SceneState.pinnedTime(of: clock.clock, at: ViewerClock.real()) : nil,
            foreign: foreign)
        return scene.link(preset: catalog.presetName, presetDefaults: catalog.presetDefaults, overBudget: catalog.overBudget, sharing: sharing)
    }

    /// Shows what a link says, over its preset's defaults.
    private func apply(_ link: Link) async {
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
        // A link that asks for a run (ADR 0016) starts one once the globe is up,
        // and reads as the open panel from then on, so the view the run keeps,
        // Recent and a share start none. Only `send` sends the report.
        if foreign.benchmarkMode == .run || foreign.benchmarkMode == .send {
            let only = foreign.benchmarkScenes
            let sends = foreign.benchmarkMode == .send
            foreign.benchmarkMode = .open
            foreign.benchmarkScenes = []
            // The view to return to is this link, which the run's first scene would
            // stop applying before its tracking or sky view.
            var restoring = link
            restoring.query.items = link.query.items.compactMap { item in
                switch item.key {
                case "benchscenes": nil
                case "bench": LinkQuery.Item(key: "bench", values: [SceneState.BenchmarkMode.open.rawValue])
                default: item
                }
            }
            Task {
                await untilRendererAttached()
                benchmark.start(on: self, only: only, prints: true, sends: sends, restoring: restoring)
            }
        }
        showsBenchmark = foreign.showsBenchmark
        if benchmark.isRunning {
            showsBenchmark = true
        }
        perform(focus.clear())
        if let base = scene.layers.compactMap(BaseLayer.init(rawValue:)).last {
            baseLayer = base
        }
        instrumentImagery.set(scene.imagery)
        replay.station = scene.replayStation
        terrain = scene.terrain
        starMap = scene.starMap
        pixelRatio = scene.pixelRatio
        passes.setMode(scene.overpassMode)
        // A clock pinned for a screenshot stays where it was put.
        if ViewerClock.launchTime == nil {
            if let time = scene.time {
                clock.scrub(to: (time.timeIntervalSince1970 * 1000).rounded(.down))
            } else if clock.clock.isOffPresent(at: ViewerClock.real()) {
                // However it left the present, as a link without `time` is live.
                clock.goLive()
            }
        }
        unseen = scene.unseen
        cameraFrame = scene.cameraFrame
        // A link cuts, as its camera does.
        setProjection(scene.projection, animated: false)
        passes.setVisiting(scene.stations.map { GroundStation($0) })
        await catalog.open(preset: preset, activation: scene.activation, components: scene.components, named: named)
        guard generation == linkGeneration else {
            return
        }
        if scene.sky {
            // On the link's first station, as it was listed; where the device is
            // when it names none, or none the globe can stand on.
            let first = scene.observer.flatMap {
                GroundStations.normalized([GroundStation($0)]).first.map(LinkStation.init)
            }
            if let station = first.flatMap({ place in passes.stations.first { LinkStation($0) == place } }) {
                lookUp(at: station.id)
            } else if let here = await stationHere(), generation == linkGeneration {
                lookUp(at: here)
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

    /// The route's preset's featured bookmarks, in the config's order; none before the index.
    var featured: [Bookmark] {
        catalog.index?.featured(preset: catalog.presetName) ?? []
    }

    /// What a bookmark's card says, read against its own preset's defaults.
    func summary(_ scene: SceneLink) -> BookmarkSummary {
        Bookmarks.summarize(scene.query, presetDefaults: catalog.index?.presetDefaults(named: scene.preset) ?? [:])
    }

    /// Opens a bookmark's scene, carrying the link's parameters no store owns.
    /// Without a `time` it is live: a paused or fast clock at the present has none either.
    func open(_ scene: SceneLink, picturing bookmark: String? = nil) {
        let carried = Bookmarks.carriedItems(of: link(sharing: false).query)
        if scene.query["time"] == nil, ViewerClock.launchTime == nil {
            clock.goLive()
        }
        open(scene.link(carrying: carried), picturing: bookmark)
    }

    /// Opens a bookmark from the Bookmarks sheet, and pictures one of the device's
    /// that has no picture: an opened link left before it had loaded.
    func open(_ bookmark: Bookmark) {
        let unpictured = bookmark.kind != .featured && bookmarks.pictures[bookmark.id] == nil
        open(bookmark.scene, picturing: unpictured ? bookmark.id : nil)
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

    /// The route's featured bookmarks' pictures as kept, then as the site has them:
    /// fetched once a launch, as the index and the route bring them, and kept for
    /// offline launches, as the star map is.
    private func loadFeaturedPictures() async {
        var asked: Set<String> = []
        for await paths in Observations({ self.featured.compactMap(\.thumbnail) }) {
            let new = paths.filter { !asked.contains($0) }
            asked.formUnion(new)
            for path in new {
                featuredPictures[path] = await repository.keptImage(path)
            }
            for path in new {
                if let fetched = try? await repository.image(path), fetched != featuredPictures[path] {
                    featuredPictures[path] = fetched
                }
            }
        }
    }

    /// Pixels across a bookmark's picture: a card two columns wide at 3x, where
    /// the web app's 320 would be soft.
    private static let pictureWidth = 480

    /// Keeps the link just opened among the opened ones, unless it shows the
    /// preset as it opens or is among the featured and saved bookmarks, and pictures it.
    private func recordOpened() async {
        let opened = here
        guard !opened.query.isEmpty, !(featured + bookmarks.saved).contains(where: { $0.scene == opened }) else {
            return
        }
        let link = bookmarks.recordOpened(name: Bookmarks.defaultName(summary(opened)), scene: opened)
        await picture(link.id)
    }

    /// Pictures the scene just opened for a bookmark once it has loaded: everything
    /// active drawn, the sky view landed, and three seconds for the tiles. Not if the
    /// user has moved on by then.
    private func picture(_ bookmark: String) async {
        let opened = here
        let start = ContinuousClock.now
        try? await Task.sleep(for: .seconds(3))
        while ContinuousClock.now - start < .seconds(20) {
            let drawn = renderer.map { drawsActive && (observer == nil || $0.isSkySettled) } ?? false
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
        bookmarks.setPicture(bookmark, picture)
    }

    // MARK: Sky view

    /// A panel's way into the sky view, with the terrain on: the horizon is the
    /// view's point. One turned off in the view stays off, and a link keeps its own
    /// (`lookUp`). A station's card closes, as an iPad's covered the corner's
    /// buttons and the compass tape; a satellite's stays.
    func enterSky(at id: UUID) {
        guard passes.station(id) != nil else {
            return
        }
        if observer == nil {
            terrain = true
        }
        lookUp(at: id)
        if case .station = selection {
            select(nil)
        }
    }

    /// Stands on a ground station and looks up (`Focus.enterSky`), if it is one.
    private func lookUp(at id: UUID) {
        guard passes.station(id) != nil else {
            return
        }
        perform(focus.enterSky(at: id))
    }

    /// Back onto the globe, from the sky view.
    func leaveSky() {
        perform(focus.leaveSky())
    }

    /// The Globe panel's projection: the globe drawn that way, the sky view left
    /// for it, as the web app's panel leaves it.
    func choose(_ projection: GlobeProjection) {
        setProjection(projection, animated: true)
        if observer != nil {
            leaveSky()
        }
    }

    /// Draws the globe as a globe or as the flat map; `animated` fades from one to
    /// the other, unless reduced motion cuts.
    private func setProjection(_ projection: GlobeProjection, animated: Bool) {
        self.projection = projection
        globe.setProjection(projection, animated: animated && !GlobeRenderer.reducesMotion)
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
        guard let location = await currentLocation(), let id = passes.setGeolocation(latitude: location.latitude, longitude: location.longitude) else {
            show("The sky view needs your location. Allow it in Settings, or look up from one of your locations.")
            return nil
        }
        return id
    }

    /// Shows `text` for a few seconds; nothing for nil.
    func show(_ text: String?) {
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

    /// What a finger held on the globe opens the globe menu on: a station's pin,
    /// else the ground. Nil off the globe and in the sky view.
    func menuSubject(at point: CGPoint, viewSize size: CGSize) -> GlobeMenuSubject? {
        guard let renderer, observer == nil else {
            return nil
        }
        if let hit = renderer.entity(at: point, viewSize: size), case .station(let id) = Selection(rendererID: hit), passes.station(id) != nil {
            return .station(id)
        }
        return renderer.groundPoint(at: point, viewSize: size).map(GlobeMenuSubject.ground)
    }

    /// The globe menu's Add ground station here: placed and its panel opened, as
    /// Pick on globe places one.
    func addStation(at place: GeoCoordinate) {
        if let id = passes.add(latitude: place.latitude, longitude: place.longitude) {
            select(.station(id))
        }
    }

    /// The globe menu's Look up from here: a station placed there, and the sky
    /// view entered on it.
    func lookUp(from place: GeoCoordinate) {
        if let id = passes.add(latitude: place.latitude, longitude: place.longitude) {
            enterSky(at: id)
        }
    }

    /// The globe menu's Remove ground station.
    func removeStation(_ id: UUID) {
        passes.remove(id)
    }

    /// What the renderer has under `point`, for a tap.
    private static func hits(_ renderer: GlobeRenderer, at point: CGPoint, viewSize size: CGSize) -> Focus.Tap {
        Focus.Tap(ground: { renderer.groundPoint(at: point, viewSize: size) }, entity: { renderer.entity(at: point, viewSize: size) })
    }

    /// Follows a satellite or a station, and opens its panel (`Focus.follow`).
    func follow(_ target: Selection, animated: Bool) {
        perform(focus.follow(target, animated: animated))
    }

    /// Lets go of what is followed.
    func stopTracking(animated: Bool) {
        perform(focus.stopTracking(animated: animated))
    }

    // MARK: Overpass replay

    /// Plays from the plan's time at its speed, the camera watching its satellite pass over
    /// its station as `camera` says: an overpass replay (ADR 0023).
    func replay(_ plan: OverpassReplay.Plan, camera: ReplayCamera) {
        clock.scrub(to: plan.time.rounded(.down))
        clock.setMultiplier(plan.multiplier)
        clock.setPlaying(true)
        aimReplay(satellite: plan.satellite, centre: plan.centre, camera: camera)
    }

    /// Points the camera at a replay as `camera` says, at the clock as it is. Tracking the
    /// satellite chases its swath while its layer is on; the sky view keeps its camera.
    func aimReplay(satellite: String, centre: GroundPoint, camera: ReplayCamera) {
        globe.stopBroadcast()
        guard observer == nil else {
            return
        }
        let motion = !GlobeRenderer.reducesMotion
        let id = catalog.loadedEntry(named: satellite)?.id
        switch camera {
        case .tracking:
            if let id, tracked != .satellite(id) {
                follow(.satellite(id), animated: true)
            }
        case .nadir, .broadcast:
            if tracked != nil {
                perform(focus.stopTracking(animated: false))
            }
            if camera == .broadcast, let id {
                globe.startBroadcast(satellite: id, station: centre, fallbackHeight: Self.replayHeight, animated: motion)
            } else {
                globe.flyOver(latitude: centre.latitude, longitude: centre.longitude, height: Self.replayHeight, animated: motion)
            }
        }
    }

    /// Metres above the station the nadir camera looks down from.
    private static let replayHeight = 5_000_000.0

    /// Keeps the view a replay starts from, for its end; one kept already stays, through
    /// the replay's steps.
    func keepViewBeforeReplay() {
        if observer == nil, viewBeforeReplay == nil {
            viewBeforeReplay = globe.currentView()
        }
    }

    /// Ends a replay's camera: the broadcast stops, and with `returnView` tracking stops
    /// too and the camera flies back to the view the replay started from. A replay opened
    /// from a link started from none, so the camera stays.
    func endReplayCamera(returnView: Bool) {
        globe.stopBroadcast()
        let view = viewBeforeReplay
        viewBeforeReplay = nil
        guard returnView, observer == nil else {
            return
        }
        if tracked != nil {
            perform(focus.stopTracking(animated: false))
        }
        if let view {
            globe.fly(to: view, animated: !GlobeRenderer.reducesMotion)
        }
    }

    /// Does what a change of focus asks of the renderer, and keeps the followed
    /// satellite active. Reduced motion cuts every flight.
    private func perform(_ commands: [Focus.Command]) {
        if catalog.tracked != focus.trackedSatellite {
            catalog.setTracked(focus.trackedSatellite)
        }
        let motion = !GlobeRenderer.reducesMotion
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
    /// notifications again, whenever the list changes.
    private func watchStations() async {
        for await stations in Observations({ self.passes.stations }) {
            globe.stations = shownMarkers
            perform(focus.stationsChanged(to: Set(stations.map(\.id))))
            // Alerts are for the saved stations only.
            alerts.forgetStations(except: Set(passes.saved.map(\.id)))
            // Not awaited: the next edit's pin waited out this plan, seconds over a
            // large group. The plans still run one at a time.
            Task { await alerts.reschedule() }
        }
    }

    /// Follows on, or lets go of, a satellite followed or open that a newer copy
    /// of its group no longer has (`Focus.catalogChanged`).
    private func watchEntries() async {
        for await lost in Observations({ self.focus.hasLost(in: self.catalog.catalog) }) where lost {
            perform(focus.catalogChanged(to: catalog.catalog))
        }
    }

    /// Finds the drawn instrument imagery among the loaded records whenever the catalog
    /// or what is drawn changes: a layer a link names is drawn once a record carrying
    /// it has loaded.
    private func watchInstrumentImagery() async {
        for await (catalog, _) in Observations({ (self.catalog.catalog, self.instrumentImagery.tokens) }) {
            instrumentImagery.resolve(catalog.entries.values)
            granuleImagery.set(instrumentImagery.granuleLayers)
            // Tracking a satellite whose recorded swath is on chases it.
            globe.chasing = Set(instrumentImagery.granuleLayers.compactMap(\.owner))
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
