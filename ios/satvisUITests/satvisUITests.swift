import XCTest

class satvisUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        SpringboardHelper.deleteMyApp()

        setupSnapshot(app)
        app.launchEnvironment["URL"] = "https://satvis.space/?time=2019-07-15T15:52&layers=ArcGis&tags=MOVE&elements=Point,Label,Orbit"
        app.launch()

        addUIInterruptionMonitor(withDescription: "Alert") {
            (alert) -> Bool in
            let okButton = alert.buttons["OK"]
            if okButton.exists {
                okButton.tap()
            }
            let allowButton = alert.buttons["Allow"]
            if allowButton.exists {
                allowButton.tap()
            }
            return true
        }
        app.activate()
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testBasicUI() {
        // Interact with app to trigger alert handling
        app.statusBars.firstMatch.tap()

        // Wait for map tiles to load
        sleep(60)
        snapshot("0Launch")
    }
}
