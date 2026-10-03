import XCTest

class satvisUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        SpringboardHelper.deleteMyApp()

        setupSnapshot(app)
        app.launchEnvironment["URL"] = "https://satvis.space/?time=2019-07-15T15:52&layers=ArcGis&tags=Weather&elements=Point,Label,Orbit"
        app.launch()

        SpringboardHelper.allowSystemAlerts()
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testBasicUI() {
        // Wait for map tiles to load
        sleep(60)
        snapshot("0Launch")
    }
}
