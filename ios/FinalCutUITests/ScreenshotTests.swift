import XCTest

/// App Store screenshot capture (ASC first pass). Each test launches the app with
/// `-ScreenshotState <name>`, which (DEBUG only) seeds the Editor with fixture data
/// (see `ios/FinalCut/Screenshots/ScreenshotFixtures.swift`), then saves a full-screen PNG
/// as a keep-always attachment named `NN-<slug>`. `.github/workflows/ios-screenshots.yml`
/// exports them from the .xcresult and renames them `iphone69-NN-<slug>.png` / `ipad13-NN-<slug>.png`.
///
/// Order and slugs follow the six frames in docs/asc/LISTING.md.
/// Elements are found by label: SwiftUI's container identifier ("Editor") overrides inner
/// identifiers in the accessibility tree.
final class ScreenshotTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    func test01Editor() throws {
        try launch(state: "editor", readyText: "Loaded sample clip")
        capture("01-editor")
    }

    func test02EditCard() throws {
        try launch(state: "edit-card", readyText: "Done. I cut the first three seconds, so the clip now opens on the action.")
        capture("02-edit-card")
    }

    func test03Compare() throws {
        try launch(state: "compare", readyText: "Made it warmer. Here's the original next to the edit.")
        capture("03-compare")
    }

    func test04Title() throws {
        try launch(state: "title", readyText: "Added “Day One” as a title over the opening.")
        capture("04-title")
    }

    func test05ColorLook() throws {
        try launch(state: "color-look", readyText: "Applied a warm film look with a soft vignette.")
        capture("05-color-look")
    }

    func test06Export() throws {
        try launch(state: "export", readyText: "Your video is ready. Tap Export to save it to Photos.")
        let export = app.buttons["Export"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 10), "Export button in the top bar")
        export.tap()
        let sheetButton = app.buttons["Share / Save (stub)"]
        if !sheetButton.waitForExistence(timeout: 10) {
            print(app.debugDescription)
            XCTFail("export sheet did not appear")
        }
        settle(3)
        capture("06-export")
    }

    // MARK: - Helpers

    private func launch(state: String, readyText: String) throws {
        app = XCUIApplication()
        app.launchArguments += ["-ScreenshotState", state]
        app.launch()
        // Wait for the fixture to finish rendering its preview clip and seed the chat.
        let ready = app.staticTexts[readyText]
        if !ready.waitForExistence(timeout: 90) {
            print(app.debugDescription)
            XCTFail("fixture state \(state) never became ready")
        }
        XCTAssertFalse(app.buttons["Not now"].exists, "paywall must not be showing")
        // Let AVPlayer draw its first frame and the player chrome settle.
        settle(4)
    }

    private func settle(_ seconds: TimeInterval) {
        let exp = expectation(description: "settle")
        exp.isInverted = true
        wait(for: [exp], timeout: seconds)
    }

    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(data: shot.pngRepresentation, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
