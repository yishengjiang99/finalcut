import XCTest

/// Keyboard dismissal and the composer mic (Design #94). Launches the real app.
final class KeyboardAndMicUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let sample = app.buttons["Try the sample clip"]
        if sample.waitForExistence(timeout: 8) { sample.tap() }
        XCTAssertTrue(app.descendants(matching: .any)["Preview"].firstMatch.waitForExistence(timeout: 15), "sample clip preview")
    }

    private var field: XCUIElement {
        app.descendants(matching: .any).matching(identifier: "ComposerField").firstMatch
    }

    private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    func testTappingPreviewDismissesKeyboard() throws {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("make it red")
        XCTAssertTrue(hasKeyboardFocus(field), "field should be focused while typing")

        app.descendants(matching: .any)["Preview"].firstMatch.tap()

        let unfocused = NSPredicate { _, _ in !self.hasKeyboardFocus(self.field) }
        wait(for: [XCTNSPredicateExpectation(predicate: unfocused, object: nil)], timeout: 5)
        XCTAssertEqual(app.keyboards.count, 0, "keyboard should be hidden")
        // The typed prompt stays in the field, unsent.
        XCTAssertTrue(app.buttons["ComposerSend"].exists)
    }

    func testMicShowsWhenFieldIsEmptyBeforePermissionIsAsked() throws {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["DictationMic"].waitForExistence(timeout: 5), "mic in the trailing slot")
        XCTAssertFalse(app.buttons["ComposerSend"].exists)

        field.tap()
        field.typeText("x")
        XCTAssertTrue(app.buttons["ComposerSend"].waitForExistence(timeout: 5), "Send replaces the mic once there's text")
        XCTAssertFalse(app.buttons["DictationMic"].exists)
    }
}
