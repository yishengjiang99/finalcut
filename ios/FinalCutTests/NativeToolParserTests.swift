import XCTest
@testable import FinalCut

final class NativeToolParserTests: XCTestCase {
    let video = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)
    let photo = NativeCanvas(width: 4032, height: 3024, duration: 0, isPhoto: true, hasAudio: false)

    private func plan(_ tool: String, _ args: [String: JSONValue], _ canvas: NativeCanvas? = nil) -> Result<NativePlan, NativeToolError> {
        NativeToolParser.plan(tool: tool, arguments: args, canvas: canvas ?? video)
    }

    private func op(_ tool: String, _ args: [String: JSONValue], _ canvas: NativeCanvas? = nil) -> NativeOp? {
        if case .success(.apply(let o)) = plan(tool, args, canvas) { return o }
        return nil
    }

    private func isInvalid(_ r: Result<NativePlan, NativeToolError>) -> Bool {
        if case .failure(.invalidArguments) = r { return true }
        return false
    }

    func testAllowlistIsTheBuild10Twenty() {
        XCTAssertEqual(NativeToolParser.supportedTools.count, 21)
        XCTAssertTrue(NativeToolParser.isSupported("generate_captions"))
        XCTAssertFalse(NativeToolParser.isSupported("translate_captions"))
        XCTAssertFalse(NativeToolParser.isSupported("burn_subtitles"))
        XCTAssertTrue(NativeToolParser.isSupported("apply_color_filter"))
        XCTAssertFalse(NativeToolParser.isSupported("audio_chorus"))
    }

    func testTrim() {
        XCTAssertEqual(op("trim_video", ["start": .string("00:01"), "end": .number(3)]), .trim(start: 1, end: 3))
        XCTAssertEqual(op("trim_video", ["start": .number(2), "end": .number(60)]), .trim(start: 2, end: 6))
        XCTAssertTrue(isInvalid(plan("trim_video", ["start": .number(3), "end": .number(2)])))
        XCTAssertTrue(isInvalid(plan("trim_video", ["start": .number(1)])))
        XCTAssertEqual(NativeToolParser.parseTime(.string("1:02:03.5")), 3723.5)
    }

    func testSpeedRange() {
        XCTAssertEqual(op("adjust_speed", ["speed": .number(2)]), .speed(2))
        XCTAssertEqual(op("adjust_speed", ["speed": .string("0.5")]), .speed(0.5))
        XCTAssertTrue(isInvalid(plan("adjust_speed", ["speed": .number(5)])))
    }

    func testCropMustFitCanvas() {
        XCTAssertEqual(op("crop_video", ["x": .number(0), "y": .number(0), "width": .number(640), "height": .number(720)]),
                       .crop(x: 0, y: 0, width: 640, height: 720))
        XCTAssertTrue(isInvalid(plan("crop_video", ["x": .number(700), "y": .number(0), "width": .number(640), "height": .number(720)])))
    }

    func testResizeKeepsAspectWithMinusOne() {
        XCTAssertEqual(op("resize_video", ["width": .number(640), "height": .number(-1)]), .resize(width: 640, height: 360))
        XCTAssertTrue(isInvalid(plan("resize_video", ["width": .number(-1), "height": .number(-1)])))
        XCTAssertEqual(op("resize_video_preset", ["preset": .string("9:16")]), .pad(width: 1080, height: 1920))
    }

    func testColorFilterAliasesAndValidation() {
        XCTAssertEqual(op("apply_color_filter", ["filter": .string("red")]), .colorFilter(filter: "red", intensity: 1))
        XCTAssertEqual(op("apply_color_filter", ["filter": .string("Gray")]), .colorFilter(filter: "grayscale", intensity: 1))
        XCTAssertEqual(op("apply_color_filter", ["filter": .string("black and white"), "intensity": .number(0.5)]),
                       .colorFilter(filter: "black_and_white", intensity: 0.5))
        XCTAssertTrue(isInvalid(plan("apply_color_filter", ["filter": .string("bogus")])))
        XCTAssertTrue(isInvalid(plan("apply_color_filter", ["filter": .string("red"), "intensity": .number(2)])))
    }

    func testAudioNeedsAnAudioTrack() {
        XCTAssertEqual(op("adjust_audio_volume", ["volume": .number(0.5)]), .volume(0.5))
        var silent = video
        silent.hasAudio = false
        XCTAssertTrue(isInvalid(plan("adjust_audio_volume", ["volume": .number(0.5)], silent)))
        XCTAssertEqual(op("audio_fade", ["type": .string("out"), "duration": .number(1)]), .fade(isIn: false, duration: 1, start: nil))
        XCTAssertEqual(op("audio_fade", ["type": .string("in"), "duration": .number(2), "start": .number(1)]),
                       .fade(isIn: true, duration: 2, start: 1))
    }

    func testGapsAndPhotoRules() {
        XCTAssertEqual(plan("audio_chorus", [:]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("convert_video_format", ["format": .string("webm")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(op("convert_video_format", ["format": .string("mov")]), .outputFormat("mov"))
        XCTAssertEqual(plan("trim_video", ["start": .number(0), "end": .number(1)], photo), .failure(.unsupportedForPhoto))
        XCTAssertEqual(op("convert_image_format", ["format": .string("jpeg")], photo), .outputFormat("jpg"))
        XCTAssertEqual(plan("convert_image_format", ["format": .string("webp")], photo), .failure(.unsupportedOnDevice))
        XCTAssertEqual(op("adjust_brightness", ["brightness": .number(0.2)], photo), .colorControls(brightness: 0.2, contrast: 1, saturation: 1))
        XCTAssertEqual(plan("get_video_dimensions", [:]), .success(.query("get_video_dimensions")))
    }

    func testGenerateCaptionsPlans() {
        XCTAssertEqual(plan("generate_captions", [:]), .success(.captions(language: nil, burnIn: true)))
        XCTAssertEqual(plan("generate_captions", ["language": .string("es"), "burn_in": .bool(false)]),
                       .success(.captions(language: "es", burnIn: false)))
        XCTAssertEqual(plan("generate_captions", ["language": .string("auto")]), .success(.captions(language: nil, burnIn: true)))
        var silent = video
        silent.hasAudio = false
        XCTAssertTrue(isInvalid(plan("generate_captions", [:], silent)))
        XCTAssertEqual(plan("generate_captions", [:], photo), .failure(.unsupportedForPhoto))
    }

    func testCanvasTracksEdits() {
        let rotated = video.applying(.rotate(degrees: 90))
        XCTAssertEqual([rotated.width, rotated.height], [720, 1280])
        let timed = video.applying(.trim(start: 1, end: 5)).applying(.speed(2))
        XCTAssertEqual(timed.duration, 2, accuracy: 0.001)
        XCTAssertEqual(NativeToolError.unsupportedOnDevice.toolError, "unsupported_on_device")
    }
}
