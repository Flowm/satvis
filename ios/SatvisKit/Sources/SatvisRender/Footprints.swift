import Foundation
import Metal
import simd

/// Mirrors `ConeInstance` in Shaders/Footprints.msl.
struct ConeInstance {
    var satellite: UInt32
    var halfAngle: Float
}

/// The ground overlay: a cube map around the Earth's centre into which the ground
/// tracks are drawn, for the globe to sample by direction (Shaders/Footprints.msl).
/// About 5 km a texel. Redrawn once a second of the clock, as the web app moves
/// its corridors on a timer, or when the satellites change.
@MainActor
final class GroundOverlay {
    static let size = 2048
    /// The web app's ground track runs from now to five minutes on.
    nonisolated static let spanMilliseconds = 300_000.0
    private static let refreshMilliseconds = 1000.0

    let texture: MTLTexture
    private var drawnAt: Double?
    /// False to begin with: a new texture holds whatever was in its memory, so the
    /// first frame clears it whether or not there is anything to draw.
    private var isEmpty = false
    /// Set when the satellites change, so the next frame draws them.
    var isStale = true

    init?(device: MTLDevice) {
        let descriptor = MTLTextureDescriptor.textureCubeDescriptor(pixelFormat: .r8Unorm, size: Self.size, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        self.texture = texture
    }

    /// Draws the ground tracks into the overlay when they are due, or clears it
    /// once when they are switched off.
    func encode(_ commands: MTLCommandBuffer, pipeline: MTLRenderPipelineState, satellites: [PointSatellite], at now: Double, enabled: Bool, device: MTLDevice) {
        if !enabled {
            if !isEmpty {
                draw(commands, pipeline: pipeline, vertices: nil, count: 0)
                isEmpty = true
            }
            drawnAt = nil
            return
        }
        guard isStale || drawnAt.map({ abs(now - $0) >= Self.refreshMilliseconds }) ?? true else {
            return
        }
        let vertices = Self.corridors(satellites, at: now)
        let buffer = vertices.isEmpty ? nil : vertices.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }
        draw(commands, pipeline: pipeline, vertices: buffer, count: vertices.count)
        isEmpty = vertices.isEmpty
        drawnAt = now
        isStale = false
    }

    func drawForTest(_ commands: MTLCommandBuffer, pipeline: MTLRenderPipelineState, vertices: MTLBuffer, count: Int) {
        draw(commands, pipeline: pipeline, vertices: vertices, count: count)
    }

    private func draw(_ commands: MTLCommandBuffer, pipeline: MTLRenderPipelineState, vertices: MTLBuffer?, count: Int) {
        for face in 0..<6 {
            let pass = MTLRenderPassDescriptor()
            pass.colorAttachments[0].texture = texture
            pass.colorAttachments[0].slice = face
            pass.colorAttachments[0].loadAction = .clear
            pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            pass.colorAttachments[0].storeAction = .store
            guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else {
                continue
            }
            if let vertices, count > 0 {
                var face = UInt32(face)
                encoder.setRenderPipelineState(pipeline)
                encoder.setCullMode(.none)
                encoder.setVertexBuffer(vertices, offset: 0, index: 0)
                encoder.setVertexBytes(&face, length: MemoryLayout<UInt32>.size, index: 1)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: count)
            }
            encoder.endEncoding()
        }
    }

    /// Each satellite's ground track as triangles, in directions from the Earth's
    /// centre: a corridor as wide as its swath along the great circle from its
    /// subpoint now to its subpoint five minutes on.
    nonisolated static func corridors(_ satellites: [PointSatellite], at now: Double) -> [(Float, Float, Float)] {
        var vertices: [(Float, Float, Float)] = []
        for satellite in satellites {
            guard let footprint = satellite.footprint,
                let start = satellite.trajectory.position(at: now),
                let end = satellite.trajectory.position(at: now + spanMilliseconds)
            else {
                continue
            }
            vertices += corridor(from: subpoint(start), to: subpoint(end), widthKm: footprint.swathKm)
        }
        return vertices
    }

    /// A corridor between two points on the ground, as triangles of directions.
    nonisolated static func corridor(from start: SIMD3<Double>, to end: SIMD3<Double>, widthKm: Double, segments: Int = 4) -> [(Float, Float, Float)] {
        let a = normalize(start)
        let b = normalize(end)
        let across = cross(a, b)
        guard length(across) > 1e-9 else {
            return []
        }
        let pole = normalize(across)
        // Half the width as an angle at the mean radius, as the web app's corridor
        // measures it on the ground.
        let halfAngle = widthKm * 500 / 6_371_000
        let angle = acos(min(max(dot(a, b), -1), 1))
        let edges = (0...segments).map { step -> (SIMD3<Double>, SIMD3<Double>) in
            let t = Double(step) / Double(segments)
            let centre = (sin((1 - t) * angle) * a + sin(t * angle) * b) / sin(angle)
            return (centre * cos(halfAngle) + pole * sin(halfAngle), centre * cos(halfAngle) - pole * sin(halfAngle))
        }
        func float(_ v: SIMD3<Double>) -> (Float, Float, Float) { (Float(v.x), Float(v.y), Float(v.z)) }
        var triangles: [(Float, Float, Float)] = []
        for step in 0..<segments {
            let (left, right) = edges[step]
            let (nextLeft, nextRight) = edges[step + 1]
            triangles += [float(left), float(right), float(nextLeft), float(right), float(nextRight), float(nextLeft)]
        }
        return triangles
    }

    /// The point on the ellipsoid below a position, along its geodetic normal.
    nonisolated static func subpoint(_ position: SIMD3<Double>) -> SIMD3<Double> {
        let a = ellipsoidRadii.x
        let e2 = 1 - (ellipsoidRadii.z * ellipsoidRadii.z) / (a * a)
        let p = (position.x * position.x + position.y * position.y).squareRoot()
        var latitude = atan2(position.z, p * (1 - e2))
        for _ in 0..<3 {
            let n = a / (1 - e2 * sin(latitude) * sin(latitude)).squareRoot()
            latitude = atan2(position.z + e2 * n * sin(latitude), p)
        }
        return fixedPosition(latitude: latitude * 180 / .pi, longitude: atan2(position.y, position.x) * 180 / .pi)
    }
}
