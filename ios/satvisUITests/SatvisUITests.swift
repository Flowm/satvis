import XCTest

nonisolated class SatvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // With no worker to answer, the groups come from the copy on disk or the
    // snapshot shipped in the app, so the test needs no network.
    @MainActor
    func testFindsASatelliteWithoutTheWorker() {
        let app = search("METOP-C")

        guard ProcessInfo.processInfo.environment["SCREENSHOTS"] != nil else {
            return
        }
        screenshot("0Launch")
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

        app.buttons["Satellites"].tap()
        let search = app.searchFields["Search satellites"]
        XCTAssert(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(name)
        XCTAssert(app.buttons[name].waitForExistence(timeout: 10))
        return app
    }

    // The App Store screenshots: the about page's views, by the same links
    // (about.html) and in this order, so the web and every device show one set.
    // The sky view's follows with the sky view (M6). Only scripts/screenshots.sh
    // takes them, against BASE_URL.

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
        XCTAssert(app.buttons["Satellites"].waitForExistence(timeout: 30))
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
