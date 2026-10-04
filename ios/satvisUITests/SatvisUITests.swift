import XCTest

nonisolated class SatvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // With no worker to answer, the groups come from the copy on disk or the
    // snapshot shipped in the app, so the test needs no network.
    @MainActor
    func testShowsGroupsWithoutTheWorker() {
        let app = XCUIApplication()
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launch()

        XCTAssert(app.staticTexts["cubesat"].waitForExistence(timeout: 10))
        // The list builds rows as they scroll into view.
        let weather = app.staticTexts["weather"]
        for _ in 0..<5 where !weather.exists {
            app.swipeUp()
        }
        weather.tap()
        XCTAssert(app.navigationBars["weather"].waitForExistence(timeout: 10))
        // A row reads as its satellite's name and orbit class.
        let satellite = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", ", LEO")).firstMatch
        XCTAssert(satellite.waitForExistence(timeout: 10))

        guard ProcessInfo.processInfo.environment["SCREENSHOTS"] != nil else {
            return
        }
        screenshot("0Launch")
    }

    @MainActor
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
