import UIKit
import XCTest
@testable import FinalCut

/// Undo / Redo on the non-destructive edit stack (top-bar buttons and shake to undo).
@MainActor
final class UndoRedoTests: XCTestCase {
    private func clip() throws -> URL {
        try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
    }
    private let videoCanvas = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)
    private let red = EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "red", intensity: 1))
    private let fast = EditEntry(tool: "adjust_speed", op: .speed(2))
    private let trim = EditEntry(tool: "trim_video", op: .trim(start: 1, end: 3))

    // MARK: EditStack

    func testTwoEditsUndoRedoAndNewEditClearsRedo() throws {
        var stack = EditStack(base: try clip(), baseCanvas: videoCanvas)
        stack.push(red)
        stack.push(fast)
        XCTAssertEqual(stack.entries.count, 2)
        XCTAssertFalse(stack.canRedo)

        XCTAssertTrue(stack.undo())
        XCTAssertEqual(stack.entries, [red])
        XCTAssertTrue(stack.canRedo)

        XCTAssertTrue(stack.redo())
        XCTAssertEqual(stack.entries, [red, fast])
        XCTAssertFalse(stack.canRedo)
        XCTAssertFalse(stack.redo(), "nothing left to redo")

        XCTAssertTrue(stack.undo())
        stack.push(trim)
        XCTAssertEqual(stack.entries, [red, trim])
        XCTAssertFalse(stack.canRedo, "a new edit clears redo")
        XCTAssertFalse(stack.redo())
    }

    func testUndoAllThenRedoAllInOrder() throws {
        var stack = EditStack(base: try clip(), baseCanvas: videoCanvas)
        [red, fast, trim].forEach { stack.push($0) }
        while stack.undo() {}
        XCTAssertTrue(stack.entries.isEmpty)
        XCTAssertFalse(stack.canUndo)
        XCTAssertTrue(stack.redo()); XCTAssertEqual(stack.entries, [red])
        XCTAssertTrue(stack.redo()); XCTAssertEqual(stack.entries, [red, fast])
        XCTAssertTrue(stack.redo()); XCTAssertEqual(stack.entries, [red, fast, trim])
        XCTAssertEqual(stack.canvas.duration, 2, accuracy: 0.001)
    }

    func testRedoReappliesACloudRebase() throws {
        let url = try clip()
        var stack = EditStack(base: url, baseCanvas: videoCanvas)
        stack.push(red)
        let cloud = URL(fileURLWithPath: "/tmp/cloud-result.mp4")
        stack.rebase(onto: cloud, canvas: videoCanvas)
        XCTAssertTrue(stack.undo())
        XCTAssertEqual(stack.base, url)
        XCTAssertEqual(stack.entries, [red])
        XCTAssertTrue(stack.redo())
        XCTAssertEqual(stack.base, cloud)
        XCTAssertTrue(stack.entries.isEmpty)
        XCTAssertTrue(stack.canUndo)
    }

    // MARK: Editor model (buttons + UndoManager)

    private func model(base: URL, canvas: NativeCanvas) -> EditorViewModel {
        let model = EditorViewModel()
        model.localVideoURL = base
        model.state = .ready
        model.editStack = EditStack(base: base, baseCanvas: canvas)
        return model
    }

    private func commit(_ entry: EditEntry, on model: EditorViewModel, manager: UndoManager? = nil) {
        guard var stack = model.editStack else { return XCTFail("no stack") }
        stack.push(entry)
        manager?.beginUndoGrouping()
        model.commitEdit(stack)
        manager?.endUndoGrouping()
    }

    func testButtonsUndoRedoOnTheModel() throws {
        let model = model(base: try clip(), canvas: videoCanvas)
        XCTAssertFalse(model.canUndo)
        XCTAssertFalse(model.canRedo)
        commit(red, on: model)
        commit(fast, on: model)
        XCTAssertTrue(model.canUndo)

        model.performUndo()
        XCTAssertEqual(model.editStack?.entries, [red])
        XCTAssertTrue(model.canRedo)
        model.performRedo()
        XCTAssertEqual(model.editStack?.entries, [red, fast])
        XCTAssertFalse(model.canRedo)

        model.performUndo()
        commit(trim, on: model)
        XCTAssertEqual(model.editStack?.entries, [red, trim])
        XCTAssertFalse(model.canRedo, "a new edit clears redo")
    }

    func testShakeToUndoGoesThroughTheUndoManager() throws {
        let model = model(base: try clip(), canvas: videoCanvas)
        let manager = UndoManager()
        manager.groupsByEvent = false
        model.undoManager = manager
        commit(red, on: model, manager: manager)
        commit(fast, on: model, manager: manager)
        XCTAssertTrue(manager.canUndo)
        XCTAssertEqual(manager.undoActionName, UXCopy.editActionName)

        manager.undo()   // what shake → Undo does
        XCTAssertEqual(model.editStack?.entries, [red])
        XCTAssertTrue(manager.canRedo)
        XCTAssertTrue(model.canRedo)

        model.performRedo()   // top-bar Redo uses the same manager
        XCTAssertEqual(model.editStack?.entries, [red, fast])
        XCTAssertFalse(manager.canRedo)

        model.performUndo()
        commit(trim, on: model, manager: manager)
        XCTAssertFalse(manager.canRedo, "a new edit clears the manager's redo too")
        XCTAssertFalse(model.canRedo)
        XCTAssertEqual(model.editStack?.entries, [red, trim])
    }

    func testPhotoUndoRedoAndExportUsesTheCurrentStack() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let png = dir.appendingPathComponent("p.png")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        try XCTUnwrap(image.pngData()).write(to: png)
        let model = model(base: png, canvas: NativeCanvas(width: 64, height: 48, duration: 0, isPhoto: true, hasAudio: false))
        let gray = EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "grayscale", intensity: 1))
        let rotate = EditEntry(tool: "rotate_video", op: .rotate(degrees: 90))
        commit(gray, on: model)
        commit(rotate, on: model)
        XCTAssertEqual(model.editStack?.canvas.width, 48)
        model.performUndo()
        XCTAssertEqual(model.editStack?.entries, [gray])
        XCTAssertEqual(model.editStack?.canvas.width, 64, "preview/export size follows the undo")
        model.performRedo()
        XCTAssertEqual(model.editStack?.canvas.width, 48)

        // Undo everything: Export hands out the untouched original.
        model.performUndo()
        model.performUndo()
        XCTAssertFalse(model.canUndo)
        let out = try await ExportController(defaults: UserDefaults(suiteName: "UndoRedoTests-\(UUID())")!)
            .render(stack: model.editStack, fallbackURL: png)
        XCTAssertEqual(out, png)
    }
}
