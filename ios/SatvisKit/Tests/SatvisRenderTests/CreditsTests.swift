import Foundation
import SatvisCore
import Testing

@testable import SatvisRender

@Suite struct CreditsTests {
    // Natural Earth is under every base map, so it is always owed; the rest only
    // while drawn.
    @Test func creditsWhatTheMapIsDrawnFrom() {
        #expect(Credit.map(baseLayer: .naturalEarth, terrain: false).map(\.text) == ["Imagery courtesy Natural Earth"])
        #expect(Credit.map(baseLayer: .versaTiles, terrain: false).map(\.text) == ["Imagery courtesy Natural Earth", "VersaTiles sources"])
        let lines = ["GOES-19 imagery: NOAA.", "Contains modified EUMETSAT Meteosat data 2026"]
        #expect(Credit.map(baseLayer: .naturalEarth, terrain: false, instrumentImagery: [.georing], mosaic: lines).map(\.text) == ["Imagery courtesy Natural Earth"] + lines)
        #expect(Credit.map(baseLayer: .naturalEarth, terrain: false, mosaic: lines).count == 1)
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

    // A granule picture on screen owes its provider, in the clock's year, once even
    // where a tiled layer of the same provider owes it too.
    @Test func creditsTheGranulePicturesOnScreen() {
        let olci = SatelliteDetails.GranulePictures(provider: .eumetview, layer: "copernicus:olci_l1_rgb_fulres", frame: .after(0))
        let viirs = SatelliteDetails.GranulePictures(provider: .gibs, layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule", frame: .granule)
        // 2025-12-31T23:59:59Z.
        let pictures = [Credit.picture(olci, at: 1_767_225_599_000), Credit.picture(viirs, at: 1_767_225_599_000)]
        #expect(
            Credit.map(baseLayer: .naturalEarth, terrain: false, instrumentImagery: [.gibs], pictures: pictures).map(\.text) == [
                "Imagery courtesy Natural Earth", "NASA Global Imagery Browse Services for EOSDIS", "Contains modified Copernicus Sentinel data 2025 processed by EUMETSAT",
            ])
    }

    @Test func linksEveryMapCreditToItsSource() {
        for layer in BaseLayer.allCases {
            for credit in Credit.map(baseLayer: layer, terrain: true) {
                #expect(credit.link?.scheme == "https", "\(credit.text)")
            }
        }
    }
}
