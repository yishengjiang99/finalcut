import XCTest
@testable import FinalCut

final class DictationEndpointerTests: XCTestCase {
    func testSendsQuickAfterSentencePunctuation() {
        var e = DictationEndpointer(now: 0)
        XCTAssertEqual(e.partial("Make it black and white.", isFinal: false, now: 1.0), .none)
        XCTAssertEqual(e.tick(now: 1.3), .none)
        XCTAssertEqual(e.tick(now: 1.4), .send("Make it black and white"))
        // Nothing left to send afterwards.
        XCTAssertEqual(e.tick(now: 3.0), .none)
    }

    func testSendsAfterOneSecondOfSilenceWithoutPunctuation() {
        var e = DictationEndpointer(now: 0)
        _ = e.partial("speed it", isFinal: false, now: 0.5)
        _ = e.partial("speed it up", isFinal: false, now: 0.9)
        XCTAssertEqual(e.tick(now: 1.5), .none)
        XCTAssertEqual(e.tick(now: 1.85), .none)
        XCTAssertEqual(e.tick(now: 1.9), .send("speed it up"))
    }

    func testTranscriptChangesResetTheSilenceTimer() {
        var e = DictationEndpointer(now: 0)
        _ = e.partial("add", isFinal: false, now: 0)
        XCTAssertEqual(e.tick(now: 0.8), .none)
        _ = e.partial("add a title", isFinal: false, now: 0.8)
        XCTAssertEqual(e.tick(now: 1.7), .none)
        XCTAssertEqual(e.tick(now: 1.8), .send("add a title"))
    }

    func testFinalResultSendsImmediately() {
        var e = DictationEndpointer(now: 0)
        XCTAssertEqual(e.partial("Flip it?", isFinal: true, now: 0.2), .send("Flip it"))
    }

    func testNeverSendsEmptyOrPunctuationOnly() {
        var e = DictationEndpointer(now: 0)
        XCTAssertEqual(e.partial("  ", isFinal: true, now: 0.1), .none)
        XCTAssertEqual(e.partial(".", isFinal: false, now: 0.2), .none)
        XCTAssertEqual(e.tick(now: 5), .none)
        XCTAssertEqual(DictationEndpointer.clean("Trim the start. ?! "), "Trim the start")
    }

    func testStopsAfterThirtySecondsWithoutSpeech() {
        var e = DictationEndpointer(now: 0)
        XCTAssertEqual(e.tick(now: 29.9), .none)
        XCTAssertEqual(e.tick(now: 30), .stop)
    }

    func testNoSpeechWindowRestartsAfterASend() {
        var e = DictationEndpointer(now: 0)
        XCTAssertEqual(e.partial("Make it red.", isFinal: false, now: 20), .none)
        XCTAssertEqual(e.tick(now: 20.4), .send("Make it red"))
        XCTAssertEqual(e.tick(now: 40), .none)
        XCTAssertEqual(e.tick(now: 50.4), .stop)
    }

    @MainActor
    func testPromptsQueueWhileAnEditIsRunning() {
        let model = EditorViewModel()
        model.state = .processing
        model.composerText = "typed draft"
        model.submitPrompt("Make it red")
        model.submitPrompt("Speed up 2x")
        XCTAssertEqual(model.queuedPromptIDs.count, 2)
        XCTAssertEqual(model.messages.suffix(2).map(\.content), ["Make it red", "Speed up 2x"])
        XCTAssertEqual(model.queuedPromptIDs, model.messages.suffix(2).map(\.id))
        // Queuing never touches what the user is typing.
        XCTAssertEqual(model.composerText, "typed draft")
    }
}
