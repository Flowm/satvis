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

    @MainActor
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
