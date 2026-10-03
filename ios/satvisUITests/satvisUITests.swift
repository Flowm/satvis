import XCTest

nonisolated class satvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBasicUI() {
        let app = XCUIApplication()
        app.launchEnvironment["URL"] = "https://satvis.space/?time=2019-07-15T15:52&layers=ArcGis&tags=Weather&elements=Point,Label,Orbit"
        app.launch()

        SpringboardHelper.allowSystemAlerts()

        // The clock deck appears once the page has rendered
        let clock = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "clock controls")).firstMatch
        XCTAssert(clock.waitForExistence(timeout: 60))

        // Screenshots wait for the map tiles, so only scripts/screenshots.sh takes them
        guard ProcessInfo.processInfo.environment["SCREENSHOTS"] != nil else {
            return
        }
        sleep(60)
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
