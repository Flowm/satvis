import Foundation

/// The device camera whose picture the sky view is drawn over (ADR 0013): what it
/// sees, so that the sky view's field of view matches the picture's. The picture
/// fills the view and is cropped to its shape, as AVFoundation's aspect fill does.
public struct CameraLens: Sendable, Equatable {
    /// The tangent of half the angle the picture's long side spans, zoom included.
    public var tanHalfLongSide: Double
    /// The picture's long side over its short side.
    public var aspectRatio: Double
    /// Whether the long side runs up the screen: the picture is turned to the
    /// interface, so in portrait it does.
    public var longSideVertical: Bool

    /// A lens as its fields describe it.
    public init(tanHalfLongSide: Double, aspectRatio: Double, longSideVertical: Bool) {
        self.tanHalfLongSide = tanHalfLongSide
        self.aspectRatio = aspectRatio
        self.longSideVertical = longSideVertical
    }

    /// Radians up a view `aspectRatio` wide for each unit of height.
    public func verticalFieldOfView(viewAspectRatio: Double) -> Double {
        let (width, height) = longSideVertical ? (1, aspectRatio) : (aspectRatio, 1)
        // Scaled until it covers the view, one unit tall.
        let scale = max(viewAspectRatio / width, 1 / height)
        return 2 * atan(tanHalfLongSide / (aspectRatio * scale))
    }
}
