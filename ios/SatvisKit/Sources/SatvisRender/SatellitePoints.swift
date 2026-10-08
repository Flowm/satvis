import Metal
import SatvisCore
import simd

/// One satellite to draw: where it is over its window, what it is called, its
/// colour, and what its sensor covers.
public struct PointSatellite: Sendable {
    /// The catalog entry's identity, which picking and tracking answer with.
    public var id: String
    public var name: String
    public var trajectory: SampledTrajectory
    /// sRGB.
    public var color: SIMD4<Float>
    /// Nil where the web app draws none: for every satellite not in a low orbit.
    public var footprint: Footprint?
    /// Its 3D model's path under the site's /data/models/, as a model manifest
    /// gives it (ADR 0007); nil for the satellites none lists.
    public var modelFile: String?

    public init(id: String, name: String, trajectory: SampledTrajectory, color: SIMD4<Float>, footprint: Footprint? = nil, modelFile: String? = nil) {
        self.id = id
        self.name = name
        self.trajectory = trajectory
        self.color = color
        self.footprint = footprint
        self.modelFile = modelFile
    }
}

/// What a satellite's sensor sees, for its ground track and its sensor cone.
public struct Footprint: Sendable, Hashable {
    /// The ground track's width: both sides of the swath together, in km.
    public var swathKm: Double
    /// The sensor cone's half angle, in degrees.
    public var coneHalfAngleDegrees: Double

    public init(swathKm: Double, coneHalfAngleDegrees: Double) {
        self.swathKm = swathKm
        self.coneHalfAngleDegrees = coneHalfAngleDegrees
    }
}

extension OrbitClass {
    /// The web app's ORBIT_CLASS_COLOR (src/config/orbitClass.ts), in sRGB.
    public var color: SIMD4<Float> {
        switch self {
        case .leo: SIMD4(0xb8, 0xc4, 0xc4, 0xff) / 255
        case .meo: SIMD4(0x56, 0xb4, 0xe9, 0xff) / 255
        case .geo: SIMD4(0xe6, 0x9f, 0x00, 0xff) / 255
        case .heo: SIMD4(0xcc, 0x79, 0xa7, 0xff) / 255
        }
    }
}

/// Mirrors `PointInstance` in Shaders/Points.msl.
struct PointInstance {
    var color: SIMD4<Float>
    var sampleStart: UInt32
    var sampleCount: UInt32
    var stepSeconds: Float
}

/// What finding a satellite's stencil needs of its trajectory, packed with every
/// other satellite's into one array: a frame reads it in order, where reading
/// each trajectory took 41% of the CPU with 16,000 satellites on an iPad mini,
/// most of it waiting on memory.
struct StencilWindow {
    var anchor: Double
    var step: Double
    var firstIndex: Int
    var count: Int
    /// Every node propagated, so no stencil's nodes need checking.
    var isComplete: Bool
}

/// Mirrors `PointFrame` in Shaders/Points.msl.
struct PointFrame {
    var stencilStart: UInt32
    var offset: Float
    var modelPoints: Float = 0
}

/// The satellites ready to draw: their samples and instances in GPU buffers, and
/// their labels. Packed off the main thread (`GlobeRenderer.prepare`), because the
/// samples of ten thousand satellites run to tens of megabytes.
public struct PreparedSatellites: @unchecked Sendable {
    let satellites: [PointSatellite]
    let samples: MTLBuffer?
    let instances: MTLBuffer?
    let labels: (atlas: LabelAtlas, instances: MTLBuffer)?
    /// The sensor cones, for the satellites that have one.
    let cones: (buffer: MTLBuffer, count: Int)?
    /// The satellites with a 3D model, by index: a handful among thousands.
    let modelled: [Int]
    /// Each satellite's, in the same order.
    let windows: [StencilWindow]

    init(_ satellites: [PointSatellite], device: MTLDevice, labelScale: Double) {
        self.satellites = satellites
        modelled = satellites.indices.filter { satellites[$0].modelFile != nil }
        windows = satellites.map {
            let trajectory = $0.trajectory
            return StencilWindow(
                anchor: trajectory.anchorMilliseconds, step: trajectory.stepMilliseconds, firstIndex: trajectory.firstIndex,
                count: trajectory.positions.count, isComplete: trajectory.isComplete)
        }
        let sampleCount = satellites.reduce(0) { $0 + $1.trajectory.positions.count }
        guard sampleCount > 0,
            let samples = device.makeBuffer(length: sampleCount * 3 * MemoryLayout<Float>.stride, options: .storageModeShared),
            let instances = device.makeBuffer(length: satellites.count * MemoryLayout<PointInstance>.stride, options: .storageModeShared)
        else {
            self.samples = nil
            self.instances = nil
            labels = nil
            cones = nil
            return
        }
        // Written in place: no intermediate array of the whole set.
        let floats = samples.contents().bindMemory(to: Float.self, capacity: sampleCount * 3)
        let instanceList = instances.contents().bindMemory(to: PointInstance.self, capacity: satellites.count)
        var next = 0
        for (index, satellite) in satellites.enumerated() {
            let trajectory = satellite.trajectory
            instanceList[index] = PointInstance(
                color: satellite.color, sampleStart: UInt32(next), sampleCount: UInt32(trajectory.positions.count),
                stepSeconds: Float(trajectory.stepMilliseconds / 1000))
            for position in trajectory.positions {
                floats[3 * next] = Float(position.x)
                floats[3 * next + 1] = Float(position.y)
                floats[3 * next + 2] = Float(position.z)
                next += 1
            }
        }
        self.samples = samples
        self.instances = instances
        let coneList = satellites.enumerated().compactMap { index, satellite in
            satellite.footprint.map { ConeInstance(satellite: UInt32(index), halfAngle: Float($0.coneHalfAngleDegrees * .pi / 180)) }
        }
        cones =
            coneList.isEmpty
            ? nil
            : coneList.withUnsafeBytes { bytes in device.makeBuffer(bytes: bytes.baseAddress!, length: bytes.count).map { ($0, coneList.count) } }
        labels =
            satellites.count <= LabelAtlas.maximumLabels
            ? LabelAtlas(names: satellites.map(\.name), scale: labelScale, device: device).flatMap { atlas in
                atlas.instances.withUnsafeBytes { bytes in device.makeBuffer(bytes: bytes.baseAddress!, length: bytes.count).map { (atlas, $0) } }
            } : nil
    }
}

/// The satellites' samples on the GPU, and each frame's stencils for them.
@MainActor
final class SatellitePoints {
    private(set) var prepared: PreparedSatellites?
    private var indexByID: [String: Int] = [:]

    var satellites: [PointSatellite] { prepared?.satellites ?? [] }
    var count: Int { satellites.count }

    func install(_ prepared: PreparedSatellites) {
        self.prepared = prepared
        indexByID = Dictionary(prepared.satellites.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Where each satellite's stencil sits at this instant, written into `buffer`.
    /// A satellite outside its window, or past a refused node, is hidden until
    /// the next refill.
    func writeFrames(at epochMilliseconds: Double, into buffer: MTLBuffer) {
        guard let prepared else {
            return
        }
        Self.writeFrames(
            prepared.windows, satellites: prepared.satellites, at: epochMilliseconds,
            into: buffer.contents().bindMemory(to: PointFrame.self, capacity: prepared.windows.count))
    }

    /// Off the main actor's isolation: in it, Swift checked it was on the main
    /// actor on every turn of this loop, 1.3 ms a frame with 16,000 satellites on
    /// an iPad mini.
    private nonisolated static func writeFrames(
        _ windows: [StencilWindow], satellites: [PointSatellite], at epochMilliseconds: Double, into frames: UnsafeMutablePointer<PointFrame>
    ) {
        for index in windows.indices {
            let window = windows[index]
            // Only a window with a refused node reads its trajectory.
            let stencil =
                window.isComplete
                ? SampledTrajectory.stencil(at: epochMilliseconds, anchor: window.anchor, step: window.step, firstIndex: window.firstIndex, count: window.count)
                : satellites[index].trajectory.stencil(at: epochMilliseconds)
            frames[index] = stencil.map { PointFrame(stencilStart: UInt32($0.start), offset: Float($0.offset)) } ?? PointFrame(stencilStart: 0, offset: -1)
        }
    }

    func satellite(_ id: String) -> PointSatellite? {
        indexByID[id].map { satellites[$0] }
    }

    /// A satellite's place in the buffers the shaders index.
    func index(of id: String) -> Int? {
        indexByID[id]
    }

    /// Where a satellite is, by the same interpolation the shader does.
    func position(of id: String, at epochMilliseconds: Double) -> SIMD3<Double>? {
        indexByID[id].flatMap { satellites[$0].trajectory.position(at: epochMilliseconds) }
    }
}
