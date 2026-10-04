import Foundation

/// How a pass is found (CONTEXT.md, Overpass mode): the satellite above 5° of
/// elevation, or the station inside the sensor's swath.
public enum OverpassMode: String, Sendable, Hashable, CaseIterable, Codable {
    case elevation
    case swath
}

/// Cross-track distance from the ground track to each edge of the sensor's
/// footprint, in kilometres (src/config/satelliteMetadata.ts).
public struct SwathExtents: Sendable, Hashable {
    public var starboardKm: Double
    public var portKm: Double

    public init(starboardKm: Double, portKm: Double) {
        self.starboardKm = starboardKm
        self.portKm = portKm
    }

    /// The web app's 200 km for a satellite whose record carries no extents.
    public static let `default` = SwathExtents(starboardKm: 100, portKm: 100)

    public var widthKm: Double { starboardKm + portKm }

    /// The record's own extents, which the worker writes as a pair or not at all.
    public init?(metadata: [String: JSONValue]) {
        guard let starboard = metadata["swathStarboardKm"]?.number, let port = metadata["swathPortKm"]?.number else {
            return nil
        }
        self.init(starboardKm: starboard, portKm: port)
    }
}

/// One pass of a satellite over a ground station, in UTC milliseconds since 1970.
public struct Pass: Sendable, Hashable {
    public enum Measure: Sendable, Hashable {
        /// Degrees. The apex is when the highest elevation was sampled, nil when
        /// that was the first sample.
        case elevation(maxElevation: Double, azimuthStart: Double, azimuthApex: Double, azimuthEnd: Double, apex: Double?)
        /// Kilometres from the ground track at closest approach, and when.
        case swath(minDistance: Double, minDistanceTime: Double, swathWidth: Double)
    }

    /// The catalog entry's id.
    public var satellite: String
    public var satelliteName: String
    /// The station's name as it is shown (`GroundStation.displayName`).
    public var station: String
    public var start: Double
    public var end: Double
    public var measure: Measure

    public init(satellite: String, satelliteName: String, station: String, start: Double, end: Double, measure: Measure) {
        self.satellite = satellite
        self.satelliteName = satelliteName
        self.station = station
        self.start = start
        self.end = end
        self.measure = measure
    }

    public var duration: Double { end - start }

    public func contains(_ time: Double) -> Bool {
        start <= time && time <= end
    }
}

/// A satellite's passes over ground stations, found the way the web app's `Orbit`
/// finds them (src/modules/Orbit.ts), step for step: the same instants are
/// propagated, so the same passes come out. JavaScript Dates hold whole
/// milliseconds, so every instant is truncated to one before it is propagated,
/// while the search itself keeps the fractions, as it does there.
public struct PassFinder: Sendable {
    public let propagator: SGP4Propagator

    public init(_ propagator: SGP4Propagator) {
        self.propagator = propagator
    }

    /// Minutes per revolution, from SGP4's recovered mean motion.
    public var orbitalPeriod: Double { 2 * Double.pi / propagator.meanMotion }

    /// The web app predicts no passes for a satellite slower than two revolutions
    /// a day: a geostationary one is overhead all the time or never.
    public var predictsPasses: Bool { orbitalPeriod <= 60 * 12 }

    /// Every pass over the stations that starts inside the window, sorted by start.
    public func passes(
        satellite: String, name: String, over stations: [GroundStation], mode: OverpassMode, swath: SwathExtents, from start: Double, to end: Double
    ) -> [Pass] {
        stations.flatMap { station in
            let found =
                switch mode {
                case .elevation: elevationPasses(over: station, from: start, to: end)
                case .swath: swathPasses(over: station, swath: swath, from: start, to: end)
                }
            return found.map { Pass(satellite: satellite, satelliteName: name, station: station.displayName, start: $0.start, end: $0.end, measure: $0.measure) }
        }.sorted { $0.start < $1.start }
    }

    // MARK: Elevation

    /// `Orbit.computePassesElevation`: coarse steps while the satellite is far
    /// below the horizon, finer as it nears it, 5 s while it is up, then half an
    /// orbit's skip after a pass.
    public func elevationPasses(over station: GroundStation, from start: Double, to end: Double, minElevation: Double = 5, maxPasses: Int = 50) -> [Pass] {
        let observer = (latitude: station.latitude * deg2rad, longitude: station.longitude * deg2rad, height: 0.0)
        // `Date.setMinutes` truncates the minutes it is handed.
        let halfOrbitMs = (orbitalPeriod * 0.5).rounded(.towardZero) * 60_000
        var date = start
        var passes: [Pass] = []
        var pass: (start: Double, azimuthStart: Double, maxElevation: Double, azimuthApex: Double, apex: Double?)?
        var lastElevation = 0.0
        while date < end {
            guard let fixed = fixedPosition(at: date) else {
                date += 60_000
                continue
            }
            let look = lookAngles(observer: observer, satellite: fixed)
            let elevation = look.elevation / deg2rad
            if elevation > minElevation {
                if var ongoing = pass {
                    if elevation > ongoing.maxElevation {
                        ongoing.maxElevation = elevation
                        ongoing.apex = date
                        ongoing.azimuthApex = look.azimuth
                        pass = ongoing
                    }
                } else {
                    pass = (date, look.azimuth, elevation, look.azimuth, nil)
                }
                date += 5000
            } else if let ongoing = pass {
                passes.append(
                    Pass(
                        satellite: "", satelliteName: "", station: station.displayName, start: ongoing.start, end: date,
                        measure: .elevation(
                            maxElevation: ongoing.maxElevation, azimuthStart: ongoing.azimuthStart / deg2rad, azimuthApex: ongoing.azimuthApex / deg2rad,
                            azimuthEnd: look.azimuth / deg2rad, apex: ongoing.apex)))
                if passes.count >= maxPasses {
                    break
                }
                pass = nil
                lastElevation = -180
                date += halfOrbitMs
            } else {
                let deltaElevation = elevation - lastElevation
                lastElevation = elevation
                if deltaElevation < 0 {
                    date += halfOrbitMs
                    lastElevation = -180
                } else if elevation < -20 {
                    date += 5 * 60_000
                } else if elevation < -5 {
                    date += 60_000
                } else if elevation < -1 {
                    date += 5000
                } else {
                    date += 2000
                }
            }
        }
        return passes
    }

    // MARK: Swath

    /// `Orbit.computePassesSwath`: steps of a tenth of an orbit, skipping every
    /// step the ground speed bound proves stays out of reach, then a golden-section
    /// search for the closest approach and bisection for the edges, to 10 ms.
    public func swathPasses(over station: GroundStation, swath: SwathExtents, from startMs: Double, to endMs: Double, maxPasses: Int = 50) -> [Pass] {
        let swathWidth = swath.starboardKm + swath.portKm
        let maxExtent = max(swath.starboardKm, swath.portKm)
        let maxSpeed = maxGroundSpeedKmS
        let stepMs = orbitalPeriod * 0.1 * 60_000
        let distanceAt = { (time: Double) in self.subpointDistanceKm(station, time) }

        var passes: [Pass] = []
        var t = startMs
        var distanceT = distanceAt(t)
        while t < endMs && passes.count < maxPasses {
            let next = min(t + stepMs, endMs)
            let distanceNext = distanceAt(next)
            if (distanceT + distanceNext - (maxSpeed * (next - t)) / 1000) / 2 > maxExtent {
                t = next
                distanceT = distanceNext
                continue
            }
            var closest = closestApproach(station, t, next, maxSpeed, abandonAboveKm: maxExtent) ?? (next, distanceNext)
            if distanceNext < closest.distanceKm {
                closest = (next, distanceNext)
            }
            if distanceT < closest.distanceKm {
                closest = (t, distanceT)
            }
            if closest.distanceKm > maxExtent {
                t = next
                distanceT = distanceNext
                continue
            }

            let withinReach = { (time: Double) in distanceAt(time) <= maxExtent }
            let reachStart = distanceT <= maxExtent ? t : crossing(withinReach, outside: t, inside: closest.timeMs).inside
            var reachEnd = endMs
            var probe = closest.timeMs
            var gap = max(closest.timeMs - reachStart, 1000)
            while probe < endMs {
                let ahead = min(closest.timeMs + gap, endMs)
                if !withinReach(ahead) {
                    reachEnd = crossing(withinReach, outside: ahead, inside: probe).outside
                    break
                }
                probe = ahead
                gap *= 2
            }

            let served =
                swath.starboardKm == swath.portKm
                ? [(reachStart, reachEnd)] : servedIntervals(station, swath, from: reachStart, to: reachEnd, closestMs: closest.timeMs)
            for (start, end) in served {
                let minimum = closestApproach(station, start, end, maxSpeed)!
                passes.append(
                    Pass(
                        satellite: "", satelliteName: "", station: station.displayName, start: start, end: end,
                        measure: .swath(minDistance: minimum.distanceKm, minDistanceTime: minimum.timeMs, swathWidth: swathWidth)))
                if passes.count >= maxPasses {
                    break
                }
            }
            t = reachEnd
            distanceT = distanceAt(t)
        }
        return passes
    }

    /// An upper bound on the subpoint's speed over the ground, km/s: the angular
    /// rate at perigee plus the Earth's rotation, with a tenth to spare.
    var maxGroundSpeedKmS: Double {
        let eccentricity = propagator.elements.eccentricity
        let meanMotionRadS = propagator.meanMotion / 60
        let perigeeKm = cbrt(muKm3S2 / (meanMotionRadS * meanMotionRadS)) * (1 - eccentricity)
        let perigeeRateRadS = (muKm3S2 * (1 + eccentricity) / perigeeKm).squareRoot() / perigeeKm
        return 1.1 * earthRadiusKm * (perigeeRateRadS + earthRotationRadS)
    }

    private func subpointDistanceKm(_ station: GroundStation, _ timeMs: Double) -> Double {
        guard let here = geodetic(at: timeMs) else {
            return .infinity
        }
        return greatCircleKm(here.latitude * deg2rad, here.longitude * deg2rad, station.latitude * deg2rad, station.longitude * deg2rad)
    }

    /// The closest approach in `[lo, hi]`, assuming one minimum there; nil as soon
    /// as the speed bound proves nothing in the bracket comes within `abandonAboveKm`.
    private func closestApproach(
        _ station: GroundStation, _ lo: Double, _ hi: Double, _ maxSpeed: Double, abandonAboveKm: Double = .infinity
    ) -> (timeMs: Double, distanceKm: Double)? {
        var a = lo
        var b = hi
        var c = b - (b - a) * inversePhi
        var d = a + (b - a) * inversePhi
        var fc = subpointDistanceKm(station, c)
        var fd = subpointDistanceKm(station, d)
        while b - a > swathResolutionMs {
            if min(fc, fd) - (maxSpeed * (b - a)) / 1000 > abandonAboveKm {
                return nil
            }
            if fc < fd {
                b = d
                d = c
                fd = fc
                c = b - (b - a) * inversePhi
                fc = subpointDistanceKm(station, c)
            } else {
                a = c
                c = d
                fc = fd
                d = a + (b - a) * inversePhi
                fd = subpointDistanceKm(station, d)
            }
        }
        return fc < fd ? (c, fc) : (d, fd)
    }

    /// Where the station lies relative to the ground track: how far, and on which
    /// side, from two subpoints 10 s apart.
    func trackOffsets(_ station: GroundStation, _ timeMs: Double) -> (starboard: Bool, distanceKm: Double)? {
        let date = timeMs.rounded(.towardZero)
        guard let here = geodetic(at: date), let ahead = geodetic(at: date + bearingSampleMs) else {
            return nil
        }
        let satLat = here.latitude * deg2rad
        let satLon = here.longitude * deg2rad
        let stationLat = station.latitude * deg2rad
        let stationLon = station.longitude * deg2rad
        let flightBearing = bearingRad(satLat, satLon, ahead.latitude * deg2rad, ahead.longitude * deg2rad)
        let stationBearing = bearingRad(satLat, satLon, stationLat, stationLon)
        return (sin(stationBearing - flightBearing) >= 0, greatCircleKm(satLat, satLon, stationLat, stationLon))
    }

    /// The parts of `[from, to]` an asymmetric swath serves the station in, with
    /// the side it lies on read every second rather than assumed for the pass.
    private func servedIntervals(_ station: GroundStation, _ swath: SwathExtents, from: Double, to: Double, closestMs: Double) -> [(Double, Double)] {
        let isServed = { (time: Double) -> Bool in
            guard let offsets = trackOffsets(station, time) else {
                return false
            }
            return offsets.distanceKm <= (offsets.starboard ? swath.starboardKm : swath.portKm)
        }
        var times: [Double] = []
        var time = from
        while time < to {
            times.append(time)
            time += sideSampleMs
        }
        times += [to, closestMs]
        times.sort()

        var intervals: [(Double, Double)] = []
        var start: Double?
        var previous = from
        for time in times {
            let served = isServed(time)
            if served && start == nil {
                start = time == from ? from : crossing(isServed, outside: previous, inside: time).inside
            } else if !served, let open = start {
                intervals.append((open, crossing(isServed, outside: time, inside: previous).outside))
                start = nil
            }
            previous = time
        }
        if let start {
            intervals.append((start, to))
        }
        return intervals
    }

    // MARK: Positions as satellite.js gives them

    /// satellite.js's `eciToEcf` at satellite.js's `gstime`, in kilometres.
    private func fixedPosition(at epochMilliseconds: Double) -> SIMD3<Double>? {
        guard let state = try? propagator.state(epochMilliseconds: epochMilliseconds) else {
            return nil
        }
        let gmst = satelliteJSGstime(julianDate(epochMilliseconds: epochMilliseconds))
        let eci = state.position
        return SIMD3(eci.x * cos(gmst) + eci.y * sin(gmst), eci.x * -sin(gmst) + eci.y * cos(gmst), eci.z)
    }

    /// `Orbit.positionGeodetic`: degrees, at the instant a Date made from it holds.
    private func geodetic(at timeMs: Double) -> (latitude: Double, longitude: Double)? {
        let date = timeMs.rounded(.towardZero)
        guard let state = try? propagator.state(epochMilliseconds: date) else {
            return nil
        }
        let geodetic = eciToGeodetic(state.position, gmst: satelliteJSGstime(julianDate(epochMilliseconds: date)))
        return (geodetic.latitude * rad2deg, geodetic.longitude * rad2deg)
    }
}

/// satellite.js's `ecfToLookAngles`, with the observer in radians and kilometres:
/// azimuth and elevation in radians.
func lookAngles(observer: (latitude: Double, longitude: Double, height: Double), satellite: SIMD3<Double>) -> (azimuth: Double, elevation: Double) {
    let (latitude, longitude) = (observer.latitude, observer.longitude)
    let station = geodeticToEcf(latitude: latitude, longitude: longitude, height: observer.height)
    let r = satellite - station
    let topS = sin(latitude) * cos(longitude) * r.x + sin(latitude) * sin(longitude) * r.y - cos(latitude) * r.z
    let topE = -sin(longitude) * r.x + cos(longitude) * r.y
    let topZ = cos(latitude) * cos(longitude) * r.x + cos(latitude) * sin(longitude) * r.y + sin(latitude) * r.z
    let range = (topS * topS + topE * topE + topZ * topZ).squareRoot()
    return (atan2(-topE, topS) + .pi, asin(topZ / range))
}

/// satellite.js's `geodeticToEcf`: radians and kilometres in, kilometres out.
func geodeticToEcf(latitude: Double, longitude: Double, height: Double) -> SIMD3<Double> {
    let a = 6378.137
    let b = 6356.7523142
    let f = (a - b) / a
    let e2 = 2 * f - f * f
    let normal = a / (1 - e2 * (sin(latitude) * sin(latitude))).squareRoot()
    return SIMD3(
        (normal + height) * cos(latitude) * cos(longitude), (normal + height) * cos(latitude) * sin(longitude), (normal * (1 - e2) + height) * sin(latitude))
}

/// satellite.js's `jday` of a Date.
func julianDate(epochMilliseconds: Double) -> Double {
    let utc = civilDate(epochMilliseconds: epochMilliseconds)
    return jday(
        year: utc.year, month: utc.month, day: utc.day, hour: Double(utc.hour), minute: Double(utc.minute), second: Double(utc.second),
        millisecond: Double(utc.millisecond))
}

/// Initial bearing from one point to another, all in radians.
private func bearingRad(_ fromLat: Double, _ fromLon: Double, _ toLat: Double, _ toLon: Double) -> Double {
    let deltaLon = toLon - fromLon
    let y = sin(deltaLon) * cos(toLat)
    let x = cos(fromLat) * sin(toLat) - sin(fromLat) * cos(toLat) * cos(deltaLon)
    return atan2(y, x)
}

/// Haversine distance on a 6,371 km sphere, all in radians.
private func greatCircleKm(_ fromLat: Double, _ fromLon: Double, _ toLat: Double, _ toLon: Double) -> Double {
    let deltaLat = toLat - fromLat
    let deltaLon = toLon - fromLon
    let a = pow(sin(deltaLat / 2), 2) + cos(fromLat) * cos(toLat) * pow(sin(deltaLon / 2), 2)
    return earthRadiusKm * 2 * atan2(a.squareRoot(), (1 - a).squareRoot())
}

/// Bisects to where `isInside` flips, to 10 ms, returning both bounds.
private func crossing(_ isInside: (Double) -> Bool, outside: Double, inside: Double) -> (outside: Double, inside: Double) {
    var outside = outside
    var inside = inside
    while abs(inside - outside) > swathResolutionMs {
        let mid = (outside + inside) / 2
        if isInside(mid) {
            inside = mid
        } else {
            outside = mid
        }
    }
    return (outside, inside)
}

private let deg2rad = Double.pi / 180
private let rad2deg = 180 / Double.pi
private let earthRadiusKm = 6371.0
private let muKm3S2 = 398600.4418
private let earthRotationRadS = 7.2921159e-5
private let inversePhi = (5.0.squareRoot() - 1) / 2
private let swathResolutionMs = 10.0
private let sideSampleMs = 1000.0
private let bearingSampleMs = 10_000.0
