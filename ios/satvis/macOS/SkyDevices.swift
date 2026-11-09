import Observation
import SatvisRender

// A Mac has no motion sensor, and its camera faces the user: the sky view is aimed
// by dragging, as the web app's is on a desktop, where a silent sensor is a
// refusal (ADR 0004). These stand in for the iPhone's, so `SkyAim` is the same on
// both, and the controls that would start them are not shown.

/// Aiming the sky view with the device, which a Mac cannot.
@Observable
final class SkyCompass {
    /// What switching it on came to, for the words in front of the user.
    enum Outcome: Equatable {
        case aiming
        /// No motion sensor here.
        case unsupported
        /// A sensor, but no north to measure from.
        case noHeading
        /// Granted, but no reading came.
        case silent
        /// The user dragged during the probe, and that was the end of it.
        case takenBack
    }

    /// Never: there is no sensor to aim by.
    let isAiming = false
    /// Never waiting for a sensor.
    let isProbing = false

    /// Refuses, as there is no sensor.
    func start(_ renderer: GlobeRenderer) async -> Outcome {
        .unsupported
    }

    /// Nothing to hand back.
    func stop(_ renderer: GlobeRenderer?) {}
}

/// The camera's picture behind the sky view, which a Mac's camera cannot show.
@Observable
final class SkyPassthrough {
    /// What switching it on came to, for the words in front of the user.
    enum Outcome: Equatable {
        case showing
        /// No back camera here.
        case noCamera
        /// Access refused, now or before.
        case denied
        /// Switched off again while it started.
        case stopped
    }

    /// Never shown.
    let isShowing = false
    /// Never interrupted, never having started.
    let isInterrupted = false

    /// Takes nothing from the globe: the lens stays the renderer's.
    init(globe: GlobeBinding) {}

    /// Refuses, as there is no camera facing the sky.
    func start() async -> Outcome {
        .noCamera
    }

    /// Nothing to stop.
    func stop() {}

    /// Nothing to zoom.
    func zoom(by scale: Double) {}
}
