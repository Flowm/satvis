import CoreGraphics
import Foundation
import Metal
import simd

#if canImport(UIKit)
    import UIKit
#else
    import AppKit
#endif

/// A ground station to draw: an id to pick and track it by, and where it stands.
public struct StationMarker: Sendable, Hashable {
    public var id: String
    /// Degrees.
    public var latitude: Double
    public var longitude: Double

    public init(id: String, latitude: Double, longitude: Double) {
        self.id = id
        self.latitude = latitude
        self.longitude = longitude
    }

    /// On the WGS84 ellipsoid, in metres, in the Earth-fixed frame.
    var position: SIMD3<Double> { fixedPosition(latitude: latitude, longitude: longitude) }
}

/// A line from a satellite to a ground station, drawn while one of its passes over
/// that station lasts.
public struct StationLink: Sendable, Hashable {
    public var satellite: String
    /// Metres, Earth-fixed.
    public var station: SIMD3<Double>
    /// UTC milliseconds since 1970.
    public var start: Double
    public var end: Double

    public init(satellite: String, latitude: Double, longitude: Double, start: Double, end: Double) {
        self.satellite = satellite
        station = fixedPosition(latitude: latitude, longitude: longitude)
        self.start = start
        self.end = end
    }
}

/// Mirrors `StationInstance` in Shaders/Stations.msl.
struct StationInstance {
    var position: (Float, Float, Float)
    var distance: Float
}

/// Mirrors `LinkInstance` in Shaders/Stations.msl.
struct LinkInstance {
    var satellite: (Float, Float, Float)
    var station: (Float, Float, Float)
}

enum StationPin {
    static let symbol = "mappin"
    private static let body = CGColor(srgbRed: 0xf8 / 255, green: 0xfa / 255, blue: 0xfc / 255, alpha: 1)
    private static let outline = CGColor(srgbRed: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255, alpha: 1)

    /// SF Symbols' `mappin`, the pin the Ground stations button carries, so the
    /// button and what it places are visibly the same object. White with a dark
    /// outline, as the web app's pin is, to read over snow and sea alike; 96 px
    /// square, its tip at the bottom centre.
    static func bitmap() -> Bitmap {
        let size = 96
        let rim = 4.0
        guard let white = symbolImage(color: body), let dark = symbolImage(color: outline) else {
            return Bitmap(width: size, height: size, alpha: true) { _ in }
        }
        // The symbol's own image is padded; what is drawn is what is opaque.
        let ink = opaqueBounds(of: white)
        let scale = (Double(size) - 2 * rim) / ink.height
        let placed = CGSize(width: Double(white.width) * scale, height: Double(white.height) * scale)
        // The tip on the bottom edge, less the rim, and the stem on the centre line.
        let origin = CGPoint(x: Double(size) / 2 - ink.midX * scale, y: rim - (Double(white.height) - ink.maxY) * scale)
        return Bitmap(width: size, height: size, alpha: true) { context in
            for step in 0..<16 {
                let angle = Double(step) / 16 * 2 * .pi
                context.draw(dark, in: CGRect(origin: CGPoint(x: origin.x + rim * cos(angle), y: origin.y + rim * sin(angle)), size: placed))
            }
            context.draw(white, in: CGRect(origin: origin, size: placed))
        }
    }

    /// Where an image has ink, in pixels from its top-left corner.
    private static func opaqueBounds(of image: CGImage) -> CGRect {
        let bitmap = Bitmap(width: image.width, height: image.height, alpha: true) { context in
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        var (minX, minY, maxX, maxY) = (bitmap.width, bitmap.height, 0, 0)
        for y in 0..<bitmap.height {
            for x in 0..<bitmap.width where bitmap.bytes[(y * bitmap.width + x) * 4 + 3] > 0 {
                (minX, minY, maxX, maxY) = (min(minX, x), min(minY, y), max(maxX, x + 1), max(maxY, y + 1))
            }
        }
        return minX < maxX ? CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY) : CGRect(x: 0, y: 0, width: image.width, height: image.height)
    }

    /// The symbol in one colour, large enough to scale down cleanly.
    private static func symbolImage(color: CGColor) -> CGImage? {
        #if canImport(UIKit)
            let configuration = UIImage.SymbolConfiguration(pointSize: 160, weight: .bold)
                .applying(UIImage.SymbolConfiguration(paletteColors: [UIColor(cgColor: color)]))
            guard let symbol = UIImage(systemName: symbol, withConfiguration: configuration) else {
                return nil
            }
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: symbol.size, format: format).image { _ in symbol.draw(at: .zero) }.cgImage
        #else
            let configuration = NSImage.SymbolConfiguration(pointSize: 160, weight: .bold)
                .applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(cgColor: color) ?? .white]))
            guard let symbol = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else {
                return nil
            }
            var rect = CGRect(origin: .zero, size: symbol.size)
            return symbol.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        #endif
    }
}

/// A geodetic position on the WGS84 ellipsoid, in metres.
func fixedPosition(latitude: Double, longitude: Double) -> SIMD3<Double> {
    let phi = latitude * .pi / 180
    let lambda = longitude * .pi / 180
    let normal = SIMD3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi))
    let k = ellipsoidRadii * ellipsoidRadii * normal
    return k / sqrt(dot(normal, k))
}

/// Geodetic latitude and longitude in degrees of a point on (or near) the
/// ellipsoid's surface, by its surface normal.
func geodetic(_ point: SIMD3<Double>) -> (latitude: Double, longitude: Double) {
    let normal = normalize(point / (ellipsoidRadii * ellipsoidRadii))
    return (asin(normal.z) * 180 / .pi, atan2(normal.y, normal.x) * 180 / .pi)
}
