import XCTest

class SpringboardHelper {
    static let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    class func allowSystemAlerts() {
        let alert = springboard.alerts.firstMatch
        while alert.waitForExistence(timeout: 5) {
            guard let allowButton = ["Allow While Using App", "Allow"].map({ alert.buttons[$0] }).first(where: { $0.exists }) else {
                return
            }
            allowButton.tap()
            _ = alert.waitForNonExistence(timeout: 5)
        }
    }
}
