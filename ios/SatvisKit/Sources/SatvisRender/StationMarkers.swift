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

enum StationPin {
    /// The web app's pin (src/images/icons/pin.svg, Lucide's `map-pin`): a white
    /// body with a dark outline and a dark dot, 96 px square.
    static func bitmap() -> Bitmap {
        let size = 96
        return Bitmap(width: size, height: size, alpha: true) { context in
            // The artwork is drawn on a 24-unit grid with y down.
            context.translateBy(x: 0, y: CGFloat(size))
            context.scaleBy(x: CGFloat(size) / 24, y: -CGFloat(size) / 24)
            let body = CGMutablePath()
            body.move(to: CGPoint(x: 20, y: 10))
            body.addCurve(to: CGPoint(x: 12.601, y: 21.799), control1: CGPoint(x: 20, y: 14.993), control2: CGPoint(x: 14.461, y: 20.193))
            body.addArc(tangent1End: CGPoint(x: 12, y: 22.2), tangent2End: CGPoint(x: 11.399, y: 21.799), radius: 1)
            body.addCurve(to: CGPoint(x: 4, y: 10), control1: CGPoint(x: 9.539, y: 20.193), control2: CGPoint(x: 4, y: 14.993))
            body.addArc(center: CGPoint(x: 12, y: 10), radius: 8, startAngle: .pi, endAngle: 0, clockwise: false)
            body.closeSubpath()
            context.addPath(body)
            context.setFillColor(CGColor(srgbRed: 0xf8 / 255, green: 0xfa / 255, blue: 0xfc / 255, alpha: 1))
            context.setStrokeColor(CGColor(srgbRed: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255, alpha: 1))
            context.setLineWidth(1.75)
            context.setLineJoin(.round)
            context.setLineCap(.round)
            context.drawPath(using: .fillStroke)
            context.fillEllipse(in: CGRect(x: 12 - 3.1, y: 10 - 3.1, width: 6.2, height: 6.2))
        }
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
