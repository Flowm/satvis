import simd

/// Whether a satellite in the sky view could be seen by eye, from geometry alone
/// (src/modules/util/visibility.ts, ADR 0010). Not brightness: a dark-coated
/// satellite in sunlight counts as visible.
public enum Visibility: String, Sendable, Equatable {
    case visible, shadow, daylight, far

    /// The web app's card text (SkyHud.vue).
    public var label: String {
        switch self {
        case .visible: "Could be seen"
        case .shadow: "In Earth's shadow"
        case .daylight: "Daylight"
        case .far: "Too far"
        }
    }

    /// Degrees: the end of civil twilight. A stand-in until a faintest visible
    /// magnitude replaces it.
    public static let darkSkySunElevation = -6.0

    /// Kilometres: beyond this a bright satellite is past the naked-eye limit. A
    /// stand-in until a predicted magnitude replaces it.
    public static let maximumRange = 5000.0

    /// Metres. The shadow is a cylinder of the mean radius: the penumbra and the
    /// flattening move shadow entry in LEO by a few seconds.
    public static let shadowRadius = 6_371_000.0

    /// A bright sky hides a satellite whether it is lit or not, so daylight comes
    /// first; a far one stays unseen in sunlight, so distance comes before the
    /// shadow.
    public init(sunElevation: Double, sunlit: Bool, range: Double) {
        if sunElevation > Self.darkSkySunElevation {
            self = .daylight
        } else if range > Self.maximumRange {
            self = .far
        } else {
            self = sunlit ? .visible : .shadow
        }
    }

    /// `position` in metres, Earth-fixed; `sun` a unit vector from `Sun`.
    public static func inEarthShadow(_ position: SIMD3<Double>, sun: SIMD3<Double>) -> Bool {
        let along = dot(position, sun)
        guard along < 0 else {
            return false
        }
        return length_squared(position) - along * along < shadowRadius * shadowRadius
    }
}

/// What the sky view does with the satellites that are not visible: `?unseen=`.
public enum UnseenMode: String, Sendable, CaseIterable {
    case show, dim, hide

    /// How a satellite with this verdict is drawn: 1 as usual, 0 hidden. On a
    /// dark sky an unseen one must stand apart from the visible ones (at 0.5 a
    /// dimmed orange GEO point was as bright as a visible grey one); daylight dims
    /// every satellite alike, and 0.22 vanished against the blue.
    public func opacity(_ visibility: Visibility) -> Double {
        switch (self, visibility) {
        case (.show, _), (_, .visible): 1
        case (.hide, _): 0
        case (.dim, .daylight): 0.6
        case (.dim, _): 0.3
        }
    }
}
