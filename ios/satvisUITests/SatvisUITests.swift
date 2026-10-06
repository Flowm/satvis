import XCTest

nonisolated class SatvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // With no worker to answer, the groups come from the copy on disk or the
    // snapshot shipped in the app, so the test needs no network.
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

    // The web app's menu column unfolds from the menu button, folded on a phone,
    // and the menus among it open.
    @MainActor
    func testOpensTheToolsFromTheMenu() {
        let app = launch()
        XCTAssert(app.buttons["Menu"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Map"].exists)
        app.buttons["Menu"].tap()
        for entry in ["Satellites", "Components", "Ground station", "Map", "View", "Graphics"] {
            XCTAssert(app.buttons[entry].waitForExistence(timeout: 5), "No \(entry) in the menu")
        }
        app.buttons["Components"].tap()
        XCTAssert(app.descendants(matching: .any)["Orbit track"].waitForExistence(timeout: 5))
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
        app.buttons["Menu"].tap()
        app.buttons["Graphics"].tap()
        app.descendants(matching: .any)["FPS"].firstMatch.tap()
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
        app.buttons["Menu"].tap()
        app.buttons["Graphics"].tap()
        app.buttons["Benchmark"].firstMatch.tap()
        XCTAssert(start.waitForExistence(timeout: 5))
    }

    /// Launches with no worker to answer, on a link: by default the plain site,
    /// rather than the view an earlier run left.
    @MainActor
    private func launch(link: String = "/") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launchEnvironment["SATVIS_LINK"] = link
        app.launch()
        return app
    }

    /// Launches and searches the satellite browser.
    @MainActor
    private func search(_ name: String) -> XCUIApplication {
        let app = launch()

        app.buttons["Menu"].tap()
        app.buttons["Satellites"].tap()
        let search = app.searchFields["Search satellites"]
        XCTAssert(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(name)
        XCTAssert(app.buttons[name].waitForExistence(timeout: 10))
        return app
    }

    // The App Store screenshots: the about page's three views, by the same links
    // (about.html) and in this order, so the web and every device show one set.
    // Only scripts/screenshots.sh takes them, against BASE_URL.

    @MainActor
    func testScreenshot1Globe() throws {
        try open("/?time=2026-10-04T08:52Z")
        screenshot("1Globe")
    }

    @MainActor
    func testScreenshot2ISS() throws {
        try open("/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles&time=2026-10-04T02:07Z")
        screenshot("2ISS")
    }

    // Night in the Lauterbrunnen valley, standing on the link's station.
    @MainActor
    func testScreenshot3Sky() throws {
        try open(
            "/?scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&layers=VersaTiles&stars=DeepStar2K&time=2026-10-04T19:22Z&tags=GNSS,Weather,OneWeb&elements=Point,Label"
                + excluding([
                    "COSMOS 2500 (755)", "GSAT0220 (GALILEO 24)", "METEOSAT-11 (MSG-4)", "BEIDOU-3 M27 (C49)", "SES-5 (EGNOS/PRN 136)",
                    "EUTELSAT 5 WEST B (EGNOS/PRN 121)", "BEIDOU-3 M21 (C43)", "METEOSAT-12 (MTG-I1)", "METEOSAT-10 (MSG-3)", "MTG-I2",
                    "LUCH 5B (SDCM/PRN 125)", "BEIDOU-3 M8 (C28)", "ONEWEB-0169", "ONEWEB-0336", "BEIDOU-3 M11 (C25)", "ONEWEB-0112",
                    "ONEWEB-0628", "GSAT-8 (GAGAN/PRN 127)", "BEIDOU-2 G5 (C05)", "TIANMU-1 10", "TIANMU-1 13",
                ]))
        screenshot("3Sky")
    }

    /// The `xsats` parameter for these satellite names.
    func excluding(_ names: [String]) -> String {
        "&xsats=" + names.map { $0.replacingOccurrences(of: " ", with: "+") }.joined(separator: ",")
    }

    /// Launches on a link of BASE_URL's site, its clock stopped at the link's
    /// minute so that every device shows the same moment, and waits for the tiles.
    @MainActor
    func open(_ path: String) throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SCREENSHOTS"] != nil else {
            throw XCTSkip("Taken by scripts/screenshots.sh")
        }
        let app = XCUIApplication()
        if let site = environment["BASE_URL"] {
            app.launchEnvironment["SATVIS_API"] = site
        }
        app.launchEnvironment["SATVIS_LINK"] = path
        if let time = path.firstMatch(of: /time=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z/) {
            app.launchEnvironment["SATVIS_TIME"] = "\(time.1):00Z"
        }
        app.launch()
        XCTAssert(app.buttons["Menu"].waitForExistence(timeout: 30))
        sleep(20)
    }

    @MainActor
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
