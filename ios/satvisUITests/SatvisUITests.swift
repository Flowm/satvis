import XCTest

nonisolated class SatvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // With no worker to answer, the groups come from the copy on disk or the
    // snapshot shipped in the app, so the test needs no network.
    @MainActor
    func testFindsASatelliteWithoutTheWorker() {
        let app = XCUIApplication()
        app.launchEnvironment["SATVIS_API"] = "http://127.0.0.1:9"
        app.launch()

        app.buttons["Satellites"].tap()
        let search = app.searchFields["Search satellites"]
        XCTAssert(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("METOP-C")
        XCTAssert(app.staticTexts["METOP-C"].waitForExistence(timeout: 10))

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
