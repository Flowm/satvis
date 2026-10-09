import Foundation
import Testing

@testable import SatvisRender

@Suite struct CreditsTests {
    // Natural Earth is under every base map, so it is always owed; the rest only
    // while drawn.
    @Test func creditsWhatTheMapIsDrawnFrom() {
        #expect(Credit.map(baseLayer: .naturalEarth, terrain: false).map(\.text) == ["Imagery courtesy Natural Earth"])
        #expect(Credit.map(baseLayer: .versaTiles, terrain: false).map(\.text) == ["Imagery courtesy Natural Earth", "VersaTiles sources"])
        let terrain = Credit.map(baseLayer: .blackMarble, terrain: true).map(\.text)
        #expect(terrain.prefix(3) == ["Imagery courtesy Natural Earth", "NASA Global Imagery Browse Services for EOSDIS", "Re:Earth Terrain · Mapterhorn (CC BY 4.0)"])
        #expect(terrain.contains("OpenStreetMap"))
    }

    // Owed in sight of the map with the terrain alone: the VersaTiles imagery uses
    // none of OpenStreetMap's data.
    @Test func owesOpenStreetMapForTheTerrainAlone() {
        for layer in BaseLayer.allCases {
            #expect(!Credit.map(baseLayer: layer, terrain: false).contains(.openStreetMap))
            #expect(Credit.map(baseLayer: layer, terrain: true).contains(.openStreetMap))
        }
    }

    @Test func linksEveryMapCreditToItsSource() {
        for layer in BaseLayer.allCases {
            for credit in Credit.map(baseLayer: layer, terrain: true) {
                #expect(credit.link?.scheme == "https", "\(credit.text)")
            }
        }
    }
}
