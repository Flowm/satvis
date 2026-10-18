import MetalKit
import SatvisRender
import SwiftUI
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "closeup")

/// What the close-up takes from the session.
struct CloseUpContext {
    /// Fetches a model by its path under /data/models/.
    let loader: @Sendable (String) async -> Data?
    /// Frames a second at most, the Graphics panel's.
    let frameRate: Int
    let onGPUFault: @MainActor @Sendable (GPUFault) -> Void
}

/// The model on the info panel's Spacecraft tab, as the web app's SatelliteModelView:
/// it turns until dragged, pinches to zoom, and puts its view back on a button. It
/// exists only while the tab shows, so its renderer lives no longer than it is looked at.
struct SatelliteModelView: View {
    /// Path under /data/models/, from the satellite's metadata.
    let modelFile: String
    /// The satellite's, for the view's accessible label.
    let name: String
    let context: CloseUpContext

    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var closeUp: ModelCloseUp?
    @State private var state = ModelCloseUp.State.loading
    @State private var lastTranslation = CGSize.zero
    @State private var lastMagnification = 1.0

    var body: some View {
        ZStack {
            // The web app's backdrop: a dim glow behind the model, black at the edges.
            RadialGradient(
                colors: [Color(red: 0.08, green: 0.09, blue: 0.11), Color(red: 0.016, green: 0.02, blue: 0.024)],
                center: UnitPoint(x: 0.5, y: 0.4), startRadius: 0, endRadius: 240)
            CloseUpMetalView(frameRate: context.frameRate) { result in
                switch result {
                case .success(let closeUp):
                    closeUp.onState = { state = $0 }
                    closeUp.onGPUFault = context.onGPUFault
                    self.closeUp = closeUp
                case .failure(let error):
                    log.error("No close-up: \(error, privacy: .public)")
                    state = .failed
                }
            }
            .accessibilityElement()
            .accessibilityLabel("3D model of \(name)")
            .accessibilityAddTraits(.isImage)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let delta = SIMD2(Double(value.translation.width - lastTranslation.width), Double(value.translation.height - lastTranslation.height))
                        lastTranslation = value.translation
                        closeUp?.drag(by: delta)
                    }
                    .onEnded { _ in lastTranslation = .zero }
            )
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        closeUp?.zoom(by: value.magnification / lastMagnification)
                        lastMagnification = value.magnification
                    }
                    .onEnded { _ in lastMagnification = 1 }
            )
            switch state {
            case .loading:
                Text("Loading model…")
            case .failed:
                Text("The model could not be loaded")
            case .ready:
                EmptyView()
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .overlay(alignment: .topTrailing) {
            if state == .ready {
                Button("Reset view", systemImage: "arrow.counterclockwise") { closeUp?.resetView() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .padding(12)
            }
        }
        // The web app's min(280px, 36dvh): 36 % of a phone in landscape is about 140 pt.
        .frame(height: verticalSizeClass == .compact ? 140 : 280)
        // Once the renderer exists, and again for each satellite the panel shows: it
        // is not rebuilt between them, so a new selection swaps the model in place.
        .task(id: "\(closeUp != nil) \(modelFile)") {
            closeUp?.load(modelFile, loader: context.loader)
        }
    }
}

/// The MTKView the close-up draws into, transparent over the backdrop.
private struct CloseUpMetalView: UIViewRepresentable {
    let frameRate: Int
    let onCloseUp: (Result<ModelCloseUp, Error>) -> Void

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.isOpaque = false
        view.backgroundColor = .clear
        view.preferredFramesPerSecond = frameRate
        Task {
            do {
                onCloseUp(.success(try await ModelCloseUp.make(view: view)))
            } catch {
                onCloseUp(.failure(error))
            }
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        if view.preferredFramesPerSecond != frameRate {
            view.preferredFramesPerSecond = frameRate
        }
    }
}
