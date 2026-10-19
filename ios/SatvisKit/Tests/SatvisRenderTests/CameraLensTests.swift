import Foundation
import Testing

@testable import SatvisRender

@Suite struct CameraLensTests {
    private static let degree = Double.pi / 180
    /// A 16:9 picture 70° across its long side.
    private static let tanHalfLongSide = tan(35 * degree)

    // On a phone upright, the picture's long side runs up a taller screen, which
    // shows all of it and crops the sides.
    @Test func spansTheLongSideUpAPortraitPhone() {
        let lens = CameraLens(tanHalfLongSide: Self.tanHalfLongSide, aspectRatio: 16 / 9, longSideVertical: true)
        #expect(abs(lens.verticalFieldOfView(viewAspectRatio: 9 / 19.5) - 70 * Self.degree) < 1e-12)
    }

    // Turned on its side, the screen is wider than the picture, which fills its
    // width and loses its top and bottom.
    @Test func cropsTheShortSideOnALandscapePhone() {
        let lens = CameraLens(tanHalfLongSide: Self.tanHalfLongSide, aspectRatio: 16 / 9, longSideVertical: false)
        let expected = 2 * atan(Self.tanHalfLongSide / (16 / 9) * (16 / 9) / (19.5 / 9))
        #expect(abs(lens.verticalFieldOfView(viewAspectRatio: 19.5 / 9) - expected) < 1e-12)
    }

    // On an iPad in landscape, 4:3, the screen is narrower than the picture,
    // which fills its height: the whole short side.
    @Test func spansTheShortSideOnALandscapeTablet() {
        let lens = CameraLens(tanHalfLongSide: Self.tanHalfLongSide, aspectRatio: 16 / 9, longSideVertical: false)
        let expected = 2 * atan(Self.tanHalfLongSide * 9 / 16)
        #expect(abs(lens.verticalFieldOfView(viewAspectRatio: 4 / 3) - expected) < 1e-12)
    }

    // Zoom divides the tangent, not the angle.
    @Test func narrowsWithTheZoom() {
        let wide = CameraLens(tanHalfLongSide: Self.tanHalfLongSide, aspectRatio: 16 / 9, longSideVertical: true)
        var near = wide
        near.tanHalfLongSide /= 2
        let half = tan(wide.verticalFieldOfView(viewAspectRatio: 9 / 19.5) / 2) / 2
        #expect(abs(near.verticalFieldOfView(viewAspectRatio: 9 / 19.5) - 2 * atan(half)) < 1e-12)
    }
}
