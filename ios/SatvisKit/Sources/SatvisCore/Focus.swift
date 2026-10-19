import Foundation

/// What the info panel is about, and what the camera can follow.
public enum Selection: Hashable, Sendable {
    /// A catalog id.
    case satellite(String)
    /// A ground station, by its id.
    case station(UUID)

    /// The renderer's id for it: a satellite's catalog id, or a station's marker,
    /// `station|<id>`.
    public var rendererID: String {
        switch self {
        case .satellite(let id): id
        case .station(let id): Self.stationPrefix + id.uuidString
        }
    }

    /// What a renderer's id names: a station's marker, or else a satellite.
    public init(rendererID id: String) {
        if id.hasPrefix(Self.stationPrefix), let station = UUID(uuidString: String(id.dropFirst(Self.stationPrefix.count))) {
            self = .station(station)
        } else {
            self = .satellite(id)
        }
    }

    /// What a station's marker id starts with.
    private static let stationPrefix = "station|"
}

/// What is selected, what the camera follows, the station the sky view stands on
/// and whether the next tap places a station, and what a gesture or a change to
/// the stations or the catalog does to them. A transition returns what the camera
/// has to do; nothing here touches it.
public struct Focus: Sendable, Equatable {
    /// What the camera has to do after a transition. `animated` is what the
    /// gesture asks for, which reduced motion still cuts.
    public enum Command: Sendable, Equatable {
        /// Follows it.
        case track(Selection, animated: Bool)
        /// Lets go of what is followed.
        case stopTracking(animated: Bool)
        /// Stands on a station and looks up; in the sky view already, moves there.
        case enterSky(UUID, animated: Bool)
        /// Back onto the globe, the compass handing the aim back and the camera
        /// going with it.
        case leaveSky(animated: Bool)
        /// Back to where the app opens.
        case flyHome(animated: Bool)
    }

    /// What a tap landed on, each asked of the renderer only where the mode needs it.
    public struct Tap {
        /// The place on the ground under the finger.
        public var ground: () -> GeoCoordinate?
        /// The satellite the sky view's crosshair holds, by catalog id.
        public var crosshair: () -> String?
        /// The renderer's id of what is under the finger.
        public var entity: () -> String?

        public init(
            ground: @escaping () -> GeoCoordinate? = { nil },
            crosshair: @escaping () -> String? = { nil },
            entity: @escaping () -> String? = { nil }
        ) {
            self.ground = ground
            self.crosshair = crosshair
            self.entity = entity
        }
    }

    /// What the info panel is about.
    public private(set) var selection: Selection?
    /// What the camera follows.
    public private(set) var tracked: Selection?
    /// The station the sky view stands on, while it is open (ADR 0003): where the
    /// device is, unless a link names one or a station's panel opened it.
    public private(set) var observer: UUID?
    /// The next tap on the globe places a ground station.
    public private(set) var isPicking = false

    public init() {}

    /// The selected satellite's catalog id.
    public var selectedSatellite: String? {
        if case .satellite(let id) = selection {
            return id
        }
        return nil
    }

    /// The followed satellite's catalog id. Tracking keeps a satellite active even
    /// when its group is switched off, as on the web.
    public var trackedSatellite: String? {
        if case .satellite(let id) = tracked {
            return id
        }
        return nil
    }

    /// Opens the info panel on `selection`, or closes it for nil, leaving what is
    /// followed.
    public mutating func select(_ selection: Selection?) {
        self.selection = selection
    }

    /// Whether the next tap on the globe places a ground station.
    public mutating func setPicking(_ picking: Bool) {
        isPicking = picking
    }

    /// A tap places a station while picking, and otherwise selects what it lands
    /// on, or nothing unless `keepingSelection`. `add` saves a station at a place
    /// and says which it became.
    public mutating func tap(_ tap: Tap, keepingSelection: Bool, add: (_ latitude: Double, _ longitude: Double) -> UUID?) {
        if isPicking {
            if let place = tap.ground(), let added = add(place.latitude, place.longitude) {
                selection = .station(added)
            }
            isPicking = false
            return
        }
        // From the ground the crosshair chooses, not the finger (ADR 0003).
        if observer != nil {
            if let lock = tap.crosshair() {
                selection = .satellite(lock)
            }
            return
        }
        let hit = tap.entity()
        if hit == nil, keepingSelection {
            return
        }
        selection = hit.map(Selection.init(rendererID:))
    }

    /// A double tap follows what it lands on.
    public mutating func doubleTap(_ tap: Tap) -> [Command] {
        guard observer == nil, let id = tap.entity() else {
            return []
        }
        return follow(Selection(rendererID: id))
    }

    /// Follows a satellite or a station. `animated` flies the camera, as the web
    /// app's Track button does; a link or a double tap cuts. `selecting` opens its
    /// panel too; a link's `track` does not, as on the web, where it follows alone.
    public mutating func follow(_ target: Selection, selecting: Bool = true, animated: Bool = false) -> [Command] {
        // Nothing is followed from the ground (ADR 0003).
        guard observer == nil else {
            return []
        }
        tracked = target
        if selecting {
            selection = target
        }
        return [.track(target, animated: animated)]
    }

    /// Lets go of what is followed, if anything.
    public mutating func stopTracking(animated: Bool = false) -> [Command] {
        guard tracked != nil else {
            return []
        }
        tracked = nil
        return [.stopTracking(animated: animated)]
    }

    /// Stands on a ground station and looks up; in the sky view already, moves
    /// there. Nothing is followed from the ground: a camera cannot both chase a
    /// satellite and stand still.
    public mutating func enterSky(at station: UUID) -> [Command] {
        let stopped = stopTracking()
        observer = station
        return stopped + [.enterSky(station, animated: true)]
    }

    /// Back onto the globe, from the sky view.
    public mutating func leaveSky() -> [Command] {
        guard observer != nil else {
            return []
        }
        observer = nil
        return [.leaveSky(animated: true)]
    }

    /// The globe button: out of the sky view onto the globe, and from anywhere on
    /// the globe back to where the app opens, letting go of what is followed.
    public mutating func goHome() -> [Command] {
        if observer != nil {
            return leaveSky()
        }
        return stopTracking(animated: true) + [.flyHome(animated: true)]
    }

    /// Lets go of what is followed, open and stood on, for a link that replaces
    /// what is shown. Picking carries on.
    public mutating func clear() -> [Command] {
        let commands = stopTracking() + leaveSky()
        selection = nil
        return commands
    }

    /// Lets go of a station no longer among `remaining`: it is no longer followed
    /// or open, and the sky view standing on it is left.
    public mutating func stationsChanged(to remaining: Set<UUID>) -> [Command] {
        var commands: [Command] = []
        if case .station(let station) = tracked, !remaining.contains(station) {
            commands += stopTracking()
        }
        if case .station(let station) = selection, !remaining.contains(station) {
            selection = nil
        }
        if let observer, !remaining.contains(observer) {
            commands += leaveSky()
        }
        return commands
    }

    /// Whether a satellite followed or open is gone from `catalog`.
    public func hasLost(in catalog: Catalog) -> Bool {
        [trackedSatellite, selectedSatellite].contains { id in id.map { catalog.entries[$0] == nil } ?? false }
    }

    /// Follows on, or lets go of, a satellite followed or open whose entry a
    /// newer copy of its group no longer has: renamed since the copy kept on
    /// disk, the catalog number kept, or decayed. Left as it was, the camera
    /// would follow nothing and the gestures steer a camera not drawn.
    public mutating func catalogChanged(to catalog: Catalog) -> [Command] {
        var commands: [Command] = []
        if let lost = trackedSatellite, catalog.entries[lost] == nil {
            if let next = catalog.entry(orSuccessorOf: lost)?.id {
                // Opened only if it was, below.
                commands += follow(.satellite(next), selecting: false)
            } else {
                commands += stopTracking()
            }
        }
        if let lost = selectedSatellite, catalog.entries[lost] == nil {
            selection = catalog.entry(orSuccessorOf: lost).map { .satellite($0.id) }
        }
        return commands
    }
}
