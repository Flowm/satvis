import Metal
import SatvisCore
import simd

/// One satellite to draw: where it is over its window, what it is called, and its
/// colour.
public struct PointSatellite: Sendable {
    /// The catalog entry's identity, which picking and tracking answer with.
    public var id: String
    public var name: String
    public var trajectory: SampledTrajectory
    /// sRGB.
    public var color: SIMD4<Float>

    public init(id: String, name: String, trajectory: SampledTrajectory, color: SIMD4<Float>) {
        self.id = id
        self.name = name
        self.trajectory = trajectory
        self.color = color
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

/// Mirrors `PointFrame` in Shaders/Points.msl.
struct PointFrame {
    var stencilStart: UInt32
    var offset: Float
}

/// The satellites ready to draw: their samples and instances in GPU buffers, and
/// their labels. Packed off the main thread (`GlobeRenderer.prepare`), because the
/// samples of ten thousand satellites run to tens of megabytes.
public struct PreparedSatellites: @unchecked Sendable {
    let satellites: [PointSatellite]
    let samples: MTLBuffer?
    let instances: MTLBuffer?
    let labels: (atlas: LabelAtlas, instances: MTLBuffer)?

    init(_ satellites: [PointSatellite], device: MTLDevice, labelScale: Double) {
        self.satellites = satellites
        let sampleCount = satellites.reduce(0) { $0 + $1.trajectory.positions.count }
        guard sampleCount > 0,
            let samples = device.makeBuffer(length: sampleCount * 3 * MemoryLayout<Float>.stride, options: .storageModeShared),
            let instances = device.makeBuffer(length: satellites.count * MemoryLayout<PointInstance>.stride, options: .storageModeShared)
        else {
            self.samples = nil
            self.instances = nil
            labels = nil
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
        let frames = buffer.contents().bindMemory(to: PointFrame.self, capacity: count)
        for (index, satellite) in satellites.enumerated() {
            if let (start, offset) = satellite.trajectory.stencil(at: epochMilliseconds) {
                frames[index] = PointFrame(stencilStart: UInt32(start), offset: Float(offset))
            } else {
                frames[index] = PointFrame(stencilStart: 0, offset: -1)
            }
        }
    }

    /// Where a satellite is, by the same interpolation the shader does.
    func position(of id: String, at epochMilliseconds: Double) -> SIMD3<Double>? {
        indexByID[id].flatMap { satellites[$0].trajectory.position(at: epochMilliseconds) }
    }
}
