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

/// Draws `text` above the screenshot at `input` and writes the result to `output`.
func caption(_ input: URL, _ text: String, to output: URL) throws {
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
        let shot = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: input.path]) }
    let width = CGFloat(shot.width)
    let height = CGFloat(shot.height)

    // No alpha channel: App Store Connect rejects one.
    let context = CGContext(
        data: nil, width: shot.width, height: shot.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.interpolationQuality = .high
    context.setFillColor(background)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // The display's corner radius: about 55 pt of an iPhone's 402, 18 pt of an iPad's 1032.
    let frame = CGRect(x: width * (1 - scale) / 2, y: height * bottomMargin, width: width * scale, height: height * scale)
    let radius = frame.width * (height / width > 1.8 ? 0.137 : 0.0174)
    let screen = CGPath(roundedRect: frame, cornerWidth: radius, cornerHeight: radius, transform: nil)
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
