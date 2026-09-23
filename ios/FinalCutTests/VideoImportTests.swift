import AVFoundation
import XCTest
@testable import FinalCut

final class VideoImportTests: XCTestCase {
    func testCopiesAreIndependentAndPreserveContainerExtension() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        let original = Data("first video".utf8)
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let first = try ImportedVideo.copy(from: source)
        defer { try? FileManager.default.removeItem(at: first.url.deletingLastPathComponent()) }
        try Data("second video".utf8).write(to: source)
        let second = try ImportedVideo.copy(from: source)
        defer { try? FileManager.default.removeItem(at: second.url.deletingLastPathComponent()) }

        XCTAssertNotEqual(first.url, source)
        XCTAssertNotEqual(first.url, second.url)
        XCTAssertEqual(first.url.lastPathComponent, source.lastPathComponent)
        XCTAssertEqual(try Data(contentsOf: first.url), original)
        XCTAssertEqual(try Data(contentsOf: second.url), Data("second video".utf8))
    }

    @MainActor
    func testImportedVideoPlaysAfterOriginalFileIsRemoved() async throws {
        let fixture = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: fixture, to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let model = EditorViewModel()
        await model.handleImport(.success([source]))
        let imported = try XCTUnwrap(model.localVideoURL)
        defer { try? FileManager.default.removeItem(at: imported.deletingLastPathComponent()) }
        XCTAssertEqual(model.state, .ready)
        XCTAssertNotEqual(imported, source)
        try FileManager.default.removeItem(at: source)

        // Reproduce the original failure: preview reads the asset after picker access ends.
        let asset = AVURLAsset(url: imported)
        let playable = try await asset.load(.isPlayable)
        XCTAssertTrue(playable)
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        player.isMuted = true
        player.play()
        defer { player.pause() }
        let deadline = Date().addingTimeInterval(10)
        while player.currentTime().seconds < 0.1, Date() < deadline, player.currentItem?.status != .failed {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(player.currentItem?.status, .readyToPlay, player.currentItem?.error?.localizedDescription ?? "")
        XCTAssertGreaterThan(player.currentTime().seconds, 0.1)
    }

    @MainActor
    func testFailedImportPreservesCurrentVideoAndNextImportRecovers() async throws {
        let model = EditorViewModel()
        let previous = URL(fileURLWithPath: "/previous.mp4")
        model.localVideoURL = previous
        model.state = .ready
        model.captionArtifacts.srt = "captions for the previous video"

        let source = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mov")
        await model.handleImport(.success([source]))
        XCTAssertEqual(model.state, .failed)
        XCTAssertNotNil(model.lastError)
        XCTAssertEqual(model.localVideoURL, previous)
        XCTAssertTrue(model.messages.isEmpty)

        try Data("replacement".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        await model.handleImport(.success([source]))
        let imported = try XCTUnwrap(model.localVideoURL)
        defer { try? FileManager.default.removeItem(at: imported.deletingLastPathComponent()) }
        XCTAssertEqual(model.state, .ready)
        XCTAssertNil(model.lastError)
        XCTAssertNil(model.captionArtifacts.srt)
        XCTAssertEqual(imported.pathExtension, "mov")
        XCTAssertEqual(model.messages.count, 1)
    }
}
