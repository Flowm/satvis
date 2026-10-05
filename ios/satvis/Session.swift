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
    let source: GPSource
    let alerts: PassAlerts
    let clock = ViewerClock()
    let catalog: CatalogModel
    let passes = PassModel()
    @ObservationIgnored let satellites = SatelliteLayer()
    @ObservationIgnored private let starMap = StarMap()
    /// Observed: it arrives once its shaders compile, possibly after a link has
    /// opened on the sky view, whose instruments wait for it.
    private(set) var renderer: GlobeRenderer?

    var selection: Selection?
    /// What the camera follows: a satellite's catalog id or a station's marker id.
    private(set) var tracked: String?
    /// The next tap on the globe places a ground station.
    var isPicking = false
    /// The station the sky view stands on, while it is open (ADR 0003).
    private(set) var observer: UUID?
    let compass = SkyCompass()
    /// A word for the user that goes by itself: how switching the compass on went.
    private(set) var notice: String?
    /// The globe's base map, kept between launches.
    var baseLayer: BaseLayer = UserDefaults.standard.string(forKey: "baseLayer").flatMap(BaseLayer.init(rawValue:)) ?? .naturalEarth {
        didSet {
            UserDefaults.standard.set(baseLayer.rawValue, forKey: "baseLayer")
            renderer?.setImagery(baseLayer, site: source.site)
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
    let analytics = Analytics()

    /// What the map is drawn from now, to credit: with the terrain the sky view
    /// always stands on, whatever the Map menu says.
    var mapCredits: [Credit] { Credit.map(baseLayer: baseLayer, terrain: terrain || observer != nil) }

    /// The site's privacy policy, which covers the app.
    var privacyPolicy: URL { source.site.appending(path: "data/privacy.html") }

    /// What the drawn links were built from.
    @ObservationIgnored private var linksKey: LinksKey?
    /// When the data was last asked for again, so that the scene turning active
    /// twice in a row does not ask twice.
    @ObservationIgnored private var revalidated = Date.distantPast
    /// A link that came before there was a catalog to open it on.
    @ObservationIgnored private var pendingLink: Link?
    /// Counts the links applied, so that one superseded while it waited stops
    /// there rather than finish over the newer one.
    @ObservationIgnored private var linkGeneration = 0
    @ObservationIgnored private var started = false
    /// What the last link carried that the app does not show (ADR 0001's foreign
    /// parameters), written back into every link the app makes.
    @ObservationIgnored private var foreign = LinkQuery()
    /// The web app's FPS switch, which the app shows as its performance overlay.
    /// Kept where the web keeps it, in the link as `fps=true`: a link the app
    /// does not otherwise read, written back as it came.
    private(set) var showsPerformance = false

    /// The view as it was left, as a link.
    private static let viewKey = "view"
    /// `SATVIS_LINK` in the launch environment opens on that link, a whole url or
    /// a path with its query (`/ot?tags=OT`): for screenshots and tests.
    private static let launchLink = ProcessInfo.processInfo.environment["SATVIS_LINK"].map(Link.init)

    init(source: GPSource, alerts: PassAlerts) {
        self.source = source
        self.alerts = alerts
        catalog = CatalogModel(source: source)
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
        renderer.tileLoader = { [tiles] request in
            do {
                return try await tiles.tile(request.url, contentType: request.contentType, headers: request.headers)
            } catch is CancellationError {
                return nil
            } catch let error as URLError where error.code == .cancelled {
                return nil
            } catch {
                log.error("\(request.url, privacy: .public): \(error, privacy: .public)")
                return nil
            }
        }
        renderer.setImagery(baseLayer, site: source.site)
        renderer.setTerrain(terrain)
        renderer.setStations(shownMarkers)
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
            Task { await starMap.load(from: source) },
            Task { await predictPasses() },
            Task { await countViews() },
        ]
        await withTaskCancellationHandler {
            // The kept copy first, so nothing waits on the network that a copy on
            // disk can show; the worker's answers follow.
            await source.loadKept()
            if source.index == nil {
                await source.refresh()
            }
            started = true
            if let link = pendingLink ?? Self.launchLink ?? UserDefaults.standard.string(forKey: Self.viewKey).map(Link.init) {
                pendingLink = nil
                await apply(link, settings: true)
            } else {
                // The first launch: the default preset, and the map as the
                // settings before links kept it.
                await apply(Link(), settings: false)
            }
            Task {
                await source.refresh()
                await catalog.revalidate(refetching: false)
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
            await source.refresh()
            await catalog.revalidate()
            await alerts.reschedule()
        }
    }

    func enteredBackground() {
        alerts.requestRefresh()
        // Kept without its time: the app reopens on the present.
        UserDefaults.standard.set(link(sharing: false, withTime: false).url(site: source.site).absoluteString, forKey: Self.viewKey)
    }

    // MARK: Links

    func setShowsPerformance(_ shows: Bool) {
        showsPerformance = shows
        foreign.items.removeAll { $0.key == Self.performanceKey }
        if shows {
            foreign.items.append(LinkQuery.Item(key: Self.performanceKey, values: ["true"]))
        }
    }

    private static let performanceKey = "fps"

    /// Opens a link: what it shows replaces what is shown, as on the web.
    func open(_ link: Link) {
        guard started else {
            pendingLink = link
            return
        }
        Task { await apply(link, settings: true) }
    }

    /// The view as a link, as the web app's address bar would hold it. Of the
    /// saved stations only the selected one goes into a link, and only one that
    /// is `sharing`: they are often where the user lives.
    func link(sharing: Bool, withTime: Bool = true) -> Link {
        let defaults = LinkCodec.defaults(preset: catalog.presetDefaults)
        var stations = passes.visiting
        if sharing, case .station(let id) = selection, let station = passes.station(id), !stations.contains(where: { $0.id == id }) {
            stations.append(station)
        }
        // The sky view stands on a link's first station.
        if let observer, let station = passes.station(observer) {
            stations = [station] + stations.filter { $0.id != observer }
        }
        let activation = catalog.activation
        let state = LinkState(
            elements: SatelliteComponents.named.filter { catalog.components.contains($0.1) }.map(\.0),
            sats: Self.ordered(activation.enabledSatellites, like: defaults.sats),
            xsats: Self.ordered(activation.disabledSatellites, like: defaults.xsats),
            tags: Self.ordered(activation.enabledTags, like: defaults.tags),
            gs: stations.map { LinkStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name) },
            track: catalog.tracked.flatMap { catalog.catalog.entries[$0]?.name } ?? "",
            overpass: passes.mode.rawValue,
            layers: [baseLayer.rawValue],
            terrain: terrain ? "ReEarth" : "None",
            scene: observer == nil ? "3D" : "Sky",
            time: withTime && clock.clock.isPinned ? minuteISO(Date(timeIntervalSince1970: clock.now() / 1000)) : nil)
        return Link(preset: catalog.presetName, query: LinkCodec.write(state, foreign: foreign, defaults: defaults))
    }

    /// Shows what a link says, over its preset's defaults. `settings` false leaves
    /// the map, the overpass mode and the clock as they are.
    private func apply(_ link: Link, settings: Bool) async {
        linkGeneration += 1
        let generation = linkGeneration
        // A preset the kept index does not know, as the index shipped in the app
        // knows only the default: the worker's may, and the link is read against
        // that preset's defaults, so it waits for it.
        if let named = link.preset, source.index?.value.presets[named] == nil {
            await source.refresh()
            guard generation == linkGeneration else {
                return
            }
        }
        let index = source.index?.value
        let preset = link.preset.flatMap { index?.presets[$0] != nil ? $0 : nil }
        let defaults = LinkCodec.defaults(preset: index?.preset(named: preset)?.defaults ?? [:])
        let read = LinkCodec.read(link.query, defaults: defaults)
        let state = read.state
        foreign = read.foreign
        showsPerformance = foreign.items.contains { $0.key == Self.performanceKey && $0.values.last == "true" }
        if let tracked {
            track(tracked, false)
        }
        if observer != nil {
            leaveSky()
        }
        selection = nil
        if settings {
            if let base = state.layerProviders.compactMap(BaseLayer.init(rawValue:)).last {
                baseLayer = base
            }
            terrain = state.terrain == "ReEarth"
            passes.setMode(OverpassMode(rawValue: state.overpass) ?? .elevation)
            // A clock pinned for a screenshot stays where it was put.
            if ViewerClock.launchTime == nil {
                if let time = state.time.flatMap(date(minuteISO:)) {
                    clock.pin(at: (time.timeIntervalSince1970 * 1000).rounded(.down))
                } else if clock.clock.isPinned {
                    clock.goLive()
                }
            }
        }
        passes.setVisiting(state.gs.map { GroundStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name) })
        await catalog.open(
            preset: preset,
            activation: Activation(enabledTags: Set(state.tags), enabledSatellites: Set(state.sats), disabledSatellites: Set(state.xsats)),
            components: SatelliteComponents(SatelliteComponents.named.filter { state.elements.contains($0.0) }.map(\.1)))
        guard generation == linkGeneration else {
            return
        }
        if state.scene == "Sky" {
            // On the link's first station, as it was listed, else the user's first.
            // Nil where the link's station is not on the globe, and was refused.
            let first = state.gs.first.flatMap {
                GroundStations.normalized([GroundStation(latitude: $0.latitude, longitude: $0.longitude, name: $0.name)]).first.map(GroundStations.Place.init)
            }
            let station = first.map { place in passes.stations.first { GroundStations.Place($0) == place } } ?? passes.saved.first
            if let station {
                enterSky(at: station.id)
            }
        } else if !state.track.isEmpty, let entry = await catalog.entry(named: state.track), generation == linkGeneration {
            track(entry.id, true)
        }
    }

    /// A page view whenever the view changes, as the web app's address bar makes
    /// one, but not for the clock alone: a pinned clock moves on every minute.
    private func countViews() async {
        var counted: Link?
        for await view in Observations({ self.link(sharing: false, withTime: false) }) {
            guard started, view != counted else {
                continue
            }
            counted = view
            analytics.pageview(link(sharing: false).url(site: source.site))
        }
    }

    // MARK: Sky view

    /// Stands on a ground station and looks up. Nothing is followed from the
    /// ground: a camera cannot both chase a satellite and stand still.
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

    func leaveSky() {
        compass.stop(renderer)
        renderer?.leaveSky(animated: !UIAccessibility.isReduceMotionEnabled)
        observer = nil
        renderer?.setStations(shownMarkers)
    }

    /// Looks up from the selected station, else the first saved one, else where
    /// the device is, which becomes a station. Without one of those it does not
    /// open: a sky at a place nobody chose looks like a working view and is not.
    func viewTheSky() async {
        if case .station(let id) = selection {
            return enterSky(at: id)
        }
        if let first = passes.saved.first ?? passes.stations.first {
            return enterSky(at: first.id)
        }
        guard let location = await currentLocation(), let id = passes.add(latitude: location.latitude, longitude: location.longitude, name: "Geolocation") else {
            show("The sky view needs a place to stand: allow your location, or add a ground station.")
            return
        }
        enterSky(at: id)
    }

    /// Aims the sky view with the device, or hands the aim back.
    func toggleCompass() {
        guard let renderer else {
            return
        }
        if compass.isAiming {
            compass.stop(renderer)
            return
        }
        Task {
            switch await compass.start(renderer) {
            case .aiming: show("Aiming by compass. Drag at any time to turn it off.")
            case .unsupported: show("This device has no motion sensor to aim with.")
            case .noHeading: show("This device cannot tell where north is, so it cannot aim by compass.")
            case .silent: show("The motion sensor did not answer.")
            case .takenBack: break
            }
        }
    }

    /// Whether a drag of `translation` so far may turn the view. While the compass
    /// aims, a drag past a tap's slop takes the aim back (ADR 0004); within it, it
    /// is a tap's tremor and the compass keeps the aim.
    func mayDrag(_ translation: CGSize) -> Bool {
        guard compass.isAiming else {
            return true
        }
        guard hypot(translation.width, translation.height) > 8 else {
            return false
        }
        compass.stop(renderer)
        return true
    }

    private func show(_ text: String) {
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

    /// A set in the order its defaults list it, the rest after in name order, so
    /// that a view at its defaults writes none of them.
    private static func ordered(_ names: Set<String>, like defaults: [String]) -> [String] {
        defaults.filter(names.contains) + names.subtracting(defaults).sorted()
    }

    /// A tap places a station while picking, and otherwise selects what it lands
    /// on, or nothing.
    func tap(at point: CGPoint, viewSize size: CGSize) {
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
        selection = renderer.entity(at: point, viewSize: size).map { id in
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
    /// active even when its group is switched off, as on the web.
    func track(_ id: String, _ follow: Bool) {
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
            selection = PassModel.stationID(id).map(Selection.station) ?? .satellite(id)
            renderer?.track(id)
        } else {
            renderer?.stopTracking()
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

    /// Stands the stations on the globe, lets go of one that is gone, drops its
    /// alerts, and predicts the notifications again, whenever the list changes.
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
            // Alerts are for the saved stations only.
            alerts.forgetStations(except: Set(passes.saved.map(\.id)))
            await alerts.reschedule()
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
                    track(next, true)
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
            let showsLinks = catalog.components.contains(.groundStationLink) && active.count <= SatelliteComponents.linkBudget
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
