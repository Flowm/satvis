import Foundation
import SGP4
import Synchronization

/// A position and velocity in the TEME frame SGP4 works in.
public struct TEMEState: Sendable, Hashable {
    /// Kilometres.
    public var position: SIMD3<Double>
    /// Kilometres per second.
    public var velocity: SIMD3<Double>
}

/// Why SGP4 gave no state, by its own error codes.
public enum SGP4Error: Error, Hashable {
    case eccentricityOutOfRange
    case negativeMeanMotion
    case perturbedEccentricityOutOfRange
    case negativeSemiLatusRectum
    case decayed
    case other(Int32)

    init(code: Int32) {
        switch code {
        case 1: self = .eccentricityOutOfRange
        case 2: self = .negativeMeanMotion
        case 3: self = .perturbedEccentricityOutOfRange
        case 4: self = .negativeSemiLatusRectum
        case 6: self = .decayed
        default: self = .other(code)
        }
    }
}

/// One element set, initialised for SGP4 as satellite.js does it: WGS-72, improved
/// mode, the epoch and the time since it by satellite.js's own Julian arithmetic.
/// It may be propagated from any thread: calls take turns on one working copy.
public final class SGP4Propagator: Sendable {
    public let elements: MeanElements
    /// The epoch's Julian date, which the minutes since epoch count from.
    public let epochJulianDate: Double
    /// The mean motion SGP4 recovered, in radians per minute: satellite.js's
    /// `satrec.no` once initialised.
    public var meanMotion: Double { sgp4_mean_motion(satellite) }
    /// satellite.js's `satrec.a`, `alta` and `altp`, in Earth radii.
    public var shape: (semiMajorAxis: Double, apogeeAltitude: Double, perigeeAltitude: Double) {
        let shape = sgp4_shape(satellite)
        return (shape.semiMajorAxis, shape.apogeeAltitude, shape.perigeeAltitude)
    }
    private nonisolated(unsafe) let satellite: OpaquePointer
    /// Propagated in place, so the deep-space integrator of a GEO or Molniya orbit
    /// goes on from where it stopped: with a fresh copy every call it integrated
    /// from the epoch each time. For GOES 19 sampled 120 days past its epoch, 7.1
    /// µs a call against 0.4 in place (a Mac, release build). The states are the
    /// same (`SGP4Bridge.h`).
    private nonisolated(unsafe) let working: OpaquePointer
    private let turn = Mutex(())

    public init(_ elements: MeanElements) throws(SGP4Error) {
        let radiansPerDegree = Double.pi / 180
        // Revolutions per day to radians per minute.
        let xpdotp = 1440.0 / (2.0 * Double.pi)
        self.elements = elements
        epochJulianDate = elements.epoch.julianDate
        let input = SGP4Elements(
            epochDays1950: epochJulianDate - 2433281.5,
            bstar: elements.bstar,
            meanMotionDot: elements.meanMotionDot / (xpdotp * 1440.0),
            meanMotionDDot: elements.meanMotionDDot / (xpdotp * 1440.0 * 1440),
            eccentricity: elements.eccentricity,
            argOfPericenter: elements.argOfPericenter * radiansPerDegree,
            inclination: elements.inclination * radiansPerDegree,
            meanAnomaly: elements.meanAnomaly * radiansPerDegree,
            meanMotion: elements.meanMotion / xpdotp,
            raOfAscNode: elements.raOfAscNode * radiansPerDegree)
        var code: Int32 = 0
        guard let satellite = sgp4_create(input, &code) else {
            throw SGP4Error(code: code)
        }
        self.satellite = satellite
        working = sgp4_copy(satellite)
    }

    deinit {
        sgp4_destroy(working)
        sgp4_destroy(satellite)
    }

    public func state(minutesSinceEpoch: Double) throws(SGP4Error) -> TEMEState {
        var position = SIMD3<Double>()
        var velocity = SIMD3<Double>()
        let code = turn.withLock { _ in
            withUnsafeMutableBytes(of: &position) { position in
                withUnsafeMutableBytes(of: &velocity) { velocity in
                    sgp4_propagate(
                        working, minutesSinceEpoch, position.baseAddress!.assumingMemoryBound(to: Double.self),
                        velocity.baseAddress!.assumingMemoryBound(to: Double.self))
                }
            }
        }
        guard code == 0 else {
            throw SGP4Error(code: code)
        }
        return TEMEState(position: position, velocity: velocity)
    }

    /// The state at a UTC instant, counted from the epoch as satellite.js's
    /// `propagate` counts it. A JavaScript Date holds whole milliseconds, so the
    /// instant should be one.
    public func state(epochMilliseconds: Double) throws(SGP4Error) -> TEMEState {
        let utc = civilDate(epochMilliseconds: epochMilliseconds)
        let julianDate = jday(
            year: utc.year, month: utc.month, day: utc.day, hour: Double(utc.hour), minute: Double(utc.minute), second: Double(utc.second),
            millisecond: Double(utc.millisecond))
        return try state(minutesSinceEpoch: (julianDate - epochJulianDate) * 1440)
    }

    public func state(at date: Date) throws(SGP4Error) -> TEMEState {
        try state(epochMilliseconds: (date.timeIntervalSince1970 * 1000).rounded(.down))
    }
}
