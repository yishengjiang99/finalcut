import AVFoundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import FinalCut

final class SlideshowBuilderTests: XCTestCase {
    func testTimingFrameCountAndDuration() {
        let timing = SlideshowBuilder.Timing(photoCount: 4)
        XCTAssertEqual(timing.framesPerPhoto, 83) // 2.75 s @ 30 fps, rounded
        XCTAssertEqual(timing.fadeFrames, 15)
        XCTAssertEqual(timing.totalFrames, 332)
        XCTAssertEqual(timing.duration, 332.0 / 30, accuracy: 0.0001)
        XCTAssertEqual(SlideshowBuilder.Timing(photoCount: 1).totalFrames, 83)
    }

    func testCrossfadeKeepsPickOrder() {
        let timing = SlideshowBuilder.Timing(photoCount: 3)
        XCTAssertEqual(timing.layer(at: 0).index, 0)
        XCTAssertNil(timing.layer(at: 67).next)            // before the fade
        let fade = timing.layer(at: 68)                     // first fade frame
        XCTAssertEqual(fade.index, 0); XCTAssertEqual(fade.next, 1)
        XCTAssertGreaterThan(fade.mix, 0); XCTAssertLessThan(fade.mix, 1)
        XCTAssertEqual(timing.layer(at: 83).index, 1)
        XCTAssertNil(timing.layer(at: timing.totalFrames - 1).next) // last photo never fades out
        XCTAssertEqual(timing.layer(at: timing.totalFrames - 1).index, 2)
    }

    func testOutputSizeFollowsFirstPhotoAspect() {
        XCTAssertEqual(SlideshowBuilder.outputSize(forFirstPhoto: CGSize(width: 4032, height: 3024)), CGSize(width: 1440, height: 1080))
        XCTAssertEqual(SlideshowBuilder.outputSize(forFirstPhoto: CGSize(width: 3024, height: 4032)), CGSize(width: 1080, height: 1440))
        XCTAssertEqual(SlideshowBuilder.outputSize(forFirstPhoto: CGSize(width: 100, height: 1000)), CGSize(width: 1080, height: 1920))
        XCTAssertEqual(SlideshowBuilder.outputSize(forFirstPhoto: nil), CGSize(width: 1080, height: 1920))
    }

    func testUprightImageAppliesEXIFOrientation() throws {
        let url = try Self.jpeg(width: 40, height: 20, orientation: 6) // stored landscape, displayed portrait
        let image = try XCTUnwrap(SlideshowBuilder.uprightImage(at: url, maxPixelSize: 1920))
        XCTAssertEqual(image.width, 20)
        XCTAssertEqual(image.height, 40)
    }

    func testBuildWritesVideoWithAudioTrack() async throws {
        let photos = [try Self.jpeg(width: 64, height: 48, orientation: 1), try Self.jpeg(width: 48, height: 64, orientation: 6)]
        let url = try await SlideshowBuilder.build(photos: photos)
        let asset = AVURLAsset(url: url)
        let video = try XCTUnwrap(try await asset.loadTracks(withMediaType: .video).first)
        let size = try await video.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 1440, height: 1080))
        XCTAssertFalse(try await asset.loadTracks(withMediaType: .audio).isEmpty)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, SlideshowBuilder.Timing(photoCount: 2).duration, accuracy: 0.1)
    }

    @MainActor
    func testSlideshowProjectIsVideoThatAcceptsAudioTools() async throws {
        let model = EditorViewModel()
        let photos = try (0..<2).map { _ in try ImportedVideo.copy(from: Self.jpeg(width: 64, height: 48, orientation: 1), contentType: .jpeg) }
        await model.importSelection(videos: [], photos: photos, failures: 0)
        let url = try XCTUnwrap(model.localVideoURL)
        XCTAssertFalse(model.isPhoto)
        XCTAssertFalse(model.messages.contains { $0.content.contains("weren't opened") })
        let canvas = try XCTUnwrap(await EditorViewModel.loadCanvas(url))
        XCTAssertFalse(canvas.isPhoto)
        XCTAssertTrue(canvas.hasAudio)
        let args: [String: JSONValue] = ["prompt": .string("piano"), "duration_seconds": .number(5)]
        XCTAssertEqual(NativeToolParser.plan(tool: "add_soundtrack", arguments: args, canvas: canvas),
                       .success(.generatedSoundtrack(arguments: args, originalVolume: 0.3)))
        if case .failure = NativeToolParser.plan(tool: "adjust_audio_volume", arguments: ["volume": .number(0.5)], canvas: canvas) {
            XCTFail("volume should apply to a slideshow")
        }
        XCTAssertNotEqual(ToolCatalog.plan(tool: "add_soundtrack", arguments: args, isPhoto: model.isPhoto),
                          .reject(error: ServerErrorCode.unsupportedForPhoto))
    }

    static func jpeg(width: Int, height: Int, orientation: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("slide-\(UUID().uuidString).jpg")
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height),
                                            format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .image { ctx in UIColor.orange.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height)) }
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, try XCTUnwrap(image.cgImage),
                                   [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url
    }
}
