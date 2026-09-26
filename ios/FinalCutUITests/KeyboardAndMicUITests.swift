import XCTest

/// Keyboard dismissal and the composer mic (Design #94). Launches the real app.
/// Elements are found by label/type: SwiftUI's container identifiers ("Editor") override
/// the inner ones in the accessibility tree.
final class KeyboardAndMicUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let sample = app.buttons["Try the sample clip"]
        if sample.waitForExistence(timeout: 8) { sample.tap() }
        let loaded = app.buttons["Red filter"].waitForExistence(timeout: 20)
        if !loaded { print(app.debugDescription) }
        XCTAssertTrue(loaded, "sample clip loaded (video chips visible)")
    }

    private var field: XCUIElement {
        let textView = app.textViews.firstMatch
        return textView.exists ? textView : app.textFields.firstMatch
    }

    private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    func testTappingPreviewDismissesKeyboard() throws {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("make it red")
        XCTAssertTrue(hasKeyboardFocus(field), "field should be focused while typing")

        // The preview sits under the top bar, above the chat.
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        let unfocused = NSPredicate { _, _ in !self.hasKeyboardFocus(self.field) }
        wait(for: [XCTNSPredicateExpectation(predicate: unfocused, object: nil)], timeout: 5)
        XCTAssertEqual(app.keyboards.count, 0, "keyboard should be hidden")
        // The typed prompt stays in the field, unsent.
        XCTAssertTrue(app.buttons["Send"].exists)
    }

    func testExportOffersPhotosAndFiles() throws {
        let export = app.buttons["Export"]
        XCTAssertTrue(export.waitForExistence(timeout: 10))
        export.tap()
        XCTAssertTrue(app.buttons["Save to Photos"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Save to Files"].exists)
        XCTAssertTrue(app.buttons["Save to Photos"].isEnabled)
    }

    func testMicShowsWhenFieldIsEmptyBeforePermissionIsAsked() throws {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Dictate"].waitForExistence(timeout: 5), "mic in the trailing slot")
        XCTAssertFalse(app.buttons["Send"].exists)

        field.tap()
        field.typeText("x")
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5), "Send replaces the mic once there's text")
        XCTAssertFalse(app.buttons["Dictate"].exists)
    }
}
