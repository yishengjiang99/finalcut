import XCTest

/// Timeline ruler scrubbing and Split on the real app (sample clip). Elements are found
/// by label: the editor's container identifier overrides inner identifiers.
final class TimelineScrubUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let notNow = app.buttons["Not now"] // the launch paywall covers the editor
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        let sample = app.buttons["Try the sample clip"]
        if sample.waitForExistence(timeout: 8) { sample.tap() }
        let loaded = app.buttons["Export"].waitForExistence(timeout: 20)
        if !loaded { print(app.debugDescription) }
        XCTAssertTrue(loaded, "sample clip loaded")
        let toggle = app.buttons["Timeline"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
    }

    private var ruler: XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Playhead")).firstMatch }
    private var playheadTime: XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Playhead time")).firstMatch }

    func testDraggingTheRulerMovesThePlayhead() throws {
        XCTAssertTrue(ruler.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(playheadTime.value as? String, "0:00")
        // A plain finger drag (no hold first), left to right across the ruler.
        let start = ruler.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        let end = ruler.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5))
        start.press(forDuration: 0.01, thenDragTo: end)
        XCTAssertNotEqual(playheadTime.value as? String, "0:00", "the playhead didn't move")
    }

    func testSplitAtThePlayheadMakesTwoClips() throws {
        XCTAssertTrue(ruler.waitForExistence(timeout: 10))
        let start = ruler.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        let end = ruler.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.01, thenDragTo: end)
        app.buttons["Split"].tap()
        let twoClips = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "of 2")).firstMatch
        XCTAssertTrue(twoClips.waitForExistence(timeout: 5), app.debugDescription)
    }

    /// A timeline wider than the screen (long clip / zoomed in) is a scroll view that can
    /// take the drag; the ruler must still scrub.
    func testDraggingTheRulerScrubsWhenTheTimelineScrolls() throws {
        XCTAssertTrue(ruler.waitForExistence(timeout: 10))
        let zoomIn = app.buttons["Zoom timeline in"]
        for _ in 0..<6 { zoomIn.tap() }
        // 6s at the maximum zoom (64 pt/s) is wider than the lanes' visible width.
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: ruler.frame.minX + 20, dy: ruler.frame.midY))
        let end = start.withOffset(CGVector(dx: 200, dy: 0))
        start.press(forDuration: 0.01, thenDragTo: end)
        XCTAssertNotEqual(playheadTime.value as? String, "0:00", "the playhead didn't move")
    }

    func testSplitAtTheStartExplainsWhyNothingHappened() throws {
        XCTAssertTrue(ruler.waitForExistence(timeout: 10))
        app.buttons["Split"].tap() // playhead at 0:00 = the clip's edge
        let note = app.staticTexts["Move the playhead inside a clip to split"]
        XCTAssertTrue(note.waitForExistence(timeout: 3), app.debugDescription)
    }
}
