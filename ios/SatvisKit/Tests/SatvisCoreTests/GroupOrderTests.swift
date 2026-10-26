import Foundation
import Testing

@testable import SatvisCore

/// The Satellites list's group order against the web app's `localeCompare`
/// (useSatelliteBrowser.ts, through scripts/parity/generate.mjs).
@Suite struct GroupOrderTests {
    @Test func sortsTheGroupsAsTheWebAppDoes() throws {
        struct Root: Decodable {
            let groupOrder: [String]
        }
        let order = try JSONDecoder().decode(Root.self, from: Parity.fixture("parity")).groupOrder
        #expect(order.count > 1)
        #expect(order.reversed().alphabetical() == order)
    }
}
