import CoreGraphics
import SatvisCore
import simd

/// What a frame was drawn from: a tap and the sky view's instruments are
/// answered from the last one, as the user saw it. The draw step sets it once a
/// frame is under way, before the surface selects its tiles by it.
struct DrawnFrame {
    /// The projection times the view, about the eye: it takes a position less
    /// `eye`.
    var viewProjection: simd_double4x4
    /// Earth-fixed, in metres.
    var eye: SIMD3<Double>
    /// The drawable's, in pixels.
    var size: SIMD2<Double>
    /// The instant drawn, in UTC milliseconds since 1970.
    var time: Double
    /// How wide each 3D model was drawn, in points, by satellite: for picking.
    var modelWidths: [Int: Double] = [:]
    /// In 2D, the map camera it was drawn from; `viewProjection` then takes metres
    /// of the map from the view's centre, and `eye` is the globe camera over it.
    var mapCamera: MapCamera?

    /// The frame `pose` draws on a drawable of `size` pixels at `time`.
    init(pose: CameraPose, size: SIMD2<Double>, time: Double, modelWidths: [Int: Double] = [:]) {
        mapCamera = pose.mapCamera
        viewProjection =
            pose.mapCamera?.viewProjection(aspectRatio: size.x / size.y) ?? pose.projection(aspectRatio: size.x / size.y) * pose.view()
        eye = pose.position
        self.size = size
        self.time = time
        self.modelWidths = modelWidths
    }

    /// Where this frame drew a point, on a view `viewSize` points across, in
    /// points; nil behind the camera.
    func screenPoint(_ position: SIMD3<Double>, viewSize: CGSize) -> CGPoint? {
        let clip = viewProjection * SIMD4(mapCamera?.offset(of: position) ?? position - eye, 1)
        guard clip.w > 0 else {
            return nil
        }
        return CGPoint(x: (clip.x / clip.w + 1) / 2 * viewSize.width, y: (1 - clip.y / clip.w) / 2 * viewSize.height)
    }

    /// The ground station or satellite drawn nearest a point on the view, within a
    /// fingertip of it and not behind the Earth. A satellite is its point and its
    /// label (`Picking`), the label as `labels` sizes it while `components` draws
    /// labels. A station's pin wins: it is the larger target, and one the user put
    /// there. `hidden` says whether a satellite at a position is drawn at all.
    func entity(
        at point: CGPoint, viewSize: CGSize, stations: [StationMarker], satellites: some DrawnSatellites, components: SatelliteComponents,
        labels: [LabelInstance]?, hidden: (SIMD3<Double>) -> Bool = { _ in false }
    ) -> String? {
        guard viewSize.width > 0 else {
            return nil
        }
        var best: (id: String, score: Double)?
        for station in stations where mapCamera != nil || isAboveHorizon(station.position, from: eye) {
            // The pin's head, a little over half its height above the spot.
            if let spot = screenPoint(station.position, viewSize: viewSize) {
                let distance = hypot(spot.x - point.x, spot.y - 10 - point.y)
                if distance < Picking.pointReach, distance < best?.score ?? .infinity {
                    best = (station.id, distance)
                }
            }
        }
        if best != nil {
            return best?.id
        }
        guard components.contains(.point) || components.contains(.label) else {
            return nil
        }
        // As Labels.msl places them, in points.
        let labels = components.contains(.label) ? labels : nil
        for index in 0..<satellites.count {
            guard let position = satellites.position(at: index, time: time), mapCamera != nil || !isHiddenByEarth(position, from: eye), !hidden(position),
                let spot = screenPoint(position, viewSize: viewSize)
            else {
                continue
            }
            var label: CGRect?
            let distance = simd.distance(position, eye)
            // On the map at any height, as Shaders/Map.msl draws them.
            if let labels, index < labels.count, mapCamera != nil || (distance > 2000 && distance < 8e7) {
                let size = labels[index].size
                let width = Double(size.x)
                let height = Double(size.y)
                let gap = max(10, (modelWidths[index] ?? 0) / 2 + 4)
                label = CGRect(x: spot.x + gap, y: spot.y - height / 2, width: width, height: height)
            }
            let reach = (modelWidths[index] ?? 0) / 2
            if let score = Picking.score(of: point, point: spot, label: label, reach: reach), score < best?.score ?? .infinity {
                best = (satellites.id(at: index), score)
            }
        }
        return best?.id
    }

    /// Where on the ellipsoid a point on the view lands; nil off the globe.
    func groundPoint(at point: CGPoint, viewSize: CGSize) -> GeoCoordinate? {
        guard viewSize.width > 0, viewSize.height > 0 else {
            return nil
        }
        let ndc = SIMD2(2 * point.x / viewSize.width - 1, 1 - 2 * point.y / viewSize.height)
        if let map = mapCamera {
            // Back through the map's projection, on the ground's depth.
            let ground = viewProjection.inverse * SIMD4(ndc.x, ndc.y, 0.5, 1)
            let latitude = map.latitude + ground.y / MapCamera.radius
            guard abs(latitude) <= .pi / 2 else {
                return nil
            }
            let longitude = remainder(map.longitude + ground.x / MapCamera.radius, 2 * .pi)
            return GeoCoordinate(latitude: latitude * 180 / .pi, longitude: longitude * 180 / .pi)
        }
        let inverse = viewProjection.inverse
        let far = inverse * SIMD4(ndc.x, ndc.y, 0.5, 1)
        let direction = normalize(SIMD3(far.x, far.y, far.z) / far.w)
        // In a frame where the ellipsoid is the unit sphere.
        let origin = eye / ellipsoidRadii
        let scaled = direction / ellipsoidRadii
        let a = dot(scaled, scaled)
        let b = 2 * dot(origin, scaled)
        let c = dot(origin, origin) - 1
        let discriminant = b * b - 4 * a * c
        guard discriminant >= 0 else {
            return nil
        }
        let t = (-b - discriminant.squareRoot()) / (2 * a)
        guard t > 0 else {
            return nil
        }
        let place = geodetic(eye + t * direction)
        return GeoCoordinate(latitude: place.latitude, longitude: place.longitude)
    }

    /// Whether the terrain stands between the eye and a point: the line of sight
    /// is walked out, in steps growing with the distance, until it is higher than
    /// any mountain. `groundHeight` is the ground's in metres at a place, nil where
    /// none is known.
    func groundHides(_ position: SIMD3<Double>, groundHeight: (GeoCoordinate) -> Double?) -> Bool {
        let range = simd.distance(position, eye)
        let direction = (position - eye) / range
        var distance = 5.0
        while distance < range {
            let point = eye + distance * direction
            let height = heightAboveEllipsoid(point)
            if height > 9_000 {
                return false
            }
            let place = geodetic(point)
            if height < groundHeight(GeoCoordinate(latitude: place.latitude, longitude: place.longitude)) ?? 0 {
                return true
            }
            distance += max(10, distance * 0.01)
        }
        return false
    }
}

/// The satellites a frame drew, by their place in the buffers the shaders index:
/// what the queries on a `DrawnFrame` read of them.
protocol DrawnSatellites {
    /// How many were drawn.
    var count: Int { get }
    /// Counts the installs, so what is kept per satellite knows to start over.
    var generation: Int { get }
    /// Its catalog id.
    func id(at index: Int) -> String
    /// Its name.
    func name(at index: Int) -> String
    /// Where it is, by the same interpolation the shader does.
    func position(at index: Int, time: Double) -> SIMD3<Double>?
    /// Where a satellite is in the buffers, by catalog id; nil when not drawn.
    func index(of id: String) -> Int?
}

/// Whether a point on the surface faces the eye.
func isAboveHorizon(_ point: SIMD3<Double>, from eye: SIMD3<Double>) -> Bool {
    dot(point / (ellipsoidRadii * ellipsoidRadii), eye - point) > 0
}

/// Whether the line of sight to a point passes through the Earth, taken as a
/// sphere of its polar radius.
func isHiddenByEarth(_ point: SIMD3<Double>, from eye: SIMD3<Double>) -> Bool {
    let direction = point - eye
    let length = simd.length(direction)
    let unit = direction / length
    let closest = -dot(eye, unit)
    guard closest > 0, closest < length else {
        return false
    }
    return simd.length(eye + closest * unit) < ellipsoidRadii.z
}

/// Metres above the WGS84 ellipsoid along the radius, near enough for a horizon.
func heightAboveEllipsoid(_ p: SIMD3<Double>) -> Double {
    let ellipsoid = 1 / sqrt((p.x * p.x + p.y * p.y) / (ellipsoidRadii.x * ellipsoidRadii.x) + p.z * p.z / (ellipsoidRadii.z * ellipsoidRadii.z))
    return length(p) * (1 - ellipsoid)
}
