import CoreGraphics
import Foundation
import Metal
import simd

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

/// The web app's ground station marker (src/images/icons/pin.svg): Lucide's
/// `map-pin`, the icon on the Ground stations button, filled white with a dark
/// outline and a dark dot, to read over snow and sea alike. Drawn from the same
/// path data, on the same 24-unit grid, into 96 px.
enum StationPin {
    private static let body = CGColor(srgbRed: 0xf8 / 255, green: 0xfa / 255, blue: 0xfc / 255, alpha: 1)
    private static let outline = CGColor(srgbRed: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255, alpha: 1)

    /// 96 px square, its tip at the bottom centre.
    static func bitmap() -> Bitmap {
        let size = 96
        let unit = Double(size) / 24
        return Bitmap(width: size, height: size, alpha: true) { context in
            // Onto the svg's grid, y down, lowered so the tip's outline, at 22
            // plus half the stroke, meets the bottom edge: the tip is the spot.
            context.translateBy(x: 0, y: Double(size))
            context.scaleBy(x: unit, y: -unit)
            context.translateBy(x: 0, y: 24 - 22 - 0.875)
            context.addPath(outlinePath)
            context.setFillColor(body)
            context.setStrokeColor(outline)
            context.setLineWidth(1.75)
            context.setLineCap(.round)
            context.setLineJoin(.round)
            context.drawPath(using: .fillStroke)
            context.setFillColor(outline)
            context.fillEllipse(in: CGRect(x: 12 - 3.1, y: 10 - 3.1, width: 6.2, height: 6.2))
        }
    }

    /// `M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0
    /// C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0`, in absolute terms. Both arcs
    /// sweep towards increasing angle on the y-down grid.
    private static var outlinePath: CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 20, y: 10))
        path.addCurve(to: CGPoint(x: 12.601, y: 21.799), control1: CGPoint(x: 20, y: 14.993), control2: CGPoint(x: 14.461, y: 20.193))
        // The rounded tip: radius 1 about (12, 21), from one flank to the other.
        let flank = atan2(0.799, 0.601)
        path.addRelativeArc(center: CGPoint(x: 12, y: 21), radius: 1, startAngle: flank, delta: .pi - 2 * flank)
        path.addCurve(to: CGPoint(x: 4, y: 10), control1: CGPoint(x: 9.539, y: 20.193), control2: CGPoint(x: 4, y: 14.993))
        // The head: radius 8 about (12, 10), over the top.
        path.addRelativeArc(center: CGPoint(x: 12, y: 10), radius: 8, startAngle: .pi, delta: .pi)
        path.closeSubpath()
        return path
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
