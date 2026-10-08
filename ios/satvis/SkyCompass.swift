import CoreMotion
import Observation
import SatvisRender
import UIKit
import simd

/// Aiming the sky view with the device (ADR 0004): CoreMotion's attitude,
/// referenced to true north where the location is known and to magnetic north
/// where it is not, both a measured heading, never an arbitrary one. A sensor that
/// says nothing within 1.2 s is refused rather than trusted, and a drag takes
/// the aim back.
@Observable
final class SkyCompass {
    /// What switching it on came to, for the words in front of the user.
    enum Outcome: Equatable {
        case aiming
        /// No motion sensor here, as in the simulator.
        case unsupported
        /// A sensor, but no north to measure from.
        case noHeading
        /// Granted, but no reading came.
        case silent
        /// The user dragged during the probe, and that was the end of it.
        case takenBack
    }

    private(set) var isAiming = false
    /// Waiting for the sensor to speak, within `probeSeconds`: aiming, but not
    /// yet known to work.
    private(set) var isProbing = false
    @ObservationIgnored private let motion = CMMotionManager()
    @ObservationIgnored private var receivedSample = false
    @ObservationIgnored private var generation = 0

    static let probeSeconds = 1.2

    /// Starts aiming `renderer`'s sky view, and says how that went once the sensor
    /// has had its chance to speak.
    func start(_ renderer: GlobeRenderer) async -> Outcome {
        guard motion.isDeviceMotionAvailable else {
            return .unsupported
        }
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        let frame: CMAttitudeReferenceFrame
        if frames.contains(.xTrueNorthZVertical) {
            frame = .xTrueNorthZVertical
        } else if frames.contains(.xMagneticNorthZVertical) {
            frame = .xMagneticNorthZVertical
        } else {
            return .noHeading
        }
        generation += 1
        let mine = generation
        receivedSample = false
        isAiming = true
        isProbing = true
        defer {
            if generation == mine {
                isProbing = false
            }
        }
        motion.deviceMotionUpdateInterval = 1.0 / 60
        motion.showsDeviceMovementDisplay = true
        motion.startDeviceMotionUpdates(using: frame, to: .main) { [weak self, weak renderer] sample, _ in
            guard let self, let sample, let renderer, self.isAiming, self.generation == mine else {
                return
            }
            self.receivedSample = true
            renderer.setSkyAttitude(Self.attitude(sample.attitude.rotationMatrix, interface: Self.interfaceOrientation))
        }
        try? await Task.sleep(for: .seconds(Self.probeSeconds))
        // A drag during the probe ended it, and the user needs telling nothing.
        guard isAiming, generation == mine else {
            return .takenBack
        }
        guard receivedSample else {
            stop(renderer)
            return .silent
        }
        return .aiming
    }

    /// Hands the aim back, levelled: a roll nothing but the sensor can straighten
    /// would read as a broken view.
    func stop(_ renderer: GlobeRenderer?) {
        guard isAiming else {
            return
        }
        isAiming = false
        isProbing = false
        generation += 1
        motion.stopDeviceMotionUpdates()
        renderer?.levelSky()
    }

    /// The camera's attitude from the device's, as the screen is turned.
    static func attitude(_ m: CMRotationMatrix, interface: UIInterfaceOrientation) -> simd_quatd {
        let rows = simd_double3x3(rows: [SIMD3(m.m11, m.m12, m.m13), SIMD3(m.m21, m.m22, m.m23), SIMD3(m.m31, m.m32, m.m33)])
        let screen: SkyCamera.ScreenOrientation =
            switch interface {
            case .portraitUpsideDown: .portraitUpsideDown
            case .landscapeLeft: .landscapeLeft
            case .landscapeRight: .landscapeRight
            default: .portrait
            }
        return SkyCamera.attitude(device: rows, screen: screen)
    }

    private static var interfaceOrientation: UIInterfaceOrientation {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.effectiveGeometry.interfaceOrientation ?? .portrait
    }
}
