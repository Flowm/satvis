import CoreGraphics
import Foundation
import ImageIO
import Metal

/// Decoded RGBA rows, top row first, ready for a texture.
struct Bitmap: Sendable {
    var width: Int
    var height: Int
    var bytes: [UInt8]

    /// `alpha` keeps a premultiplied alpha channel, for text drawn over nothing.
    init(width: Int, height: Int, alpha: Bool = false, draw: (CGContext) -> Void) {
        self.width = width
        self.height = height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: (alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue)!
            draw(context)
        }
        self.bytes = bytes
    }
}

enum Textures {
    private static func image(_ url: URL) -> CGImage? {
        CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    }

    /// Natural Earth II at level 2 of its geodetic tile pyramid, stitched into one
    /// equirectangular image with north at the top: 8 × 4 tiles of 256 px.
    static func naturalEarth() -> Bitmap? {
        guard let root = Bundle.module.url(forResource: "NaturalEarthII", withExtension: nil) else {
            return nil
        }
        let tile = 256
        var missing = false
        let bitmap = Bitmap(width: 8 * tile, height: 4 * tile) { context in
            for x in 0..<8 {
                for y in 0..<4 {
                    // TMS counts rows from the south, as Core Graphics does.
                    guard let image = image(root.appending(path: "2/\(x)/\(y).webp")) else {
                        missing = true
                        continue
                    }
                    context.draw(image, in: CGRect(x: x * tile, y: y * tile, width: tile, height: tile))
                }
            }
        }
        return missing ? nil : bitmap
    }

    /// A sky box's six faces, encoded, in Metal's cube order (+X, −X, +Y, −Y, +Z,
    /// −Z), which is the order WebGL takes them in too. Nil unless all six decode
    /// to squares of one size.
    ///
    /// Each face goes in upside down, bottom row first, because that is how
    /// CesiumJS uploads a cube map (`CubeMap`'s `flipY` defaults to true) and so how
    /// every Cesium sky box, satvis's included, is drawn. Upright, the faces meet
    /// at visible seams.
    static func cubeFaces(_ encoded: [Data]) -> [Bitmap]? {
        let images = encoded.compactMap { CGImageSourceCreateWithData($0 as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) } }
        guard images.count == 6, let size = images.first?.width, images.allSatisfy({ $0.width == size && $0.height == size }) else {
            return nil
        }
        return images.map { face in
            Bitmap(width: size, height: size) { context in
                context.translateBy(x: 0, y: CGFloat(size))
                context.scaleBy(x: 1, y: -1)
                context.draw(face, in: CGRect(x: 0, y: 0, width: size, height: size))
            }
        }
    }

    static func texture2D(_ bitmap: Bitmap, device: MTLDevice, queue: MTLCommandQueue) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: bitmap.width, height: bitmap.height, mipmapped: true)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        bitmap.bytes.withUnsafeBytes {
            texture.replace(region: MTLRegionMake2D(0, 0, bitmap.width, bitmap.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: bitmap.width * 4)
        }
        generateMipmaps(texture, queue: queue)
        return texture
    }

    static func textureCube(_ faces: [Bitmap], device: MTLDevice, queue: MTLCommandQueue) -> MTLTexture? {
        guard let size = faces.first?.width else {
            return nil
        }
        let descriptor = MTLTextureDescriptor.textureCubeDescriptor(pixelFormat: .rgba8Unorm, size: size, mipmapped: true)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        for (slice, face) in faces.enumerated() {
            face.bytes.withUnsafeBytes {
                texture.replace(
                    region: MTLRegionMake2D(0, 0, size, size), mipmapLevel: 0, slice: slice, withBytes: $0.baseAddress!, bytesPerRow: size * 4,
                    bytesPerImage: size * size * 4)
            }
        }
        generateMipmaps(texture, queue: queue)
        return texture
    }

    private static func generateMipmaps(_ texture: MTLTexture, queue: MTLCommandQueue) {
        guard let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder() else {
            return
        }
        blit.generateMipmaps(for: texture)
        blit.endEncoding()
        commands.commit()
    }
}
