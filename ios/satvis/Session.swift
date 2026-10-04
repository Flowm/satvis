import Foundation
import OSLog
import Observation
import SatvisCore
import SatvisData
import SatvisRender

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
    @ObservationIgnored private var renderer: GlobeRenderer?

    var selection: Selection?
    /// What the camera follows: a satellite's catalog id or a station's marker id.
    private(set) var tracked: String?
    /// The next tap on the globe places a ground station.
    var isPicking = false
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

    /// What the drawn links were built from.
    @ObservationIgnored private var linksKey: LinksKey?
    /// When the data was last asked for again, so that the scene turning active
    /// twice in a row does not ask twice.
    @ObservationIgnored private var revalidated = Date.distantPast

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
        renderer.setStations(passes.markers)
        satellites.attach(renderer)
        starMap.attach(renderer)
    }

    /// Loads what there is to show and keeps it in step until cancelled.
    func run() async {
        let watchers = [
            Task { await watchActive() },
            Task { await watchStations() },
            Task { await watchMode() },
            Task { await starMap.load(from: source) },
            Task { await predictPasses() },
        ]
        await withTaskCancellationHandler {
            // The kept copy first, so nothing waits on the network that a copy on
            // disk can show; the worker's answers follow.
            await source.loadKept()
            if source.index == nil {
                await source.refresh()
            }
            await catalog.start()
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
        selection = renderer.entity(at: point, viewSize: size).map { id in
            PassModel.stationID(id).map(Selection.station) ?? .satellite(id)
        }
    }

    /// A double tap follows what it lands on.
    func doubleTap(at point: CGPoint, viewSize size: CGSize) {
        if let id = renderer?.entity(at: point, viewSize: size) {
            track(id, true)
        }
    }

    /// Follows a satellite or a station, or lets it go. Tracking keeps a satellite
    /// active even when its group is switched off, as on the web.
    func track(_ id: String, _ follow: Bool) {
        let isStation = PassModel.stationID(id) != nil
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
            renderer?.setStations(passes.markers)
            let ids = Set(stations.map(\.id))
            if let tracked, let station = PassModel.stationID(tracked), !ids.contains(station) {
                track(tracked, false)
            }
            if case .station(let station) = selection, !ids.contains(station) {
                selection = nil
            }
            alerts.forgetStations(except: ids)
            await alerts.reschedule()
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
            let showsLinks = catalog.components.contains(.groundStationLink) && active.count <= SatelliteComponents.linkBudget
            var wanted: [CatalogEntry] = []
            var showsStation = false
            switch selection {
            case .satellite(let id):
                wanted += catalog.catalog.entries[id].map { [$0] } ?? []
            case .station:
                showsStation = true
            case nil:
                break
            }
            if showsLinks || showsStation {
                let selected = Set(wanted.map(\.id))
                wanted += active.filter { !selected.contains($0.id) }
            }
            if passes.hasStations, !wanted.isEmpty {
                await passes.refresh(wanted, at: clock.now())
            }
            await passes.keep(only: wanted)
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
