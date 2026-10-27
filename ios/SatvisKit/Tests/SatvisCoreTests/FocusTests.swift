import Foundation
import Testing

@testable import SatvisCore

@Suite struct FocusTests {
    private let station = UUID()
    private let other = UUID()

    @Test func readsTheRenderersIDs() {
        #expect(Selection(rendererID: Selection.station(station).rendererID) == .station(station))
        #expect(Selection(rendererID: "25544|ISS (ZARYA)") == .satellite("25544|ISS (ZARYA)"))
        #expect(Selection(rendererID: "station|not-a-uuid") == .satellite("station|not-a-uuid"))
    }

    @Test func aTapWhilePickingAddsAStationAndSelectsIt() {
        var focus = Focus()
        focus.setPicking(true)
        var added: (Double, Double)?
        let station = station
        focus.tap(Focus.Tap(ground: { GeoCoordinate(latitude: 48.1, longitude: 11.6) }, entity: { "25544|ISS (ZARYA)" }), keepingSelection: false) { latitude, longitude in
            added = (latitude, longitude)
            return station
        }
        #expect(added.map { [$0.0, $0.1] } == [48.1, 11.6])
        #expect(focus.selection == .station(station))
        #expect(!focus.isPicking)
    }

    @Test func aTapOnNothingClearsTheSelectionUnlessKept() {
        var focus = Focus()
        focus.select(.satellite("a"))
        focus.tap(Focus.Tap(), keepingSelection: true) { _, _ in nil }
        #expect(focus.selection == .satellite("a"))
        focus.tap(Focus.Tap(), keepingSelection: false) { _, _ in nil }
        #expect(focus.selection == nil)
        focus.tap(Focus.Tap(entity: { Selection.station(station).rendererID }), keepingSelection: false) { _, _ in nil }
        #expect(focus.selection == .station(station))
    }

    // From the ground a tap opens what it lands on, as on the globe, and a tap on
    // empty sky keeps what is open, whatever the crosshair holds.
    @Test func aTapInTheSkyViewOpensOnlyWhatItLandsOn() {
        var focus = Focus()
        _ = focus.enterSky(at: station)
        focus.tap(Focus.Tap(), keepingSelection: false) { _, _ in nil }
        #expect(focus.selection == nil)
        focus.tap(Focus.Tap(entity: { "a" }), keepingSelection: false) { _, _ in nil }
        #expect(focus.selection == .satellite("a"))
        focus.tap(Focus.Tap(), keepingSelection: false) { _, _ in nil }
        #expect(focus.selection == .satellite("a"))
    }

    @Test func aDoubleTapInTheSkyViewDoesNothing() {
        var focus = Focus()
        _ = focus.enterSky(at: station)
        let before = focus
        #expect(focus.doubleTap(Focus.Tap(entity: { "a" })).isEmpty)
        #expect(focus == before)

        var globe = Focus()
        #expect(globe.doubleTap(Focus.Tap(entity: { "a" })) == [.track(.satellite("a"), animated: false)])
        #expect(globe.tracked == .satellite("a"))
        #expect(globe.selection == .satellite("a"))
    }

    @Test func nothingIsTrackedFromTheGround() {
        var focus = Focus()
        _ = focus.follow(.satellite("a"))
        #expect(focus.enterSky(at: station) == [.stopTracking(animated: false), .enterSky(station, animated: true)])
        #expect(focus.tracked == nil)
        #expect(focus.follow(.satellite("b")).isEmpty)
        #expect(focus.tracked == nil)
        #expect(focus.trackedSatellite == nil)
    }

    @Test func aDeletedStationIsReleasedAndItsSkyViewLeft() {
        var focus = Focus()
        _ = focus.follow(.station(station))
        #expect(focus.trackedSatellite == nil)
        #expect(focus.stationsChanged(to: [station, other]).isEmpty)
        #expect(focus.stationsChanged(to: [other]) == [.stopTracking(animated: false)])
        #expect(focus.tracked == nil)
        #expect(focus.selection == nil)

        _ = focus.enterSky(at: other)
        focus.select(.station(other))
        #expect(focus.stationsChanged(to: []) == [.leaveSky(animated: true)])
        #expect(focus.observer == nil)
        #expect(focus.selection == nil)
    }

    @Test func goingHomeStopsTracking() {
        var focus = Focus()
        _ = focus.follow(.satellite("a"), animated: true)
        #expect(focus.goHome() == [.stopTracking(animated: true), .flyHome(animated: true)])
        #expect(focus.tracked == nil)
        #expect(focus.selection == .satellite("a"))
        #expect(focus.goHome() == [.flyHome(animated: true)])

        // From the sky view, only back onto the globe.
        _ = focus.enterSky(at: station)
        #expect(focus.goHome() == [.leaveSky(animated: true)])
        #expect(focus.observer == nil)
    }

    @Test func aLinkLetsGoOfEverythingButPicking() {
        var focus = Focus()
        _ = focus.follow(.satellite("a"))
        focus.setPicking(true)
        #expect(focus.clear() == [.stopTracking(animated: false)])
        #expect(focus.selection == nil)
        #expect(focus.isPicking)
        _ = focus.enterSky(at: station)
        #expect(focus.clear() == [.leaveSky(animated: true)])
    }

    @Test func aRenamedSatelliteStaysFollowedAndOpenByItsCatalogNumber() throws {
        let record = try GPRecord.decodePayload(Parity.fixture("parity-input"))[0]
        var catalog = Catalog()
        catalog.add([record], tags: ["Weather"], group: "weather")
        let id = Catalog.id(of: record)
        var focus = Focus()
        _ = focus.follow(.satellite(id))
        #expect(!focus.hasLost(in: catalog))

        var renamed = record
        renamed.name = "RENAMED"
        catalog.add([renamed], tags: ["Weather"], group: "weather")
        let next = Catalog.id(of: renamed)
        #expect(focus.hasLost(in: catalog))
        #expect(focus.catalogChanged(to: catalog) == [.track(.satellite(next), animated: false)])
        #expect(focus.tracked == .satellite(next))
        #expect(focus.selection == .satellite(next))
        #expect(!focus.hasLost(in: catalog))

        // Decayed: let go of.
        catalog.add([], tags: ["Weather"], group: "weather")
        #expect(focus.catalogChanged(to: catalog) == [.stopTracking(animated: false)])
        #expect(focus.tracked == nil)
        #expect(focus.selection == nil)
    }

    // 578a54ca: a link's `track` follows alone, as on the web, and a satellite
    // followed on to its successor, or kept, stays unselected.
    @Test func followingWithoutSelectingLeavesTheSelectionAlone() throws {
        let record = try GPRecord.decodePayload(Parity.fixture("parity-input"))[0]
        var catalog = Catalog()
        catalog.add([record], tags: ["Weather"], group: "weather")
        let followed = Selection.satellite(Catalog.id(of: record))
        var focus = Focus()
        #expect(focus.follow(followed, selecting: false) == [.track(followed, animated: false)])
        #expect(focus.selection == nil)

        catalog.add([record], tags: ["Weather"], group: "weather")
        #expect(focus.catalogChanged(to: catalog).isEmpty)
        #expect(focus.selection == nil)

        var renamed = record
        renamed.name = "RENAMED"
        catalog.add([renamed], tags: ["Weather"], group: "weather")
        #expect(focus.catalogChanged(to: catalog) == [.track(.satellite(Catalog.id(of: renamed)), animated: false)])
        #expect(focus.tracked == .satellite(Catalog.id(of: renamed)))
        #expect(focus.selection == nil)
    }

    @Test func aRenamedSatelliteOpenButNotFollowedStaysOpen() throws {
        let record = try GPRecord.decodePayload(Parity.fixture("parity-input"))[0]
        var catalog = Catalog()
        catalog.add([record], tags: ["Weather"], group: "weather")
        var focus = Focus()
        focus.select(.satellite(Catalog.id(of: record)))
        var renamed = record
        renamed.name = "RENAMED"
        catalog.add([renamed], tags: ["Weather"], group: "weather")
        #expect(focus.catalogChanged(to: catalog).isEmpty)
        #expect(focus.selection == .satellite(Catalog.id(of: renamed)))
        #expect(focus.tracked == nil)
    }
}
