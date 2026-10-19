import Foundation

/// A scene, what a link shows (CONTEXT.md, Bookmarks), in the app's own terms:
/// `LinkState` is the same in the wire's. Not `Scene`, which SwiftUI and the
/// benchmark's scenes already name.
public struct SceneState: Sendable, Equatable {
    /// Which groups and satellites are switched on.
    public var activation: Activation
    /// What of each satellite is drawn.
    public var components: SatelliteComponents
    /// The stations the link carries, which visit: shown and predicted for, saved
    /// only on the user's word.
    public var stations: [LinkStation]
    /// The selected station, written into a shared link alone: of the saved
    /// stations, which are often where the user lives, only the one being shared.
    /// Never read from a link.
    public var selectedStation: LinkStation?
    /// Whether the sky view is up (ADR 0003).
    public var sky: Bool
    /// The station the sky view stands on, a link's first: written first, and read
    /// as the first of a sky view's link.
    public var observer: LinkStation?
    /// The tracked satellite, by name.
    public var tracked: String?
    /// How a pass is found.
    public var overpassMode: OverpassMode
    /// The imagery a link names, by provider, in order: the app draws the last of
    /// its base maps among them.
    public var layers: [String]
    /// Whether the globe follows Re:Earth's terrain.
    public var terrain: Bool
    /// In the sky view, how the satellites that cannot be seen are drawn (ADR 0010).
    public var unseen: UnseenMode
    /// What the free camera holds still in (CONTEXT.md, Camera mode).
    public var cameraFrame: CameraFrame
    /// Drawable pixels per point: `1`, `1.5`, or `native` for the screen's own.
    public var pixelRatio: String
    /// The instant the clock is pinned at, nil while it is live.
    public var time: Date?
    /// The parameters the app does not show, kept to be written back.
    public var foreign: Foreign

    /// By default the web app's view before any preset (`LinkState.global`).
    public init(
        activation: Activation = Activation(), components: SatelliteComponents = [.point, .label], stations: [LinkStation] = [],
        selectedStation: LinkStation? = nil, sky: Bool = false, observer: LinkStation? = nil, tracked: String? = nil, overpassMode: OverpassMode = .elevation,
        layers: [String] = ["NaturalEarth"], terrain: Bool = false, unseen: UnseenMode = .dim, cameraFrame: CameraFrame = .fixed, pixelRatio: String = "native",
        time: Date? = nil, foreign: Foreign = Foreign()
    ) {
        self.activation = activation
        self.components = components
        self.stations = stations
        self.selectedStation = selectedStation
        self.sky = sky
        self.observer = observer
        self.tracked = tracked
        self.overpassMode = overpassMode
        self.layers = layers
        self.terrain = terrain
        self.unseen = unseen
        self.cameraFrame = cameraFrame
        self.pixelRatio = pixelRatio
        self.time = time
        self.foreign = foreign
    }

    /// What a link carries that the app does not show (ADR 0001's foreign
    /// parameters), written back as it came into every link the app makes. The
    /// web app's FPS switch and benchmark panel are kept among them, where the web
    /// keeps them, as `fps=true` and `bench=true`.
    public struct Foreign: Sendable, Hashable {
        /// In the order the link carried them.
        public var query: LinkQuery

        /// The parameters as a link carried them, in order.
        public init(_ query: LinkQuery = LinkQuery()) {
            self.query = query
        }

        /// The web app's FPS switch, shown as the performance overlay.
        public var showsPerformance: Bool {
            get { flag("fps") }
            set { setFlag("fps", newValue) }
        }

        /// The benchmark panel.
        public var showsBenchmark: Bool {
            get { flag("bench") }
            set { setFlag("bench", newValue) }
        }

        /// On where its last value is `true`.
        private func flag(_ key: String) -> Bool {
            query.items.contains { $0.key == key && $0.values.last == "true" }
        }

        /// Switched on at the end, as a link that never named it gets it.
        private mutating func setFlag(_ key: String, _ on: Bool) {
            query.items.removeAll { $0.key == key }
            if on {
                query.items.append(LinkQuery.Item(key: key, values: ["true"]))
            }
        }
    }

    /// The scene a link shows over its preset's `presetDefaults`, and the
    /// components it names in `elements`, which a budget crossed on the way does
    /// not switch off.
    public static func read(_ query: LinkQuery, presetDefaults: [String: String]) -> (scene: SceneState, named: SatelliteComponents) {
        let read = LinkCodec.read(query, defaults: LinkCodec.defaults(preset: presetDefaults))
        let state = read.state
        let components = SatelliteComponents(names: state.elements)
        let sky = state.scene == "Sky"
        let scene = SceneState(
            activation: Activation(enabledTags: Set(state.tags), enabledSatellites: Set(state.sats), disabledSatellites: Set(state.xsats)),
            components: components,
            stations: state.gs,
            sky: sky,
            observer: sky ? state.gs.first : nil,
            tracked: state.track.isEmpty ? nil : state.track,
            overpassMode: OverpassMode(rawValue: state.overpass) ?? .elevation,
            layers: state.layerProviders,
            terrain: state.terrain == "ReEarth",
            unseen: state.unseen,
            cameraFrame: state.camera,
            pixelRatio: state.pixelRatio,
            time: state.time.flatMap(date(minuteISO:)),
            foreign: Foreign(read.foreign))
        return (scene, query.items.contains { $0.key == "elements" } ? components : [])
    }

    /// The scene as a link on `preset`, as the web app's address bar would hold
    /// it, writing only what differs from `presetDefaults`. Past a budget
    /// (`overBudget`) the default lacks the component, so a view showing it anyway
    /// says so (ADR 0001). The selected station goes in only `sharing`.
    public func link(preset: String?, presetDefaults: [String: String], overBudget: SatelliteComponents, sharing: Bool) -> Link {
        var defaults = LinkCodec.defaults(preset: presetDefaults)
        let over = Set(overBudget.names)
        defaults.elements.removeAll { over.contains($0) }
        var stations = stations
        if sharing, let selectedStation, !stations.contains(selectedStation) {
            stations.append(selectedStation)
        }
        // The sky view stands on a link's first station.
        if let observer {
            stations = [observer] + stations.filter { $0 != observer }
        }
        let state = LinkState(
            elements: components.names,
            sats: Self.ordered(activation.enabledSatellites, like: defaults.sats),
            xsats: Self.ordered(activation.disabledSatellites, like: defaults.xsats),
            tags: Self.ordered(activation.enabledTags, like: defaults.tags),
            gs: stations,
            track: tracked ?? "",
            overpass: overpassMode.rawValue,
            layers: layers,
            terrain: terrain ? "ReEarth" : "None",
            scene: sky ? "Sky" : "3D",
            unseen: unseen,
            camera: cameraFrame,
            pixelRatio: pixelRatio,
            time: time.map(minuteISO))
        return Link(preset: preset, query: LinkCodec.write(state, foreign: foreign.query, defaults: defaults))
    }

    /// The instant a link records for `clock` at the wall clock's `real`
    /// milliseconds: whenever it is off the present, as the deck's Live dot says
    /// (`sceneSync.ts`), so a shared link shows what the sender saw.
    public static func pinnedTime(of clock: SimulationClock, at real: Double) -> Date? {
        clock.isOffPresent(at: real) ? Date(timeIntervalSince1970: clock.time(at: real) / 1000) : nil
    }

    /// A set in the order its defaults list it, the rest after in name order, so
    /// that a view at its defaults writes none of them.
    private static func ordered(_ names: Set<String>, like defaults: [String]) -> [String] {
        defaults.filter(names.contains) + names.subtracting(defaults).sorted()
    }
}

extension LinkStation {
    /// A ground station as a link carries it.
    public init(_ station: GroundStation) {
        self.init(latitude: station.latitude, longitude: station.longitude, name: station.name)
    }
}
