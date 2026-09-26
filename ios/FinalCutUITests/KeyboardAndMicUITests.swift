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

    /// The composer is the only TextField (the player's timecode can surface as a TextView,
    /// and the placeholder attribute disappears once there's text).
    private var field: XCUIElement { app.textFields.firstMatch }

    /// The composer mic, not the software keyboard's own "Dictate" key.
    private var composerMicExists: Bool {
        let dictate = NSPredicate(format: "label == %@", "Dictate")
        return app.buttons.matching(dictate).count > app.keyboards.buttons.matching(dictate).count
    }

    /// Taps into the composer and waits for focus (retrying once: the first tap can land while
    /// the sample clip's chips are still animating in).
    private func focusField() {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        for _ in 0..<3 {
            field.tap()
            let focused = NSPredicate { _, _ in self.hasKeyboardFocus(self.field) }
            let result = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: focused, object: nil)], timeout: 3)
            if result == .completed { return }
        }
        print(app.debugDescription)
        XCTFail("composer field never took keyboard focus")
    }

    private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        return (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    func testTappingPreviewDismissesKeyboard() throws {
        focusField()
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
        XCTAssertTrue(composerMicExists)
        XCTAssertFalse(app.buttons["Send"].exists)

        focusField()
        field.typeText("x")
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5), "Send replaces the mic once there's text")
        XCTAssertFalse(composerMicExists, "the composer mic gives way to Send")
    }
}
