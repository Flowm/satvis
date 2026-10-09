import MetalKit
import SatvisRender
import SwiftUI
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "globe")

/// The Metal globe, steered by drag, pinch and twist; what a tap or a double tap
/// means is the caller's. The gestures are SwiftUI's, so that the controls laid
/// over the globe, the clock deck's timeline among them, take the touches that
/// land on them first.
struct GlobeView: View {
    /// Called once the renderer exists, so the satellites can be handed to it.
    let onRenderer: (GlobeRenderer) -> Void
    /// Where on the view, and the view's size.
    let onTap: (CGPoint, CGSize) -> Void
    let onDoubleTap: (CGPoint, CGSize) -> Void
    /// Asked with a drag's translation so far whether it may move the view.
    var mayDrag: (CGSize) -> Bool = { _ in true }
    /// Drawable pixels per point, the web app's `pixelratio`; nil for the screen's own.
    var pixelRatio: Double?
    /// Frames a second at most, the Graphics panel's.
    let frameRate: Int

    @State private var renderer: GlobeRenderer?
    @State private var lastTranslation = CGSize.zero
    @State private var lastMagnification = 1.0
    @State private var lastRotation = Angle.zero

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            MetalView(pixelRatio: pixelRatio, frameRate: frameRate) { renderer in
                self.renderer = renderer
                onRenderer(renderer)
            }
            .gesture(
                SpatialTapGesture(count: 2)
                    .onEnded { onDoubleTap($0.location, size) }
                    .exclusively(before: SpatialTapGesture().onEnded { onTap($0.location, size) })
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let delta = SIMD2(Double(value.translation.width - lastTranslation.width), Double(value.translation.height - lastTranslation.height))
                        lastTranslation = value.translation
                        if mayDrag(value.translation) {
                            renderer?.drag(by: delta, viewSize: size)
                        }
                    }
                    .onEnded { _ in lastTranslation = .zero }
            )
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        let scale = value.magnification / lastMagnification
                        lastMagnification = value.magnification
                        renderer?.zoom(by: scale)
                    }
                    .onEnded { _ in lastMagnification = 1 }
            )
            .simultaneousGesture(
                RotateGesture()
                    .onChanged { value in
                        let radians = (value.rotation - lastRotation).radians
                        lastRotation = value.rotation
                        renderer?.rotate(by: radians)
                    }
                    .onEnded { _ in lastRotation = .zero }
            )
        }
    }
}

/// The MTKView the renderer draws into, and nothing else.
private struct MetalView: UIViewRepresentable {
    let pixelRatio: Double?
    let frameRate: Int
    let onRenderer: (GlobeRenderer) -> Void

    func makeUIView(context: Context) -> ScaledMTKView {
        let view = ScaledMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.pixelRatio = pixelRatio
        // Over 60 on an iPhone only with CADisableMinimumFrameDuration in Info.plist.
        view.preferredFramesPerSecond = frameRate
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        Task {
            do {
                // The web app's level 2, copied in by the app target's "Copy Natural
                // Earth" phase from data/imagery rather than kept a second time.
                onRenderer(try await GlobeRenderer.make(view: view, naturalEarth: Bundle.main.url(forResource: "NaturalEarthII", withExtension: nil)))
            } catch {
                log.error("No globe: \(error, privacy: .public)")
            }
        }
        return view
    }

    func updateUIView(_ view: ScaledMTKView, context: Context) {
        view.pixelRatio = pixelRatio
        if view.preferredFramesPerSecond != frameRate {
            view.preferredFramesPerSecond = frameRate
        }
    }
}

/// Drawn at the pixel ratio asked for: fewer pixels a point than the screen's,
/// which the system scales up to it, for frames the GPU can finish in time.
/// UIKit sets a view's scale to the screen's when it joins a window, so the
/// ratio is set again then.
private final class ScaledMTKView: MTKView {
    /// Nil for the screen's own.
    var pixelRatio: Double? {
        didSet {
            if pixelRatio != oldValue {
                applyPixelRatio()
            }
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        applyPixelRatio()
    }

    private func applyPixelRatio() {
        guard window != nil else {
            return
        }
        contentScaleFactor = pixelRatio.map { CGFloat($0) } ?? traitCollection.displayScale
    }
}
