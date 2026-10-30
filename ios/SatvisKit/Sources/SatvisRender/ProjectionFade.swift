import Metal

/// The change from the globe to the flat map or back: the last frame drawn in
/// the old projection, kept and faded out over the new for `duration`. The
/// renderer draws one frame more of the old projection to keep, so the fade
/// covers whatever changed it, the landing out of the sky view too.
struct ProjectionFade {
    /// Seconds.
    static let duration = 0.35

    /// `fadeFragment` over the screen.
    let pipeline: MTLRenderPipelineState
    /// The frame kept, and when the fade began, in uptime seconds; nil once it
    /// has gone.
    private var kept: (texture: MTLTexture, start: Double)?

    init(pipeline: MTLRenderPipelineState) {
        self.pipeline = pipeline
    }

    /// Whether a kept frame is still fading out.
    var isFading: Bool { kept != nil }

    /// Keeps a copy of `drawable`, the frame just drawn, which has to be readable,
    /// to fade out from `uptime` on.
    mutating func keep(_ drawable: MTLTexture, commands: MTLCommandBuffer, device: MTLDevice, at uptime: Double) {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: drawable.pixelFormat, width: drawable.width, height: drawable.height, mipmapped: false)
        descriptor.usage = .shaderRead
        descriptor.storageMode = .private
        guard !drawable.isFramebufferOnly, let texture = device.makeTexture(descriptor: descriptor), let blit = commands.makeBlitCommandEncoder() else {
            kept = nil
            return
        }
        blit.copy(from: drawable, to: texture)
        blit.endEncoding()
        kept = (texture, uptime)
    }

    /// The kept frame over `screen`, as faded as it is at `uptime`; let go of once
    /// it has gone. Whether it went now, which the next frame has to show.
    mutating func encode(onto screen: MTLTexture, commands: MTLCommandBuffer, at uptime: Double) -> Bool {
        guard let kept else {
            return false
        }
        let progress = (uptime - kept.start) / Self.duration
        guard progress < 1 else {
            self.kept = nil
            return true
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = screen
        pass.colorAttachments[0].loadAction = .load
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else {
            return false
        }
        var opacity = Float(1 - SkyFlight.ease(max(progress, 0)))
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(kept.texture, index: 0)
        encoder.setFragmentBytes(&opacity, length: MemoryLayout<Float>.size, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        return false
    }
}
