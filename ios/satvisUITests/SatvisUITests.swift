import CoreLocation
import XCTest

nonisolated class SatvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // With no worker to answer, the groups come from the copy on disk or the
    // test catalog, so the test needs no network.
    @MainActor
    func testFindsASatelliteWithoutTheWorker() {
        _ = search("METOP-C")
    }

    // A search result's info button switches it on and opens its panel.
    @MainActor
    func testOpensASatelliteFromTheBrowser() {
        let app = search("METOP-C")
        app.buttons["Details of METOP-C"].tap()
        XCTAssert(app.navigationBars["METOP-C"].waitForExistence(timeout: 10))
        XCTAssert(app.buttons["Track"].exists)
        if isRoomy(app) {
            // The browser's panel closes under the card, as on the web.
            XCTAssert(app.searchFields["Search satellites"].waitForNonExistence(timeout: 5))
        } else {
            // On a phone the column stays folded, clear of the satellite's panel.
            XCTAssertEqual(menuToggle(app).label, "Menu")
        }
    }

    // Where there is room, Satellites is a panel beside the menu column, as on the
    // web: the globe stays in reach, its entry is lit, a group drills in, and the
    // entry closes it again.
    @MainActor
    func testBrowsesSatellitesBesideTheMenu() throws {
        let app = launch()
        openMenu(app)
        try XCTSkipIf(!isRoomy(app), "A compact width's browser is a sheet")
        let entry = app.buttons["Satellites"]
        entry.tap()
        let search = app.searchFields["Search satellites"]
        XCTAssert(search.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Done"].exists)
        XCTAssert(entry.isSelected)
        XCTAssert(app.buttons["Clear all"].exists)
        // Beside the column, not over it.
        XCTAssertGreaterThan(search.frame.minX, entry.frame.maxX)
        // Below the list's foot on an iPad mini in landscape, where the lazy list has
        // no row for it until scrolled to.
        let group = app.staticTexts["Weather"].firstMatch
        XCTAssert(app.staticTexts["Active"].firstMatch.waitForExistence(timeout: 10))
        for _ in 0..<6 where !(group.exists && group.isHittable) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssert(group.isHittable)
        group.tap()
        XCTAssert(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Details of '")).firstMatch.waitForExistence(timeout: 10))
        entry.tap()
        XCTAssert(search.waitForNonExistence(timeout: 5))
    }

    // The groups read A to Z, ignoring case, as the web app's `localeCompare` sorts
    // them: the index lists Eutelsat last, and code points put GNSS before Globalstar.
    @MainActor
    func testListsTheGroupsAToZ() {
        let app = launch()
        openMenu(app)
        app.buttons["Satellites"].tap()
        let rows = ["Active", "Cubesat", "Eutelsat", "Globalstar", "GNSS"].map { app.staticTexts[$0].firstMatch }
        XCTAssert(rows[0].waitForExistence(timeout: 10))
        let tops = rows.map(\.frame.minY)
        XCTAssertEqual(tops, tops.sorted())
    }

    // A link opens on what it names, as on the web: the satellite enabled and
    // tracked, its panel closed, as `track` follows alone.
    @MainActor
    func testOpensALink() {
        let app = launch(link: "/?tags=&sats=METOP-B&track=METOP-B&elements=Point,Label,Orbit")
        let stop = app.buttons["Stop tracking"].firstMatch
        XCTAssert(stop.waitForExistence(timeout: 20))
        XCTAssertFalse(app.navigationBars["METOP-B"].exists)
        // The corner's, there while the panel is closed.
        stop.tap()
        XCTAssert(stop.waitForNonExistence(timeout: 5))
        XCTAssert(app.buttons["Home view"].exists)
    }

    // The Spacecraft tab's links are one row, which opens a menu of the five sites.
    @MainActor
    func testOpensTheLinksFromAMenu() {
        let app = search("METOP-C")
        app.buttons["Details of METOP-C"].tap()
        XCTAssert(app.navigationBars["METOP-C"].waitForExistence(timeout: 10))
        app.buttons["Spacecraft"].tap()
        let links = app.buttons["Links"]
        // Under a phone's half-height sheet, in a lazy list.
        for _ in 0..<3 where !links.waitForExistence(timeout: 2) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssertEqual(links.value as? String, "5 sites")
        links.tap()
        for site in ["CelesTrak", "Satcat", "n2yo", "Heavens-Above", "KeepTrack"] {
            XCTAssert(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", site)).firstMatch.waitForExistence(timeout: 5), site)
        }
    }

    // The Instruments tab is a table, a line an instrument CEOS lists: its name, Retired
    // once its mission is over, its finest resolution or a dash, and its bands, which a
    // press unfolds into its kind and facts; under the table, the credit CC BY asks for.
    @MainActor
    func testListsTheInstruments() {
        let app = search("INSAT-3D")
        app.buttons["Details of INSAT-3D"].tap()
        XCTAssert(app.navigationBars["INSAT-3D"].waitForExistence(timeout: 10))
        app.buttons["Instruments"].tap()
        // The full names beside the short ones where the panel has room for them, as on the web.
        let roomy = isRoomy(app)
        let imager = app.buttons["Imager (INSAT 3D), \(roomy ? "Very High Resolution Radiometer, " : "")Retired, 1 km, Bands: VIS, SWIR, MWIR, TIR"]
        XCTAssert(imager.waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Sounder (INSAT), \(roomy ? "IR Sounder, " : "")Retired, Bands: VIS, MWIR, TIR"].exists)
        let kind = app.descendants(matching: .any)["Kind, Multi-purpose imaging Vis/IR radiometer"]
        XCTAssertFalse(kind.exists)
        // No layer shows any of INSAT-3D's instruments, and each has figures for the table.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Imagery'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["Also carries"].exists)
        imager.tap()
        for label in ["Very High Resolution Radiometer", "Kind, Multi-purpose imaging Vis/IR radiometer", "Resolution, 1 km", "CEOS MIM Database, CC BY 4.0"] {
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            // Under a phone's half-height sheet, in a lazy list.
            for _ in 0..<4 where !row.waitForExistence(timeout: 2) {
                app.collectionViews.firstMatch.swipeUp()
            }
            XCTAssert(row.exists, label)
        }
    }

    // An instrument CEOS gives no bands, resolution or imagery for is a chip under the
    // table, which unfolds its facts as a line does.
    @MainActor
    func testFoldsTheInstrumentsWithoutFiguresIntoChips() {
        let app = search("GOES 19")
        app.buttons["Details of GOES 19"].tap()
        XCTAssert(app.navigationBars["GOES 19"].waitForExistence(timeout: 10))
        app.buttons["Instruments"].tap()
        let exis = app.buttons["EXIS"]
        // Under a phone's half-height sheet, in a lazy list.
        for _ in 0..<4 where !exis.waitForExistence(timeout: 2) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssert(app.staticTexts["Also carries"].exists)
        for chip in ["Magnetometer (GOES)", "SEISS", "DCS (GOES)"] {
            XCTAssert(app.buttons[chip].exists, chip)
        }
        // CCOR-1 has a band, so a line.
        XCTAssertFalse(app.buttons["CCOR-1"].exists)
        XCTAssert(app.buttons["CCOR-1, \(isRoomy(app) ? "Compact Coronagraph - 1, " : "")Bands: VIS"].exists)
        exis.tap()
        let kind = app.descendants(matching: .any)["Kind, Solar irradiance monitor"]
        for _ in 0..<3 where !kind.waitForExistence(timeout: 2) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssert(kind.exists)
    }

    // An instrument with imagery has a button on its line that opens the Imagery tab,
    // a card a layer: the picture under the instrument's name, what the layer is, and a
    // link to it in its provider's viewer.
    @MainActor
    func testOpensAnInstrumentsImageryFromItsLine() {
        let app = search("METEOSAT-12 (MTG-I1)")
        app.buttons["Details of METEOSAT-12 (MTG-I1)"].tap()
        XCTAssert(app.navigationBars["METEOSAT-12 (MTG-I1)"].waitForExistence(timeout: 10))
        app.buttons["Instruments"].tap()
        let button = app.buttons["Imagery of FCI"]
        XCTAssert(button.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Imagery of LI"].exists)
        button.tap()
        XCTAssert(app.buttons["Imagery (2)"].waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Imagery (2)"].isSelected)
        for layer in ["GeoColour", "True colour"] {
            let picture = app.images["FCI, \(layer)"]
            // Under a phone's half-height sheet, in a lazy list.
            for _ in 0..<3 where !picture.waitForExistence(timeout: 2) {
                app.collectionViews.firstMatch.swipeUp()
            }
            XCTAssert(picture.exists, layer)
        }
        let detail = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'True colour, every 10 min since 2024'")).firstMatch
        for _ in 0..<3 where !detail.waitForExistence(timeout: 2) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssert(detail.exists)
        let link = app.links["Open in EUMETView"].firstMatch
        for _ in 0..<3 where !link.waitForExistence(timeout: 2) {
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssert(link.exists)
    }

    // An instrument's imagery button opens the Imagery tab at that instrument's first
    // card, here the second; the tab opened from the tab row starts at the top.
    @MainActor
    func testOpensTheImageryTabAtTheInstrumentsCard() {
        let app = search("TERRA")
        app.buttons["Details of TERRA"].tap()
        XCTAssert(app.navigationBars["TERRA"].waitForExistence(timeout: 10))
        app.buttons["Instruments"].tap()
        let button = app.buttons["Imagery of MODIS"]
        XCTAssert(button.waitForExistence(timeout: 5))
        button.tap()
        let tabs = app.buttons["Imagery (2)"]
        XCTAssert(tabs.waitForExistence(timeout: 5))
        let modis = app.images["MODIS, True colour"]
        XCTAssert(modis.waitForExistence(timeout: 5))
        // Whole, and under the pinned tab row, once the scroll has settled.
        let list = app.collectionViews.firstMatch
        let shown = NSPredicate { _, _ in modis.frame.minY >= tabs.frame.maxY && modis.frame.maxY <= list.frame.maxY }
        wait(for: [XCTNSPredicateExpectation(predicate: shown, object: nil)], timeout: 5)
        // Another tab, then back: the focus is forgotten, and the first card on top.
        app.buttons["Instruments"].tap()
        XCTAssert(button.waitForExistence(timeout: 5))
        tabs.tap()
        let misr = app.images["MISR, True colour, nadir camera, Ended 2022-10-12"]
        XCTAssert(misr.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(misr.frame.minY, tabs.frame.maxY)
        XCTAssertLessThan(misr.frame.minY, tabs.frame.maxY + 60)
    }

    // The Graphics panel's Hide UI hides the menu column, the clock deck and the
    // corner's buttons, as the web app's does, and the corner's Show UI, there
    // alone while they are hidden, brings them back with the panel closed.
    @MainActor
    func testHidesTheUI() {
        let app = launch()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Show UI"].exists)
        openMenu(app)
        app.buttons["Graphics"].tap()
        app.buttons["Hide UI"].tap()
        let show = app.buttons["Show UI"]
        XCTAssert(show.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Home view"].exists)
        XCTAssertFalse(app.buttons["Hide UI"].exists)
        XCTAssertFalse(menuToggle(app).exists)
        // The clock deck's time, which is a button.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'UTC'")).firstMatch.exists)
        show.tap()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 5))
        XCTAssert(menuToggle(app).exists)
        XCTAssertFalse(show.exists)
        XCTAssertFalse(app.buttons["Hide UI"].exists)
    }

    // The web app's menu column unfolds from the menu button, folded on a phone
    // and open from the start on an iPad, and the menus among it open.
    @MainActor
    func testOpensTheToolsFromTheMenu() {
        let app = launch()
        let toggle = menuToggle(app)
        XCTAssert(toggle.waitForExistence(timeout: 30))
        if isRoomy(app) {
            XCTAssertEqual(toggle.label, "Close menu")
        } else {
            XCTAssertFalse(app.buttons["Map"].exists)
            toggle.tap()
        }
        for entry in ["Bookmarks", "Satellites", "Components", "Map", "Locations", "Globe", "Sky", "Graphics", "About"] {
            XCTAssert(app.buttons[entry].waitForExistence(timeout: 5), "No \(entry) in the menu")
        }
        app.buttons["Components"].tap()
        XCTAssert(app.descendants(matching: .any)["Orbit track"].waitForExistence(timeout: 5))
    }

    // A tap on the globe puts the menu back as it starts, as on the web: the panel
    // closed, and on a phone the column folded.
    @MainActor
    func testClosesTheMenuOnATapOnTheGlobe() {
        let app = launch()
        openMenu(app)
        app.buttons["Components"].tap()
        let panel = app.descendants(matching: .any)["Orbit track"]
        XCTAssert(panel.waitForExistence(timeout: 5))
        // Right of the globe's middle, clear of the menu and its panel, the buttons
        // and the clock, on an iPhone Duo's short cover display too. On the window:
        // an iPhone Duo opened sends the app's own gestures to its dark cover.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.62)).tap()
        XCTAssert(panel.waitForNonExistence(timeout: 5))
        XCTAssertEqual(menuToggle(app).label, isRoomy(app) ? "Close menu" : "Menu")
    }

    // A sheet opened from the menu column and closed again leaves the column as it
    // was: on a phone it folds under the sheet and unfolds as the sheet goes.
    @MainActor
    func testReopensTheMenuAfterASheet() throws {
        let app = launch()
        try XCTSkipIf(isRoomy(app), "A regular width's column never folds")
        openMenu(app)
        for entry in ["Satellites", "Bookmarks"] {
            app.buttons[entry].tap()
            let done = app.buttons["Done"]
            XCTAssert(done.waitForExistence(timeout: 10), "No \(entry) sheet")
            done.tap()
            XCTAssert(done.waitForNonExistence(timeout: 5))
            XCTAssert(app.buttons[entry].waitForExistence(timeout: 5), "The menu stayed folded after \(entry)")
            XCTAssertEqual(menuToggle(app).label, "Close menu")
        }
    }

    // At the largest text the menu column is taller than a phone: its entries
    // scroll under the toggle, and the last of them is still reached.
    @MainActor
    func testScrollsTheMenuAtTheLargestText() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launchEnvironment["SATVIS_TEST_CATALOG"] = "1"
        app.launchEnvironment["SATVIS_LINK"] = "/"
        app.launch()
        openMenu(app)
        let about = app.buttons["About"]
        // Dragged from inside the column, under the toggle, whichever entries are there.
        let toggle = menuToggle(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        for _ in 0..<4 where !(about.exists && about.isHittable) {
            toggle.withOffset(CGVector(dx: 0, dy: 400)).press(forDuration: 0.05, thenDragTo: toggle.withOffset(CGVector(dx: 0, dy: 100)))
        }
        XCTAssert(about.isHittable)
        about.tap()
        XCTAssert(app.navigationBars["About Satvis"].waitForExistence(timeout: 10))
    }

    // Locations is a panel beside the menu, as on the web: a link's stations are
    // saved from it, dragged into place by their grips and removed by their
    // crosses, and a pick on the globe that is cancelled opens it again.
    @MainActor
    func testEditsLocationsInTheirPanel() {
        // Each launch starts with no saved stations (`TestCatalog.stationDefaults`).
        let app = launch(link: "/?gs=48.1372,11.5756,Testhausen_47.2692,11.4041,Probeburg")
        openMenu(app)
        app.buttons["Locations"].tap()
        for _ in 0..<2 {
            let save = app.buttons["Save"].firstMatch
            XCTAssert(save.waitForExistence(timeout: 5))
            save.tap()
        }
        let names = { app.textFields.allElementsBoundByIndex.compactMap { $0.value as? String } }
        XCTAssert(app.textFields["Name"].waitForExistence(timeout: 5))
        XCTAssertLessThan(names().firstIndex(of: "Testhausen") ?? .max, names().firstIndex(of: "Probeburg") ?? .min)

        // Slowly, and held over the target: let go on arrival with every core busy,
        // the drag ended before the drop session saw the target, in 2 runs of 12.
        let grip = app.descendants(matching: .any)["Reorder Probeburg"]
        grip.press(forDuration: 1, thenDragTo: app.descendants(matching: .any)["Reorder Testhausen"], withVelocity: .slow, thenHoldForDuration: 1)
        let moved = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in (names().firstIndex(of: "Probeburg") ?? .max) < (names().firstIndex(of: "Testhausen") ?? .min) },
            object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed, "Probeburg was not dragged above Testhausen")

        app.buttons["Remove Testhausen"].tap()
        app.buttons["Remove Probeburg"].tap()
        XCTAssert(app.buttons["Remove Probeburg"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(names().contains("Testhausen"))

        app.buttons["Pick on globe"].tap()
        XCTAssert(app.staticTexts["Tap the globe to place a ground station"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Pick on globe"].exists)
        app.buttons["Cancel"].tap()
        XCTAssert(app.buttons["Pick on globe"].waitForExistence(timeout: 5))
    }

    // A finger held on the globe opens its menu, as a right click does on the web,
    // and leaves the open panel open: Add places a station and opens its panel, and
    // the menu held on its pin removes it.
    @MainActor
    func testPlacesAndRemovesAStationFromTheGlobe() {
        let app = launch()
        openMenu(app)
        app.buttons["Components"].tap()
        let panel = app.descendants(matching: .any)["Orbit track"]
        XCTAssert(panel.waitForExistence(timeout: 5))
        // On the globe, right of its middle and below the panel, which reaches 475 pt
        // down a 390 × 844 phone. On the window, for an iPhone Duo opened.
        let spot = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6))
        let add = app.buttons["Add ground station here"]
        // Until the globe has drawn a frame to find the ground in. Just past the
        // hold: lifted at 0.6 s, SwiftUI still reports a tap, which closed the panel;
        // at 1 s it reports none.
        for _ in 0..<3 where !add.exists {
            spot.press(forDuration: 0.6)
            _ = add.waitForExistence(timeout: 5)
        }
        XCTAssert(add.exists)
        XCTAssert(panel.exists, "The hold closed the panel as a tap would")
        add.tap()
        let sky = app.buttons["View the sky from here"]
        XCTAssert(sky.waitForExistence(timeout: 5))
        // The station's own, not the panel's: a phone's sheet covers the pin.
        app.navigationBars.buttons["Close"].firstMatch.tap()
        XCTAssert(sky.waitForNonExistence(timeout: 5))

        spot.press(forDuration: 1)
        let remove = app.buttons["Remove ground station"]
        XCTAssert(remove.waitForExistence(timeout: 5))
        XCTAssertFalse(add.exists)
        remove.tap()
        // No pin there now: the ground's menu again.
        XCTAssert(remove.waitForNonExistence(timeout: 5))
        spot.press(forDuration: 1)
        XCTAssert(add.waitForExistence(timeout: 5))

        // A tap elsewhere closes it, and the next tap on the globe is a tap again,
        // which closes the panel: SwiftUI gives every touch the same id, which had
        // kept the first hold for good.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.9)).tap()
        XCTAssert(add.waitForNonExistence(timeout: 5))
        if !panel.exists {
            openMenu(app)
            app.buttons["Components"].tap()
            XCTAssert(panel.waitForExistence(timeout: 5))
        }
        spot.tap()
        XCTAssert(panel.waitForNonExistence(timeout: 5))
    }

    // The 2D map finds its ground apart from the globe's.
    @MainActor
    func testAddsAStationFromTheMap() {
        let app = launch(link: "/?scene=2D")
        let spot = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        let add = app.buttons["Add ground station here"]
        for _ in 0..<3 where !add.exists {
            spot.press(forDuration: 1)
            _ = add.waitForExistence(timeout: 5)
        }
        add.tap()
        XCTAssert(app.buttons["View the sky from here"].waitForExistence(timeout: 5))
    }

    // My location stands where the device is, kept as "Geolocation", first in the
    // list, and Back to the globe leaves the sky view again.
    @MainActor
    func testLooksUpFromWhereTheDeviceIs() {
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 47.2692, longitude: 11.4041))
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .location)
        let launched = launch(link: "/?gs=48.1372,11.5756,Munich")
        openMenu(launched)
        launched.buttons["Sky"].tap()
        let here = launched.buttons["My location"]
        XCTAssert(here.waitForExistence(timeout: 5))
        here.tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow While Using App"]
        if allow.waitForExistence(timeout: 10) {
            allow.tap()
        }
        XCTAssert(launched.buttons["Leave the sky view"].waitForExistence(timeout: 20))
        XCTAssert(here.isSelected)
        // Touches soon after the location prompt are lost on the iOS 27 simulator,
        // sometimes more than one (ios/docs/manual-verification.md): up to three tries.
        let back = launched.buttons["Back to the globe"]
        for _ in 0..<3 where !launched.buttons["Home view"].exists {
            if back.exists {
                back.tap()
            }
            _ = launched.buttons["Home view"].waitForExistence(timeout: 5)
        }
        XCTAssert(launched.buttons["Home view"].exists)
        // Kept first in the list, as on the web.
        launched.buttons["Locations"].tap()
        let first = launched.textFields.firstMatch
        XCTAssert(first.waitForExistence(timeout: 5))
        XCTAssertEqual(first.value as? String, "Geolocation")
    }

    // A location's row in the Sky panel stands there, marked, without the device's
    // position, on the terrain, which credits OpenStreetMap; Back to the globe leaves.
    @MainActor
    func testLooksUpFromALocation() {
        let app = launch(link: "/?gs=48.1372,11.5756,Munich")
        openMenu(app)
        app.buttons["Sky"].tap()
        let munich = app.buttons["Munich"]
        XCTAssert(munich.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Back to the globe"].exists)
        munich.tap()
        XCTAssert(app.buttons["© OpenStreetMap"].waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Leave the sky view"].waitForExistence(timeout: 20))
        XCTAssert(munich.isSelected)
        XCTAssertFalse(app.buttons["My location"].isSelected)
        app.buttons["Back to the globe"].tap()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 10))
        XCTAssertFalse(munich.isSelected)
    }

    // The sky view holds the camera, keeping a link's camera mode for the globe,
    // and the Globe panel's projection takes the view back there.
    @MainActor
    func testReturnsToTheGlobeFromTheGlobePanel() {
        let app = launch(link: "/?gs=48.1372,11.5756,Munich&scene=Sky&camera=Inertial")
        openMenu(app)
        app.buttons["Globe"].tap()
        let projection = app.buttons["3D"]
        XCTAssert(projection.waitForExistence(timeout: 5))
        XCTAssertFalse(projection.isSelected)
        let note = app.staticTexts["Select a projection to leave sky view."]
        XCTAssert(note.exists)
        // A disabled picker's segments read as enabled; the control does not.
        let camera = app.segmentedControls.element(boundBy: 1)
        let inertial = camera.buttons["Inertial"]
        XCTAssert(inertial.isSelected)
        XCTAssertFalse(camera.isEnabled)
        projection.tap()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 10))
        XCTAssert(projection.isSelected)
        XCTAssertFalse(note.exists)
        XCTAssert(camera.isEnabled && inertial.isSelected)
        app.buttons["Fixed"].tap()
        XCTAssert(app.buttons["Fixed"].isSelected)
    }

    // A link that names 2D opens on the map, which the Globe panel switches to 3D
    // and back; from the sky view, 2D leaves it for the map.
    @MainActor
    func testSwitchesTo2DAndBack() {
        let app = launch(link: "/?scene=2D&gs=48.1372,11.5756,Munich")
        openMenu(app)
        app.buttons["Globe"].tap()
        let twoD = app.buttons["2D"]
        let threeD = app.buttons["3D"]
        XCTAssert(twoD.waitForExistence(timeout: 5))
        XCTAssert(twoD.isSelected)
        threeD.tap()
        XCTAssert(threeD.isSelected)
        XCTAssertFalse(twoD.isSelected)
        twoD.tap()
        XCTAssert(twoD.isSelected)

        app.buttons["Sky"].tap()
        let munich = app.buttons["Munich"]
        XCTAssert(munich.waitForExistence(timeout: 5))
        munich.tap()
        XCTAssert(app.buttons["Leave the sky view"].waitForExistence(timeout: 20))
        app.buttons["Globe"].tap()
        XCTAssert(app.staticTexts["Select a projection to leave sky view."].waitForExistence(timeout: 5))
        XCTAssertFalse(twoD.isSelected)
        twoD.tap()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 10))
        XCTAssert(twoD.isSelected)
    }

    // A link the app opens with is kept under Recent; saving it moves it to Saved,
    // under the name given, and it opens again from there after the default view.
    @MainActor
    func testSavesAndReopensABookmark() {
        let app = launch(link: "/?tags=&sats=METOP-B&elements=Point,Label")
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        XCTAssert(app.buttons["Recent (1)"].waitForExistence(timeout: 10))
        // The view is shared from here, the corner holding the ways back alone.
        XCTAssert(app.buttons["Share this view"].exists)
        XCTAssertFalse(app.buttons["Share"].exists)
        app.buttons["Save this view"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssert(name.waitForExistence(timeout: 10))
        // Over the name drawn from the scene.
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + "Mine\n")
        XCTAssert(app.alerts.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssert(app.buttons["Saved (1)"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Recent (1)"].exists)
        XCTAssert(app.buttons["Saved"].exists)

        let sheet = app.navigationBars["Bookmarks"]
        app.buttons["Default view"].tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 5))
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mine'")).firstMatch
        XCTAssert(card.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Default view"].isEnabled)
        XCTAssertFalse(card.isSelected)
        card.tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 5))
        // On a phone the column stays folded over the scene the bookmark opened.
        if !isRoomy(app) {
            sleep(1)
            XCTAssertEqual(menuToggle(app).label, "Menu")
        }
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        XCTAssert(card.waitForExistence(timeout: 10))
        XCTAssert(card.isSelected)
        XCTAssert(app.buttons["Default view"].isEnabled)
    }

    // About opens from the menu, and opens a featured bookmark of its carousel, a
    // step on, as its card does.
    @MainActor
    func testOpensAFeaturedBookmarkFromAbout() {
        let app = launch()
        openMenu(app)
        app.buttons["About"].tap()
        let sheet = app.navigationBars["About Satvis"]
        XCTAssert(sheet.waitForExistence(timeout: 5))
        let next = app.buttons["Next bookmark"].firstMatch
        XCTAssert(next.waitForExistence(timeout: 5))
        next.tap()
        let featured = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Follow the ISS'")).firstMatch
        XCTAssert(featured.waitForExistence(timeout: 5))
        featured.tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 5))
    }

    // The terrain draws OpenStreetMap's data, so its name shows beside the clock
    // for five seconds, and opens the acknowledgements.
    @MainActor
    func testCreditsOpenStreetMapWhileTheTerrainIsDrawn() {
        let app = launch(link: "/?terrain=ReEarth")
        let credit = app.buttons["© OpenStreetMap"]
        XCTAssert(credit.waitForExistence(timeout: 30))
        credit.tap()
        XCTAssert(app.navigationBars["Acknowledgements"].waitForExistence(timeout: 5))
        XCTAssert(app.descendants(matching: .any)["OpenStreetMap"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        // Faded after five seconds; About keeps it.
        XCTAssert(credit.waitForNonExistence(timeout: 10))
    }

    // The Map panel ticks the star map a link names, and the Tycho map, which the
    // app lacks, as the Deep Star (1K) it draws instead.
    @MainActor
    func testChoosesTheStarMapALinkNames() {
        var app = XCUIApplication()
        for (link, ticked) in [("/?stars=DeepStar2K", "Deep Star (2K)"), ("/?stars=Tycho1K", "Deep Star (1K)")] {
            app = launch(link: link)
            openMenu(app)
            app.buttons["Map"].tap()
            let choice = app.buttons[ticked]
            XCTAssert(choice.waitForExistence(timeout: 5), link)
            XCTAssert(choice.isSelected, link)
        }
        app.buttons["Deep Star (2K)"].tap()
        XCTAssert(app.buttons["Deep Star (2K)"].isSelected)
        XCTAssertFalse(app.buttons["Deep Star (1K)"].isSelected)
    }

    // Without the terrain no source wants its name over the map: the credits are
    // About's.
    @MainActor
    func testKeepsTheCreditsInAbout() {
        let app = launch()
        XCTAssert(menuToggle(app).waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["© OpenStreetMap"].exists)
        openMenu(app)
        app.buttons["About"].tap()
        XCTAssert(app.navigationBars["About Satvis"].waitForExistence(timeout: 5))
        // At the foot of a lazy list, which has no rows off screen.
        let sharing = app.switches["Share usage data"]
        for _ in 0..<6 where !sharing.exists {
            app.windows.firstMatch.swipeUp()
        }
        XCTAssert(sharing.exists)
        app.buttons["Acknowledgements"].tap()
        XCTAssert(app.descendants(matching: .any)["Imagery courtesy Natural Earth"].waitForExistence(timeout: 5))
    }

    // Paused, the clock falls behind the present, and the deck offers the way back
    // without anything else being touched.
    @MainActor
    func testOffersBackToNowOncePaused() {
        let app = launch()
        let stamp = app.buttons.matching(NSPredicate(format: "label CONTAINS 'UTC'")).firstMatch
        XCTAssert(stamp.waitForExistence(timeout: 30))
        stamp.tap()
        XCTAssert(app.buttons["Pause"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Back to now"].exists)
        app.buttons["Pause"].tap()
        // A minute off the present (`SimulationClock.presentTolerance`) and a tick.
        XCTAssert(app.buttons["Back to now"].waitForExistence(timeout: 75))
    }

    // UTC on a 24-hour clock, in a locale whose own clock has 12 hours.
    @MainActor
    func testReadsUTCOnA24HourClock() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLocale", "en_US", "-AppleLanguages", "(en)"]
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launchEnvironment["SATVIS_TEST_CATALOG"] = "1"
        app.launchEnvironment["SATVIS_LINK"] = "/"
        app.launchEnvironment["SATVIS_TIME"] = "2026-10-04T19:22:00Z"
        app.launch()
        let stamp = app.buttons.matching(NSPredicate(format: "label CONTAINS 'UTC'")).firstMatch
        XCTAssert(stamp.waitForExistence(timeout: 30))
        XCTAssert(stamp.label.contains("19:22"), "The clock read \(stamp.label)")
        XCTAssert(stamp.label.contains("Sun, Oct 04 UTC"), "The clock read \(stamp.label)")
    }

    // The web app's `fps=graph` shows the performance panel with its graph, which
    // a tap folds away; the Graphics panel's FPS switches it off.
    @MainActor
    func testShowsPerformanceFromALink() {
        let app = launch(link: "/?fps=graph")
        let overlay = app.descendants(matching: .any)["Performance"]
        XCTAssert(overlay.waitForExistence(timeout: 30))
        XCTAssertEqual(overlay.value as? String, "Graph")
        overlay.tap()
        XCTAssertEqual(overlay.value as? String, "Compact")
        openMenu(app)
        app.buttons["Graphics"].tap()
        flip(app, "FPS")
        XCTAssert(overlay.waitForNonExistence(timeout: 5))
    }

    // The web app's `bench=true` opens the benchmark panel; Close puts it away,
    // and the Graphics panel brings it back, closing with the menu, which the
    // benchmark's panel stood over.
    @MainActor
    func testOpensTheBenchmarkFromALink() {
        let app = launch(link: "/?bench=true")
        let start = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Run '")).firstMatch
        XCTAssert(start.waitForExistence(timeout: 30))
        app.buttons["Close"].firstMatch.tap()
        XCTAssert(start.waitForNonExistence(timeout: 5))
        openMenu(app)
        app.buttons["Graphics"].tap()
        flip(app, "Benchmark")
        XCTAssert(start.waitForExistence(timeout: 5))
        XCTAssert(app.switches["Benchmark"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(menuToggle(app).label, "Menu")
    }

    // `bench=run` runs the scenes it names at once and leaves the panel open on the
    // results; the performance panel stays up through the run.
    @MainActor
    func testRunsTheBenchmarkFromALink() {
        let app = launch(link: "/?bench=run&benchscenes=default_view&fps=true")
        XCTAssert(app.buttons["Cancel"].waitForExistence(timeout: 30))
        XCTAssert(app.descendants(matching: .any)["Performance"].exists)
        XCTAssert(app.buttons["Run 1 scene"].waitForExistence(timeout: 120))
        XCTAssertEqual(app.staticTexts["Benchmark status"].label, "Done")
    }

    // As the web app's panel: the scenes ticked run alone, and a measured row
    // opens in place for the rest of its figures.
    @MainActor
    func testRunsTheTickedScenesAndOpensARow() {
        let app = launch(link: "/?bench=true")
        let all = app.descendants(matching: .any)["checkbox All scenes"]
        XCTAssert(all.waitForExistence(timeout: 30))
        all.tap()
        XCTAssertFalse(app.buttons["Run 0 scenes"].isEnabled)
        app.descendants(matching: .any)["checkbox default_view"].tap()
        app.buttons["Run 1 scene"].tap()
        let status = app.staticTexts["Benchmark status"]
        XCTAssert(status.waitForExistence(timeout: 5))
        XCTAssert(waitForLabel(status, "Done", timeout: 120), status.label)
        app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' satellites'")).firstMatch.tap()
        XCTAssert(app.descendants(matching: .any)["Scene details"].waitForExistence(timeout: 5))
        XCTAssert(app.staticTexts["total CPU"].exists)
    }

    // A sweep from the panel's settings, its steps and drift tables after it.
    @MainActor
    func testRunsASweep() {
        let app = launch(link: "/?bench=true&elements=Point")
        let sweep = app.buttons["Sweep"]
        XCTAssert(sweep.waitForExistence(timeout: 30))
        sweep.tap()
        let counts = app.textFields["Counts"]
        counts.tap()
        // Return puts the keyboard away, which would cover the button.
        counts.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30) + "0, 50\n")
        // Two counts, and the first again at the end.
        let run = app.buttons["Run 3 steps"]
        XCTAssert(run.waitForExistence(timeout: 5))
        run.tap()
        XCTAssert(app.buttons["Cancel"].waitForExistence(timeout: 10))
        let status = app.staticTexts["Benchmark status"]
        // Without a drift: the steps differ by under the millisecond it needs.
        XCTAssert(waitForLabel(status, "Done", timeout: 120), status.label)
        XCTAssert(app.staticTexts["Steps"].exists)
        XCTAssert(app.staticTexts["Drift: the first step again at the end"].exists)
    }

    // On a phone a menu entry's sheet takes the place of a satellite's: SwiftUI
    // presents one sheet at a time, and the entry opened nothing.
    @MainActor
    func testOpensASheetOverASatellitesSheet() throws {
        let app = search("METOP-C")
        try XCTSkipIf(isRoomy(app), "A regular width's satellite panel is a card")
        app.buttons["Details of METOP-C"].tap()
        XCTAssert(app.navigationBars["METOP-C"].waitForExistence(timeout: 10))
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        XCTAssert(app.navigationBars["Bookmarks"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.navigationBars["METOP-C"].exists)
    }

    // A station's panel closes on the way into its sky view: as a card it covered
    // the corner's buttons and the compass tape.
    @MainActor
    func testClosesAStationsPanelForItsSky() {
        let app = launch(link: "/?gs=48.1372,11.5756,Munich")
        openMenu(app)
        app.buttons["Locations"].tap()
        // A link's station has no panel of its own until saved.
        let save = app.buttons["Save"].firstMatch
        XCTAssert(save.waitForExistence(timeout: 5))
        save.tap()
        let show = app.buttons["Show passes"].firstMatch
        XCTAssert(show.waitForExistence(timeout: 5))
        show.tap()
        let sky = app.buttons["View the sky from here"]
        XCTAssert(sky.waitForExistence(timeout: 10))
        sky.tap()
        XCTAssert(app.buttons["Leave the sky view"].waitForExistence(timeout: 20))
        XCTAssert(sky.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Munich"].exists)
    }

    /// Whether the app has an iPad's width, where the menu column opens from the
    /// start and never folds: an iPhone Duo opened has it too, and is no `.pad`.
    @MainActor
    private func isRoomy(_ app: XCUIApplication) -> Bool {
        app.windows.firstMatch.horizontalSizeClass == .regular
    }

    /// The menu column's toggle, named for what a tap on it does: "Menu" folded,
    /// "Close menu" open.
    @MainActor
    private func menuToggle(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label IN {'Menu', 'Close menu'}")).firstMatch
    }

    /// Flips a panel's switch by the switch itself: a tap in the middle of the row
    /// lands on its name, which does not.
    @MainActor
    private func flip(_ app: XCUIApplication, _ name: String) {
        let row = app.switches[name]
        XCTAssert(row.waitForExistence(timeout: 5))
        let control = row.switches.firstMatch
        (control.exists ? control : row).tap()
    }

    /// Unfolds the menu column, unless it is open already, as on an iPad.
    @MainActor
    private func openMenu(_ app: XCUIApplication) {
        let toggle = menuToggle(app)
        XCTAssert(toggle.waitForExistence(timeout: 30))
        if toggle.label == "Menu" {
            toggle.tap()
            // Its rows take no taps while they fade in, and one reaches the globe.
            sleep(1)
        }
    }

    /// Launches with no worker to answer, on the app's fixed test catalog
    /// (`TestCatalog`), on a link: by default the plain site, rather than the view
    /// an earlier run left.
    @MainActor
    private func launch(link: String = "/") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launchEnvironment["SATVIS_TEST_CATALOG"] = "1"
        app.launchEnvironment["SATVIS_LINK"] = link
        app.launch()
        return app
    }

    /// Whether `element`'s label starts with `prefix` within `timeout` seconds.
    @MainActor
    private func waitForLabel(_ element: XCUIElement, _ prefix: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", prefix), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    /// Launches and searches the satellite browser.
    @MainActor
    private func search(_ name: String) -> XCUIApplication {
        let app = launch()

        openMenu(app)
        app.buttons["Satellites"].tap()
        let search = app.searchFields["Search satellites"]
        // A sheet on a phone, a panel with no bar where there is room.
        XCTAssert((isRoomy(app) ? search : app.navigationBars["Satellites"]).waitForExistence(timeout: 10))
        // An iPhone Duo closed keeps the field in a Search button at the foot.
        if !search.exists {
            app.buttons["Search"].tap()
        }
        XCTAssert(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText(name)
        XCTAssert(app.buttons[name].waitForExistence(timeout: 10))
        return app
    }

    // The App Store screenshots: the Bookmarks sheet's three featured bookmarks,
    // opened from their cards as anyone would, so they show what one shows. Globe, sky,
    // ISS: the first three are the search result's. Only scripts/screenshots.sh
    // takes them, against BASE_URL, at the bookmark's `pictureAt` in the core config.

    @MainActor
    func testScreenshot1Globe() throws {
        let app = try openFeatured("Weather satellites")
        screenshot(app, "1Globe")
    }

    // Night in the Lauterbrunnen valley. The terrain refines a level at a time
    // from an empty cache, a few seconds a tile, on three simulators at once: 30 s
    // left an iPad's cliffs coarse.
    @MainActor
    func testScreenshot2Sky() throws {
        let app = try openFeatured("Sky over Lauterbrunnen", wait: 60)
        screenshot(app, "2Sky")
    }

    // Over the Tyrrhenian Sea, Italy beside it: over desert the station was hard
    // to make out.
    @MainActor
    func testScreenshot3ISS() throws {
        let app = try openFeatured("Follow the ISS")
        screenshot(app, "3ISS")
    }

    /// Launches on BASE_URL's site with its clock stopped at TIME (UTC), so
    /// that every device shows the same moment, opens the featured bookmark of that name from
    /// the Bookmarks sheet, which leaves a stopped clock where it is, and waits
    /// `wait` seconds for the tiles.
    @MainActor
    func openFeatured(_ name: String, wait: UInt32 = 20) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SCREENSHOTS"] != nil, let time = environment["TIME"] else {
            throw XCTSkip("Taken by scripts/screenshots.sh")
        }
        let app = XCUIApplication()
        if let site = environment["BASE_URL"] {
            app.launchEnvironment["SATVIS_API"] = site
        }
        // The default view, not the one the last shot left.
        app.launchEnvironment["SATVIS_LINK"] = "/"
        app.launchEnvironment["SATVIS_TIME"] = "\(time)Z"
        app.launch()
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        // Labelled by its name first, then what it shows.
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name), ")).firstMatch
        XCTAssert(card.waitForExistence(timeout: 30))
        card.tap()
        XCTAssert(app.navigationBars["Bookmarks"].waitForNonExistence(timeout: 10))
        sleep(wait)
        return app
    }

    /// Attaches the screen the app is on, status bar and all. Not always the main
    /// one: an iPhone Duo opened shows the app on its second, the inner display,
    /// a picture a pixel short each way, 2006 by 2852, and turned on its side by
    /// its orientation tag (`scripts/caption.swift` takes both).
    @MainActor
    func screenshot(_ app: XCUIApplication, _ name: String) {
        let window = app.windows.firstMatch.frame.size
        let shot =
            XCUIScreen.screens.lazy.map { $0.screenshot() }
            .first { abs($0.image.size.width - window.width) < 2 && abs($0.image.size.height - window.height) < 2 }
            ?? XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
