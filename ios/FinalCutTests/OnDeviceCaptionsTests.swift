import AVFoundation
import XCTest
@testable import FinalCut

private struct StubCaptioner: CaptionTranscribing {
    var words: [TimedWord] = []
    var failure: OnDeviceCaptioner.Failure?

    func transcribe(_ composed: ComposedVideo, language: String?) async throws -> CaptionTranscript {
        if let failure { throw failure }
        return CaptionTranscript(words: words, language: language ?? "en-US")
    }
}

final class OnDeviceCaptionsTests: XCTestCase {
    private let words = [
        TimedWord(text: "Hello", start: 0.2, duration: 0.4),
        TimedWord(text: "world.", start: 0.7, duration: 0.5),
        TimedWord(text: "Second", start: 2.0, duration: 0.4),
        TimedWord(text: "line", start: 2.5, duration: 0.4),
    ]

    func testCuesAndSubtitleFormats() {
        let cues = CaptionFormatter.cues(from: words)
        XCTAssertEqual(cues.map(\.text), ["Hello world.", "Second line"])
        XCTAssertEqual(cues[0].start, 0.2, accuracy: 0.001)
        XCTAssertEqual(cues[0].end, 1.2, accuracy: 0.001)
        XCTAssertEqual(CaptionFormatter.srt(cues), """
        1
        00:00:00,200 --> 00:00:01,200
        Hello world.

        2
        00:00:02,000 --> 00:00:02,900
        Second line

        """)
        XCTAssertTrue(CaptionFormatter.vtt(cues).hasPrefix("WEBVTT\n\n00:00:00.200 --> 00:00:01.200\nHello world.\n"))
        XCTAssertEqual(CaptionFormatter.timestamp(3723.5, separator: ","), "01:02:03,500")
    }

    func testLongSpeechSplitsIntoShortCues() {
        let many = (0..<30).map { TimedWord(text: "word\($0)", start: Double($0) * 0.3, duration: 0.25) }
        let cues = CaptionFormatter.cues(from: many)
        XCTAssertGreaterThan(cues.count, 3)
        for cue in cues {
            XCTAssertLessThanOrEqual(cue.text.count, CaptionFormatter.maxCharacters + 8)
            XCTAssertLessThanOrEqual(cue.end - cue.start, CaptionFormatter.maxCueDuration + 0.5)
        }
        for (a, b) in zip(cues, cues.dropFirst()) { XCTAssertLessThanOrEqual(a.end, b.start + 0.0001) }
    }

    func testCaptionsFollowLaterTrimAndSpeed() throws {
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        var stack = EditStack(base: clip, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "generate_captions", op: .captions([
            CaptionCue(start: 0.5, end: 1.5, text: "one"),
            CaptionCue(start: 3, end: 4, text: "two"),
        ])))
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 2, end: 6)))
        stack.push(EditEntry(tool: "adjust_speed", op: .speed(2)))
        XCTAssertEqual(stack.captionCues, [CaptionCue(start: 0.5, end: 1, text: "two")])
    }

    func testBurnedInCaptionDrawsAtTheBottomOnlyWhileActive() async throws {
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        var stack = EditStack(base: clip, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "generate_captions", op: .captions([CaptionCue(start: 0, end: 3, text: "HELLO FINALCAP")])))
        let composed = try await NativeComposer.compose(stack)
        let generator = composed.makeImageGenerator()
        let during = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
        let after = try await generator.image(at: CMTime(seconds: 4.5, preferredTimescale: 600)).image
        XCTAssertTrue(hasWhite(during, rows: 560..<700), "caption text near the bottom")
        XCTAssertFalse(hasWhite(after, rows: 560..<700), "no caption after the cue ends")
    }

    private func hasWhite(_ image: CGImage, rows: Range<Int>) -> Bool {
        let w = image.width, h = image.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        for y in rows where y < h {
            for x in stride(from: 0, to: w, by: 2) {
                let i = (y * w + x) * 4
                if data[i] > 230, data[i + 1] > 230, data[i + 2] > 230 { return true }
            }
        }
        return false
    }

    // MARK: - Tool execution (no network: apiClient is nil)

    @MainActor
    func testGenerateCaptionsToolRunsOnDevice() async throws {
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        model.captioner = StubCaptioner(words: words)
        let result = await model.executeToolCall(ClientToolCall(id: "cap1", name: "generate_captions", arguments: [:]))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.executedOn, .device)
        XCTAssertEqual(result.output?["cues"], .number(2))
        XCTAssertEqual(result.output?["burnedIn"], .bool(true))
        guard case .captions(let cues)? = model.editStack?.entries.last?.op else { return XCTFail("captions entry") }
        XCTAssertEqual(cues.count, 2)
        let chips = try XCTUnwrap(model.messages.last?.downloadChips)
        XCTAssertEqual(chips.map(\.label), ["SRT", "VTT"])
        XCTAssertTrue(chips[0].content.contains("Hello world."))
        XCTAssertEqual(model.editStack?.canUndo, true)
    }

    @MainActor
    func testCaptionsWithoutBurnInOnlyOfferFiles() async throws {
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        model.captioner = StubCaptioner(words: words)
        let result = await model.executeToolCall(ClientToolCall(id: "cap2", name: "generate_captions", arguments: ["burn_in": .bool(false)]))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(model.editStack?.entries.count, 0)
        XCTAssertEqual(model.messages.last?.downloadChips.count, 2)
    }

    @MainActor
    func testCaptionsUnavailableAndNoSpeech() async throws {
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        let unavailable = EditorViewModel()
        unavailable.localVideoURL = clip
        unavailable.captioner = StubCaptioner(failure: .unavailable)
        let r1 = await unavailable.executeToolCall(ClientToolCall(id: "c", name: "generate_captions", arguments: [:]))
        XCTAssertEqual(r1.error, "unsupported_on_device")
        XCTAssertEqual(r1.content.objectValue?["code"], .string("unsupported_on_device"))
        XCTAssertEqual(unavailable.messages.last?.failureCard?.kind, .unavailable)

        let silent = EditorViewModel()
        silent.localVideoURL = clip
        silent.captioner = StubCaptioner(words: [])
        let r2 = await silent.executeToolCall(ClientToolCall(id: "c", name: "generate_captions", arguments: [:]))
        XCTAssertEqual(r2.error, "no_speech")
        XCTAssertEqual(silent.messages.last?.content, UXCopy.captionsNoSpeech)
        XCTAssertEqual(silent.editStack?.entries.count, 0)
    }
}
