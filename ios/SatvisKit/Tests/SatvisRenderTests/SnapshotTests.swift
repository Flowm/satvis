import Foundation
import ImageIO
import Metal
import Testing

@testable import SatvisRender

/// A bookmark's picture: the frame's BGRA pixels, scaled and encoded.
@Suite struct SnapshotTests {
    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func scalesTheFrameAndKeepsItsColours() throws {
        let device = try #require(MTLCreateSystemDefaultDevice())
        // 8 by 4 pixels, the left half red and the right half blue, in BGRA.
        let (width, height) = (8, 4)
        let buffer = try #require(device.makeBuffer(length: width * height * 4, options: .storageModeShared))
        let pixels = buffer.contents().bindMemory(to: UInt8.self, capacity: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let bgra: [UInt8] = x < width / 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]
                for channel in 0..<4 {
                    pixels[(y * width + x) * 4 + channel] = bgra[channel]
                }
            }
        }
        let jpeg = try #require(Snapshot(buffer: buffer, width: width, height: height).jpeg(width: 4))
        let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        #expect((image.width, image.height) == (4, 2))

        let context = try #require(
            CGContext(
                data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 4, height: 2))
        let rgba = try #require(context.data).bindMemory(to: UInt8.self, capacity: 32)
        // The first pixel red, the last blue, give or take the JPEG.
        #expect(rgba[0] > 200 && rgba[2] < 60)
        #expect(rgba[28] < 60 && rgba[30] > 200)
    }
}
