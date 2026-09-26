import AVFoundation
import XCTest
@testable import FinalCut

@MainActor
final class ExportTests: XCTestCase {
    private func clip() throws -> URL {
        try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
    }
    private let canvas = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)

    func testSheetOffersPhotosAndFiles() {
        XCTAssertEqual(ExportSheet.destinations, [.photos, .files])
        XCTAssertEqual(ExportSheet.destinations.map(\.title), ["Save to Photos", "Save to Files"])
    }

    func testNoEditsExportsTheOriginal() async throws {
        let url = try clip()
        let controller = ExportController(defaults: UserDefaults(suiteName: "ExportTests-\(UUID())")!)
        let stack = EditStack(base: url, baseCanvas: canvas)
        let out = try await controller.render(stack: stack, fallbackURL: url)
        XCTAssertEqual(out, url)
        // Without a stack (not built yet) the file itself is used.
        let fallback = try await ExportController().render(stack: nil, fallbackURL: url)
        XCTAssertEqual(fallback, url)
    }

    func testEditedExportIsPlayableWithExpectedDuration() async throws {
        let url = try clip()
        var stack = EditStack(base: url, baseCanvas: canvas)
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 1, end: 3)))
        stack.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "red", intensity: 1)))
        let controller = ExportController(defaults: UserDefaults(suiteName: "ExportTests-\(UUID())")!)
        let out = try await controller.render(stack: stack, fallbackURL: url)
        defer { try? FileManager.default.removeItem(at: out) }
        XCTAssertNotEqual(out, url)
        XCTAssertEqual(out.pathExtension, "mp4")
        XCTAssertEqual(controller.renderedURL, out, "cached for Photos / Files / Share")
        let asset = AVURLAsset(url: out)
        let playable = try await asset.load(.isPlayable)
        XCTAssertTrue(playable)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 2, accuracy: 0.15)
        // Second render reuses the file.
        let again = try await controller.render(stack: stack, fallbackURL: url)
        XCTAssertEqual(again, out)
    }

    func testEditedPhotoExportKeepsFormat() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let png = dir.appendingPathComponent("p.png")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        try XCTUnwrap(image.pngData()).write(to: png)
        var stack = EditStack(base: png, baseCanvas: NativeCanvas(width: 64, height: 48, duration: 0, isPhoto: true, hasAudio: false))
        stack.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "grayscale", intensity: 1)))
        let out = try await ExportController(defaults: UserDefaults(suiteName: "ExportTests-\(UUID())")!).render(stack: stack, fallbackURL: png)
        XCTAssertEqual(out.pathExtension, "png")
        XCTAssertNotNil(UIImage(contentsOfFile: out.path))
    }
}
