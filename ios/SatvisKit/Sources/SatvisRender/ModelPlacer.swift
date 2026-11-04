import SatvisCore
import simd

/// A 3D model where it is drawn this frame.
struct ModelPlacement {
    var index: Int
    var model: PreparedModel
    /// The model's frame to the eye's, scaled: metres from the eye. On the map,
    /// to the map's east, north and up from the view's centre.
    var toEye: simd_double4x4
    /// The same in the fixed frame, which the sun lights it in: on the map,
    /// seen from straight above (`MapCamera.lighting`).
    var lightingToEye: simd_double4x4
    var rotation: simd_float3x3
    /// How wide its bounding sphere is drawn, in points.
    var points: Double
    /// How the sky view draws it, 1 as usual.
    var opacity: Float
}

/// Where each modelled satellite's 3D model is drawn, and which of its copies.
@MainActor
struct ModelPlacer {
    /// The level each modelled satellite with copies is drawn at, by its id: 0 its
    /// file, `i + 1` its copy `i` (ADR 0007). Kept across frames for the hysteresis.
    private(set) var levels: [String: Int] = [:]

    /// Forgets every level: models switched off come back from their coarsest
    /// copies, as on the web.
    mutating func reset() {
        levels = [:]
    }

    /// Forgets the levels of the satellites no longer in `prepared`, by the index it
    /// built off the main thread: a set of 16,000 ids here was the kind of cost
    /// `prepare` takes off it.
    mutating func keep(_ prepared: PreparedSatellites) {
        levels = levels.filter { prepared.indexByID[$0.key] != nil }
    }

    /// Each modelled satellite's model where it is, its glTF +Z along the velocity
    /// and +Y up from the ellipsoid, as CesiumJS's VelocityOrientationProperty
    /// turns it. At its real size in metres where that is large enough, else
    /// scaled up to the web app's smallest size on screen
    /// (`modelMinimumPixelSize`), but no further than that size at the home
    /// view's distance, so it shrinks with the globe beyond it. A model not
    /// loaded yet is asked for, and has no place until it lands; one the sky view
    /// hides has none either. `tracked` is the id followed, whose model is drawn
    /// from its file.
    mutating func placements(
        of prepared: PreparedSatellites?, models: SatelliteModels, pose: CameraPose, size: SIMD2<Double>, pixelScale: Double, now: Double, tracked: String?,
        judgement: SkyJudgement?
    ) -> [ModelPlacement] {
        guard let prepared, !prepared.modelled.isEmpty else {
            return []
        }
        let aspectRatio = size.x / size.y
        let heightPoints = size.y / pixelScale
        let longerPoints = max(size.x, size.y) / pixelScale
        let tangent = tan(pose.verticalFieldOfView(aspectRatio: aspectRatio) / 2)
        // On the map, no larger than at the zoom-out limit, the whole map across.
        let homeMetresPerPoint =
            pose.mapCamera != nil
            ? MapCamera.maximumSpan(aspectRatio: aspectRatio) / longerPoints : 2 * OrbitCamera.home(aspectRatio: aspectRatio).radius * tangent / heightPoints
        return prepared.modelled.compactMap { index in
            let satellite = prepared.satellites[index]
            guard let satelliteModel = satellite.model, let position = satellite.trajectory.position(at: now),
                let before = satellite.trajectory.position(at: now - 1000), let after = satellite.trajectory.position(at: now + 1000)
            else {
                return nil
            }
            let metresPerPoint = pose.mapCamera.map { $0.span / longerPoints } ?? 2 * simd.distance(position, pose.position) * tangent / heightPoints
            // How large the model is drawn: its scale, and its bounding sphere's diameter in points.
            func size(of model: PreparedModel) -> (scale: Double, points: Double) {
                let diameter = 2 * Double(model.radius)
                let minimum = Self.modelMinimumPoints(diameter: diameter)
                let scale = min(max(1, minimum * metresPerPoint / diameter), minimum * homeMetresPerPoint / diameter)
                return (scale, diameter * scale / metresPerPoint)
            }
            // The file, then its copies (ADR 0007).
            let files = satelliteModel.files
            var level = 0
            if files.count > 1 {
                level = Self.chooseModelLevel(
                    current: levels[satellite.id], lods: satelliteModel.lods, tracked: tracked == satellite.id,
                    failed: { models.failed(files[$0]) }, points: { models.model(files[$0]).map { size(of: $0).points } },
                    loaded: { models.model(files[$0]) != nil })
                levels[satellite.id] = level
            }
            guard let model = models.model(files[level]) else {
                return nil
            }
            let opacity = judgement?.opacity(of: position, from: pose.position) ?? 1
            guard opacity > 0 else {
                return nil
            }
            let forward = normalize(after - before)
            let surfaceUp = normalize(position / (ellipsoidRadii * ellipsoidRadii))
            let port = normalize(cross(surfaceUp, forward))
            let up = cross(forward, port)
            let (scale, drawnPoints) = size(of: model)
            let axes = simd_double3x3(columns: (port, up, forward))
            let toEye = modelFrame(axes, scale: scale, from: position - pose.position)
            var placement = ModelPlacement(
                index: index, model: model, toEye: toEye, lightingToEye: toEye,
                rotation: simd_float3x3(columns: (SIMD3<Float>(port), SIMD3<Float>(up), SIMD3<Float>(forward))),
                points: drawnPoints, opacity: Float(opacity))
            if let map = pose.mapCamera {
                // On the map, east, north and up from where it is, seen from
                // straight above, as CesiumJS draws a model in 2D.
                placement.toEye = map.placement(of: axes, at: position, scale: scale)
                placement.lightingToEye = MapCamera.lighting(of: axes, at: position, scale: scale)
            }
            return placement
        }
    }

    /// The level a satellite with copies is drawn at this frame, 0 its file and `i + 1`
    /// its copy `i`, from the level drawn last, else the coarsest. A copy that cannot
    /// load gives way to the next finer level; then the file while tracked, else the
    /// level the drawn one's size asks for, once that has loaded. `points` is nil for a
    /// level not loaded; `loaded` asks for the level it is given.
    static func chooseModelLevel(
        current: Int?, lods: [ModelLod], tracked: Bool, failed: (Int) -> Bool, points: (Int) -> Double?, loaded: (Int) -> Bool
    ) -> Int {
        var level = min(current ?? lods.count, lods.count)
        while level > 0, failed(level) {
            level -= 1
        }
        guard let drawn = points(level) else {
            return level
        }
        let wanted = tracked ? 0 : ModelLevel.level(diameter: drawn, current: level, lods: lods)
        return wanted != level && !failed(wanted) && loaded(wanted) ? wanted : level
    }

    /// The web app's smallest size for a model on screen, by its bounding sphere's
    /// diameter in metres: a cubesat at 20 points, Landsat at 55, the ISS at 72.
    nonisolated static func modelMinimumPoints(diameter: Double) -> Double {
        min(72, max(20, 23 * cbrt(diameter)))
    }
}
