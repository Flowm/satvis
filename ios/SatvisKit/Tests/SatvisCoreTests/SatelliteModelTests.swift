import Testing

@testable import SatvisCore

@Suite struct SatelliteModelTests {
    @Test func readsARecordsModelWithItsCopies() {
        let lods = JSONValue.array([.object(["file": .string("ISS-(ZARYA)-low.glb"), "maxPoints": .number(100)])])
        let metadata: [String: JSONValue] = ["modelFile": .string("ISS-(ZARYA).glb"), "model": .object(["file": .string("ISS-(ZARYA).glb"), "lods": lods])]
        #expect(SatelliteModel(metadata: metadata) == SatelliteModel(file: "ISS-(ZARYA).glb", lods: [ModelLod(file: "ISS-(ZARYA)-low.glb", maxPoints: 100)]))
    }

    @Test func fallsBackToModelFileInAPayloadFromBeforeTheModel() {
        #expect(SatelliteModel(metadata: ["modelFile": .string("ISS-(ZARYA).glb")]) == SatelliteModel(file: "ISS-(ZARYA).glb"))
        #expect(SatelliteModel(metadata: [:]) == nil)
    }

    @Test func drawsTheFileWhenACopyDoesNotParse() {
        let metadata: [String: JSONValue] = ["model": .object(["file": .string("a.glb"), "lods": .array([.object(["file": .string("a-low.glb")])])])]
        #expect(SatelliteModel(metadata: metadata) == SatelliteModel(file: "a.glb"))
    }

    @Test func listsItsLevelsFilesFromTheModelsOwn() {
        let model = SatelliteModel(file: "ISS-(ZARYA).glb", lods: [ModelLod(file: "ISS-(ZARYA)-low.glb", maxPoints: 100)])
        #expect(model.files == ["ISS-(ZARYA).glb", "ISS-(ZARYA)-low.glb"])
    }
}
