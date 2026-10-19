import AVFoundation
import SwiftUI

/// The camera's picture, filling the globe's view from underneath (ADR 0013).
struct CameraPreview: UIViewRepresentable {
    /// `SkyPassthrough`'s, which outlives the view.
    let layer: AVCaptureVideoPreviewLayer

    /// A view holding the shared layer.
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.preview = layer
        return view
    }

    /// Nothing to update: the layer follows the session by itself.
    func updateUIView(_ view: PreviewView, context: Context) {}

    /// Holds the preview layer at its own size.
    final class PreviewView: UIView {
        /// The layer shown, a sublayer rather than the view's own, as it is shared.
        var preview: AVCaptureVideoPreviewLayer? {
            didSet {
                oldValue?.removeFromSuperlayer()
                if let preview {
                    layer.addSublayer(preview)
                }
            }
        }

        /// Sizes the layer to the view.
        override func layoutSubviews() {
            super.layoutSubviews()
            // Not animated: the globe's view above it resizes at once.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            preview?.frame = bounds
            CATransaction.commit()
        }
    }
}
