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
        let pill = app.scrollViews.buttons.firstMatch
        if pill.waitForExistence(timeout: 5) { pill.tap() }
        watch("edit", seconds: 6)

        // Start an export once the editor is idle.
        let enabled = NSPredicate(format: "isEnabled == true")
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: export)], timeout: 60)
        export.tap()
        let saveToFiles = app.buttons["Save to Files"]
        XCTAssertTrue(saveToFiles.waitForExistence(timeout: 10))
        watch("export sheet", seconds: 1)
        saveToFiles.tap()
        watch("export", seconds: 6)
    }
}
