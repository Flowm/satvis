import Foundation
import SatvisCore
import simd

// Where the camera watches a satellite's swath from (ADR 0023): the chase that
// tracking takes while the recorded swath is on, the broadcast camera of an overpass
// replay, and the views a replay flies to and back from. The web app's
// src/modules/ReplayCamera.ts.

/// A view the camera can fly back to (`GlobeRenderer.currentView`): the free camera
/// over the globe, and on the map the map's.
public struct CameraView: Sendable, Equatable {
    /// The free camera over the globe; on the map, the one over the map's place.
    let globe: OrbitCamera
    /// The free camera over the map, where the view was taken on it.
    let map: MapCamera?

    /// Straight down on a place, in degrees, north up, from `height` metres above
    /// the ellipsoid.
    static func over(latitude: Double, longitude: Double, height: Double) -> CameraView {
        let ground = fixedPosition(latitude: latitude, longitude: longitude)
        let up = eastNorthUp(latitude: latitude * .pi / 180, longitude: longitude * .pi / 180).up
        // OrbitCamera's altitude is above a sphere of the equatorial radius.
        let altitude = length(ground + height * up) - ellipsoidRadii.x
        return CameraView(
            globe: OrbitCamera(
                latitude: latitude * .pi / 180, longitude: longitude * .pi / 180,
                altitude: min(max(altitude, OrbitCamera.minimumAltitude), OrbitCamera.maximumAltitude)),
            map: nil)
    }
}

/// A swath's width bounded to what a camera distance scales with, in metres: Landsat's
/// 185 km and VIIRS's 3,000 km.
func swathScale(km: Double) -> Double {
    min(max(km, 600), 3000) * 1000
}

/// The chase: tracking a satellite whose recorded swath is on, from behind it and
/// above, looking down at the ground under it.
enum Chase {
    /// The angle below the horizontal, onto the ground under the satellite.
    static let pitch = 50 * Double.pi / 180
    /// The most the satellite may sit above the chase's aim: NOAA-20's 12°, inside
    /// the 14° half of the field of view a 21:9 screen has up.
    static let maximumTilt = 12 * Double.pi / 180

    /// Metres from the ground under the satellite: the swath's, or further where the
    /// satellite would sit more than `maximumTilt` above the ground under it.
    static func range(swathKm: Double, altitude: Double) -> Double {
        let keepsSatelliteInView = altitude / (sin(pitch) - cos(pitch) * tan(pitch - maximumTilt))
        return max(0.8 * swathScale(km: swathKm) + 700_000, keepsSatelliteInView)
    }

    /// The eye from the satellite in `TrackingCamera.axes`, in metres: along its
    /// motion, the orbit's normal and up.
    static func offset(swathKm: Double, altitude: Double) -> SIMD3<Double> {
        let range = range(swathKm: swathKm, altitude: altitude)
        return SIMD3(-range * cos(pitch), 0, range * sin(pitch) - altitude)
    }

    /// Radians the chase looks down past the satellite, at the ground under it.
    static func tilt(swathKm: Double, altitude: Double) -> Double {
        let range = range(swathKm: swathKm, altitude: altitude)
        return pitch - atan2(range * sin(pitch) - altitude, range * cos(pitch))
    }
}

extension TrackingCamera {
    /// The chase of a satellite `altitude` metres up whose swath is `swathKm` across.
    static func chase(swathKm: Double, altitude: Double) -> TrackingCamera {
        let offset = Chase.offset(swathKm: swathKm, altitude: altitude)
        var camera = TrackingCamera()
        // Back along the x axis.
        camera.heading = -.pi / 2
        camera.pitch = atan2(offset.z, -offset.x)
        camera.range = length(offset)
        camera.tilt = Chase.tilt(swathKm: swathKm, altitude: altitude)
        return camera
    }
}

extension OrbitCamera {
    /// Over the place `pose` looks at on the ellipsoid, as far from it as the eye,
    /// the screen's up kept: the free camera a held pose leaves behind, which can
    /// only look straight down. Over the point under the eye where it looks past
    /// the Earth.
    static func facing(_ pose: CameraPose) -> OrbitCamera {
        let eye = pose.position
        let direction = -pose.back
        // In a frame where the ellipsoid is the unit sphere.
        let (origin, scaled) = (eye / ellipsoidRadii, direction / ellipsoidRadii)
        let (a, b, c) = (dot(scaled, scaled), 2 * dot(origin, scaled), dot(origin, origin) - 1)
        let discriminant = b * b - 4 * a * c
        let t = discriminant >= 0 ? (-b - discriminant.squareRoot()) / (2 * a) : -1
        let place = geodeticPosition(t > 0 ? eye + t * direction : eye)
        let altitude = t > 0 ? t : place.height
        let (east, north, _) = eastNorthUp(latitude: place.latitude, longitude: place.longitude)
        // Up the screen once looking straight down: its up, or where it looks level, ahead.
        let screenUp = pose.up - pose.back
        return OrbitCamera(
            latitude: place.latitude, longitude: place.longitude,
            altitude: min(max(altitude, minimumAltitude), maximumAltitude), heading: atan2(-dot(screenUp, east), dot(screenUp, north)))
    }
}

/// A camera held beyond a ground station on its side of a satellite's ground track,
/// turning each frame to keep the satellite in view as it passes, the web app's
/// `BroadcastCamera`. It swings in from the pose it started from.
struct BroadcastCamera {
    /// What it follows: a satellite's id.
    let satellite: String
    /// Where it is held, in the fixed frame.
    let eye: SIMD3<Double>
    /// The ellipsoid's normal under the eye, which the view is kept level to.
    let eyeUp: SIMD3<Double>
    /// The pose it swings in from, and the uptime it set off, while it swings.
    var swing: (from: CameraPose, start: Double)?
    /// The last pose aimed, held while the satellite has no place.
    private var held: CameraPose?

    /// Metres above the station.
    static let height = 1_800_000.0
    /// How far up from the ground under the satellite it aims, as a share of the
    /// satellite's height: the satellite and its fresh swath both in view.
    static let aimHeightShare = 0.15
    /// Seconds the swing in takes, as every replay camera's: `PoseFlight.duration`.
    static let swingDuration = PoseFlight.duration

    /// Beyond `station` from the ground track of `satellite`, whose swath is
    /// `swathKm` across, as `position` places it at a time in UTC milliseconds at
    /// `now`. Nil where it has no place then, or is held still.
    init?(satellite: String, station: GroundPoint, swathKm: Double, now: Double, position: (Double) -> SIMD3<Double>?) {
        guard let track = Self.groundTrack(now: now, position: position) else {
            return nil
        }
        self.satellite = satellite
        let stationPoint = fixedPosition(latitude: station.latitude, longitude: station.longitude)
        let stationUp = eastNorthUp(latitude: station.latitude * .pi / 180, longitude: station.longitude * .pi / 180).up
        // Beyond the station, so it sits in the foreground with the track behind it.
        let side: Double = dot(stationPoint - track.ground, track.right) < 0 ? -1 : 1
        eye = stationPoint + track.right * side * (swathScale(km: swathKm) / 2 + 900_000) + stationUp * Self.height
        let place = geodeticPosition(eye)
        eyeUp = eastNorthUp(latitude: place.latitude, longitude: place.longitude).up
    }

    /// The ground track under the satellite at `now`: the ground point, its up, the
    /// track's starboard and the satellite's height. Nil where the satellite has no
    /// place, or barely moves: its samples do not reach the clock yet.
    static func groundTrack(now: Double, position: (Double) -> SIMD3<Double>?) -> (
        ground: SIMD3<Double>, up: SIMD3<Double>, right: SIMD3<Double>, altitude: Double
    )? {
        guard let here = position(now), let later = position(now + 1000) else {
            return nil
        }
        let place = geodeticPosition(here)
        let ground = fixedPosition(latitude: place.latitude * 180 / .pi, longitude: place.longitude * 180 / .pi)
        let up = eastNorthUp(latitude: place.latitude, longitude: place.longitude).up
        let velocity = later - here
        guard length(velocity) >= 1 else {
            return nil
        }
        let forward = normalize(velocity - dot(velocity, up) * up)
        return (ground, up, normalize(cross(forward, up)), distance(here, ground))
    }

    /// The pose at `uptime` with the clock at `now`, partway through any swing in;
    /// the last one while the satellite has no place, nil before it has had one.
    mutating func pose(uptime: Double, time now: Double, position: (Double) -> SIMD3<Double>?) -> CameraPose? {
        if let track = Self.groundTrack(now: now, position: position) {
            let aim = track.ground + track.up * track.altitude * Self.aimHeightShare
            let direction = normalize(aim - eye)
            let right = normalize(cross(direction, eyeUp))
            held = CameraPose(position: eye, right: right, up: cross(right, direction), back: -direction)
        }
        guard var pose = held else {
            return nil
        }
        if let swing {
            let t = (uptime - swing.start) / Self.swingDuration
            if t < 1 {
                // The whole turn at once: blending direction and up apart whips the roll round where they cross.
                let eased = SkyFlight.ease(t)
                let basis = simd_double3x3(simd_slerp(SkyFlight.attitude(swing.from), SkyFlight.attitude(pose), eased).normalized)
                pose = CameraPose(
                    position: swing.from.position + (eye - swing.from.position) * eased, right: basis.columns.0, up: basis.columns.1,
                    back: basis.columns.2)
            } else {
                self.swing = nil
            }
        }
        return pose
    }
}
