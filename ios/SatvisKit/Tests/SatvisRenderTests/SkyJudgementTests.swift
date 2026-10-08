import Foundation
import SatvisCore
import Testing
import simd

@testable import SatvisRender

/// What the sky view tells the shaders of the observer's sky (ADR 0010). At noon
/// in Munich on 5 October no satellite can be seen; by 17:45 UTC the sun is about
/// 9° down, and a low satellite overhead is still lit.
@Suite struct SkyJudgementTests {
    private static let munich = SkyCamera(latitude: 48.1372, longitude: 11.5756)

    private static func milliseconds(_ iso: String) throws -> Double {
        try Date(iso, strategy: .iso8601).timeIntervalSince1970 * 1000
    }

    @Test func mutesEverySatelliteInDaylight() throws {
        let noon = SkyJudgement(camera: Self.munich, at: try Self.milliseconds("2026-10-05T11:15:00Z"), unseen: .dim)
        #expect(noon.sunElevation > 30)
        #expect(noon.uniforms.unseenOpacity == 0.6 && noon.uniforms.skyIsDark == 0)
        let overhead = Self.munich.position + 400_000 * Self.munich.frame.up
        #expect(noon.visibility(of: overhead, from: Self.munich.position) == .daylight)
    }

    @Test func tellsTheLitFromTheFarAfterDusk() throws {
        let dusk = SkyJudgement(camera: Self.munich, at: try Self.milliseconds("2026-10-05T17:45:00Z"), unseen: .hide)
        #expect(dusk.sunElevation < Visibility.darkSkySunElevation && dusk.sunElevation > -15)
        #expect(dusk.uniforms.unseenOpacity == 0 && dusk.uniforms.skyIsDark == 1)
        let eye = Self.munich.position
        #expect(dusk.visibility(of: eye + 400_000 * Self.munich.frame.up, from: eye) == .visible)
        #expect(dusk.visibility(of: eye + 36_000_000 * Self.munich.frame.up, from: eye) == .far)
        #expect(dusk.opacity(of: eye + 36_000_000 * Self.munich.frame.up, from: eye) == 0)
    }

    @Test func drawsEverySatelliteAsUsualWhenAskedTo() throws {
        let noon = SkyJudgement(camera: Self.munich, at: try Self.milliseconds("2026-10-05T11:15:00Z"), unseen: .show)
        #expect(noon.uniforms.unseenOpacity == 1)
    }
}
