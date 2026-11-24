import CoreGraphics
import Foundation
import Metal
import SatvisCore
import simd

// Granules replayed behind the clock (ADR 0023), as the web app's GranuleLayers.ts draws
// them: where the satellite that sensed one is drawn, it fills in behind the scan line of
// the ground track fan, and once passed shows its outline, and its picture where it keeps
// one. The globe's and the map's tile fragments draw them (Shaders/Granules.msl), each
// granule's outline laid out in the gnomonic projection about its middle, where its
// edges, great circles, are straight.

/// A granule's picture, cut from its provider's frame to its outline.
public struct GranulePicture: @unchecked Sendable, Equatable {
    public var image: CGImage
    /// Degrees (plate carrée) when `projection` is nil; metres east and north of the pole
    /// in `projection`'s plane otherwise. A plate carrée box across the antimeridian runs
    /// past 180° east.
    public var bounds: SatelliteDetails.PreviewBounds
    public var projection: PolarProjection?

    public init(image: CGImage, bounds: SatelliteDetails.PreviewBounds, projection: PolarProjection? = nil) {
        self.image = image
        self.bounds = bounds
        self.projection = projection
    }

    /// The same image, not an equal one: a texture is made once an image.
    public static func == (a: GranulePicture, b: GranulePicture) -> Bool {
        a.image === b.image && a.bounds == b.bounds && a.projection == b.projection
    }
}

/// One granule on the globe.
public struct GranuleDrawing: Sendable, Equatable {
    /// Whether its provider has its pixels: not known yet, known and pictured, or known
    /// to have none, which greys it.
    public enum State: Sendable { case waiting, pictured, missing }

    /// Stable across calls: the granule's key and its layer's.
    public var id: String
    /// The `PointSatellite.id` of the satellite that sensed it, where that is drawn.
    public var satellite: String?
    /// Epoch milliseconds.
    public var start: Double
    public var end: Double
    /// A closed ring, which may cross the antimeridian, with no cut round a pole.
    public var outline: [GroundPoint]
    public var state: State
    public var picture: GranulePicture?
    /// False: once passed, no fill, as for a GIBS granule whose own tiles take its place.
    public var keepsFill: Bool

    public init(
        id: String, satellite: String?, start: Double, end: Double, outline: [GroundPoint], state: State, picture: GranulePicture? = nil, keepsFill: Bool = true
    ) {
        self.id = id
        self.satellite = satellite
        self.start = start
        self.end = end
        self.outline = outline
        self.state = state
        self.picture = picture
        self.keepsFill = keepsFill
    }
}

/// Mirrors `GranuleShape` in Shaders/Granules.msl: one granule as a frame draws it.
struct GranuleShape {
    /// The gnomonic projection's middle, a unit vector, and in w the cosine of the
    /// angle within which the granule and its outline lie.
    var centre: SIMD4<Float>
    /// Its axes; east's w is the picture's pole (0 for plate carrée, else
    /// `PolarProjection.pole`), north's w its `PolarProjection.radiusScale`.
    var east: SIMD4<Float>
    var north: SIMD4<Float>
    /// The scan plane's normal ahead, and in w its offset from the centre of the Earth:
    /// what lies ahead of it is not filled yet. Zero fills it whole.
    var scan: SIMD4<Float>
    /// The picture's west, south, east and north: radians, or metres of the polar plane.
    var bounds: SIMD4<Float>
    /// sRGB and alpha; a zero alpha draws none.
    var tint: SIMD4<Float>
    var outline: SIMD4<Float>
    /// Its picture's slot in the frame's pictures, or -1.
    var picture: Int32
    var cornerStart: UInt32
    var cornerCount: UInt32
    var padding: UInt32 = 0
}

/// Mirrors `FanInstance` in Shaders/Granules.msl.
struct FanInstance {
    var satellite: UInt32
    var starboardKm: Float
    var portKm: Float
}

/// A granule's outline in the gnomonic projection about its middle, from the Earth's
/// centre onto the plane tangent there: great circles project to straight lines, so
/// its edges are straight, and a granule across the antimeridian or round a pole has
/// no seam.
struct GnomonicOutline {
    /// Radians the cap round the outline is widened by, for an outline drawn as wide
    /// as 64 km of ground: two pixels of the whole globe on a phone.
    static let margin = 0.01
    /// Radians past which the cap is too wide to project: the plane goes to infinity at 90°.
    static let widest = 80 * Double.pi / 180
    /// The most corners a granule keeps; CMR's are four or five.
    static let mostCorners = 256

    let centre: SIMD3<Double>
    let east: SIMD3<Double>
    let north: SIMD3<Double>
    /// The cosine of the angle from `centre` within which the outline lies, widened by `margin`.
    let cosRadius: Double
    /// The corners on the plane, the ring left open.
    let corners: [SIMD2<Double>]
    /// The corners on the ellipsoid, the ring left open, which the scan plane sweeps.
    let ground: [SIMD3<Double>]

    /// Nil for fewer than three corners, or a granule too wide to project.
    init?(_ outline: [GroundPoint]) {
        // A corner repeated would make an edge of no length, which has no direction.
        var points = outline.enumerated().filter { $0.offset == 0 || $0.element != outline[$0.offset - 1] }.map(\.element)
        if points.count > 1, points.first == points.last {
            points.removeLast()
        }
        guard points.count >= 3, points.count <= Self.mostCorners else {
            return nil
        }
        let ground = points.map { fixedPosition(latitude: $0.latitude, longitude: $0.longitude) }
        let directions = ground.map(normalize)
        let sum = directions.reduce(SIMD3<Double>(), +)
        guard length(sum) > 1e-9 else {
            return nil
        }
        let centre = normalize(sum)
        let reference = abs(centre.z) < 0.99 ? SIMD3<Double>(0, 0, 1) : SIMD3<Double>(1, 0, 0)
        let east = normalize(cross(reference, centre))
        let north = cross(centre, east)
        let angle = directions.map { acos(min(max(dot($0, centre), -1), 1)) }.max() ?? 0
        guard angle + Self.margin < Self.widest else {
            return nil
        }
        self.centre = centre
        self.east = east
        self.north = north
        self.ground = ground
        cosRadius = cos(angle + Self.margin)
        corners = directions.map { SIMD2(dot($0, east), dot($0, north)) / dot($0, centre) }
    }

    /// Where a direction from the Earth's centre lands on the plane; nil outside the cap.
    func project(_ direction: SIMD3<Double>) -> SIMD2<Double>? {
        let unit = normalize(direction)
        let c = dot(unit, centre)
        guard c >= cosRadius else {
            return nil
        }
        return SIMD2(dot(unit, east), dot(unit, north)) / c
    }

    /// Whether the granule covers the ground in `direction` from the Earth's centre,
    /// by the even-odd rule, as the shaders find it.
    func contains(_ direction: SIMD3<Double>) -> Bool {
        guard let point = project(direction) else {
            return false
        }
        var inside = false
        for (index, a) in corners.enumerated() {
            let b = corners[(index + 1) % corners.count]
            if (a.y > point.y) != (b.y > point.y), point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
        }
        return inside
    }
}

/// The ground track fan's axes at a satellite, as the web app's `fanFrame` finds them
/// with no roll: down its geodetic normal, starboard level across the way its subpoint
/// goes, and ahead along it.
struct FanAxes {
    let position: SIMD3<Double>
    let down: SIMD3<Double>
    let starboard: SIMD3<Double>
    let ahead: SIMD3<Double>

    /// From the satellite's place now and a second on; nil where its subpoint stays.
    init?(position: SIMD3<Double>, next: SIMD3<Double>) {
        let here = GroundOverlay.subpoint(position)
        let tangent = GroundOverlay.subpoint(next) - here
        guard length_squared(tangent) >= 1, length(here - position) > 0 else {
            return nil
        }
        let up = normalize(here / (ellipsoidRadii * ellipsoidRadii))
        let down = normalize(here - position)
        var starboard = cross(tangent, up)
        starboard -= down * dot(starboard, down)
        guard length(starboard) > 0 else {
            return nil
        }
        self.position = position
        self.down = down
        self.starboard = normalize(starboard)
        ahead = cross(self.starboard, down)
    }

    /// Where the fan meets the ground across the track, port edge to starboard edge, at
    /// `steps` + 1 points; a ray that misses the ground stops at the fan's reach.
    func groundLine(_ swath: SwathExtents, steps: Int) -> [SIMD3<Double>] {
        let subpoint = GroundOverlay.subpoint(position)
        let earthRadius = length(subpoint)
        let altitude = length(position) - earthRadius
        let starboardAngle = Self.nadirAngle(groundMeters: swath.starboardKm * 1000, altitude: altitude, earthRadius: earthRadius)
        let portAngle = Self.nadirAngle(groundMeters: swath.portKm * 1000, altitude: altitude, earthRadius: earthRadius)
        let reach = Self.reach(swath, altitude: altitude, earthRadius: earthRadius)
        return (0...steps).map { step in
            let angle = -portAngle + (starboardAngle + portAngle) * Double(step) / Double(steps)
            let direction = cos(angle) * down + sin(angle) * starboard
            return position + direction * min(Self.distanceToGround(from: position, along: direction) ?? reach, reach)
        }
    }

    /// Metres from `camera` to the nearest of the fan reaching `swath`'s edges.
    func distance(from camera: SIMD3<Double>, swath: SwathExtents) -> Double {
        let line = groundLine(swath, steps: 8)
        return zip(line, line.dropFirst()).map { Self.triangleDistance(camera, position, $0, $1) }.min() ?? simd.distance(camera, position)
    }

    /// Metres from `p` to the triangle `a`, `b`, `c`: Ericson's closest point on a
    /// triangle, by the region of the plane it falls in.
    static func triangleDistance(_ p: SIMD3<Double>, _ a: SIMD3<Double>, _ b: SIMD3<Double>, _ c: SIMD3<Double>) -> Double {
        let (ab, ac, ap) = (b - a, c - a, p - a)
        let (d1, d2) = (dot(ab, ap), dot(ac, ap))
        if d1 <= 0, d2 <= 0 {
            return simd.distance(p, a)
        }
        let bp = p - b
        let (d3, d4) = (dot(ab, bp), dot(ac, bp))
        if d3 >= 0, d4 <= d3 {
            return simd.distance(p, b)
        }
        let vc = d1 * d4 - d3 * d2
        if vc <= 0, d1 >= 0, d3 <= 0 {
            return simd.distance(p, a + ab * (d1 / (d1 - d3)))
        }
        let cp = p - c
        let (d5, d6) = (dot(ab, cp), dot(ac, cp))
        if d6 >= 0, d5 <= d6 {
            return simd.distance(p, c)
        }
        let vb = d5 * d2 - d1 * d6
        if vb <= 0, d2 >= 0, d6 <= 0 {
            return simd.distance(p, a + ac * (d2 / (d2 - d6)))
        }
        let va = d3 * d6 - d5 * d4
        if va <= 0, d4 - d3 >= 0, d5 - d6 >= 0 {
            return simd.distance(p, b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))))
        }
        let denominator = va + vb + vc
        guard denominator != 0 else {
            return min(simd.distance(p, a), simd.distance(p, b), simd.distance(p, c))
        }
        return simd.distance(p, a + ab * (vb / denominator) + ac * (vc / denominator))
    }

    /// Radians off nadir at which a sensor `altitude` over a sphere of `earthRadius`
    /// sees the ground `groundMeters` away along it: the web app's `nadirAngle`.
    static func nadirAngle(groundMeters: Double, altitude: Double, earthRadius: Double) -> Double {
        let central = groundMeters / earthRadius
        return atan2(earthRadius * sin(central), earthRadius + altitude - earthRadius * cos(central))
    }

    /// Metres from the satellite the fan's sides reach: past its farther edge's slant
    /// range by a fifth, as the web app's `FAN_REACH`.
    static func reach(_ swath: SwathExtents, altitude: Double, earthRadius: Double) -> Double {
        let central = max(swath.starboardKm, swath.portKm) * 1000 / earthRadius
        let orbitRadius = earthRadius + altitude
        return 1.2 * (earthRadius * earthRadius + orbitRadius * orbitRadius - 2 * earthRadius * orbitRadius * cos(central)).squareRoot()
    }

    /// Metres from `origin` along the unit `direction` to the ellipsoid; nil where it misses.
    static func distanceToGround(from origin: SIMD3<Double>, along direction: SIMD3<Double>) -> Double? {
        let o = origin / ellipsoidRadii
        let d = direction / ellipsoidRadii
        let (a, b, c) = (dot(d, d), 2 * dot(d, o), dot(o, o) - 1)
        let det = b * b - 4 * a * c
        guard det >= 0 else {
            return nil
        }
        let near = (-b - det.squareRoot()) / (2 * a)
        return near > 0 ? near : nil
    }
}

/// The plane of the ground track fan through the satellite, which a granule is sensed
/// behind (the web app's `scanPlane`).
struct ScanPlane: Equatable {
    var point: SIMD3<Double>
    /// Unit, along the track.
    var ahead: SIMD3<Double>

    /// From the satellite's place now and a second on; nil where its subpoint stays.
    init?(position: SIMD3<Double>, next: SIMD3<Double>) {
        guard let axes = FanAxes(position: position, next: next) else {
            return nil
        }
        point = position
        ahead = axes.ahead
    }

    /// Whether `point` lies behind it, swept already.
    func isBehind(_ point: SIMD3<Double>) -> Bool {
        dot(point - self.point, ahead) < 0
    }
}

/// Where a granule stands at an instant: not begun, being swept by its satellite's
/// scan line, or passed.
enum GranuleStage: Equatable {
    case before
    case sweeping(ScanPlane)
    case passed

    /// How far past its end a granule may still be swept, in milliseconds: an element
    /// set 30 days old places NOAA-20 up to 17 s off its granules, and past it the
    /// scan plane, through the Earth, turns back toward it (`SENSING_SLACK_MS`).
    static let slack = 120_000.0

    /// Where `granule` stands at `time` (epoch milliseconds), its satellite's scan
    /// plane then `plane`, nil where it is not drawn: without one, passed once begun.
    init(start: Double, end: Double, corners: [SIMD3<Double>], time: Double, plane: ScanPlane?) {
        guard let plane, time <= end + Self.slack else {
            self = time >= start ? .passed : .before
            return
        }
        self = corners.allSatisfy(plane.isBehind) ? .passed : .sweeping(plane)
    }
}

/// What one frame draws of the granules: their shapes, corners and pictures for the
/// tile fragments, and the caps that say which tiles they reach.
@MainActor
struct GranuleFrame {
    /// The most granules one tile draws, the newest.
    static let perTile = 64

    let shapes: MTLBuffer
    let corners: MTLBuffer
    /// `GranulePictures` in Shaders/Granules.msl: the textures' resource ids.
    let pictures: MTLBuffer
    /// What `pictures` names, which the encoder has to make resident.
    let textures: [MTLTexture]
    /// Each shape's cap, as a unit vector and the cosine of its angle.
    let caps: [(centre: SIMD3<Double>, angle: Double)]

    /// The shapes over `tile`, newest last, after their count: what the tile
    /// fragment reads; empty where none is.
    func granules(over tile: Surface.Tile) -> [UInt32] {
        let centre = normalize(tile.centre)
        let tileAngle = tile.radius >= 2 * ellipsoidRadii.z ? Double.pi : 2 * asin(tile.radius / (2 * ellipsoidRadii.z))
        var over: [UInt32] = []
        for (index, cap) in caps.enumerated().reversed() where acos(min(max(dot(centre, cap.centre), -1), 1)) <= tileAngle + cap.angle {
            over.append(UInt32(index))
            if over.count == Self.perTile {
                break
            }
        }
        return over.isEmpty ? [] : [UInt32(over.count)] + over.reversed()
    }
}

/// The granules on the globe, and the ground track fans: what is set, the pictures'
/// textures, and each frame's shapes.
@MainActor
final class GranuleOverlay {
    /// The most granules drawn, the newest: a 50-minute trail of HLS scenes is 60.
    static let capacity = 256
    /// Mirrors `granulePictureSlots` in Shaders/Granules.msl: the newest pictures
    /// drawn, the rest tinted.
    static let pictureSlots = 64

    /// The web app's colours: the outline, and the fill before its picture or without one.
    static let outlineColor = SIMD4<Float>(0xff, 0xd5, 0x4a, 0.9 * 255) / 255
    static let missingOutlineColor = SIMD4<Float>(0x9e, 0x9e, 0x9e, 0.7 * 255) / 255
    static let tint = SIMD4<Float>(0xff, 0xd5, 0x4a, 0.35 * 255) / 255
    static let missingTint = SIMD4<Float>(0x9e, 0x9e, 0x9e, 0.35 * 255) / 255

    private struct Entry {
        var drawing: GranuleDrawing
        var outline: GnomonicOutline
        var cornerStart: Int
    }

    /// A picture's texture, made off the main thread; the image is kept so its identity is.
    private struct Picture {
        let image: CGImage
        var texture: MTLTexture?
    }

    private let device: MTLDevice
    private let queue: MTLCommandQueue
    /// Oldest first.
    private var entries: [Entry] = []
    private var corners: MTLBuffer?
    private var textures: [ObjectIdentifier: Picture] = [:]
    /// The satellites whose fan is drawn whatever the component.
    private var fans: Set<String> = []
    private var fanInstances: (generation: Int, enabled: Bool, buffer: MTLBuffer?, count: Int, indices: Set<Int>)?
    /// Counts what was set and the pictures made, for the frame that draws them.
    private(set) var revision = 0

    var isEmpty: Bool { entries.isEmpty }

    init(device: MTLDevice, queue: MTLCommandQueue) {
        self.device = device
        self.queue = queue
    }

    /// The granules to draw, and the satellites whose fan is drawn with the component off.
    func set(_ granules: [GranuleDrawing], fans: Set<String>) {
        var previous: [String: Entry] = [:]
        for entry in entries {
            previous[entry.drawing.id] = entry
        }
        let sorted = granules.enumerated().sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }.map(\.element).suffix(Self.capacity)
        var next: [Entry] = []
        var points: [SIMD2<Float>] = []
        for drawing in sorted {
            let old = previous[drawing.id]
            guard let outline = old?.drawing.outline == drawing.outline ? old?.outline : GnomonicOutline(drawing.outline) else {
                continue
            }
            next.append(Entry(drawing: drawing, outline: outline, cornerStart: points.count))
            points += outline.corners.map(SIMD2<Float>.init)
        }
        entries = next
        corners = points.isEmpty ? nil : device.makeBuffer(copying: points)
        keepPictures()
        if fans != self.fans {
            self.fans = fans
            fanInstances = nil
        }
        revision += 1
    }

    /// Makes the textures of the pictures drawn, and drops the rest.
    private func keepPictures() {
        var wanted: [ObjectIdentifier: GranulePicture] = [:]
        for entry in entries where entry.drawing.state == .pictured {
            if let picture = entry.drawing.picture {
                wanted[ObjectIdentifier(picture.image)] = picture
            }
        }
        textures = textures.filter { wanted[$0.key] != nil }
        for (key, picture) in wanted where textures[key] == nil {
            textures[key] = Picture(image: picture.image)
            Task.detached(priority: .userInitiated) { [weak self] in
                let image = picture.image
                let bitmap = Bitmap(width: image.width, height: image.height) { $0.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height)) }
                await MainActor.run {
                    guard let self, self.textures[key]?.image === image else {
                        return
                    }
                    self.textures[key]?.texture = Textures.texture2D(bitmap, device: self.device, queue: self.queue)
                    self.revision += 1
                }
            }
        }
    }

    /// The satellites a granule may be swept by around `time`: their scan lines move
    /// over the ground as fast as their fans' do.
    func sweepers(at time: Double, points: SatellitePoints) -> Set<Int> {
        Set(
            entries.compactMap { entry in
                let drawing = entry.drawing
                guard let id = drawing.satellite, time >= drawing.start - GranuleStage.slack, time <= drawing.end + GranuleStage.slack else {
                    return nil
                }
                return points.index(of: id)
            })
    }

    /// The fans to draw: every satellite with a footprint while `enabled`, those set
    /// to have one otherwise. Their indices too, for the pacing.
    func fans(points: SatellitePoints, enabled: Bool) -> (buffer: MTLBuffer?, count: Int, indices: Set<Int>) {
        if let cached = fanInstances, cached.generation == points.generation, cached.enabled == enabled {
            return (cached.buffer, cached.count, cached.indices)
        }
        let instances = points.satellites.enumerated().compactMap { index, satellite -> FanInstance? in
            guard let footprint = satellite.footprint, enabled || fans.contains(satellite.id) else {
                return nil
            }
            return FanInstance(satellite: UInt32(index), starboardKm: Float(footprint.swath.starboardKm), portKm: Float(footprint.swath.portKm))
        }
        let buffer = instances.isEmpty ? nil : device.makeBuffer(copying: instances)
        let indices = Set(instances.map { Int($0.satellite) })
        fanInstances = (points.generation, enabled, buffer, instances.count, indices)
        return (buffer, instances.count, indices)
    }

    /// What the frame at `time` draws of the granules; nil where it draws none.
    func frame(at time: Double, points: SatellitePoints) -> GranuleFrame? {
        guard !entries.isEmpty, let corners else {
            return nil
        }
        var planes: [String: ScanPlane?] = [:]
        func plane(_ id: String?) -> ScanPlane? {
            guard let id else {
                return nil
            }
            if let known = planes[id] {
                return known
            }
            let found = points.index(of: id).flatMap { index -> ScanPlane? in
                let trajectory = points.satellites[index].trajectory
                guard let now = trajectory.position(at: time), let next = trajectory.position(at: time + 1000) else {
                    return nil
                }
                return ScanPlane(position: now, next: next)
            }
            planes[id] = found
            return found
        }
        let staged = entries.map { entry in
            (entry, GranuleStage(start: entry.drawing.start, end: entry.drawing.end, corners: entry.outline.ground, time: time, plane: plane(entry.drawing.satellite)))
        }
        // The newest pictures drawn get the slots.
        var slots: [ObjectIdentifier: Int32] = [:]
        var textures: [MTLTexture] = []
        for (entry, stage) in staged.reversed() where stage != .before && slots.count < Self.pictureSlots {
            guard entry.drawing.state == .pictured, let image = entry.drawing.picture?.image, let texture = self.textures[ObjectIdentifier(image)]?.texture,
                slots[ObjectIdentifier(image)] == nil
            else {
                continue
            }
            slots[ObjectIdentifier(image)] = Int32(textures.count)
            textures.append(texture)
        }
        var shapes: [GranuleShape] = []
        var caps: [(centre: SIMD3<Double>, angle: Double)] = []
        for (entry, stage) in staged {
            guard let shape = Self.shape(entry.drawing, outline: entry.outline, cornerStart: entry.cornerStart, stage: stage, slot: { slots[$0] }) else {
                continue
            }
            shapes.append(shape)
            caps.append((entry.outline.centre, acos(entry.outline.cosRadius)))
        }
        guard !shapes.isEmpty, let shapeBuffer = device.makeBuffer(copying: shapes),
            let pictures = device.makeBuffer(length: Self.pictureSlots * MemoryLayout<MTLResourceID>.stride, options: .storageModeShared)
        else {
            return nil
        }
        let ids = pictures.contents().bindMemory(to: MTLResourceID.self, capacity: Self.pictureSlots)
        for (slot, texture) in textures.enumerated() {
            ids[slot] = texture.gpuResourceID
        }
        return GranuleFrame(shapes: shapeBuffer, corners: corners, pictures: pictures, textures: textures, caps: caps)
    }

    /// How `drawing` is drawn at `stage`, its picture in the slot `slot` gives; nil
    /// where nothing of it is. Before it is passed, the fill behind the scan line:
    /// the picture, or the tint until it comes or where there is none. Once passed,
    /// the outline, and the picture or the tint where it keeps its fill.
    static func shape(
        _ drawing: GranuleDrawing, outline: GnomonicOutline, cornerStart: Int, stage: GranuleStage, slot: (ObjectIdentifier) -> Int32?
    ) -> GranuleShape? {
        let picture = drawing.state == .pictured ? drawing.picture : nil
        var pictureSlot = picture.flatMap { slot(ObjectIdentifier($0.image)) } ?? -1
        var scan = SIMD4<Float>()
        var outlineColor = SIMD4<Float>()
        switch stage {
        case .before:
            return nil
        case .sweeping(let plane):
            scan = SIMD4(SIMD3<Float>(plane.ahead), Float(dot(plane.point, plane.ahead)))
        case .passed:
            outlineColor = drawing.state == .missing ? Self.missingOutlineColor : Self.outlineColor
            if !drawing.keepsFill {
                pictureSlot = -1
            }
        }
        let tint = drawing.state == .missing ? Self.missingTint : Self.tint
        let fill = pictureSlot >= 0 || (stage == .passed && !drawing.keepsFill) ? SIMD4<Float>() : tint
        var bounds = SIMD4<Float>()
        var pole: Float = 0
        var polarScale: Float = 0
        if let picture, pictureSlot >= 0 {
            let b = picture.bounds
            if let projection = picture.projection {
                bounds = SIMD4(Float(b.west), Float(b.south), Float(b.east), Float(b.north))
                pole = Float(projection.pole)
                polarScale = Float(projection.radiusScale)
            } else {
                bounds = SIMD4(Float(b.west), Float(b.south), Float(b.east), Float(b.north)) * .pi / 180
            }
        }
        guard pictureSlot >= 0 || fill.w > 0 || outlineColor.w > 0 else {
            return nil
        }
        return GranuleShape(
            centre: SIMD4(SIMD3<Float>(outline.centre), Float(outline.cosRadius)), east: SIMD4(SIMD3<Float>(outline.east), pole),
            north: SIMD4(SIMD3<Float>(outline.north), polarScale), scan: scan, bounds: bounds, tint: fill, outline: outlineColor, picture: pictureSlot,
            cornerStart: UInt32(cornerStart), cornerCount: UInt32(outline.corners.count))
    }
}
