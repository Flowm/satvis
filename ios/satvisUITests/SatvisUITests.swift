import XCTest

nonisolated class SatvisUITests: XCTestCase {
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
        XCTAssert(clockDeck(app).waitForExistence(timeout: 60))
    }

    // The App Store screenshots: the about page's three views, in this order.
    // Only scripts/screenshots.sh takes them, against BASE_URL.

    @MainActor
    func testScreenshot1Globe() throws {
        _ = try open("/")
        screenshot("1Globe")
    }

    @MainActor
    func testScreenshot2ISS() throws {
        _ = try open("/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles&time=2026-10-04T02:07Z")
        screenshot("2ISS")
    }

    // Night in the Lauterbrunnen valley. Each device's frame gets its own time and
    // satellites, chosen so that no two labels touch, none sits under the chrome,
    // and nothing is close enough to the crosshair to open its card. Moving
    // satellites keep that layout for 20 s from the pinned minute; the clock is
    // paused well inside it.
    @MainActor
    func testScreenshot3Sky() throws {
        let sky = "/?scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&layers=VersaTiles&stars=DeepStar2K&elements=Point,Label"
        if UIDevice.current.userInterfaceIdiom == .pad {
            _ = try open(
                sky + "&time=2026-10-04T19:10Z&tags=GNSS,IridiumNEXT,Resource,Weather,OneWeb"
                    + excluding([
                        "METEOSAT-11 (MSG-4)", "METEOSAT-12 (MTG-I1)", "BEIDOU-3 M8 (C28)", "GPS BIIF-3  (PRN 24)", "LUCH 5B (SDCM/PRN 125)",
                        "EUTELSAT 5 WEST B (EGNOS/PRN 121)", "SES-5 (EGNOS/PRN 136)", "DMSP 5D-3 F16 (USA 172)", "ONEWEB-0164",
                    ]),
                pausing: true)
        } else {
            _ = try open(
                sky + "&time=2026-10-04T19:22Z&tags=GNSS,IridiumNEXT,Weather,OneWeb"
                    + excluding([
                        "METEOSAT-10 (MSG-3)", "METEOSAT-11 (MSG-4)", "METEOSAT-12 (MTG-I1)", "MTG-I2", "BEIDOU-3 M21 (C43)", "BEIDOU-3 M27 (C49)",
                        "EUTELSAT 5 WEST B (EGNOS/PRN 121)", "SES-5 (EGNOS/PRN 136)", "GSAT0220 (GALILEO 24)", "IRIDIUM 117",
                    ]),
                pausing: true)
        }
        screenshot("3Sky")
    }

    /// The `xsats` parameter for these satellite names.
    func excluding(_ names: [String]) -> String {
        "&xsats=" + names.map { $0.replacingOccurrences(of: " ", with: "+") }.joined(separator: ",")
    }

    /// Launch on a path of BASE_URL and wait for the tiles, with the clock
    /// stopped as soon as the page is up when `pausing`.
    ///
    /// Relaunches when the take is spoiled: a cold simulator can be slow enough
    /// that the clock runs past the window the sky layouts hold for, and its
    /// WebGL now and then fails a shader compile. A warm second launch is not.
    @MainActor
    func open(_ path: String, pausing: Bool = false) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SCREENSHOTS"] != nil else {
            throw XCTSkip("Taken by scripts/screenshots.sh")
        }
        let app = XCUIApplication()
        app.launchEnvironment["URL"] = (environment["BASE_URL"] ?? "https://satvis.space") + path
        for attempt in 1...3 {
            app.launch()
            SpringboardHelper.allowSystemAlerts()
            XCTAssert(clockDeck(app).waitForExistence(timeout: 60))
            if pausing {
                pauseClock(app)
                guard let seconds = clockSeconds(app), seconds <= 20 else {
                    print("Attempt \(attempt): the clock stopped too late")
                    continue
                }
            }
            sleep(30)
            if app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "An error occurred while rendering")).firstMatch.exists {
                print("Attempt \(attempt): Cesium stopped rendering")
                continue
            }
            return app
        }
        XCTFail("No clean take of \(path)")
        return app
    }

    /// The seconds past the minute on the clock deck, which leads its label.
    @MainActor
    func clockSeconds(_ app: XCUIApplication) -> Int? {
        Int(clockDeck(app).label.prefix(8).suffix(2))
    }

    /// Opening the deck if it is folded, as it is on a phone, and folding it again.
    @MainActor
    func pauseClock(_ app: XCUIApplication) {
        let folded = clockDeck(app).label.hasSuffix("Show clock controls")
        if folded {
            clockDeck(app).tap()
        }
        app.buttons["Pause"].tap()
        if folded {
            clockDeck(app).tap()
        }
    }

    @MainActor
    func clockDeck(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "clock controls")).firstMatch
    }

    @MainActor
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
