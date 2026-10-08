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
    }

    // A link opens on what it names, as on the web: the satellite enabled and
    // tracked, its panel open.
    @MainActor
    func testOpensALink() {
        let app = launch(link: "/?tags=&sats=METOP-B&track=METOP-B&elements=Point,Label,Orbit")
        XCTAssert(app.navigationBars["METOP-B"].waitForExistence(timeout: 20))
        XCTAssert(app.buttons["Stop tracking"].firstMatch.exists)
    }

    // The web app's menu column unfolds from the menu button, folded on a phone
    // and open from the start on an iPad, and the menus among it open.
    @MainActor
    func testOpensTheToolsFromTheMenu() {
        let app = launch()
        let toggle = menuToggle(app)
        XCTAssert(toggle.waitForExistence(timeout: 30))
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertEqual(toggle.label, "Close menu")
        } else {
            XCTAssertFalse(app.buttons["Map"].exists)
            toggle.tap()
        }
        for entry in ["Bookmarks", "Satellites", "Components", "Map", "Locations", "Globe", "Sky", "Graphics"] {
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
        // Space beside the globe, clear of the menu, the buttons and the clock.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)).tap()
        XCTAssert(panel.waitForNonExistence(timeout: 5))
        XCTAssertEqual(menuToggle(app).label, UIDevice.current.userInterfaceIdiom == .pad ? "Close menu" : "Menu")
    }

    // Look up stands where the device is, kept as "Geolocation", first in the list,
    // and leaves the sky view again.
    @MainActor
    func testLooksUpFromWhereTheDeviceIs() {
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 47.2692, longitude: 11.4041))
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .location)
        let launched = launch(link: "/?gs=48.1372,11.5756,Munich")
        openMenu(launched)
        launched.buttons["Sky"].tap()
        flip(launched, "Look up")
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow While Using App"]
        if allow.waitForExistence(timeout: 10) {
            allow.tap()
        }
        XCTAssert(launched.buttons["Leave the sky view"].waitForExistence(timeout: 20))
        XCTAssertEqual(launched.switches["Look up"].value as? String, "1")
        // Touches soon after the location prompt are lost on the iOS 27 simulator,
        // sometimes more than one (ios/docs/manual-verification.md): up to three tries.
        for _ in 0..<3 where !launched.buttons["Home view"].exists {
            flip(launched, "Look up")
            _ = launched.buttons["Home view"].waitForExistence(timeout: 5)
        }
        XCTAssert(launched.buttons["Home view"].exists)
        // Kept first in the list, as on the web.
        launched.buttons["Locations"].tap()
        let first = launched.textFields.firstMatch
        XCTAssert(first.waitForExistence(timeout: 5))
        XCTAssertEqual(first.value as? String, "Geolocation")
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
        // A disabled picker's segments read as enabled; the control does not.
        let camera = app.segmentedControls.firstMatch
        let inertial = camera.buttons["Inertial"]
        XCTAssert(inertial.isSelected)
        XCTAssertFalse(camera.isEnabled)
        projection.tap()
        XCTAssert(app.buttons["Home view"].waitForExistence(timeout: 10))
        XCTAssert(projection.isSelected)
        XCTAssert(camera.isEnabled && inertial.isSelected)
        app.buttons["Fixed"].tap()
        XCTAssert(app.buttons["Fixed"].isSelected)
    }

    // A link the app opens with is kept under Recent; saving it moves it to Saved,
    // under the name given, and it opens again from there after the default view.
    @MainActor
    func testSavesAndReopensABookmark() {
        let app = launch(link: "/?tags=&sats=METOP-B&elements=Point,Label")
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        XCTAssert(app.buttons["Recent (1)"].waitForExistence(timeout: 10))
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
        openMenu(app)
        app.buttons["Bookmarks"].tap()
        XCTAssert(card.waitForExistence(timeout: 10))
        XCTAssert(card.isSelected)
        XCTAssert(app.buttons["Default view"].isEnabled)
    }

    // The about page's demos open in the app: the first pins the clock at its minute.
    @MainActor
    func testOpensADemoFromAbout() {
        let app = launch()
        XCTAssert(app.buttons["About Satvis"].waitForExistence(timeout: 30))
        app.buttons["About Satvis"].tap()
        let demo = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open it'")).firstMatch
        XCTAssert(demo.waitForExistence(timeout: 5))
        demo.tap()
        let stamp = app.buttons.matching(NSPredicate(format: "label CONTAINS 'UTC'")).firstMatch
        XCTAssert(stamp.waitForExistence(timeout: 10))
        let pinned = NSPredicate(format: "label CONTAINS '08:5'")
        expectation(for: pinned, evaluatedWith: stamp)
        waitForExpectations(timeout: 10)
    }

    // The credits open from the link beside the clock.
    @MainActor
    func testOpensTheAttribution() {
        let app = launch()
        XCTAssert(app.buttons["Attribution"].waitForExistence(timeout: 30))
        app.buttons["Attribution"].tap()
        XCTAssert(app.buttons["Done"].waitForExistence(timeout: 5))
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
    }

    // The web app's `fps=true` shows the performance overlay; the Graphics menu's
    // FPS switches it off.
    @MainActor
    func testShowsPerformanceFromALink() {
        let app = launch(link: "/?fps=true")
        let overlay = app.descendants(matching: .any)["Performance"]
        XCTAssert(overlay.waitForExistence(timeout: 30))
        openMenu(app)
        app.buttons["Graphics"].tap()
        flip(app, "FPS")
        XCTAssert(overlay.waitForNonExistence(timeout: 5))
    }

    // The web app's `bench=true` opens the benchmark panel; Close puts it away,
    // and the Graphics menu brings it back.
    @MainActor
    func testOpensTheBenchmarkFromALink() {
        let app = launch(link: "/?bench=true")
        let start = app.buttons["Start"]
        XCTAssert(start.waitForExistence(timeout: 30))
        app.buttons["Close"].firstMatch.tap()
        XCTAssert(start.waitForNonExistence(timeout: 5))
        openMenu(app)
        app.buttons["Graphics"].tap()
        flip(app, "Benchmark")
        XCTAssert(start.waitForExistence(timeout: 5))
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

    /// Launches and searches the satellite browser.
    @MainActor
    private func search(_ name: String) -> XCUIApplication {
        let app = launch()

        openMenu(app)
        app.buttons["Satellites"].tap()
        let search = app.searchFields["Search satellites"]
        XCTAssert(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(name)
        XCTAssert(app.buttons[name].waitForExistence(timeout: 10))
        return app
    }

    // The App Store screenshots: the Bookmarks sheet's three demos, opened from
    // their cards as anyone would, so they show what a demo shows. Globe, sky,
    // ISS: the first three are the search result's. Only scripts/screenshots.sh
    // takes them, against BASE_URL.

    @MainActor
    func testScreenshot1Globe() throws {
        try openDemo("Weather satellites", at: "2026-10-04T08:52")
        screenshot("1Globe")
    }

    // Night in the Lauterbrunnen valley. The terrain refines a level at a time
    // from an empty cache, a few seconds a tile, on three simulators at once: 30 s
    // left an iPad's cliffs coarse.
    @MainActor
    func testScreenshot2Sky() throws {
        try openDemo("Sky over Lauterbrunnen", at: "2026-10-04T19:22", wait: 60)
        screenshot("2Sky")
    }

    // The station alone: the panel would cover it on a phone and crowd it on an
    // iPad, and closing it keeps the station tracked.
    @MainActor
    func testScreenshot3ISS() throws {
        let app = try openDemo("Follow the ISS", at: "2026-10-04T02:07")
        app.buttons["Close"].firstMatch.tap()
        sleep(2)
        screenshot("3ISS")
    }

    /// Launches on BASE_URL's site with its clock stopped at `minute` (UTC), so
    /// that every device shows the same moment, opens the demo of that name from
    /// the Bookmarks sheet, which leaves a stopped clock where it is, and waits
    /// `wait` seconds for the tiles.
    @MainActor
    @discardableResult
    func openDemo(_ name: String, at minute: String, wait: UInt32 = 20) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SCREENSHOTS"] != nil else {
            throw XCTSkip("Taken by scripts/screenshots.sh")
        }
        let app = XCUIApplication()
        if let site = environment["BASE_URL"] {
            app.launchEnvironment["SATVIS_API"] = site
        }
        // The default view, not the one the last shot left.
        app.launchEnvironment["SATVIS_LINK"] = "/"
        app.launchEnvironment["SATVIS_TIME"] = "\(minute):00Z"
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

    @MainActor
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
