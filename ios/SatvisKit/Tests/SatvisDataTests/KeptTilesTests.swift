import Foundation
import Testing

@testable import SatvisData

@Suite struct KeptTilesTests {
    @Test func keepsATileByItsHostAndPath() {
        let kept = KeptTiles(directory: URL.temporaryDirectory.appending(path: UUID().uuidString))
        let url = URL(string: "https://satvis.test/data/imagery/NaturalEarthII/3/1/2.webp")!
        #expect(kept.read(url) == nil)
        kept.keep(Data([1, 2, 3]), for: url)
        #expect(kept.read(url) == Data([1, 2, 3]))
        // Another site's tile at the same path is another tile.
        #expect(kept.read(URL(string: "https://other.test/data/imagery/NaturalEarthII/3/1/2.webp")!) == nil)
    }
}
