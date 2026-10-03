import XCTest

nonisolated class satvisUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBasicUI() {
        let app = XCUIApplication()
        SpringboardHelper.deleteMyApp()

        setupSnapshot(app)
        app.launchEnvironment["URL"] = "https://satvis.space/?time=2019-07-15T15:52&layers=ArcGis&tags=Weather&elements=Point,Label,Orbit"
        app.launch()

        SpringboardHelper.allowSystemAlerts()

        // Wait for map tiles to load
        sleep(60)
        snapshot("0Launch")
    }
}
