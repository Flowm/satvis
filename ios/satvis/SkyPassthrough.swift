import AVFoundation
import Observation
import SatvisRender

/// The camera's picture behind the sky view (ADR 0013): the back wide-angle
/// camera, shown by a preview layer under the globe's view, which is clear where
/// the scene leaves the sky. The renderer matches its field of view to the
/// picture's, and the compass aims both; a pinch zooms the camera.
@Observable
final class SkyPassthrough {
    /// What switching it on came to, for the words in front of the user.
    enum Outcome: Equatable {
        case showing
        /// No back camera here, as in the simulator.
        case noCamera
        /// Access refused, now or before.
        case denied
        /// Switched off again while it started.
        case stopped
    }

    /// Switched on and started: the camera is the sky view's backdrop, but while
    /// the system has taken it away.
    private(set) var isShowing = false
    /// Asking for access, or starting the camera.
    @ObservationIgnored private var isStarting = false
    /// Always under the globe's view, which hides it while it is opaque: the
    /// rotation coordinator reads the interface's orientation from its window.
    @ObservationIgnored let previewLayer = AVCaptureVideoPreviewLayer()
    /// The session the camera runs in, and its queue.
    @ObservationIgnored private let capture = Capture()
    /// The camera, once the session has it as its input.
    @ObservationIgnored private var device: AVCaptureDevice?
    /// Turns the picture with the interface while it shows.
    @ObservationIgnored private var rotation: AVCaptureDevice.RotationCoordinator?
    /// The coordinator's preview angle, watched while the picture shows.
    @ObservationIgnored private var rotationObservation: NSKeyValueObservation?
    /// The capture session's interruptions and errors, watched for the app's life.
    @ObservationIgnored private var sessionObservers: [NSObjectProtocol] = []
    /// What the picture is drawn over.
    @ObservationIgnored private weak var renderer: GlobeRenderer?
    /// The picture while it shows, which the renderer's field of view follows.
    @ObservationIgnored private var lens: CameraLens? {
        didSet { updateRenderer() }
    }
    /// Whether the system has taken the camera away for now: another app in Split
    /// View or Stage Manager, a call, or the app in the background. The sky is
    /// drawn as without the camera until it comes back.
    @ObservationIgnored private(set) var isInterrupted = false {
        didSet { updateRenderer() }
    }
    /// The unzoomed picture's, from its format.
    @ObservationIgnored private var tanHalfLongSide = 0.0
    /// The camera's zoom factor, 1 unzoomed.
    @ObservationIgnored private var zoom = 1.0
    /// Counts the starts and stops, so that a start overtaken by a stop ends there.
    @ObservationIgnored private var generation = 0

    /// The most a pinch zooms the camera: 8 takes a wide-angle camera's 70° along
    /// its long side to the sky view's narrowest, 10°.
    static let maximumZoom = 8.0

    /// Watches the capture session's interruptions and errors from the start.
    init() {
        let center = NotificationCenter.default
        let session = capture.session
        sessionObservers = [
            center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.isInterrupted = true }
            },
            center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.isInterrupted = false }
            },
            center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] note in
                let code = (note.userInfo?[AVCaptureSessionErrorKey] as? AVError)?.code
                MainActor.assumeIsolated { self?.recover(from: code) }
            },
        ]
    }

    /// Shows the camera's picture behind `renderer`'s sky view, asking for access
    /// the first time.
    func start(_ renderer: GlobeRenderer) async -> Outcome {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            return .noCamera
        }
        generation += 1
        let mine = generation
        isStarting = true
        defer {
            if generation == mine {
                isStarting = false
            }
        }
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            return .denied
        }
        guard generation == mine else {
            return .stopped
        }
        if self.device == nil {
            guard configure(device) else {
                return .noCamera
            }
        }
        await withCheckedContinuation { continuation in
            capture.setRunning(true) { continuation.resume() }
        }
        // Stopped meanwhile, the camera is stopped again behind this on its queue.
        guard generation == mine else {
            return .stopped
        }
        // The format the session chose for its preset, known once it runs.
        let format = device.activeFormat
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let degrees = device.isGeometricDistortionCorrectionEnabled ? format.geometricDistortionCorrectedVideoFieldOfView : format.videoFieldOfView
        tanHalfLongSide = tan(Double(degrees) * .pi / 360)
        self.renderer = renderer
        isShowing = true
        lens = CameraLens(
            tanHalfLongSide: tanHalfLongSide / zoom,
            aspectRatio: Double(max(dimensions.width, dimensions.height)) / Double(max(min(dimensions.width, dimensions.height), 1)),
            longSideVertical: true)
        observeRotation(of: device)
        return .showing
    }

    /// Back to the sky the renderer draws, unzoomed for next time.
    func stop() {
        guard isShowing || isStarting else {
            return
        }
        generation += 1
        isShowing = false
        isStarting = false
        isInterrupted = false
        lens = nil
        rotationObservation = nil
        rotation = nil
        setZoom(1)
        capture.setRunning(false)
    }

    /// A pinch: the camera nearer for a scale above 1, and the view with it.
    func zoom(by scale: Double) {
        guard isShowing, scale.isFinite, scale > 0, let device else {
            return
        }
        setZoom(min(max(zoom * scale, 1), min(Self.maximumZoom, Double(device.maxAvailableVideoZoomFactor))))
    }

    /// Zooms the camera to `factor`, and narrows the lens with it: digital zoom
    /// crops the centre, so it divides the tangent.
    private func setZoom(_ factor: Double) {
        zoom = factor
        if let device, (try? device.lockForConfiguration()) != nil {
            device.videoZoomFactor = CGFloat(factor)
            device.unlockForConfiguration()
        }
        lens?.tanHalfLongSide = tanHalfLongSide / factor
    }

    /// Hands the renderer the lens while the picture is there to draw over.
    private func updateRenderer() {
        renderer?.passthrough = isInterrupted ? nil : lens
    }

    /// After a runtime error: started again once the media services are back, as
    /// Apple's samples do, and switched off otherwise.
    private func recover(from code: AVError.Code?) {
        guard isShowing else {
            return
        }
        guard code == .mediaServicesWereReset else {
            return stop()
        }
        capture.setRunning(true)
    }

    /// The session, with the camera as its one input; false where it cannot be.
    private func configure(_ device: AVCaptureDevice) -> Bool {
        let session = capture.session
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .high
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            return false
        }
        session.addInput(input)
        previewLayer.session = session
        previewLayer.videoGravity = .resizeAspectFill
        self.device = device
        return true
    }

    /// Turns the picture with the interface, as the system's camera preview does.
    private func observeRotation(of device: AVCaptureDevice) {
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
        rotation = coordinator
        turn(to: coordinator.videoRotationAngleForHorizonLevelPreview)
        rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) {
            @Sendable [weak self] _, change in
            guard let angle = change.newValue else {
                return
            }
            // At once where it can be, as the view changes shape in the same turn.
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.turn(to: angle) }
            } else {
                Task { @MainActor in self?.turn(to: angle) }
            }
        }
    }

    /// Turns the picture by `angle` degrees, and the lens with it.
    private func turn(to angle: CGFloat) {
        guard isShowing, let connection = previewLayer.connection, connection.isVideoRotationAngleSupported(angle) else {
            return
        }
        connection.videoRotationAngle = angle
        lens?.longSideVertical = isLongSideVertical(angle)
    }

    /// The sensor's long side is its width, so a quarter turn stands it up.
    private func isLongSideVertical(_ angle: CGFloat) -> Bool {
        Int(angle.rounded()) % 180 == 90
    }
}

/// The capture session and the queue it is started and stopped on, since both
/// block until the camera has.
nonisolated private final class Capture: @unchecked Sendable {
    /// The camera's one session, configured on the main thread before it first runs.
    let session = AVCaptureSession()
    /// Where it is started and stopped, in the order asked.
    let queue = DispatchQueue(label: "org.frcy.app.satvis.camera")

    /// Starts or stops the session behind whatever was asked before, then calls `done`.
    func setRunning(_ running: Bool, then done: @escaping @Sendable () -> Void = {}) {
        queue.async {
            if running {
                self.session.startRunning()
            } else {
                self.session.stopRunning()
            }
            done()
        }
    }
}
