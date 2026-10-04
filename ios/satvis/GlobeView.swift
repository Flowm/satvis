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

    @State private var renderer: GlobeRenderer?
    @State private var lastTranslation = CGSize.zero
    @State private var lastMagnification = 1.0
    @State private var lastRotation = Angle.zero

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let longerSide = max(size.width, size.height)
            MetalView { renderer in
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
                        if renderer?.tracked != nil {
                            renderer?.trackingCamera.orbit(by: delta, longerSide: longerSide)
                        } else {
                            renderer?.camera?.pan(by: delta, longerSide: longerSide)
                        }
                    }
                    .onEnded { _ in lastTranslation = .zero }
            )
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        let scale = value.magnification / lastMagnification
                        lastMagnification = value.magnification
                        if renderer?.tracked != nil {
                            renderer?.trackingCamera.zoom(by: scale)
                        } else {
                            renderer?.camera?.zoom(by: scale)
                        }
                    }
                    .onEnded { _ in lastMagnification = 1 }
            )
            .simultaneousGesture(
                RotateGesture()
                    .onChanged { value in
                        let radians = (value.rotation - lastRotation).radians
                        lastRotation = value.rotation
                        if renderer?.tracked != nil {
                            renderer?.trackingCamera.rotate(by: radians)
                        } else {
                            renderer?.camera?.rotate(by: radians)
                        }
                    }
                    .onEnded { _ in lastRotation = .zero }
            )
        }
    }
}

/// The MTKView the renderer draws into, and nothing else.
private struct MetalView: UIViewRepresentable {
    let onRenderer: (GlobeRenderer) -> Void

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.preferredFramesPerSecond = 60
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        Task {
            do {
                onRenderer(try await GlobeRenderer.make(view: view))
            } catch {
                log.error("No globe: \(error, privacy: .public)")
            }
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {}
}
