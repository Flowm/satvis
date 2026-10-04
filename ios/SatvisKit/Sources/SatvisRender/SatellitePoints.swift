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

/// The satellites' samples on the GPU, and each frame's stencils for them.
@MainActor
final class SatellitePoints {
    private(set) var samples: MTLBuffer?
    private(set) var instances: MTLBuffer?
    private(set) var satellites: [PointSatellite] = []
    private var indexByID: [String: Int] = [:]

    var count: Int { satellites.count }

    func update(_ satellites: [PointSatellite], device: MTLDevice) {
        self.satellites = satellites
        indexByID = Dictionary(satellites.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard !satellites.isEmpty else {
            samples = nil
            instances = nil
            return
        }
        var flat: [Float] = []
        var instanceList: [PointInstance] = []
        for satellite in satellites {
            let trajectory = satellite.trajectory
            instanceList.append(
                PointInstance(
                    color: satellite.color, sampleStart: UInt32(flat.count / 3), sampleCount: UInt32(trajectory.positions.count),
                    stepSeconds: Float(trajectory.stepMilliseconds / 1000)))
            for position in trajectory.positions {
                flat += [Float(position.x), Float(position.y), Float(position.z)]
            }
        }
        samples = device.makeBuffer(bytes: flat, length: flat.count * MemoryLayout<Float>.stride)
        instances = device.makeBuffer(bytes: instanceList, length: instanceList.count * MemoryLayout<PointInstance>.stride)
    }

    /// Where each satellite's stencil sits at this instant. A satellite outside its
    /// window is hidden until the next refill brings it back.
    func frames(at epochMilliseconds: Double) -> [PointFrame] {
        satellites.map { satellite in
            guard let (start, offset) = satellite.trajectory.stencil(at: epochMilliseconds) else {
                return PointFrame(stencilStart: 0, offset: -1)
            }
            return PointFrame(stencilStart: UInt32(start), offset: Float(offset))
        }
    }

    /// Where a satellite is, by the same interpolation the shader does.
    func position(of id: String, at epochMilliseconds: Double) -> SIMD3<Double>? {
        indexByID[id].flatMap { satellites[$0].trajectory.position(at: epochMilliseconds) }
    }
}
