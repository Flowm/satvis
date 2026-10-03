import XCTest

class SpringboardHelper {
    static let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    class func deleteMyApp() {
        XCUIApplication().terminate()

        // Force delete the app from the springboard
        let icon = springboard.icons["SatVis"]
        if icon.waitForExistence(timeout: 5) {
            icon.press(forDuration: 1.5)

            let removeButton = springboard.buttons["Remove App"]
            XCTAssert(removeButton.waitForExistence(timeout: 10))
            removeButton.tap()

            let deleteAppButton = springboard.alerts.buttons["Delete App"]
            XCTAssert(deleteAppButton.waitForExistence(timeout: 10))
            deleteAppButton.tap()

            let deleteButton = springboard.alerts.buttons["Delete"]
            XCTAssert(deleteButton.waitForExistence(timeout: 10))
            deleteButton.tap()
        }
    }

    class func allowSystemAlerts() {
        let alert = springboard.alerts.firstMatch
        while alert.waitForExistence(timeout: 10) {
            guard let allowButton = ["Allow While Using App", "Allow"].map({ alert.buttons[$0] }).first(where: { $0.exists }) else {
                return
            }
            allowButton.tap()
            _ = alert.waitForNonExistence(timeout: 5)
        }
    }
}
