import XCTest

class satvisUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        SpringboardHelper.deleteMyApp()

        setupSnapshot(app)
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

    func testExample() {
        app.tap()
        sleep(10)
        snapshot("0Launch")

        //app.webViews.buttons.firstMatch.tap()
        //print(app.webViews.buttons.debugDescription)
    }
}
