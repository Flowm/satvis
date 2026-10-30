import Foundation
import Testing

@testable import SatvisCore

/// Links read into a scene and written back from one (`SceneState`).
@Suite struct SceneStateTests {
    private let munich = LinkStation(latitude: 48.1372, longitude: 11.5756, name: "Munich")
    private let home = LinkStation(latitude: 47.2692, longitude: 11.4041, name: "Home")
    private let field = LinkStation(latitude: 46.5935, longitude: 7.9091)

    private func written(_ scene: SceneState, presetDefaults: [String: String] = [:], overBudget: SatelliteComponents = [], sharing: Bool = false) -> String {
        scene.link(preset: nil, presetDefaults: presetDefaults, overBudget: overBudget, sharing: sharing).query.string
    }

    @Test func aViewRoundTripsThroughALinkOntoTheSameScene() throws {
        let time = try #require(date(minuteISO: "2026-10-04T19:22Z"))
        let views = [
            SceneState(),
            SceneState(
                activation: Activation(enabledTags: ["GNSS", "Weather"], enabledSatellites: ["ISS (ZARYA)"], disabledSatellites: ["GOES 19"]),
                components: [.point, .orbit, .model], stations: [munich, field], tracked: "ISS (ZARYA)", overpassMode: .swath, layers: ["VIIRS"],
                terrain: true, starMap: .deepStar2K, unseen: .hide, cameraFrame: .inertial, pixelRatio: "1.5", time: time,
                foreign: SceneState.Foreign(LinkQuery(parsing: "embed&surface=OsmBuildings&framems=16"))),
            SceneState(activation: Activation(enabledTags: []), components: [], stations: [munich], sky: true, observer: munich),
        ]
        for presetDefaults in [[:], ["tags": "GNSS", "elements": "Point,Orbit,Ground track", "overpass": "swath", "layers": "VersaTiles"]] {
            for view in views {
                let link = view.link(preset: "demo", presetDefaults: presetDefaults, overBudget: [], sharing: false)
                #expect(link.preset == "demo")
                #expect(SceneState.read(link.query, presetDefaults: presetDefaults).scene == view, "\(link.query.string)")
            }
        }
    }

    @Test func keepsForeignParametersAsTheyCame() {
        let query = LinkQuery(parsing: "embed&tags=GNSS&surface=OsmBuildings&utm_source=x+y&fps=false")
        let (scene, _) = SceneState.read(query, presetDefaults: [:])
        #expect(scene.foreign.query.string == "embed&surface=OsmBuildings&utm_source=x+y&fps=false")
        #expect(written(scene) == "embed&surface=OsmBuildings&utm_source=x+y&fps=false&tags=GNSS")
    }

    // The app draws two of the web app's three star maps, and a link keeps the one it named.
    @Test func drawsTheStarMapALinkNamesAsTheAppCan() {
        let read = { (query: String) in SceneState.read(LinkQuery(parsing: query), presetDefaults: [:]).scene }
        #expect(read("").starMap == .tycho1K && read("").starMap.drawn == .deepStar1K)
        #expect(read("stars=Tycho1K").starMap.drawn == .deepStar1K)
        #expect(read("stars=DeepStar1K").starMap.drawn == .deepStar1K)
        #expect(read("stars=DeepStar2K").starMap.drawn == .deepStar2K)
        #expect(read("stars=Bogus").starMap == .tycho1K)
        #expect(written(read("stars=Tycho1K")) == "")
        #expect(written(read("stars=DeepStar1K")) == "stars=DeepStar1K")
        #expect(written(SceneState(starMap: .deepStar2K)) == "stars=DeepStar2K")
    }

    @Test func readsAndWritesTheFPSSwitchAndTheBenchmarkPanel() {
        var scene = SceneState.read(LinkQuery(parsing: "fps=true&framems=16"), presetDefaults: [:]).scene
        #expect(scene.foreign.showsPerformance)
        #expect(!scene.foreign.showsBenchmark)
        scene.foreign.showsBenchmark = true
        #expect(written(scene) == "fps=true&framems=16&bench=true")
        scene.foreign.showsPerformance = false
        #expect(written(scene) == "framems=16&bench=true")
        // The last value decides, as the web app's store reads it.
        #expect(!SceneState.read(LinkQuery(parsing: "fps=true&fps=false"), presetDefaults: [:]).scene.foreign.showsPerformance)
        #expect(SceneState.read(LinkQuery(parsing: "bench=true"), presetDefaults: [:]).scene.foreign.showsBenchmark)
    }

    @Test func namesTheComponentsOnlyWhereTheLinkHasElements() {
        let named = SceneState.read(LinkQuery(parsing: "elements=Point,Label"), presetDefaults: [:])
        #expect(named.scene.components == [.point, .label])
        #expect(named.named == [.point, .label])
        let unnamed = SceneState.read(LinkQuery(parsing: "tags=GNSS"), presetDefaults: ["elements": "Point,Orbit"])
        #expect(unnamed.scene.components == [.point, .orbit])
        #expect(unnamed.named.isEmpty)
    }

    @Test func writesAComponentPastItsBudgetEvenAtTheDefault() {
        let scene = SceneState(activation: Activation(enabledTags: ["Starlink"]), components: [.point, .label])
        #expect(written(scene) == "tags=Starlink")
        #expect(written(scene, overBudget: [.label]) == "elements=Point,Label&tags=Starlink")
        #expect(written(SceneState(activation: Activation(enabledTags: ["Starlink"]), components: [.point]), overBudget: [.label]) == "tags=Starlink")
    }

    @Test func carriesTheSelectedStationOnlyInASharedLink() {
        let scene = SceneState(stations: [field], selectedStation: home)
        #expect(written(scene) == "gs=46.5935,7.9091")
        #expect(written(scene, sharing: true) == "gs=46.5935,7.9091_47.2692,11.4041,Home")
        // A visiting station selected is in the link already.
        #expect(written(SceneState(stations: [field], selectedStation: field), sharing: true) == "gs=46.5935,7.9091")
    }

    @Test func writesTheObserversStationFirst() {
        let visiting = SceneState(stations: [field, munich], sky: true, observer: munich)
        #expect(written(visiting) == "gs=48.1372,11.5756,Munich_46.5935,7.9091&scene=Sky")
        // A saved station, which only the sky view puts in a link that is not shared.
        let saved = SceneState(stations: [field], selectedStation: home, sky: true, observer: home)
        #expect(written(saved) == "gs=47.2692,11.4041,Home_46.5935,7.9091&scene=Sky")
        #expect(written(saved, sharing: true) == "gs=47.2692,11.4041,Home_46.5935,7.9091&scene=Sky")
        let read = SceneState.read(LinkQuery(parsing: "gs=48.1372,11.5756,Munich_46.5935,7.9091&scene=Sky"), presetDefaults: [:]).scene
        #expect(read.sky)
        #expect(read.observer == munich)
        #expect(read.stations == [munich, field])
        #expect(SceneState.read(LinkQuery(parsing: "gs=48.1372,11.5756"), presetDefaults: [:]).scene.observer == nil)
    }

    @Test func readsAndWritesTheProjection() {
        #expect(written(SceneState(projection: .twoD)) == "scene=2D")
        #expect(written(SceneState(projection: .threeD)) == "")
        // The sky view's link names the sky view alone; the projection it goes back
        // to is not the link's.
        #expect(written(SceneState(sky: true, projection: .twoD, observer: munich)) == "gs=48.1372,11.5756,Munich&scene=Sky")
        #expect(SceneState.read(LinkQuery(parsing: "scene=2D"), presetDefaults: [:]).scene.projection == .twoD)
        let sky = SceneState.read(LinkQuery(parsing: "scene=Sky"), presetDefaults: [:]).scene
        #expect(sky.sky && sky.projection == .threeD)
        // Columbus is the web app's alone: the globe, the parameter dropped.
        let columbus = SceneState.read(LinkQuery(parsing: "scene=Columbus"), presetDefaults: [:]).scene
        #expect(!columbus.sky && columbus.projection == .threeD)
        #expect(written(columbus) == "")
        // A preset's 2D is its default, and its 3D then a choice the link names.
        #expect(SceneState.read(LinkQuery(), presetDefaults: ["scene": "2D"]).scene.projection == .twoD)
        #expect(written(SceneState(), presetDefaults: ["scene": "2D"]) == "scene=3D")
    }

    @Test func recordsTheTimeOnlyOffThePresent() throws {
        let start = 1_790_000_000_000.0
        var clock = SimulationClock(real: start)
        #expect(SceneState.pinnedTime(of: clock, at: start + 30_000) == nil)
        clock.setPlaying(false, at: start)
        #expect(SceneState.pinnedTime(of: clock, at: start + 30_000) == nil)
        let paused = try #require(SceneState.pinnedTime(of: clock, at: start + 90_000))
        #expect(paused == Date(timeIntervalSince1970: start / 1000))
        #expect(written(SceneState(time: paused)) == "time=\(minuteISO(paused))")
        #expect(written(SceneState(time: nil)) == "")
    }

    @Test func readsTheFixturesWholeLinksAsTheAppShowsThem() throws {
        let root = try #require(try JSONSerialization.jsonObject(with: Parity.fixture("parity")) as? [String: Any])
        let links = try #require(root["links"] as? [String: Any])
        let presets = try #require(links["presets"] as? [String: [String: String]])
        let cases = try #require(links["cases"] as? [[String: Any]])
        for test in cases {
            let preset = try #require(presets[test["preset"] as! String])
            let query = test["query"] as! String
            let label = "\(test["preset"]!) ?\(query)"
            let want = try #require(test["state"] as? [String: Any])
            let scene = SceneState.read(LinkQuery(parsing: query), presetDefaults: preset).scene
            #expect(scene.components == SatelliteComponents(names: want["elements"] as! [String]), "\(label)")
            #expect(scene.activation.enabledTags == Set(want["tags"] as! [String]), "\(label)")
            #expect(scene.activation.enabledSatellites == Set(want["sats"] as! [String]), "\(label)")
            #expect(scene.tracked ?? "" == want["track"] as? String, "\(label)")
            #expect(scene.sky == (want["scene"] as? String == "Sky"), "\(label)")
            #expect(scene.projection == (want["scene"] as? String == "2D" ? .twoD : .threeD), "\(label)")
            #expect(scene.overpassMode.rawValue == want["overpass"] as? String, "\(label)")
            #expect(scene.terrain == (want["terrain"] as? String == "ReEarth"), "\(label)")
            #expect(scene.time.map(minuteISO) == want["time"] as? String, "\(label)")
            // Written and read again, it is the same scene.
            let link = scene.link(preset: nil, presetDefaults: preset, overBudget: [], sharing: false)
            #expect(SceneState.read(link.query, presetDefaults: preset).scene == scene, "\(label)")
        }
    }
}

/// The component budgets' crossing rule (ADR 0001, `ComponentBudgets`).
@Suite struct ComponentBudgetsTests {
    private let on: SatelliteComponents = [.point, .label, .model, .groundStationLink]

    @Test func switchesAComponentOffOnTheCrossingUnlessTheLinkNamesIt() {
        var budgets = ComponentBudgets()
        #expect(budgets.components(on, active: 200, modelled: 0, named: []) == on)
        #expect(budgets.over.isEmpty)
        #expect(budgets.components(on, active: 201, modelled: 0, named: []) == [.point, .model, .groundStationLink])
        #expect(budgets.over == [.label])

        var named = ComponentBudgets()
        #expect(named.components(on, active: 501, modelled: 0, named: [.label]) == [.point, .label, .model])
        #expect(named.over == [.label, .groundStationLink])
    }

    @Test func switchesOffOnlyOnTheCrossing() {
        var budgets = ComponentBudgets()
        var components = budgets.components(on, active: 300, modelled: 0, named: [])
        #expect(!components.contains(.label))
        // Switched back on past the budget, it stays on.
        components.insert(.label)
        #expect(budgets.components(components, active: 350, modelled: 0, named: []) == components)
        // Down under and up again is a crossing of its own.
        #expect(budgets.components(components, active: 150, modelled: 0, named: []) == components)
        #expect(budgets.over.isEmpty)
        #expect(!budgets.components(components, active: 250, modelled: 0, named: []).contains(.label))
    }

    @Test func countsOnlySatellitesWithAModelFileForModels() {
        var budgets = ComponentBudgets()
        #expect(budgets.components([.point, .model], active: 5000, modelled: 200, named: []) == [.point, .model])
        #expect(budgets.over == [.label, .groundStationLink])
        #expect(budgets.components([.point, .model], active: 5000, modelled: 201, named: []) == [.point])
        #expect(budgets.over == [.label, .groundStationLink, .model])
    }

    @Test func namesTheComponentsAsTheWebAppDoes() {
        let all = SatelliteComponents(names: LinkCodec.components)
        #expect(all.names == LinkCodec.components)
        #expect(SatelliteComponents(names: ["Orbit", "Point", "Bogus"]) == [.point, .orbit])
        #expect(SatelliteComponents([.orbit, .point]).names == ["Point", "Orbit"])
    }
}
