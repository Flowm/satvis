import Foundation

/// What is drawn for each satellite: the web app's satellite components, those
/// this milestone draws.
public struct SatelliteComponents: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let point = SatelliteComponents(rawValue: 1 << 0)
    public static let label = SatelliteComponents(rawValue: 1 << 1)
    public static let orbit = SatelliteComponents(rawValue: 1 << 2)
    public static let orbitTrack = SatelliteComponents(rawValue: 1 << 3)
    public static let groundTrack = SatelliteComponents(rawValue: 1 << 4)
    public static let sensorCone = SatelliteComponents(rawValue: 1 << 5)
    /// For the satellites a model manifest gives a model (ADR 0007).
    public static let model = SatelliteComponents(rawValue: 1 << 6)
    public static let groundStationLink = SatelliteComponents(rawValue: 1 << 7)

    /// Past these many active satellites the web app switches a component off,
    /// once, on the crossing (`COMPONENT_BUDGETS`): labels stop being readable,
    /// every link is a line, and every model is drawn alone. Only a satellite with
    /// a model file counts against the models' budget. Labels past theirs are not
    /// drawn here even when switched back on: their atlas would outgrow a texture.
    public static let labelBudget = 200
    public static let linkBudget = 500
    public static let modelBudget = 200
    public static let budgets: [(component: SatelliteComponents, limit: Int)] = [(.label, labelBudget), (.groundStationLink, linkBudget), (.model, modelBudget)]

    /// The web app's names, as its `elements` url parameter and presets use them.
    public static let named: [(String, SatelliteComponents)] = [
        ("Point", .point), ("Label", .label), ("Orbit", .orbit), ("Orbit track", .orbitTrack), ("Ground track", .groundTrack), ("Sensor cone", .sensorCone), ("3D model", .model),
        ("Ground station link", .groundStationLink),
    ]

    /// The components `names` lists; a name it does not know is skipped.
    public init(names: [String]) {
        self.init(Self.named.filter { names.contains($0.0) }.map(\.1))
    }

    /// Its names, in the web app's order.
    public var names: [String] {
        Self.named.filter { contains($0.1) }.map(\.0)
    }
}

/// Which components are past their budget for what is active, and what that
/// switches off: edge-triggered, as the web app's sceneSync, so a component
/// switched back on past its budget stays on until the count drops under and
/// crosses again (ADR 0001).
public struct ComponentBudgets: Sendable, Equatable {
    /// The components past their budget, which links leave out of the default for
    /// `elements`, so that one naming them keeps them.
    public private(set) var over: SatelliteComponents = []

    /// Nothing past its budget yet: counted afresh, as for a link just opened.
    public init() {}

    /// `components` once `active` satellites are, `modelled` of them with a model
    /// file: less each one whose budget this count crosses, unless `named`, what
    /// the link being opened names.
    public mutating func components(_ components: SatelliteComponents, active: Int, modelled: Int, named: SatelliteComponents) -> SatelliteComponents {
        var components = components
        for (component, budget) in SatelliteComponents.budgets {
            if (component == .model ? modelled : active) <= budget {
                over.remove(component)
            } else if !over.contains(component) {
                over.insert(component)
                if !named.contains(component) {
                    components.remove(component)
                }
            }
        }
        return components
    }
}
