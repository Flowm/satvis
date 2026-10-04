import MetalKit
import SatvisRender
import SwiftUI
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "globe")

/// The Metal globe, steered by drag, pinch and twist.
struct GlobeView: UIViewRepresentable {
    /// Called once the renderer exists, so the satellites can be handed to it.
    let onRenderer: (GlobeRenderer) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.preferredFramesPerSecond = 60
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        let coordinator = context.coordinator
        Task {
            do {
                let renderer = try await GlobeRenderer.make(view: view)
                coordinator.renderer = renderer
                onRenderer(renderer)
            } catch {
                log.error("No globe: \(error, privacy: .public)")
            }
        }
        let recognizers: [UIGestureRecognizer] = [
            UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.pan)),
            UIPinchGestureRecognizer(target: coordinator, action: #selector(Coordinator.pinch)),
            UIRotationGestureRecognizer(target: coordinator, action: #selector(Coordinator.rotate)),
        ]
        for recognizer in recognizers {
            recognizer.delegate = coordinator
            view.addGestureRecognizer(recognizer)
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var renderer: GlobeRenderer?

        @objc func pan(_ recognizer: UIPanGestureRecognizer) {
            guard let view = recognizer.view else {
                return
            }
            let translation = recognizer.translation(in: view)
            recognizer.setTranslation(.zero, in: view)
            renderer?.camera?.pan(by: SIMD2(translation.x, translation.y), longerSide: max(view.bounds.height, view.bounds.width))
        }

        @objc func pinch(_ recognizer: UIPinchGestureRecognizer) {
            renderer?.camera?.zoom(by: recognizer.scale)
            recognizer.scale = 1
        }

        @objc func rotate(_ recognizer: UIRotationGestureRecognizer) {
            renderer?.camera?.rotate(by: recognizer.rotation)
            recognizer.rotation = 0
        }

        // Pinching and twisting together is one gesture to a person.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
