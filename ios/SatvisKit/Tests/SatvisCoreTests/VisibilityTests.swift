import Foundation
import Testing
import simd

@testable import SatvisCore

/// The sky view's verdict against the web app's own (visibility.ts, through
/// scripts/parity/generate.mjs).
@Suite struct VisibilityTests {
    private struct Fixture: Decodable {
        struct Vector: Decodable {
            let x: Double
            let y: Double
            let z: Double

            var simd: SIMD3<Double> { SIMD3(x, y, z) }
        }

        struct SunDirection: Decodable {
            let instant: String
            let direction: Vector
        }

        struct Shadow: Decodable {
            let position: Vector
            let sun: Vector
            let inShadow: Bool
        }

        struct Verdict: Decodable {
            let sunElevation: Double
            let sunlit: Bool
            let rangeKm: Double
            let visibility: String
        }

        let sunDirections: [SunDirection]
        let shadows: [Shadow]
        let verdicts: [Verdict]
    }

    private static func fixture() throws -> Fixture {
        struct Root: Decodable {
            let visibility: Fixture
        }
        return try JSONDecoder().decode(Root.self, from: Parity.fixture("parity")).visibility
    }

    @Test func findsTheSunWhereTheWebAppDoes() throws {
        for sample in try Self.fixture().sunDirections {
            let date = try Date(sample.instant, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
            let sun = Sun.directionFixed(epochMilliseconds: (date.timeIntervalSince1970 * 1000).rounded())
            #expect(distance(sun, sample.direction.simd) < 1e-12, "\(sample.instant)")
        }
    }

    @Test func castsTheShadowTheWebAppCasts() throws {
        let shadows = try Self.fixture().shadows
        #expect(shadows.contains { $0.inShadow } && shadows.contains { !$0.inShadow })
        for shadow in shadows {
            #expect(Visibility.inEarthShadow(shadow.position.simd, sun: shadow.sun.simd) == shadow.inShadow, "\(shadow.position.simd)")
        }
    }

    @Test func givesTheWebAppsVerdict() throws {
        for verdict in try Self.fixture().verdicts {
            let visibility = Visibility(sunElevation: verdict.sunElevation, sunlit: verdict.sunlit, range: verdict.rangeKm)
            #expect(visibility.rawValue == verdict.visibility, "\(verdict.sunElevation)° \(verdict.sunlit) \(verdict.rangeKm) km")
        }
    }

    @Test func dimsInDaylightLessThanOnADarkSky() {
        #expect(UnseenMode.dim.opacity(.visible) == 1)
        #expect(UnseenMode.dim.opacity(.shadow) < UnseenMode.dim.opacity(.daylight))
        #expect(UnseenMode.dim.opacity(.daylight) < 1)
        #expect(UnseenMode.hide.opacity(.far) == 0)
        #expect(UnseenMode.hide.opacity(.visible) == 1)
        #expect(UnseenMode.show.opacity(.shadow) == 1)
    }
}
