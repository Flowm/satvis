import CoreGraphics
import CoreText
import Foundation
import Metal
import Synchronization

/// Mirrors `LabelGlyph` in Shaders/Labels.msl: the outline or the fill of one
/// glyph of one satellite's name.
struct LabelGlyph {
    /// Its outline's cell in the atlas; its fill's is the same, half the atlas lower.
    var uvRect: SIMD4<Float>
    /// Its cell beside the satellite, in points: x from the label's left end, y up
    /// from its middle, then width and height.
    var rect: SIMD4<Float>
    var satellite: UInt32
    /// 1 for the fill.
    var fill: UInt32 = 0
}

/// The satellites' names as the shaders draw them, a quad per glyph cut from an
/// atlas of the glyphs they use: 13-point type in the neutral the LEO point uses,
/// with a 2-point dim grey outline, as the web app's LabelGraphics has it. A label's
/// outlines are drawn before its fills, as Core Text strokes a whole line before
/// filling it, so a glyph's outline never covers its neighbour's text; and a whole
/// label before the next, so where two overlap, the later one covers the other.
struct LabelText {
    let texture: MTLTexture
    let glyphs: MTLBuffer?
    let glyphCount: Int
    /// Each satellite's label, in points, in the satellites' order: what a tap reaches.
    let sizes: [SIMD2<Float>]

    init?(names: [String], scale: Double, device: MTLDevice) {
        let font = LabelFont.at(scale: scale)
        guard let (atlas, layouts) = font.atlas(for: names, device: device) else {
            return nil
        }
        let height = font.labelHeight
        // The baseline, up from the label's middle, as Core Text set it a line's
        // outline below the top.
        let baseline = height / 2 - font.outline - font.ascent
        var glyphs: [LabelGlyph] = []
        var sizes: [SIMD2<Float>] = []
        sizes.reserveCapacity(names.count)
        let atlasWidth = Float(atlas.width)
        let atlasHeight = Float(2 * atlas.height)
        for (index, layout) in layouts.enumerated() {
            sizes.append(SIMD2(Float((layout.width + 2 * font.outline) / scale), Float(height / scale)))
            let first = glyphs.count
            for glyph in layout.glyphs {
                guard let cell = atlas.cells[glyph.key] else {
                    continue
                }
                let x = font.outline + glyph.origin.x + cell.bounds.minX
                let y = baseline + glyph.origin.y + cell.bounds.minY
                glyphs.append(
                    LabelGlyph(
                        uvRect: SIMD4(
                            Float(cell.frame.minX) / atlasWidth, Float(cell.frame.minY) / atlasHeight, Float(cell.frame.maxX) / atlasWidth,
                            Float(cell.frame.maxY) / atlasHeight),
                        rect: SIMD4(Float(x), Float(y), Float(cell.bounds.width), Float(cell.bounds.height)) / Float(scale), satellite: UInt32(index)))
            }
            for outline in glyphs[first...] {
                var fill = outline
                fill.fill = 1
                glyphs.append(fill)
            }
        }
        texture = atlas.texture
        self.glyphs = glyphs.isEmpty ? nil : device.makeBuffer(copying: glyphs)
        glyphCount = glyphs.count
        self.sizes = sizes
    }

    /// From the glyphs bound at 4, in one draw, which blends in instance order; the
    /// pipeline, the depth test and the rest are the caller's.
    func draw(_ encoder: MTLRenderCommandEncoder) {
        guard let glyphs, glyphCount > 0 else {
            return
        }
        encoder.setVertexBuffer(glyphs, offset: 0, index: 4)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: glyphCount)
    }
}

/// A glyph of one font: names in scripts the system font lacks come out in
/// another, with glyph numbers of its own.
private struct GlyphKey: Hashable, Sendable {
    var font: String
    var glyph: CGGlyph
}

/// A name set by Core Text: its glyphs from the pen's start on the baseline, in pixels.
private struct NameLayout: Sendable {
    var glyphs: [(key: GlyphKey, origin: CGPoint)]
    var width: Double
}

/// Every glyph drawn so far, each twice: its outline in the upper half, its fill
/// in the lower.
/// Sendable: its texture is written once, before it is handed out.
private struct GlyphAtlas: @unchecked Sendable {
    struct Cell {
        /// In the upper half, in pixels from the top left.
        var frame: CGRect
        /// From the glyph's origin, in pixels, y up.
        var bounds: CGRect
    }

    let texture: MTLTexture
    let width: Int
    /// Of each half.
    let height: Int
    let cells: [GlyphKey: Cell]
    /// Glyphs that draw nothing, a space: known, so the atlas is not drawn again for them.
    let blank: Set<GlyphKey>

    func holds(_ key: GlyphKey) -> Bool { cells[key] != nil || blank.contains(key) }
}

/// The label font at one drawable scale, with the names it has set and the glyphs
/// it has drawn. Kept for the app's life: Core Text takes tens of milliseconds to
/// set 16,000 names, and the glyphs they share number a few hundred.
private final class LabelFont: @unchecked Sendable {
    private static let fonts = Mutex<[Double: LabelFont]>([:])
    /// Past this many names, they are set again rather than kept.
    private static let maximumLayouts = 100_000
    private static let atlasWidth = 2048

    let scale: Double
    let font: CTFont
    let outline: Double
    let ascent: Double
    let labelHeight: Double
    private let fill = CGColor(srgbRed: 0xb8 / 255, green: 0xc4 / 255, blue: 0xc4 / 255, alpha: 1)
    private let rim = CGColor(srgbRed: 0x69 / 255, green: 0x69 / 255, blue: 0x69 / 255, alpha: 1)
    private let state = Mutex<(layouts: [String: NameLayout], fonts: [String: CTFont], atlas: GlyphAtlas?)>(([:], [:], nil))

    static func at(scale: Double) -> LabelFont {
        fonts.withLock { fonts in
            if let font = fonts[scale] {
                return font
            }
            let font = LabelFont(scale: scale)
            fonts[scale] = font
            return font
        }
    }

    private init(scale: Double) {
        self.scale = scale
        font = CTFontCreateUIFontForLanguage(.system, 13 * scale, nil) ?? CTFontCreateWithName("Helvetica" as CFString, 13 * scale, nil)
        outline = 2 * scale
        ascent = CTFontGetAscent(font)
        labelHeight = (ascent + CTFontGetDescent(font) + 2 * outline).rounded(.up)
    }

    /// Each name set, in order, and an atlas holding all their glyphs: the last
    /// one drawn when it does, which a texture already handed out stays valid for.
    func atlas(for names: [String], device: MTLDevice) -> (GlyphAtlas, [NameLayout])? {
        state.withLock { state in
            if state.layouts.count > Self.maximumLayouts {
                state.layouts = [:]
            }
            let layouts = names.map { name in
                if let layout = state.layouts[name] {
                    return layout
                }
                let layout = layOut(name, fonts: &state.fonts)
                state.layouts[name] = layout
                return layout
            }
            if let atlas = state.atlas, layouts.allSatisfy({ $0.glyphs.allSatisfy { atlas.holds($0.key) } }) {
                return (atlas, layouts)
            }
            var keys = Set(state.atlas.map { Array($0.cells.keys) + $0.blank } ?? [])
            for layout in layouts {
                keys.formUnion(layout.glyphs.map(\.key))
            }
            guard let atlas = draw(keys.sorted { ($0.font, $0.glyph) < ($1.font, $1.glyph) }, fonts: state.fonts, device: device) else {
                return nil
            }
            state.atlas = atlas
            return (atlas, layouts)
        }
    }

    private func layOut(_ name: String, fonts: inout [String: CTFont]) -> NameLayout {
        let attributes: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: name, attributes: attributes))
        var glyphs: [(key: GlyphKey, origin: CGPoint)] = []
        for run in CTLineGetGlyphRuns(line) as? [CTRun] ?? [] {
            let runFont = (CTRunGetAttributes(run) as? [CFString: Any])?[kCTFontAttributeName].map { $0 as! CTFont } ?? font
            let fontName = CTFontCopyPostScriptName(runFont) as String
            fonts[fontName] = fonts[fontName] ?? runFont
            let count = CTRunGetGlyphCount(run)
            var runGlyphs = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &runGlyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            for (glyph, position) in zip(runGlyphs, positions) {
                // On whole pixels, so neighbouring glyphs are resampled alike.
                glyphs.append((GlyphKey(font: fontName, glyph: glyph), CGPoint(x: position.x.rounded(), y: position.y.rounded())))
            }
        }
        return NameLayout(glyphs: glyphs, width: CTLineGetTypographicBounds(line, nil, nil, nil))
    }

    /// Shelf-packed, left to right, a new row when one fills.
    private func draw(_ keys: [GlyphKey], fonts: [String: CTFont], device: MTLDevice) -> GlyphAtlas? {
        // A pixel clear of the outline's reach, so linear filtering takes in nothing of a neighbour.
        let padding = (outline / 2 + 1).rounded(.up)
        var cells: [GlyphKey: GlyphAtlas.Cell] = [:]
        var blank: Set<GlyphKey> = []
        var x = 0.0
        var y = 0.0
        var rowHeight = 0.0
        for key in keys {
            var glyph = key.glyph
            var bounds = CGRect.zero
            CTFontGetBoundingRectsForGlyphs(fonts[key.font] ?? font, .default, &glyph, &bounds, 1)
            // A space draws nothing.
            if bounds.isEmpty {
                blank.insert(key)
                continue
            }
            let cell = bounds.insetBy(dx: -padding, dy: -padding).integral
            if x + cell.width > Double(Self.atlasWidth) {
                x = 0
                y += rowHeight
                rowHeight = 0
            }
            cells[key] = GlyphAtlas.Cell(frame: CGRect(x: x, y: y, width: cell.width, height: cell.height), bounds: cell)
            x += cell.width
            rowHeight = max(rowHeight, cell.height)
        }
        let height = max(Int(y + rowHeight), 1)
        let width = Self.atlasWidth
        let bitmap = Bitmap(width: width, height: 2 * height, alpha: true) { context in
            context.setLineJoin(.round)
            context.setLineWidth(outline)
            context.setStrokeColor(rim)
            context.setFillColor(fill)
            for (key, cell) in cells {
                let font = fonts[key.font] ?? font
                var glyph = key.glyph
                // Core Graphics counts rows from the bottom; the frames count from the top.
                func origin(_ top: Double) -> CGPoint {
                    CGPoint(x: cell.frame.minX - cell.bounds.minX, y: Double(2 * height) - top - cell.frame.height - cell.bounds.minY)
                }
                // Round, as Cesium strokes its labels: a mitred outline throws spikes
                // off the sharp corners of an M or a V.
                if let path = CTFontCreatePathForGlyph(font, glyph, nil) {
                    for (top, stroke) in [(cell.frame.minY, true), (cell.frame.minY + Double(height), false)] {
                        let at = origin(top)
                        context.saveGState()
                        context.translateBy(x: at.x, y: at.y)
                        context.addPath(path)
                        if stroke {
                            context.strokePath()
                        } else {
                            context.fillPath()
                        }
                        context.restoreGState()
                    }
                } else {
                    // A glyph without an outline, such as an emoji's bitmap: its fill alone.
                    var at = origin(cell.frame.minY + Double(height))
                    CTFontDrawGlyphs(font, &glyph, &at, 1, context)
                }
            }
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: 2 * height, mipmapped: false)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            return nil
        }
        bitmap.bytes.withUnsafeBytes {
            texture.replace(region: MTLRegionMake2D(0, 0, width, 2 * height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: width * 4)
        }
        return GlyphAtlas(texture: texture, width: width, height: height, cells: cells, blank: blank)
    }
}
