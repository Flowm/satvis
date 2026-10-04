import CoreGraphics
import CoreText
import Foundation
import Metal

/// Mirrors `LabelInstance` in Shaders/Labels.msl.
struct LabelInstance {
    var uvRect: SIMD4<Float>
    var size: SIMD2<Float>
    var satellite: UInt32
}

/// Every label's text drawn once, into one texture: 13-point type in the neutral
/// the LEO point uses, with a 2-point dim grey outline, as the web app's
/// LabelGraphics has it.
struct LabelAtlas {
    /// Past this many satellites the web app switches labels off, and so does this.
    static let maximumLabels = SatelliteComponents.labelBudget

    let texture: MTLTexture
    let instances: [LabelInstance]

    init?(names: [String], scale: Double, device: MTLDevice) {
        let font = CTFontCreateUIFontForLanguage(.system, 13 * scale, nil) ?? CTFontCreateWithName("Helvetica" as CFString, 13 * scale, nil)
        let outline = 2 * scale
        let fill = CGColor(srgbRed: 0xb8 / 255, green: 0xc4 / 255, blue: 0xc4 / 255, alpha: 1)
        let rim = CGColor(srgbRed: 0x69 / 255, green: 0x69 / 255, blue: 0x69 / 255, alpha: 1)
        func line(_ text: String, stroke: Bool) -> CTLine {
            var attributes: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font]
            if stroke {
                attributes[.init(kCTStrokeColorAttributeName as String)] = rim
                attributes[.init(kCTStrokeWidthAttributeName as String)] = outline / (13 * scale) * 100
            } else {
                attributes[.init(kCTForegroundColorAttributeName as String)] = fill
            }
            return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        }

        let ascent = CTFontGetAscent(font)
        let descent = CTFontGetDescent(font)
        let height = Int((ascent + descent + 2 * outline).rounded(.up))
        let width = 2048
        // Shelf packing: left to right, a new row when one fills.
        var frames: [CGRect] = []
        var x = 0
        var y = 0
        for name in names {
            let textWidth = Int((CTLineGetTypographicBounds(line(name, stroke: false), nil, nil, nil) + 2 * outline).rounded(.up))
            let labelWidth = min(textWidth, width)
            if x + labelWidth > width {
                x = 0
                y += height
            }
            frames.append(CGRect(x: x, y: y, width: labelWidth, height: height))
            x += labelWidth
        }
        let atlasHeight = max(y + height, 1)
        let bitmap = Bitmap(width: width, height: atlasHeight, alpha: true) { context in
            // Core Graphics counts rows from the bottom; the frames count from the top.
            context.textMatrix = .identity
            // Round, as Cesium strokes its labels: a mitred outline throws spikes
            // off the sharp corners of an M or a V, long enough to reach the next
            // name in the atlas.
            context.setLineJoin(.round)
            for (name, frame) in zip(names, frames) {
                let baseline = CGFloat(atlasHeight) - frame.minY - outline - ascent
                for stroke in [true, false] {
                    context.textPosition = CGPoint(x: frame.minX + outline, y: baseline)
                    CTLineDraw(line(name, stroke: stroke), context)
                }
            }
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: atlasHeight, mipmapped: false)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        bitmap.bytes.withUnsafeBytes {
            texture.replace(region: MTLRegionMake2D(0, 0, width, atlasHeight), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: width * 4)
        }
        self.texture = texture
        instances = frames.enumerated().map { index, frame in
            LabelInstance(
                uvRect: SIMD4(
                    Float(frame.minX) / Float(width), Float(frame.minY) / Float(atlasHeight), Float(frame.maxX) / Float(width), Float(frame.maxY) / Float(atlasHeight)),
                size: SIMD2(Float(frame.width), Float(frame.height)), satellite: UInt32(index))
        }
    }
}
