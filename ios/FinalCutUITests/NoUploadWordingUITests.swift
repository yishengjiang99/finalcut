import XCTest

/// Build 12: with Cloud processing off the word "Upload" never appears — not while importing,
/// applying an edit, or exporting (labels checked case-insensitively throughout).
final class NoUploadWordingUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // Settings → Cloud processing OFF (argument domain beats stored defaults).
        app.launchArguments += ["-settings.cloudProcessing", "NO"]
        app.launch()
    }

    private func assertNoUpload(_ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let matches = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "upload"))
        let count = matches.count
        guard count > 0 else { return }
        let label = matches.firstMatch.label
        print(app.debugDescription)
        XCTFail("'Upload' shown during \(step): \(label)", file: file, line: line)
    }

    /// Checks repeatedly for `seconds`, so short-lived states are caught too.
    private func watch(_ step: String, seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            assertNoUpload(step)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        } while Date() < end
    }

    /// Swipes the pill's horizontal row (at most 6 times) until the pill's center is on screen.
    /// Uses the frame, not `isHittable`: querying hittability of a fully off-screen element throws.
    private func scrollIntoView(_ pill: XCUIElement, label: String) {
        // Prefer the pill row by id; otherwise the innermost scroll view that holds the pill
        // (the editor container's id can replace inner identifiers).
        let tagged = app.scrollViews["SampleChips"]
        let holders = app.scrollViews.containing(NSPredicate(format: "label == %@", label))
        let row = tagged.exists ? tagged : holders.element(boundBy: max(holders.count - 1, 0))
        for _ in 0..<6 {
            if isOnScreen(pill) { return }
            if pill.frame.midX > app.windows.firstMatch.frame.midX {
                row.swipeLeft(velocity: .slow)
            } else {
                row.swipeRight(velocity: .slow)
            }
        }
    }

    private func isOnScreen(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let visible = app.windows.firstMatch.frame.insetBy(dx: 8, dy: 0)
        let frame = element.frame
        return !frame.isEmpty && visible.contains(CGPoint(x: frame.midX, y: frame.midY))
    }

    func testNoUploadWordingWithCloudProcessingOff() throws {
        assertNoUpload("launch")

        // Import the bundled fixture clip.
        let sample = app.buttons["Try the sample clip"]
        XCTAssertTrue(sample.waitForExistence(timeout: 10))
        sample.tap()
        watch("import", seconds: 2)
        let export = app.buttons["Export"]
        XCTAssertTrue(export.waitForExistence(timeout: 20))

        // Apply an edit (a suggestion pill sends its prompt; the edit runs on device).
        // "Speed up 2×" avoids the Captions pill's speech-permission prompt.
        // The pill row scrolls horizontally, so the pill may start off-screen: scroll it into view.
        let byID = app.buttons["suggestion-v-speed-2x"]
        let pill = byID.waitForExistence(timeout: 5) ? byID : app.buttons["Speed up 2×"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "Speed up 2× suggestion pill exists")
        scrollIntoView(pill, label: "Speed up 2×")
        XCTAssertTrue(isOnScreen(pill), "Speed up 2× pill scrolled into view")
        pill.tap()
        watch("edit", seconds: 6)

        // Start an export once the editor is idle.
        let enabled = NSPredicate(format: "isEnabled == true")
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: export)], timeout: 90)
        XCTAssertTrue(export.isEnabled, "editor idle again after the edit")
        export.tap()
        let saveToFiles = app.buttons["Save to Files"]
        XCTAssertTrue(saveToFiles.waitForExistence(timeout: 10))
        watch("export sheet", seconds: 1)
        saveToFiles.tap()
        watch("export", seconds: 6)
    }
}
