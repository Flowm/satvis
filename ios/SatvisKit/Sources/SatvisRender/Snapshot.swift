import CoreGraphics
import Foundation
import ImageIO
import Metal
import QuartzCore
import UniformTypeIdentifiers

/// A small picture of the frame on screen, for a bookmark's card (the web app's
/// `src/modules/util/thumbnail.ts`). The drawable is read only for the frame asked
/// for: a view whose drawables can be read cannot keep them in tile memory.
struct Snapshot: @unchecked Sendable {
    /// The frame's BGRA pixels: written by the GPU, then read once, after the
    /// command buffer has completed.
    let buffer: MTLBuffer
    let width: Int
    let height: Int

    /// Copies `texture`, a BGRA drawable, into a buffer the CPU can read, in `commands`.
    static func encodeCopy(of texture: MTLTexture, into commands: MTLCommandBuffer, device: MTLDevice) -> Snapshot? {
        let bytesPerRow = texture.width * 4
        guard texture.pixelFormat == .bgra8Unorm, let buffer = device.makeBuffer(length: bytesPerRow * texture.height, options: .storageModeShared),
            let blit = commands.makeBlitCommandEncoder()
        else {
            return nil
        }
        blit.copy(
            from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: texture.width, height: texture.height, depth: 1), to: buffer, destinationOffset: 0,
            destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerRow * texture.height)
        blit.endEncoding()
        return Snapshot(buffer: buffer, width: texture.width, height: texture.height)
    }

    /// The copied frame scaled to `width` pixels across, as a JPEG.
    func jpeg(width: Int) -> Data? {
        let (sourceWidth, sourceHeight) = (self.width, self.height)
        let bytesPerRow = sourceWidth * 4
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        // BGRA in memory: little-endian ARGB, the alpha ignored.
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
        let bytes = Data(bytes: buffer.contents(), count: bytesPerRow * sourceHeight)
        guard let provider = CGDataProvider(data: bytes as CFData),
            let frame = CGImage(
                width: sourceWidth, height: sourceHeight, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: info), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else {
            return nil
        }
        let height = max(1, Int((Double(sourceHeight) * Double(width) / Double(sourceWidth)).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info) else {
            return nil
        }
        context.interpolationQuality = .high
        context.draw(frame, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else {
            return nil
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

/// The picture asked of the next frame that can be read, and who waits for it.
@MainActor
final class SnapshotRequests {
    /// Its width in pixels, and who waits for it.
    private var request: (id: Int, width: Int, continuation: CheckedContinuation<Data?, Never>)?
    private var count = 0

    /// Whether a picture is waited for: the next frame is drawn, and its
    /// drawable can be read.
    var isWaiting: Bool { request != nil }

    /// The next frame as a JPEG `width` pixels across; nil where none comes within
    /// two seconds, as in the background. One asked for before is given nil.
    func next(width: Int) async -> Data? {
        count += 1
        let id = count
        return await withCheckedContinuation { continuation in
            request?.continuation.resume(returning: nil)
            request = (id, width, continuation)
            Task {
                try? await Task.sleep(for: .seconds(2))
                finish(id, nil)
            }
        }
    }

    private func finish(_ id: Int, _ data: Data?) {
        guard let request, request.id == id else {
            return
        }
        self.request = nil
        request.continuation.resume(returning: data)
    }

    /// A copy of the drawable for the picture asked for, where it can be read.
    func encode(of drawable: CAMetalDrawable, into commands: MTLCommandBuffer, device: MTLDevice) {
        // Taken off as it is queued: the frames already in flight would copy it again.
        if let request, !drawable.texture.isFramebufferOnly,
            let copy = Snapshot.encodeCopy(of: drawable.texture, into: commands, device: device)
        {
            self.request = nil
            commands.addCompletedHandler { _ in
                request.continuation.resume(returning: copy.jpeg(width: request.width))
            }
        }
    }
}
