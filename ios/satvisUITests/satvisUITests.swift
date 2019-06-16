import XCTest

class satvisUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        setupSnapshot(app)
        app.launch()

        addUIInterruptionMonitor(withDescription: "System Dialog") {
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
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testExample() {
        sleep(10)
        app.webViews.buttons.firstMatch.tap()
        app.webViews.buttons.firstMatch.tap()
        print(app.webViews.buttons.debugDescription)
        snapshot("0Launch")
    }
}
