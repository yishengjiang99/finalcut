import XCTest
@testable import FinalCut

final class StillVideoPromotionTests: XCTestCase {

    func testDurationPrefersExplicitRequest() {
        XCTAssertEqual(StillVideoPromotion.duration(requested: 20, soundtrackLength: 14), 20)
        XCTAssertEqual(StillVideoPromotion.duration(requested: 8, soundtrackLength: nil), 8)
    }

    func testDurationFallsBackToSoundtrackLength() {
        XCTAssertEqual(StillVideoPromotion.duration(requested: nil, soundtrackLength: 14), 14)
        XCTAssertEqual(StillVideoPromotion.duration(requested: 0, soundtrackLength: 14), 14)
        XCTAssertEqual(StillVideoPromotion.duration(requested: -1, soundtrackLength: 7), 7)
    }

    func testDurationDefaultsToTenSeconds() {
        XCTAssertEqual(StillVideoPromotion.duration(requested: nil, soundtrackLength: nil), 10)
        XCTAssertEqual(StillVideoPromotion.duration(requested: 0, soundtrackLength: 0), 10)
        XCTAssertEqual(StillVideoPromotion.duration(requested: .nan, soundtrackLength: .infinity), 10)
    }

    func testRequestedDurationFromSoundtrackArgs() {
        let args: [String: JSONValue] = ["prompt": .string("calm piano"), "duration_seconds": .number(20)]
        XCTAssertEqual(StillVideoPromotion.requestedDuration(tool: "add_soundtrack", arguments: args), 20)
        XCTAssertNil(StillVideoPromotion.requestedDuration(tool: "add_soundtrack", arguments: ["prompt": .string("x")]))
    }

    func testRequestedDurationFromTrimUsesEndSoTheRangeFits() {
        let args: [String: JSONValue] = ["start": .number(0), "end": .number(5)]
        XCTAssertEqual(StillVideoPromotion.requestedDuration(tool: "trim_video", arguments: args), 5)
        let mid: [String: JSONValue] = ["start": .number(2), "end": .number(8)]
        XCTAssertEqual(StillVideoPromotion.requestedDuration(tool: "trim_video", arguments: mid), 8)
    }

    func testCaptionAndSoundtrackNeedStillVideoAndFrameEditsDoNot() {
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "generate_captions"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "lyric_captions"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "add_soundtrack"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "youtube_soundtrack"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "trim_video"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "adjust_speed"))
        XCTAssertTrue(StillVideoPromotion.needsStillVideo(tool: "audio_effect"))
        XCTAssertFalse(StillVideoPromotion.needsStillVideo(tool: "add_text"))
        XCTAssertFalse(StillVideoPromotion.needsStillVideo(tool: "apply_color_filter"))
        XCTAssertFalse(StillVideoPromotion.needsStillVideo(tool: "crop_video"))
        XCTAssertFalse(StillVideoPromotion.needsStillVideo(tool: "ffmpeg_cli"))
        XCTAssertFalse(StillVideoPromotion.needsStillVideo(tool: "get_video_dimensions"))
    }

    func testToolCatalogNoLongerRefusesCaptionOrSoundtrackOnPhotos() {
        if case .reject = ToolCatalog.plan(tool: "generate_captions", arguments: [:], isPhoto: true) {
            XCTFail("generate_captions on a photo should plan; the client converts first")
        }
        let args: [String: JSONValue] = ["prompt": .string("piano"), "duration_seconds": .number(20)]
        if case .reject = ToolCatalog.plan(tool: "add_soundtrack", arguments: args, isPhoto: true) {
            XCTFail("add_soundtrack on a photo should plan; the client converts first")
        }
        if case .reject(let error) = ToolCatalog.plan(
            tool: "trim_video", arguments: ["start": .number(0), "end": .number(2)], isPhoto: true
        ) {
            XCTFail("trim_video on a photo should plan, got \(error)")
        }
        // Frame edits are unchanged.
        XCTAssertEqual(
            ToolCatalog.plan(tool: "apply_color_filter", arguments: ["filter": .string("warm")], isPhoto: true),
            .serverJob(operation: "apply_color_filter", args: ["filter": .string("warm")])
        )
    }
}
