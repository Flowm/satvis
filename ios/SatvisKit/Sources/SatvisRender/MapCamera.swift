import Foundation
import simd

/// The camera over the flat map, the web app's 2D: CesiumJS's SCENE2D, in its
/// geographic projection (plate carrée, x = a·longitude, y = a·latitude, `a` the
/// equatorial radius), seen straight down. The map repeats east and west, so the
/// longitude wraps; the centre stops at the poles. Dragging moves the centre,
/// pinching the span, twisting the heading.
struct MapCamera: Sendable, Equatable {
    /// Radians, geodetic, of the point at the view's centre.
    var latitude: Double
    /// Radians east, of the same point.
    var longitude: Double
    /// Metres of the map across the view's longer side, as the 3D camera's field
    /// of view spans it.
    var span: Double
    /// Radians clockwise from north at the top of the screen, as `OrbitCamera`'s.
    var heading: Double

    /// The projection's radius, CesiumJS's GeographicProjection's: the equatorial.
    static let radius = ellipsoidRadii.x
    /// Metres from the map's west edge to its east: once round the equator.
    static let mapWidth = 2 * Double.pi * radius
    /// As close as the 3D free camera comes: its 100 km above the ground, which
    /// spans what this does across the view's longer side.
    static let minimumSpan = span(atAltitude: OrbitCamera.minimumAltitude)

    init(latitude: Double, longitude: Double, span: Double, heading: Double = 0) {
        self.latitude = latitude
        self.longitude = longitude
        self.span = span
        self.heading = heading
    }

    /// The most the map spans on a view of `aspectRatio` turned by `heading`: its
    /// whole width across the view, the view's bounds measured east to west once
    /// turned. Not further, where CesiumJS lets the map shrink to a stamp: so the view never takes in a point twice, and
    /// what is drawn once, nearest the centre, is never missing from it.
    static func maximumSpan(aspectRatio: Double, heading: Double = 0) -> Double {
        let across = aspectRatio >= 1 ? SIMD2(1, 1 / aspectRatio) : SIMD2(aspectRatio, 1)
        return mapWidth / (abs(cos(heading)) * across.x + abs(sin(heading)) * across.y)
    }

    /// Where 2D opens, as the web app's does: centred on 0°, 0°, five equatorial
    /// radii across the view's width whatever its shape, 287° of longitude, as
    /// CesiumJS's 2D frustum opens.
    static func home(aspectRatio: Double) -> MapCamera {
        MapCamera(latitude: 0, longitude: 0, span: 5 * radius * max(1, 1 / aspectRatio))
    }

    /// Over the place the globe camera looks down on, at the scale its view has
    /// there, so a switch to 2D keeps the place. From where the globe's whole disc
    /// is in sight, the home view, where the web app's morph lands.
    static func matching(_ globe: OrbitCamera, aspectRatio: Double) -> MapCamera {
        let halfNarrow = atan(tan(OrbitCamera.fieldOfView / 2) * min(aspectRatio, 1 / aspectRatio))
        if ellipsoidRadii.x / globe.radius <= sin(halfNarrow) {
            return home(aspectRatio: aspectRatio)
        }
        var map = MapCamera(
            latitude: globe.latitude, longitude: globe.longitude, span: span(atAltitude: globe.altitude), heading: globe.heading)
        map.clamp(aspectRatio: aspectRatio)
        return map
    }

    /// The globe camera over the map's centre at the scale the map has there, no
    /// further than the home view: so a switch back to 3D keeps the place, and the
    /// whole map becomes a globe as large as the home view's.
    func globe(aspectRatio: Double) -> OrbitCamera {
        let altitude = Self.altitude(spanning: span)
        let home = OrbitCamera.home(aspectRatio: aspectRatio).altitude
        return OrbitCamera(
            latitude: latitude, longitude: longitude, altitude: min(max(altitude, OrbitCamera.minimumAltitude), home), heading: heading)
    }

    /// Metres across the view's longer side that a camera `altitude` metres from
    /// what it looks at sees there, through the 3D camera's field of view: the
    /// scale the map and the globe have in common.
    static func span(atAltitude altitude: Double) -> Double {
        2 * altitude * tan(OrbitCamera.fieldOfView / 2)
    }

    /// The distance at which the 3D camera sees `span` metres across, the inverse
    /// of `span(atAltitude:)`.
    static func altitude(spanning span: Double) -> Double {
        span / (2 * tan(OrbitCamera.fieldOfView / 2))
    }

    /// Back inside what the map allows on a view of `aspectRatio`: the longitude
    /// wrapped, the latitude to the poles, the span between its limits.
    mutating func clamp(aspectRatio: Double) {
        longitude = remainder(longitude, 2 * .pi)
        latitude = min(max(latitude, -.pi / 2), .pi / 2)
        span = min(max(span, Self.minimumSpan), Self.maximumSpan(aspectRatio: aspectRatio, heading: heading))
    }

    /// The camera `t` of the way from one to another, eased: the centre in a
    /// straight line on the map, the shorter way round, the span evenly in its
    /// logarithm, the heading the shorter way round.
    static func between(_ from: MapCamera, _ to: MapCamera, t: Double) -> MapCamera {
        let eased = SkyFlight.ease(min(max(t, 0), 1))
        let east = remainder(to.longitude - from.longitude, 2 * .pi)
        let turn = remainder(to.heading - from.heading, 2 * .pi)
        return MapCamera(
            latitude: from.latitude + (to.latitude - from.latitude) * eased,
            longitude: remainder(from.longitude + east * eased, 2 * .pi),
            span: exp(log(from.span) + (log(to.span) - log(from.span)) * eased),
            heading: from.heading + turn * eased)
    }

    /// The screen's right and up on the map, east and north as x and y.
    var screenAxes: (right: SIMD2<Double>, up: SIMD2<Double>) {
        (SIMD2(cos(heading), sin(heading)), SIMD2(-sin(heading), cos(heading)))
    }

    /// Moves the centre so the map follows a drag of `points`, right and down as
    /// UIKit measures them, on a view whose longer side is `longerSide` points.
    mutating func pan(by points: SIMD2<Double>, longerSide: Double) {
        guard points.isFinite, longerSide > 0 else {
            return
        }
        let metresPerPoint = span / longerSide
        let (right, up) = screenAxes
        let moved = (-points.x * right + points.y * up) * metresPerPoint
        longitude = remainder(longitude + moved.x / Self.radius, 2 * .pi)
        latitude = min(max(latitude + moved.y / Self.radius, -.pi / 2), .pi / 2)
    }

    /// Nearer for a scale above 1; held to its limits as each frame is drawn,
    /// which knows the view's shape.
    mutating func zoom(by scale: Double) {
        guard scale.isFinite, scale > 0 else {
            return
        }
        span = min(max(span / scale, Self.minimumSpan), Self.mapWidth * 4)
    }

    /// A twist of `radians` clockwise on the screen turns the map with the fingers.
    mutating func rotate(by radians: Double) {
        guard radians.isFinite else {
            return
        }
        heading += radians
    }

    /// Metres of the map from the view's centre to a place, east and north, the
    /// copy of it nearest the centre: radians in, as the map repeats every
    /// `mapWidth`.
    func offset(latitude: Double, longitude: Double) -> SIMD2<Double> {
        SIMD2(remainder(longitude - self.longitude, 2 * .pi), latitude - self.latitude) * Self.radius
    }

    /// Metres east and north of the view's centre, the copy nearest it, and up from
    /// the ellipsoid, of a point in the fixed frame: as Shaders/Map.msl's
    /// `mapPosition` places it.
    func offset(of position: SIMD3<Double>) -> SIMD3<Double> {
        let place = geodeticPosition(position)
        let offset = offset(latitude: place.latitude, longitude: place.longitude)
        return SIMD3(offset.x, offset.y, place.height)
    }

    /// A tile's place on the map: its north-west corner from the view's centre,
    /// the copy nearest it, and its width and height, in metres.
    func rectangle(of bounds: Bounds) -> (corner: SIMD2<Double>, size: SIMD2<Double>) {
        let corner = offset(latitude: bounds.north * .pi / 180, longitude: bounds.west * .pi / 180)
        return (corner, SIMD2(bounds.east - bounds.west, bounds.north - bounds.south) * .pi / 180 * Self.radius)
    }

    /// A frame at `position` in the fixed frame, its axes the columns of `axes`
    /// scaled by `scale`, taken to the map's east, north and up from the view's
    /// centre: how a 3D model stands on the map, seen from straight above as
    /// CesiumJS draws one in 2D.
    func placement(of axes: simd_double3x3, at position: SIMD3<Double>, scale: Double) -> simd_double4x4 {
        let place = geodeticPosition(position)
        let local = eastNorthUp(latitude: place.latitude, longitude: place.longitude)
        return modelFrame(simd_double3x3(rows: [local.east, local.north, local.up]) * axes, scale: scale, from: offset(of: position))
    }

    /// Metres above a 3D model on the map that the sun's highlight on it is seen
    /// from: straight above, as the map is.
    static let lightingHeight = 1e7

    /// The same frame in the fixed frame, where the sun lights it, from an eye
    /// `lightingHeight` straight above it: the model less the eye, as the globe's
    /// own frame from its eye is.
    static func lighting(of axes: simd_double3x3, at position: SIMD3<Double>, scale: Double) -> simd_double4x4 {
        let place = geodeticPosition(position)
        let above = eastNorthUp(latitude: place.latitude, longitude: place.longitude).up
        return modelFrame(axes, scale: scale, from: -lightingHeight * above)
    }

    /// Half the view's extent east to west and south to north, once turned by the
    /// heading, in metres of the map, on a view of `aspectRatio`.
    func boundingHalfExtent(aspectRatio: Double) -> SIMD2<Double> {
        let half = halfExtent(aspectRatio: aspectRatio)
        let (c, s) = (abs(cos(heading)), abs(sin(heading)))
        return SIMD2(c * half.x + s * half.y, s * half.x + c * half.y)
    }

    /// Half the view's width and height in metres of the map, on a view of `aspectRatio`.
    func halfExtent(aspectRatio: Double) -> SIMD2<Double> {
        let longer = span / 2
        return aspectRatio >= 1 ? SIMD2(longer, longer / aspectRatio) : SIMD2(longer * aspectRatio, longer)
    }

    /// Takes metres of the map from the centre, east, north and up, to clip space:
    /// turned by the heading, orthographic, the ground at depth ½ and higher
    /// nearer, as reversed-Z has it, out to `depthRange` either side.
    func viewProjection(aspectRatio: Double) -> simd_double4x4 {
        let half = halfExtent(aspectRatio: aspectRatio)
        let (right, up) = screenAxes
        return simd_double4x4(
            rows: [
                SIMD4(right.x / half.x, right.y / half.x, 0, 0),
                SIMD4(up.x / half.y, up.y / half.y, 0, 0),
                SIMD4(0, 0, 0.5 / Self.depthRange, 0.5),
                SIMD4(0, 0, 0, 1),
            ])
    }

    /// Metres above and below the map that depth holds: past the Moon, as
    /// Chandra's and TESS's apogees reach 150,000 km and more. A float holds the
    /// depth near the map to 60 m, finer than a 3D model is ever drawn here.
    static let depthRange = 5e8

    /// Half the larger of the view's extents in metres: CesiumJS's camera distance
    /// in 2D, which the globe's lighting fades by.
    var lightingDistance: Double { span / 2 }
}

/// Geodetic latitude and longitude, in radians, and height above the WGS84
/// ellipsoid, of a point anywhere: Bowring's formula, within millimetres out to
/// GEO. Where CesiumJS's 2D places a satellite, as its cartographic position.
func geodeticPosition(_ p: SIMD3<Double>) -> (latitude: Double, longitude: Double, height: Double) {
    let a = ellipsoidRadii.x
    let b = ellipsoidRadii.z
    let e2 = 1 - b * b / (a * a)
    let ep2 = a * a / (b * b) - 1
    let horizontal = (p.x * p.x + p.y * p.y).squareRoot()
    let theta = atan2(p.z * a, horizontal * b)
    let latitude = atan2(p.z + ep2 * b * pow(sin(theta), 3), horizontal - e2 * a * pow(cos(theta), 3))
    let sinLatitude = sin(latitude)
    // Along the normal from the foot of it, which holds at the poles too.
    let height = horizontal * cos(latitude) + p.z * sinLatitude - a * (1 - e2 * sinLatitude * sinLatitude).squareRoot()
    return (latitude, atan2(p.y, p.x), height)
}

/// East, north and up at a geodetic latitude and longitude, in radians, as unit
/// vectors in the fixed frame.
func eastNorthUp(latitude: Double, longitude: Double) -> (east: SIMD3<Double>, north: SIMD3<Double>, up: SIMD3<Double>) {
    let (sinLatitude, cosLatitude) = (sin(latitude), cos(latitude))
    let (sinLongitude, cosLongitude) = (sin(longitude), cos(longitude))
    return (
        SIMD3(-sinLongitude, cosLongitude, 0), SIMD3(-sinLatitude * cosLongitude, -sinLatitude * sinLongitude, cosLatitude),
        SIMD3(cosLatitude * cosLongitude, cosLatitude * sinLongitude, sinLatitude)
    )
}

/// A 3D model's frame: its axes, the columns of `axes`, scaled by `scale`, and
/// its origin `offset` from an eye.
func modelFrame(_ axes: simd_double3x3, scale: Double, from offset: SIMD3<Double>) -> simd_double4x4 {
    simd_double4x4(
        columns: (SIMD4(axes.columns.0 * scale, 0), SIMD4(axes.columns.1 * scale, 0), SIMD4(axes.columns.2 * scale, 0), SIMD4(offset, 1)))
}
