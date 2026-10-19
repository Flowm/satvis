import CoreLocation
import Observation
import SatvisCore
import SatvisRender

/// Aiming the sky view by compass and showing the camera's picture behind it
/// (ADR 0004, ADR 0013): the two devices, and the rules the controls and the
/// globe's gestures follow over them.
@Observable
final class SkyAim {
    /// Aims the sky view with the device (ADR 0004).
    let compass = SkyCompass()
    /// The camera's picture behind the sky view, aimed by the compass (ADR 0013).
    let passthrough: SkyPassthrough
    /// From asking for the camera, the compass first, until it shows or not.
    private(set) var isStartingCamera = false
    /// Why the satellites may not be where the camera shows them, while it does:
    /// the sky is drawn for a place other than where the device is, or where the
    /// device is cannot be told. A clock away from now is no such reason: the sky
    /// to come over the place in the picture is a view of its own.
    private(set) var cameraWarning: String?
    /// The renderer the compass aims, once it exists; until then nothing starts.
    @ObservationIgnored var renderer: GlobeRenderer?
    /// Shows a word for the user that goes by itself: how switching on went.
    @ObservationIgnored var show: (String?) -> Void = { _ in }

    /// The camera's picture hands its lens to `globe`.
    init(globe: GlobeBinding) {
        passthrough = SkyPassthrough(globe: globe)
    }

    /// Aims the sky view with the device, or hands the aim back, and the camera's
    /// picture with it.
    func toggleCompass() {
        guard let renderer else {
            return
        }
        if compass.isAiming {
            return compass.stop(renderer)
        }
        Task {
            let outcome = await compass.start(renderer)
            show(outcome == .aiming ? "Aiming by compass. \(Self.dragHandsBack)" : Self.words(for: outcome))
        }
    }

    /// Shows the camera's picture behind the sky view, aiming by compass first,
    /// as it has to (ADR 0013), or takes it away and leaves the compass aiming.
    func togglePassthrough() {
        guard let renderer, !isStartingCamera else {
            return
        }
        if passthrough.isShowing {
            return passthrough.stop()
        }
        isStartingCamera = true
        Task {
            defer { isStartingCamera = false }
            if !compass.isAiming {
                let outcome = await compass.start(renderer)
                guard outcome == .aiming else {
                    return show(Self.words(for: outcome))
                }
            }
            switch await passthrough.start() {
            case .showing: show("Showing the camera, aimed by compass. \(Self.dragHandsBack)")
            case .noCamera: return show("This device has no camera to show the sky through.")
            case .denied: return show("Showing the sky through the camera needs access to it. Allow it in Settings.")
            case .stopped: return
            }
        }
    }

    /// Hands the aim back, out of the sky view; the camera goes with it.
    func stop() {
        compass.stop(renderer)
    }

    /// How a drag ends the compass's aiming, and the camera's picture with it.
    private static let dragHandsBack = "Drag at any time to turn it off."

    /// Why the compass would not aim; nil where it did, or the user took the aim
    /// back meanwhile and needs telling nothing.
    private static func words(for outcome: SkyCompass.Outcome) -> String? {
        switch outcome {
        case .aiming, .takenBack: nil
        case .unsupported: "This device has no motion sensor to aim with."
        case .noHeading: "This device cannot tell where north is, so it cannot aim by compass."
        case .silent: "The motion sensor did not answer."
        }
    }

    /// Whether a drag of `translation` so far, with at most `fingers` down, may
    /// turn the view. While the compass aims, a drag by one finger past a tap's slop
    /// takes the aim back (ADR 0004), and the camera goes with it; within the slop,
    /// it is a tap's tremor. A drag more fingers have been part of never does: a
    /// pinch's fingers drift as they spread.
    func mayDrag(_ translation: CGSize, fingers: Int) -> Bool {
        guard compass.isAiming else {
            return true
        }
        guard fingers < 2, hypot(translation.width, translation.height) > 8 else {
            return false
        }
        compass.stop(renderer)
        return true
    }

    /// Takes a pinch of `scale` while the camera shows: it zooms the camera, and
    /// the view follows its picture. False where the pinch is the view's, as it is
    /// while the system has the camera and the sky is drawn without it.
    func takePinch(_ scale: Double) -> Bool {
        guard passthrough.isShowing, !passthrough.isInterrupted else {
            return false
        }
        passthrough.zoom(by: scale)
        return true
    }

    /// Takes the camera's picture away whenever the compass stops aiming, however
    /// it stopped (ADR 0013): a picture the sky drawn over it does not follow
    /// looks right and is wrong.
    func watchAiming() async {
        for await aiming in Observations({ self.compass.isAiming }) where !aiming {
            passthrough.stop()
        }
    }

    /// Metres between the device and the place the sky is drawn for past which
    /// the camera's picture is warned about: at the ISS's height, 5 km moves a
    /// satellite overhead by under a degree.
    private static let cameraWarningDistance = 5_000.0

    /// Judges the camera's place again whenever `standing`, the station the sky
    /// view stands on, changes, it moves or the camera comes on: one judgement at
    /// a time, so a position that takes seconds to come never overwrites a newer one.
    func watchCameraPlace(standing: @escaping @MainActor () -> GroundStation?) async {
        // What the picture is judged against: the station, while the camera shows.
        let cameraStation: @MainActor @Sendable () -> GroundStation? = { self.passthrough.isShowing ? standing() : nil }
        var judged: GroundStation?
        for await station in Observations(cameraStation) where station != judged {
            judged = station
            cameraWarning = nil
            guard let station else {
                continue
            }
            let warning = await Self.cameraWarning(at: station)
            // Moved on meanwhile: the next value is judged in turn.
            if cameraStation() == station {
                cameraWarning = warning
            }
        }
    }

    /// Why the camera may not show `station`'s sky, by where the device is now; nil
    /// where it does.
    private static func cameraWarning(at station: GroundStation) async -> String? {
        guard let here = await currentLocation() else {
            return "Satvis cannot tell where you are, so the satellites may not be where the camera shows them."
        }
        let metres = CLLocation(latitude: here.latitude, longitude: here.longitude).distance(from: CLLocation(latitude: station.latitude, longitude: station.longitude))
        guard metres > cameraWarningDistance else {
            return nil
        }
        let distance = Measurement(value: metres / 1000, unit: UnitLength.kilometers).formatted(.measurement(width: .abbreviated, usage: .road))
        let place = station.name == StationList.geolocation ? "your last location" : station.name ?? "this location"
        return "The satellites are drawn for \(place), \(distance) from you, so they are not where the camera shows them."
    }
}
