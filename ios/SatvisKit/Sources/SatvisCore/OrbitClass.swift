/// The orbit's regime, derived from the element set and never configured
/// (`orbitClassOf` in src/modules/util/gp.ts).
public enum OrbitClass: String, Sendable, Codable, CaseIterable {
    case leo = "LEO"
    case meo = "MEO"
    case geo = "GEO"
    case heo = "HEO"

    /// Read straight off the mean motion and eccentricity, as the web app does: no
    /// SGP4 initialisation for a three-letter answer. Eccentricity comes first,
    /// because a highly elliptical orbit can have an MEO-looking period.
    public init(meanMotionRevPerDay: Double, eccentricity: Double) {
        if eccentricity > 0.25 {
            self = .heo
            return
        }
        let periodMinutes = minutesPerDay / meanMotionRevPerDay
        if periodMinutes <= 128 {
            self = .leo
        } else if periodMinutes >= 1400 && periodMinutes <= 1470 {
            self = .geo
        } else {
            self = .meo
        }
    }
}

let minutesPerDay = 1440.0
