// Puts a caption above each App Store screenshot: the screenshot, scaled down,
// below a headline on the launch screen's colour, at the screenshot's own size,
// which is the size App Store Connect accepts.
//
//   swift scripts/caption.swift <in> <out> <name> <caption> [<name> <caption>]...
//
// writes <out>/<file> for every <in>/<file> named "<device> - <name>.png".
import AppKit
import ImageIO
import UniformTypeIdentifiers

/// LaunchBackground in Assets.xcassets, the logo's background.
let background = CGColor(srgbRed: 0x0B / 255, green: 0x22 / 255, blue: 0x2D / 255, alpha: 1)

/// The screenshot's share of the image's width and height.
let scale: CGFloat = 0.8
/// The margin below the screenshot, as a share of the image's height.
let bottomMargin: CGFloat = 0.03

/// The display's outline in `frame`, its corner radii as shares of its width:
/// about 55 pt of an iPhone's 402 and 18 pt of an iPad's 1032. An iPhone Duo's
/// cover display, 1398 pixels across, has 59 pt of its 466 on the right and 8 pt
/// along the hinge; its inner one, lying down, 55 pt of 951.
func outline(_ frame: CGRect, pixelWidth: Int) -> CGPath {
    let (left, right): (CGFloat, CGFloat) =
        switch pixelWidth {
        case 1398: (8.0 / 466, 59.0 / 466)
        case 2853: (55.0 / 951, 55.0 / 951)
        default: frame.height / frame.width > 1.8 ? (0.137, 0.137) : (0.0174, 0.0174)
        }
    let path = CGMutablePath()
    path.move(to: CGPoint(x: frame.midX, y: frame.minY))
    path.addArc(tangent1End: CGPoint(x: frame.maxX, y: frame.minY), tangent2End: CGPoint(x: frame.maxX, y: frame.maxY), radius: right * frame.width)
    path.addArc(tangent1End: CGPoint(x: frame.maxX, y: frame.maxY), tangent2End: CGPoint(x: frame.minX, y: frame.maxY), radius: right * frame.width)
    path.addArc(tangent1End: CGPoint(x: frame.minX, y: frame.maxY), tangent2End: CGPoint(x: frame.minX, y: frame.minY), radius: left * frame.width)
    path.addArc(tangent1End: CGPoint(x: frame.minX, y: frame.minY), tangent2End: CGPoint(x: frame.midX, y: frame.minY), radius: left * frame.width)
    path.closeSubpath()
    return path
}

/// App Store sizes XCUIScreen falls a pixel short of each way: it takes an
/// iPhone Duo's inner display at 2006 by 2852.
let fullSizes = [(2007, 2853), (2853, 2007)]

/// Draws `text` above the screenshot at `input` and writes the result to `output`.
func caption(_ input: URL, _ text: String, to output: URL) throws {
    // Turned upright by its orientation tag, which the iPhone Duo's inner
    // display's carries.
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let stored = properties[kCGImagePropertyPixelWidth] as? Int, let storedHeight = properties[kCGImagePropertyPixelHeight] as? Int,
        let shot = CGImageSourceCreateThumbnailAtIndex(
            source, 0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(stored, storedHeight),
            ] as CFDictionary)
    else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: input.path]) }
    let (pixelWidth, pixelHeight) =
        fullSizes.first { $0.0 - shot.width == 1 && $0.1 - shot.height == 1 } ?? (shot.width, shot.height)
    let width = CGFloat(pixelWidth)
    let height = CGFloat(pixelHeight)

    // No alpha channel: App Store Connect rejects one.
    let context = CGContext(
        data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.interpolationQuality = .high
    context.setFillColor(background)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    let frame = CGRect(x: width * (1 - scale) / 2, y: height * bottomMargin, width: width * scale, height: height * scale)
    let screen = outline(frame, pixelWidth: pixelWidth)
    context.saveGState()
    context.setShadow(offset: .zero, blur: width * 0.04, color: CGColor(gray: 0, alpha: 0.6))
    context.addPath(screen)
    context.fillPath()
    context.restoreGState()
    context.saveGState()
    context.addPath(screen)
    context.clip()
    context.draw(shot, in: frame)
    context.restoreGState()
    context.addPath(screen)
    context.setStrokeColor(CGColor(gray: 1, alpha: 0.18))
    context.setLineWidth(width * 0.003)
    context.strokePath()

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let headline = NSAttributedString(
        string: text,
        attributes: [
            .font: NSFont.systemFont(ofSize: height * 0.034, weight: .bold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ])
    let band = CGRect(x: width * 0.08, y: frame.maxY, width: width * 0.84, height: height - frame.maxY)
    let framesetter = CTFramesetterCreateWithAttributedString(headline)
    let fit = CTFramesetterSuggestFrameSizeWithConstraints(framesetter, CFRange(), nil, band.size, nil)
    let box = CGRect(x: band.minX, y: band.midY - fit.height / 2, width: band.width, height: ceil(fit.height))
    CTFrameDraw(CTFramesetterCreateFrame(framesetter, CFRange(), CGPath(rect: box, transform: nil), nil), context)

    guard let image = context.makeImage(),
        let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: output.path]) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: output.path])
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 4, arguments.count % 2 == 0 else {
    FileHandle.standardError.write("usage: caption.swift <in> <out> <name> <caption> [<name> <caption>]...\n".data(using: .utf8)!)
    exit(2)
}
let input = URL(fileURLWithPath: arguments[0])
let output = URL(fileURLWithPath: arguments[1])
let captions = stride(from: 2, to: arguments.count, by: 2).map { (name: arguments[$0], text: arguments[$0 + 1]) }
let files = try FileManager.default.contentsOfDirectory(atPath: input.path)
for (name, text) in captions {
    let matching = files.filter { $0.hasSuffix(" - \(name).png") }
    guard !matching.isEmpty else {
        FileHandle.standardError.write("No screenshot named \(name)\n".data(using: .utf8)!)
        exit(1)
    }
    for file in matching {
        try caption(input.appendingPathComponent(file), text, to: output.appendingPathComponent(file))
    }
}
