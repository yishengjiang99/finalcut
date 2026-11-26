import AVFoundation
import UIKit
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

    func testPassthroughTrimRangeFoldsSequentialTrims() {
        var stack = EditStack(base: URL(fileURLWithPath: "/tmp/clip.mp4"), baseCanvas: canvas)
        XCTAssertNil(stack.passthroughTrimRange, "empty stack returns the base as-is")
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 1, end: 5)))
        XCTAssertEqual(stack.passthroughTrimRange?.start, 1)
        XCTAssertEqual(stack.passthroughTrimRange?.end, 5)
        // The second trim is expressed on the already-trimmed timeline.
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 1, end: 3)))
        XCTAssertEqual(stack.passthroughTrimRange?.start, 2)
        XCTAssertEqual(stack.passthroughTrimRange?.end, 4)
        stack.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "red", intensity: 1)))
        XCTAssertNil(stack.passthroughTrimRange, "any non-trim op forces the composed render")
    }

    func testTrimOnlyExportPassesThrough() async throws {
        let url = try clip()
        var stack = EditStack(base: url, baseCanvas: canvas)
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 1, end: 3)))
        let controller = ExportController(defaults: UserDefaults(suiteName: "ExportTests-\(UUID())")!)
        let out = try await controller.render(stack: stack, fallbackURL: url)
        defer { try? FileManager.default.removeItem(at: out) }
        XCTAssertNotEqual(out, url)
        let asset = AVURLAsset(url: out)
        let playable = try await asset.load(.isPlayable)
        XCTAssertTrue(playable)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 2, accuracy: 0.15)
    }

    /// HEVC sources (every iPhone HDR clip) export with the HEVC preset so HDR / 10-bit
    /// survive; H.264 sources stay H.264. Checked through a composition, as export sees it.
    func testExportPresetFollowsSourceCodec() async throws {
        let url = try clip()
        let h264Preset = await NativeExporter.presetName(for: AVURLAsset(url: url))
        XCTAssertEqual(h264Preset, AVAssetExportPresetHighestQuality)

        let hevcURL = FileManager.default.temporaryDirectory.appendingPathComponent("hevc-\(UUID()).mov")
        defer { try? FileManager.default.removeItem(at: hevcURL) }
        let session = try XCTUnwrap(AVAssetExportSession(asset: AVURLAsset(url: url), presetName: AVAssetExportPresetHEVCHighestQuality))
        session.outputURL = hevcURL
        session.outputFileType = .mov
        await session.export()
        XCTAssertEqual(session.status, .completed)

        var stack = EditStack(base: hevcURL, baseCanvas: canvas)
        stack.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "red", intensity: 1)))
        let composed = try await NativeComposer.compose(stack)
        let hevcPreset = await NativeExporter.presetName(for: composed.asset)
        XCTAssertEqual(hevcPreset, AVAssetExportPresetHEVCHighestQuality)
        let out = try await NativeExporter().export(composed, format: "mp4") { _ in }
        defer { try? FileManager.default.removeItem(at: out) }
        let outTracks = try await AVURLAsset(url: out).loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(outTracks.first)
        let codec = try await track.load(.formatDescriptions).first.map(CMFormatDescriptionGetMediaSubType)
        XCTAssertEqual(codec, kCMVideoCodecType_HEVC)
    }

    func testTimelineProjectPassthroughOnlyForAnUntouchedTrimmedClip() throws {
        let url = try clip()
        var stack = EditStack(base: url, baseCanvas: canvas)
        stack.project = stack.makeProject()
        let clipID = try XCTUnwrap(stack.project?.videoClips.first?.id)
        try stack.performProjectCommand(.trimVideoClip(clipID: clipID, sourceStart: 1, sourceEnd: 3))
        let trimmed = try XCTUnwrap(stack.project)
        let range = try XCTUnwrap(trimmed.passthroughClip)
        XCTAssertEqual(range.start, 1, accuracy: 0.001)
        XCTAssertEqual(range.end, 3, accuracy: 0.001)

        var sped = trimmed
        sped.videoClips[0].speed = 2
        XCTAssertNil(sped.passthroughClip, "a clip setting forces the render")
        var captioned = trimmed
        captioned.captions = [CaptionCue(start: 0, end: 1, text: "hi")]
        XCTAssertNil(captioned.passthroughClip)
        var resized = trimmed
        resized.canvas = ProjectCanvas(width: 720, height: 1280)
        XCTAssertNil(resized.passthroughClip, "a different canvas letterboxes")
        var split = trimmed
        split.videoClips.append(split.videoClips[0])
        XCTAssertNil(split.passthroughClip)
    }

    func testTimelineTrimExportCopiesTheSource() async throws {
        let url = try clip()
        var stack = EditStack(base: url, baseCanvas: canvas)
        stack.project = stack.makeProject()
        let clipID = try XCTUnwrap(stack.project?.videoClips.first?.id)
        try stack.performProjectCommand(.trimVideoClip(clipID: clipID, sourceStart: 1, sourceEnd: 3))
        XCTAssertTrue(stack.isTimelineProject)
        let controller = ExportController(defaults: UserDefaults(suiteName: "ExportTests-\(UUID())")!)
        let out = try await controller.render(stack: stack, fallbackURL: url)
        defer { try? FileManager.default.removeItem(at: out) }
        let asset = AVURLAsset(url: out)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 2, accuracy: 0.15)
        // Copied, not re-encoded: same codec and bitrate class as the source.
        let srcTracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .video)
        let outTracks = try await asset.loadTracks(withMediaType: .video)
        let srcTrack = try XCTUnwrap(srcTracks.first)
        let outTrack = try XCTUnwrap(outTracks.first)
        let srcRate = try await srcTrack.load(.estimatedDataRate)
        let outRate = try await outTrack.load(.estimatedDataRate)
        XCTAssertEqual(Double(outRate), Double(srcRate), accuracy: Double(srcRate) * 0.25)
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
