import XCTest

nonisolated class satvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBasicUI() {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchEnvironment["URL"] = "https://satvis.space/?time=2019-07-15T15:52&layers=ArcGis&tags=Weather&elements=Point,Label,Orbit"
        app.launch()

        SpringboardHelper.allowSystemAlerts()

        // The clock deck appears once the page has rendered
        let clock = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "clock controls")).firstMatch
        XCTAssert(clock.waitForExistence(timeout: 60))

        // Wait for map tiles to load
        sleep(60)
        snapshot("0Launch")
    }
}
