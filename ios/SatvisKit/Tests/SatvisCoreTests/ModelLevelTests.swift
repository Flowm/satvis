import Foundation
import Testing

@testable import SatvisCore

@Suite struct ModelLevelTests {
    /// The `modelLevels` section of the parity fixture.
    private struct Fixture: Decodable {
        struct Lod: Decodable {
            let file: String
            let maxPoints: Double
        }

        struct Section: Decodable {
            let hysteresis: Double
            let lodSets: [[Lod]]
            /// [lodSets index, diameter, current level, level].
            let cases: [[Double]]
        }

        let modelLevels: Section
    }

    @Test func choosesTheWebAppsLevel() throws {
        let section = try JSONDecoder().decode(Fixture.self, from: Parity.fixture("parity")).modelLevels
        #expect(section.hysteresis == ModelLevel.hysteresis)
        #expect(section.cases.count > 100)
        for entry in section.cases {
            let lods = section.lodSets[Int(entry[0])].map { ModelLod(file: $0.file, maxPoints: $0.maxPoints) }
            let level = ModelLevel.level(diameter: entry[1], current: Int(entry[2]), lods: lods)
            #expect(level == Int(entry[3]), "\(entry)")
        }
    }
}
