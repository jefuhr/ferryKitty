import XCTest

final class FerryKittyUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment = ["FERRY_UI_TESTS":"1", "FERRY_RESET":"1"]
        app.launch()
        XCTAssertTrue(app.buttons["chooseLanding"].waitForExistence(timeout: 20))
    }
    private func openBoat() {
        app.tabBars.buttons["Map"].tap()
        XCTAssertTrue(app.buttons["chooseBoat"].waitForExistence(timeout: 10))
        app.buttons["chooseBoat"].tap()
        XCTAssertTrue(app.buttons["vessel-opportunity"].waitForExistence(timeout: 10))
        app.buttons["vessel-opportunity"].tap()
        XCTAssertTrue(app.staticTexts["rideVesselName"].waitForExistence(timeout: 10))
    }
    private func waitForLabel(_ element: XCUIElement, containing text: String) {
        let condition = NSPredicate(format: "label CONTAINS %@", text)
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: condition, object: element)], timeout: 15), .completed)
    }
    /// Rotation and sidebar changes animate, so layout is compared once it settles.
    private func waitForLayout(_ description: String, _ condition: @escaping () -> Bool) {
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, description)
    }
    /// A toggle row's own tap lands on its label; flip the switch control inside it.
    private func flip(_ toggle: XCUIElement) {
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        let control = toggle.switches.firstMatch
        if control.exists { control.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
    }
    private func sideBySide(_ left: XCUIElement, _ right: XCUIElement) -> Bool {
        left.exists && right.exists && abs(left.frame.minY - right.frame.minY) < 2 && left.frame.maxX <= right.frame.minX + 1
    }
    private func stacked(_ upper: XCUIElement, _ lower: XCUIElement) -> Bool {
        upper.exists && lower.exists && lower.frame.minY >= upper.frame.maxY - 1
    }
    private func capture(_ name: String) {
        // Layout settles before the rotation animation ends; let it finish so the picture is whole.
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways
        add(shot)
    }
    func testLandingFavoritesAndPreferences() {
        app.buttons["chooseLanding"].tap()
        XCTAssertTrue(app.buttons["landing-26"].waitForExistence(timeout: 10))
        app.buttons["favorite-26"].tap()
        app.buttons["landing-26"].tap()
        waitForLabel(app.buttons["landingTitle"], containing: "79")
        app.buttons["settings"].tap()
        flip(app.switches["clockFormat"])
        app.buttons["settingsTheme"].tap()
        app.buttons["theme-hello-kitty"].tap()
        // Done belongs to the sheet's first page; the theme list is pushed onto it.
        app.navigationBars["Theme"].buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["dismissSheet"].waitForExistence(timeout: 10))
        app.buttons["dismissSheet"].tap()
        app.terminate()
        app.launchEnvironment["FERRY_RESET"] = "0"
        app.launch()
        waitForLabel(app.buttons["landingTitle"], containing: "79")
        app.buttons["settings"].tap()
        XCTAssertTrue(app.switches["clockFormat"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.switches["clockFormat"].value as? String, "1")
    }
    func testWidgetLinksOpenSetupAndCurrentLandingAfterColdLaunch() {
        app.terminate()
        app.open(URL(string: "ferryboard://landing/26")!)
        waitForLabel(app.buttons["landingTitle"], containing: "79")
        app.buttons["nextDay"].tap()
        app.open(URL(string: "ferryboard://landing/16")!)
        waitForLabel(app.buttons["landingTitle"], containing: "Pier 11")
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 10))
        app.open(URL(string: "ferryboard://nearby")!)
        XCTAssertTrue(app.buttons["widgetEnableLocation"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["widgetEnableLocation"].isEnabled)
        capture("Nearby ferry widget location setup")
    }
    func testWidgetDefaultsCopyVisibilityAndIndependentPersistence() {
        app.buttons["chooseLanding"].tap()
        XCTAssertTrue(app.buttons["landing-26"].waitForExistence(timeout: 10))
        app.buttons["landing-26"].tap()
        app.buttons["operatorFilter"].tap()
        flip(app.switches["operator-NY Waterway"])
        XCTAssertEqual(app.switches["operator-NY Waterway"].value as? String, "0")
        app.buttons["dismissSheet"].tap()
        app.launchEnvironment["FERRY_RESET"] = "0"
        openWidgetSettings()
        XCTAssertTrue(app.buttons["widgetCopySettings"].waitForExistence(timeout: 10))
        app.buttons["widgetCopySettings"].tap()
        XCTAssertEqual(app.switches["widgetAutomaticLanding"].value as? String, "0")
        XCTAssertTrue(app.buttons["widgetFixedLanding"].exists)
        XCTAssertEqual(app.switches["widgetOperator-NY Waterway"].value as? String, "0")
        flip(app.switches["widgetOperator-NYC Ferry"])
        for id in ["widgetBoatNames", "widgetAssignments", "widgetDwells", "widgetLayovers"] {
            let toggle = app.switches[id]
            for _ in 0..<5 where !toggle.isHittable { app.swipeUp() }
            flip(toggle)
        }
        capture("Widget visibility settings")
        app.navigationBars["Nearby ferry widget"].buttons.firstMatch.tap()
        app.buttons["dismissSheet"].tap()
        app.buttons["operatorFilter"].tap()
        XCTAssertEqual(app.switches["operator-NYC Ferry"].value as? String, "1")
        XCTAssertEqual(app.switches["operator-NY Waterway"].value as? String, "0")
        app.buttons["dismissSheet"].tap()
        app.terminate()
        app.launch()
        openWidgetSettings()
        XCTAssertTrue(app.switches["widgetAutomaticLanding"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.switches["widgetAutomaticLanding"].value as? String, "0")
        XCTAssertEqual(app.switches["widgetOperator-NYC Ferry"].value as? String, "0")
        for id in ["widgetBoatNames", "widgetAssignments", "widgetDwells", "widgetLayovers"] {
            let toggle = app.switches[id]
            for _ in 0..<5 where !toggle.isHittable { app.swipeUp() }
            XCTAssertEqual(toggle.value as? String, "0")
        }
    }
    private func openWidgetSettings() {
        app.buttons["settings"].tap()
        let link = app.buttons["settingsWidget"]
        for _ in 0..<6 where !link.isHittable { app.swipeUp() }
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
    }
    func testCompactMapMarkerSearchAndSelection() {
        app.tabBars.buttons["Map"].tap()
        let search = app.textFields["vesselSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        app.buttons["Fit harbor"].tap()
        capture("Compact hull markers")

        let marker = app.buttons["mapBoatMarker-opportunity"]
        for hull in ["H204", "H-204"] {
            search.tap()
            search.typeText(hull)
            waitForLabel(marker, containing: "Opportunity, H-204")
            XCTAssertFalse(app.buttons["mapBoatMarker-bay-hopper"].exists, "Hull search excludes other boats")
            if hull == "H204" { app.buttons["Clear search"].tap() }
        }
        search.typeText("\n")
        XCTAssertGreaterThanOrEqual(marker.frame.width, 44)
        XCTAssertGreaterThanOrEqual(marker.frame.height, 44)
        // Tap outside the visible circle, inside its larger touch target.
        marker.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.navigationBars["Opportunity"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["rideThisBoat"].waitForExistence(timeout: 10))
        capture("Compact marker opens the matching boat")
        app.buttons["dismissSheet"].tap()
        capture("Selected compact hull marker")

        app.terminate()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        app.tabBars.buttons["Map"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        app.buttons["mapBoat-opportunity"].tap()
        XCTAssertTrue(app.navigationBars["Opportunity"].waitForExistence(timeout: 10))
        app.buttons["dismissSheet"].tap()
        capture("Compact hull markers with accessibility text")

        app.terminate()
        app.launchArguments = []
        app.launchEnvironment["FERRY_RESET"] = "0"
        app.launchEnvironment["FERRY_OFFLINE"] = "1"
        app.launch()
        app.tabBars.buttons["Map"].tap()
        XCTAssertTrue(app.staticTexts["Saved / unavailable"].waitForExistence(timeout: 10))
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        app.buttons["Fit harbor"].tap()
        capture("Saved compact hull markers")
    }
    func testTripMapRideAndOfflineRestoration() {
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 15))
        app.buttons["departure-nine"].tap()
        XCTAssertTrue(app.buttons["tripRide"].waitForExistence(timeout: 10))
        app.buttons["dismissSheet"].tap()
        openBoat()
        XCTAssertTrue(app.staticTexts["rideArrival"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["rideArrival"].label.contains("estimated"))
        app.buttons["minimizeRide"].tap()
        XCTAssertTrue(app.buttons["rideBar"].waitForExistence(timeout: 10))
        app.terminate()
        app.launchEnvironment["FERRY_RESET"] = "0"
        app.launchEnvironment["FERRY_OFFLINE"] = "1"
        app.launch()
        XCTAssertTrue(app.staticTexts["rideVesselName"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["rideVesselName"].label, "Opportunity")
        XCTAssertTrue(app.staticTexts["rideArrival"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["rideArrival"].label.contains("scheduled"))
        app.buttons["rideActions"].tap()
        app.buttons["Exit boat"].tap()
        app.tabBars.buttons["Departures"].tap()
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["rideBar"].exists)
    }
    func testOfflineFirstLaunchOffersRecovery() {
        app.terminate()
        app.launchEnvironment["FERRY_OFFLINE"] = "1"
        app.launch()
        XCTAssertTrue(app.staticTexts["Schedule unavailable"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Try again"].exists)
    }
    func testOperatorsDatesAndAlerts() {
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 15))
        app.buttons["operatorFilter"].tap()
        flip(app.switches["operator-NYC Ferry"])
        app.buttons["dismissSheet"].tap()
        XCTAssertTrue(app.staticTexts["No matching departures"].waitForExistence(timeout: 10))
        app.buttons["Show all departures"].tap()
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 10))
        app.buttons["nextDay"].tap()
        waitForLabel(app.buttons["scheduleDate"], containing: "2026-09-05")
        app.buttons["scheduleDate"].tap()
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 10))
        app.swipeUp()
        app.buttons["serviceAlerts"].tap()
        XCTAssertTrue(app.staticTexts["Service update"].waitForExistence(timeout: 10))
    }
    func testRoutesAndNYCMovementsFilterIndependently() {
        app.buttons["operatorFilter"].tap()
        let expand = app.buttons["expandOperator-NYC Ferry"]
        XCTAssertTrue(expand.waitForExistence(timeout: 10))
        XCTAssertFalse(app.switches["routeFilter-ER"].exists)
        expand.tap()
        XCTAssertTrue(app.switches["routeFilter-ER"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.switches["movementFilter-pierC"].exists)
        XCTAssertTrue(app.switches["movementFilter-outOfService"].exists)
        capture("Expanded operator routes and NYC Ferry movements")
        flip(app.switches["movementFilter-crewShuttle"])
        app.buttons["dismissSheet"].tap()
        XCTAssertTrue(app.buttons["departure-home"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["departure-crew"].exists)
        app.buttons["operatorFilter"].tap()
        app.buttons["expandOperator-NYC Ferry"].tap()
        flip(app.switches["movementFilter-pierC"])
        app.buttons["dismissSheet"].tap()
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["departure-home"].exists)
        app.buttons["operatorFilter"].tap()
        app.buttons["expandOperator-NYC Ferry"].tap()
        flip(app.switches["routeFilter-ER"])
        app.buttons["dismissSheet"].tap()
        XCTAssertTrue(app.staticTexts["No matching departures"].waitForExistence(timeout: 10))
        app.buttons["Show all departures"].tap()
        XCTAssertTrue(app.buttons["departure-nine"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["departure-home"].exists)
        XCTAssertTrue(app.buttons["departure-crew"].exists)
    }
    func testMapSelectionAndSwitchBoats() {
        app.tabBars.buttons["Map"].tap()
        XCTAssertTrue(app.buttons["mapBoat-opportunity"].waitForExistence(timeout: 15))
        app.buttons["mapBoat-opportunity"].tap()
        XCTAssertTrue(app.buttons["rideThisBoat"].waitForExistence(timeout: 10))
        app.buttons["rideThisBoat"].tap()
        waitForLabel(app.staticTexts["rideVesselName"], containing: "Opportunity")
        app.buttons["rideActions"].tap()
        app.buttons["Switch boats"].tap()
        XCTAssertTrue(app.buttons["vessel-bay-hopper"].waitForExistence(timeout: 10))
        app.buttons["vessel-bay-hopper"].tap()
        waitForLabel(app.staticTexts["rideVesselName"], containing: "Bay Hopper")
        app.buttons["rideActions"].tap()
        app.buttons["Exit boat"].tap()
        XCTAssertTrue(app.buttons["chooseBoat"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["rideBar"].exists)
    }
    /// iPad boards read left to right: the next two sailings share the top row in both orientations.
    func testTabletBoardFillsTwoDepartureColumns() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("Tablet layout") }
        let first = app.buttons["departure-nine"], second = app.buttons["departure-ten"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        for (name, orientation) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft)] {
            XCUIDevice.shared.orientation = orientation
            waitForLayout("Time sort, \(name): 09:00 and 10:00 share a row") { self.sideBySide(first, second) }
            capture("Tablet board by time, \(name)")
        }
        first.tap()
        XCTAssertTrue(app.buttons["tripRide"].waitForExistence(timeout: 10))
        app.buttons["dismissSheet"].tap()
        // Route groups tile the same way, in route order: Crew pickup, then Pier 11 beside it.
        app.segmentedControls["departureSort"].buttons["Route"].tap()
        let crew = app.buttons["departure-crew"]
        waitForLayout("Route sort: groups share a row") { self.sideBySide(crew, first) }
        capture("Tablet board by route, landscape")
        app.segmentedControls["departureSort"].buttons["Time"].tap()
        // Portrait keeps the board's width: the landing list opens on demand and closes after a choice.
        XCUIDevice.shared.orientation = .portrait
        waitForLayout("Portrait: board has both columns") { self.sideBySide(first, second) }
        app.buttons["Show Sidebar"].tap()
        XCTAssertTrue(app.buttons["landing-26"].waitForExistence(timeout: 10))
        app.buttons["landing-26"].tap()
        waitForLabel(app.buttons["landingTitle"], containing: "79")
        waitForLayout("Sidebar closes after choosing a landing") {
            let row = self.app.buttons["landing-26"]
            return (!row.exists || !row.isHittable) && self.sideBySide(first, second)
        }
        capture("Tablet board after choosing a landing, portrait")
        // Accessibility text keeps one readable column.
        app.terminate()
        app.launchEnvironment["FERRY_RESET"] = "0"
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        waitForLayout("Accessibility text: one column") { self.stacked(first, second) }
        capture("Tablet board with accessibility text")
    }
    /// Phones keep one column, with compact rows that remain full-size touch targets.
    func testPhoneBoardIsCompact() throws {
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("Phone layout") }
        XCUIDevice.shared.orientation = .portrait
        let first = app.buttons["departure-nine"], second = app.buttons["departure-ten"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        waitForLayout("Portrait: one column") { self.stacked(first, second) }
        XCTAssertGreaterThanOrEqual(first.frame.height, 44, "Rows stay comfortable touch targets")
        XCTAssertLessThanOrEqual(first.frame.height, 64, "A departure with a vessel and dwell fits two lines")
        XCTAssertLessThan(first.frame.minY, app.frame.height * 0.3, "Board controls leave most of the screen to departures")
        capture("Phone board, portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        waitForLayout("Landscape: two columns") { self.sideBySide(first, second) }
        capture("Phone board, landscape")
        XCUIDevice.shared.orientation = .portrait
    }
    func testLandscapeAndLargeText() {
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["chooseLanding"].waitForExistence(timeout: 10))
        app.buttons["chooseLanding"].tap()
        XCTAssertTrue(app.buttons["landing-26"].waitForExistence(timeout: 10))
        app.buttons["dismissSheet"].tap()
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.buttons["chooseLanding"].waitForExistence(timeout: 15))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Departures with accessibility text"; capture.lifetime = .keepAlways
        add(capture)
    }
}
