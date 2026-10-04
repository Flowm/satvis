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
        /// Degrees, and when the satellite stood highest.
        case elevation(maxElevation: Double, azimuthStart: Double, azimuthApex: Double, azimuthEnd: Double, apex: Double?)
        /// Kilometres from the ground track at closest approach, and when.
        case swath(minDistance: Double, minDistanceTime: Double, swathWidth: Double)
    }

    /// The catalog entry's id.
    public var satellite: String
    public var satelliteName: String
    /// The station's name as it is shown (`GroundStation.displayName`).
    public var station: String
    /// Which station, whatever it is called.
    public var stationID: UUID
    public var start: Double
    public var end: Double
    public var measure: Measure

    public init(satellite: String, satelliteName: String, station: String, stationID: UUID, start: Double, end: Double, measure: Measure) {
        self.satellite = satellite
        self.satelliteName = satelliteName
        self.station = station
        self.stationID = stationID
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
            return found.map {
                Pass(satellite: satellite, satelliteName: name, station: station.displayName, stationID: station.id, start: $0.start, end: $0.end, measure: $0.measure)
            }
        }.sorted { $0.start < $1.start }
    }

    // MARK: Elevation

    /// `Orbit.computePassesElevation`: within each reach of the station, found as
    /// the swath search finds them, steps of a tenth of an orbit; in each, the peak
    /// by golden section and the rise and set by bisection, to 10 ms. A pass that
    /// runs over a step is carried on into the next.
    public func elevationPasses(over station: GroundStation, from start: Double, to end: Double, minElevation: Double = 5, maxPasses: Int = .max) -> [Pass] {
        let observer = (latitude: station.latitude * deg2rad, longitude: station.longitude * deg2rad, height: 0.0)
        let lookAt = { (time: Double) -> (azimuth: Double, elevation: Double)? in
            fixedPosition(at: time.rounded(.towardZero)).map { lookAngles(observer: observer, satellite: $0) }
        }
        let elevationAt = { (time: Double) in (lookAt(time)?.elevation ?? -Double.pi / 2) * rad2deg }
        let azimuthAt = { (time: Double) in (lookAt(time)?.azimuth ?? 0) * rad2deg }
        let isAbove = { (time: Double) in elevationAt(time) > minElevation }
        let step = scanStepMs

        var passes: [Pass] = []
        for reach in reachIntervals(station, radiusKm: visibilityRadiusKm(minElevation), from: start, to: end) {
            var open: (start: Double, apex: (timeMs: Double, elevation: Double))?
            var a = reach.start
            while a < reach.end {
                defer { a += step }
                let b = min(a + step, reach.end)
                let atA = elevationAt(a)
                let atB = elevationAt(b)
                let inner = minimum({ -elevationAt($0) }, a, b)!
                var apex = (timeMs: inner.timeMs, elevation: -inner.value)
                if atA > apex.elevation {
                    apex = (a, atA)
                }
                if atB > apex.elevation {
                    apex = (b, atB)
                }
                if apex.elevation <= minElevation {
                    continue
                }
                // A step starts above the horizon only mid-pass, which `open` carries,
                // or at the window's start.
                let passStart = open?.start ?? (atA > minElevation ? a : crossing(isAbove, outside: a, inside: apex.timeMs).inside)
                let peak = open.map { $0.apex.elevation > apex.elevation ? $0.apex : apex } ?? apex
                if atB > minElevation && b < reach.end {
                    open = (passStart, peak)
                    continue
                }
                open = nil
                let passEnd = atB > minElevation ? b : crossing(isAbove, outside: b, inside: apex.timeMs).outside
                passes.append(
                    Pass(
                        satellite: "", satelliteName: "", station: station.displayName, stationID: station.id, start: passStart, end: passEnd,
                        measure: .elevation(
                            maxElevation: peak.elevation, azimuthStart: azimuthAt(passStart), azimuthApex: azimuthAt(peak.timeMs), azimuthEnd: azimuthAt(passEnd),
                            apex: peak.timeMs)))
                if passes.count >= maxPasses {
                    return passes
                }
            }
        }
        return passes
    }

    // MARK: Swath

    /// `Orbit.computePassesSwath`: the reaches of the wider extent, each the pass
    /// for a symmetric swath, cut to where the station's side is served for an
    /// asymmetric one, with the closest approach by golden section.
    public func swathPasses(over station: GroundStation, swath: SwathExtents, from startMs: Double, to endMs: Double, maxPasses: Int = .max) -> [Pass] {
        let swathWidth = swath.starboardKm + swath.portKm
        let maxExtent = max(swath.starboardKm, swath.portKm)
        let distanceAt = { (time: Double) in self.subpointDistanceKm(station, time) }

        var passes: [Pass] = []
        for reach in reachIntervals(station, radiusKm: maxExtent, from: startMs, to: endMs) {
            let served =
                swath.starboardKm == swath.portKm
                ? [(reach.start, reach.end)] : servedIntervals(station, swath, from: reach.start, to: reach.end, closestMs: reach.closestMs)
            for (start, end) in served {
                let closest = minimum(distanceAt, start, end)!
                passes.append(
                    Pass(
                        satellite: "", satelliteName: "", station: station.displayName, stationID: station.id, start: start, end: end,
                        measure: .swath(minDistance: closest.value, minDistanceTime: closest.timeMs, swathWidth: swathWidth)))
                if passes.count >= maxPasses {
                    return passes
                }
            }
        }
        return passes
    }

    private var semiMajorAxisKm: Double {
        let meanMotionRadS = propagator.meanMotion / 60
        return cbrt(muKm3S2 / (meanMotionRadS * meanMotionRadS))
    }

    /// Short enough that the distance to a station, and the elevation, peak at most
    /// once per step.
    private var scanStepMs: Double { orbitalPeriod * 0.1 * 60_000 }

    /// An upper bound on the subpoint's speed over the ground, km/s: the angular
    /// rate at perigee plus the Earth's rotation, with a tenth to spare.
    var maxGroundSpeedKmS: Double {
        let eccentricity = propagator.elements.eccentricity
        let perigeeKm = semiMajorAxisKm * (1 - eccentricity)
        let perigeeRateRadS = (muKm3S2 * (1 + eccentricity) / perigeeKm).squareRoot() / perigeeKm
        return 1.1 * earthRadiusKm * (perigeeRateRadS + earthRotationRadS)
    }

    /// The furthest the subpoint can be from a station while the satellite is above
    /// `minElevation`, at the highest the orbit gets, erring wide: the osculating
    /// orbit rises above the mean apogee, and a station can sit at the polar radius.
    private func visibilityRadiusKm(_ minElevation: Double) -> Double {
        let apogeeKm = semiMajorAxisKm * (1 + propagator.elements.eccentricity) + 30
        let elevation = minElevation * deg2rad
        return 1.02 * earthRadiusKm * (acos(polarRadiusKm * cos(elevation) / apogeeKm) - elevation)
    }

    /// The stretches of the window where the subpoint is within `radiusKm` of the
    /// station, each with its closest approach: steps of a tenth of an orbit, each
    /// skipped when the ground speed bound proves it stays out of reach.
    private func reachIntervals(_ station: GroundStation, radiusKm: Double, from startMs: Double, to endMs: Double) -> [(start: Double, end: Double, closestMs: Double)] {
        let maxSpeed = maxGroundSpeedKmS
        let distanceAt = { (time: Double) in self.subpointDistanceKm(station, time) }
        let unreachable = { (best: Double, width: Double) in best - (maxSpeed * width) / 1000 > radiusKm }
        let step = scanStepMs

        var reaches: [(start: Double, end: Double, closestMs: Double)] = []
        var t = startMs
        var distanceT = distanceAt(t)
        while t < endMs {
            let next = min(t + step, endMs)
            let distanceNext = distanceAt(next)
            if (distanceT + distanceNext - (maxSpeed * (next - t)) / 1000) / 2 > radiusKm {
                t = next
                distanceT = distanceNext
                continue
            }
            var closest = minimum(distanceAt, t, next, giveUp: unreachable) ?? (next, distanceNext)
            if distanceNext < closest.value {
                closest = (next, distanceNext)
            }
            if distanceT < closest.value {
                closest = (t, distanceT)
            }
            if closest.value > radiusKm {
                t = next
                distanceT = distanceNext
                continue
            }

            // Only the window's start can already be within reach; every other `t` is outside.
            let withinReach = { (time: Double) in distanceAt(time) <= radiusKm }
            let start = distanceT <= radiusKm ? t : crossing(withinReach, outside: t, inside: closest.timeMs).inside
            var end = endMs
            var probe = closest.timeMs
            var gap = max(closest.timeMs - start, 1000)
            while probe < endMs {
                let ahead = min(closest.timeMs + gap, endMs)
                if !withinReach(ahead) {
                    end = crossing(withinReach, outside: ahead, inside: probe).outside
                    break
                }
                probe = ahead
                gap *= 2
            }
            reaches.append((start, end, closest.timeMs))
            t = end
            distanceT = distanceAt(t)
        }
        return reaches
    }

    private func subpointDistanceKm(_ station: GroundStation, _ timeMs: Double) -> Double {
        guard let here = geodetic(at: timeMs) else {
            return .infinity
        }
        return greatCircleKm(here.latitude * deg2rad, here.longitude * deg2rad, station.latitude * deg2rad, station.longitude * deg2rad)
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

/// The minimum of `cost` over `[lo, hi]` by golden-section search, to 10 ms,
/// assuming one minimum there. `giveUp` is asked as the bracket narrows, and ends
/// the search with nil.
private func minimum(
    _ cost: (Double) -> Double, _ lo: Double, _ hi: Double, giveUp: ((_ best: Double, _ width: Double) -> Bool)? = nil
) -> (timeMs: Double, value: Double)? {
    var a = lo
    var b = hi
    var c = b - (b - a) * inversePhi
    var d = a + (b - a) * inversePhi
    var fc = cost(c)
    var fd = cost(d)
    while b - a > passResolutionMs {
        if let giveUp, giveUp(min(fc, fd), b - a) {
            return nil
        }
        if fc < fd {
            b = d
            d = c
            fd = fc
            c = b - (b - a) * inversePhi
            fc = cost(c)
        } else {
            a = c
            c = d
            fc = fd
            d = a + (b - a) * inversePhi
            fd = cost(d)
        }
    }
    return fc < fd ? (c, fc) : (d, fd)
}

/// Bisects to where `isInside` flips, to 10 ms, returning both bounds.
private func crossing(_ isInside: (Double) -> Bool, outside: Double, inside: Double) -> (outside: Double, inside: Double) {
    var outside = outside
    var inside = inside
    while abs(inside - outside) > passResolutionMs {
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
private let polarRadiusKm = 6356.752
private let muKm3S2 = 398600.4418
private let earthRotationRadS = 7.2921159e-5
private let inversePhi = (5.0.squareRoot() - 1) / 2
/// Pass edges and peaks are resolved to this.
private let passResolutionMs = 10.0
private let sideSampleMs = 1000.0
private let bearingSampleMs = 10_000.0
