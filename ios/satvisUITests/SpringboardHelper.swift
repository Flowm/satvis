import XCTest

class SpringboardHelper {
    static let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    class func deleteMyApp() {
        XCUIApplication().terminate()

        // Force delete the app from the springboard
        let icon = springboard.icons["SatVis"]
        if icon.exists {
            let iconFrame = icon.frame
            let springboardFrame = springboard.frame
            icon.press(forDuration: 1.3)

            // Tap the little "X" button at approximately where it is. The X is not exposed directly
            springboard.coordinate(withNormalizedOffset: CGVector(dx: (iconFrame.minX + 3) / springboardFrame.maxX, dy: (iconFrame.minY + 3) / springboardFrame.maxY)).tap()

            let deleteButton = springboard.alerts.buttons["Delete"]
            let deleteButtonExists = deleteButton.waitForExistence(timeout: 10)
            XCTAssert(deleteButtonExists)
            deleteButton.tap()
        }
    }
}
