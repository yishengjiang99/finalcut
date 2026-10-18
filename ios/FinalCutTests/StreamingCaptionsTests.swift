import XCTest
@testable import FinalCut

/// A scripted ElevenLabs socket: yields `session_started`, then lets `script` answer each
/// `input_audio_chunk` (typically with a committed transcript when `commit` is true).
final class MockCaptionSocket: CaptionSocket, @unchecked Sendable {
    let url: URL
    private(set) var chunks: [[String: Any]] = []
    private(set) var closed = false
    private let script: (MockCaptionSocket, [String: Any]) -> Void
    private var continuation: AsyncThrowingStream<String, Error>.Continuation!
    private var iterator: AsyncThrowingStream<String, Error>.AsyncIterator
    private let lock = NSLock()

    init(url: URL, start: Bool = true, script: @escaping (MockCaptionSocket, [String: Any]) -> Void) {
        self.url = url
        self.script = script
        var c: AsyncThrowingStream<String, Error>.Continuation!
        let stream = AsyncThrowingStream<String, Error> { c = $0 }
        continuation = c
        iterator = stream.makeAsyncIterator()
        if start { push(["message_type": "session_started"]) }
    }

    func push(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        continuation.yield(text)
    }

    func drop() { close() }

    func send(_ text: String) async throws {
        if closed { throw URLError(.networkConnectionLost) }
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        lock.withLock { chunks.append(object) }
        script(self, object)
    }

    func receive() async throws -> String {
        guard let next = try await iterator.next() else { throw URLError(.networkConnectionLost) }
        return next
    }

    func close() {
        closed = true
        continuation.finish()
    }

    /// Audio bytes received so far.
    var audioBytes: Int {
        lock.withLock { chunks.reduce(0) { $0 + (Data(base64Encoded: $1["audio_base_64"] as? String ?? "")?.count ?? 0) } }
    }

    func committed(text: String, words: [(String, Double, Double)], language: String = "eng") {
        push(["message_type": "committed_transcript_with_timestamps", "text": text, "language_code": language,
              "words": words.map { ["text": $0.0, "start": $0.1, "end": $0.2, "type": "word"] as [String: Any] }])
    }
}

@MainActor
final class StreamingCaptionsTests: XCTestCase {
    // MARK: - Pure logic

    private func noisy(seconds: Double, quiet: [ClosedRange<Double>] = []) -> [Int16] {
        let rate = StreamingConstants.sampleRate
        return (0..<Int(seconds * Double(rate))).map { i in
            let t = Double(i) / Double(rate)
            if quiet.contains(where: { $0.contains(t) }) { return 0 }
            return Int16(i % 2 == 0 ? 3000 : -3000)
        }
    }

    func testCommitPlanningCutsAtTheQuietestPointEvery20To30Seconds() {
        let pcm = noisy(seconds: 70, quiet: [27.3...27.5, 52.1...52.3])
        let points = CommitPlanner.points(pcm)
        XCTAssertEqual(points.last, pcm.count, "the last commit is the end of the audio")
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(Double(points[0]) / 16000, 27.4, accuracy: 0.15)
        XCTAssertEqual(Double(points[1]) / 16000, 52.2, accuracy: 0.15 + 0)
        var previous = 0
        for (k, point) in points.enumerated() {
            XCTAssertGreaterThan(point, previous)
            XCTAssertEqual(point % StreamingConstants.gridSamples, k == points.count - 1 ? point % StreamingConstants.gridSamples : 0, "on the 0.1 s grid")
            if k < points.count - 1 {
                let span = Double(point - previous) / 16000
                XCTAssertTrue((20...30).contains(span), "span \(span)")
            }
            previous = point
        }
        // Short audio is one range; nothing is planned inside it.
        XCTAssertEqual(CommitPlanner.points(noisy(seconds: 29)), [29 * 16000])
        XCTAssertEqual(CommitPlanner.points(noisy(seconds: 12)), [12 * 16000])
        // Digital silence is cut in the middle of the span.
        let silent = CommitPlanner.points([Int16](repeating: 0, count: 16000 * 61))
        XCTAssertEqual(silent.count, 3)
        XCTAssertEqual(Double(silent[0]) / 16000, 25, accuracy: 0.2)
    }

    func testResumeOffsetMath() {
        func w(_ s: Double) -> [ElevenWord] { [ElevenWord(text: " Hi ", start: s, end: s + 0.4, type: "word"), ElevenWord(text: " ", start: s + 0.4, end: s + 0.5, type: "spacing")] }
        // A normal session: session-absolute times are kept, spacing is dropped.
        let normal = StreamingLines.offsetWords(w(3.1), sessionStartSec: 0, rangeStartInSession: 0, rangeStartAbs: 0)
        XCTAssertEqual(normal, [TimedWordText(w: "Hi", start: 3.1, end: 3.5)])
        // A resumed socket that starts at second 40: times are relative to the socket, so add 40.
        let resumed = StreamingLines.offsetWords(w(0.5), sessionStartSec: 40, rangeStartInSession: 0, rangeStartAbs: 40)
        XCTAssertEqual(resumed.first?.start ?? 0, 40.5, accuracy: 1e-9)
        XCTAssertEqual(resumed.first?.end ?? 0, 40.9, accuracy: 1e-9)
        // Second range of that resumed socket (starts at 60 = 20 s into the socket).
        let second = StreamingLines.offsetWords(w(21), sessionStartSec: 40, rangeStartInSession: 20, rangeStartAbs: 60)
        XCTAssertEqual(second.first?.start ?? 0, 61, accuracy: 1e-9)
        // Times relative to the range itself are detected and offset from the range start.
        let relative = StreamingLines.offsetWords(w(1), sessionStartSec: 40, rangeStartInSession: 20, rangeStartAbs: 60)
        XCTAssertEqual(relative.first?.start ?? 0, 61, accuracy: 1e-9)
        XCTAssertTrue(StreamingLines.offsetWords([], sessionStartSec: 0, rangeStartInSession: 0, rangeStartAbs: 0).isEmpty)
    }

    func testPercentIsFormulaMonotonicAndClampedAt99() {
        XCTAssertEqual(StreamingPercent.value(sentSec: 0, doneSec: 0, totalSec: 60), 5)
        XCTAssertEqual(StreamingPercent.value(sentSec: 60, doneSec: 0, totalSec: 60), 5 + 47)
        XCTAssertEqual(StreamingPercent.value(sentSec: 30, doneSec: 15, totalSec: 60), 5 + Int((94 * (0.5 * 0.5 + 0.5 * 0.25)).rounded(.down)))
        XCTAssertEqual(StreamingPercent.value(sentSec: 60, doneSec: 60, totalSec: 60), 99, "never 100")
        XCTAssertEqual(StreamingPercent.value(sentSec: 600, doneSec: 600, totalSec: 60), 99)
        XCTAssertEqual(StreamingPercent.value(sentSec: -4, doneSec: -4, totalSec: 60), 5)
        XCTAssertEqual(StreamingPercent.value(sentSec: 1, doneSec: 1, totalSec: 0), 5)
        XCTAssertEqual(StreamingPercent.text(stage: .connecting, percent: nil), "Connecting…")
        XCTAssertEqual(StreamingPercent.text(stage: .listening, percent: 34), "Listening to the audio… 34%")
        XCTAssertEqual(StreamingPercent.text(stage: .translating, percent: 72), "Translating… 72%")
        XCTAssertEqual(StreamingPercent.text(stage: .translating, percent: 100), "Translating… 99%", "100 only after the overlay is ready")
    }

    func testLineBuildingSplitsAtPausesAndKeepsMinimumOnScreenTime() {
        func word(_ t: String, _ s: Double, _ e: Double) -> TimedWordText { TimedWordText(w: t, start: s, end: e) }
        let lines = StreamingLines.build(text: "Hello my friend. How are you?", start: 0.5, end: 5, words: [
            word("Hello", 0.5, 0.9), word("my", 1.0, 1.2), word("friend.", 1.3, 1.9),
            word("How", 4.0, 4.2), word("are", 4.3, 4.4), word("you?", 4.5, 4.6),
        ])
        XCTAssertEqual(lines.map(\.text), ["Hello my friend.", "How are you?"])
        XCTAssertEqual(lines[0].start, 0.5, accuracy: 1e-9)
        XCTAssertEqual(lines[0].end, 1.9, accuracy: 1e-9)
        XCTAssertEqual(lines[1].end - lines[1].start, 0.8, accuracy: 1e-9, "at least 0.8 s on screen")
        XCTAssertEqual(StreamingLines.join([word("你", 0, 1), word("好", 1, 2), word("。", 2, 3)]), "你好。")
        XCTAssertEqual(StreamingLines.build(text: "No words", start: 2, end: 3, words: []).map(\.text), ["No words"])
    }

    func testErrorMappingNeverShowsRawServerText() {
        let couldntFinish = "Captions couldn't finish. Nothing was changed. Try again."
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "streaming_captions_busy", status: 503)), "The transcription service is busy. Try again in a moment.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "rate_limited", status: 429)), "The transcription service is busy. Try again in a moment.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "busy")), "The transcription service is busy. Try again in a moment.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "streaming_captions_unavailable", status: 503)), "Translated captions aren't available right now. Try again later.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "x", status: 503)), "Translated captions aren't available right now. Try again later.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "stalled")), "Captions stopped making progress. Nothing was changed. Try again.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "job_lost")), "Captions couldn't finish because the service restarted. Nothing was changed. Try again.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "audio_too_long", status: 413)), LyricCaptionsCopy.tooLong)
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "x", status: 413)), LyricCaptionsCopy.tooLong)
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "batch_too_large", status: 413)), couldntFinish)
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "no_speech")), "No speech found in this video.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "no_audio")), "This video has no sound to caption.")
        XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: "declined_continue", message: StreamingCopy.connectionDropped(at: 34))),
                       "The connection dropped at 0:34. Captions up to there are kept.")
        for code in ["translation_failed", "weird", "ranges_failed", "network", "unauthorized"] {
            XCTAssertEqual(StreamingCopy.friendly(StreamingError(code: code)), couldntFinish, code)
        }
        XCTAssertEqual(StreamingCopy.timeLimit(at: 600), "The transcription session reached its time limit at 10:00. Captions up to there are kept.")

        // HTTP failures become stable codes (and the paywall).
        let busy = APIClient.streamingError(from: APIError.httpStatus(503, #"{"error":"raw text","code":"streaming_captions_busy"}"#))
        XCTAssertEqual(busy, StreamingError(code: "streaming_captions_busy", status: 503))
        let failed = APIClient.streamingError(from: APIError.httpStatus(502, #"{"error":"x","code":"translation_failed","retryable":true}"#))
        XCTAssertEqual(failed, StreamingError(code: "translation_failed", status: 502, retryable: true))
        XCTAssertEqual(APIClient.streamingError(from: APIError.httpStatus(429, "{}")).code, "rate_limited")
        XCTAssertEqual(APIClient.streamingError(from: APIError.httpStatus(503, "")).code, "streaming_captions_unavailable")
        XCTAssertEqual(APIClient.streamingError(from: APIError.paywallRequired("Active subscription required")).code, "paywall")
        XCTAssertEqual(APIClient.streamingError(from: URLError(.notConnectedToInternet)).code, "network")
    }

    func testTokenSocketURLCarriesQueryAndToken() throws {
        let token = StreamingToken(token: "sutkn_abc", sessionId: "s1", wsUrl: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
                                   query: ["model_id": "scribe_v2_realtime", "audio_format": "pcm_16000", "include_timestamps": "true", "commit_strategy": "manual"])
        let url = try XCTUnwrap(token.socketURL)
        let items = Dictionary(uniqueKeysWithValues: try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items["token"], "sutkn_abc")
        XCTAssertEqual(items["commit_strategy"], "manual")
        XCTAssertNil(items["keepalive_interval_ms"], "never sent")
        XCTAssertEqual(url.host, "api.elevenlabs.io")
    }

    // MARK: - Engine with a scripted socket and stubbed HTTP

    private final class Harness {
        var sockets: [MockCaptionSocket] = []
        var mints: [String?] = []
        var translateRequests: [TranslateRequest] = []
        var percents: [Int] = []
        var stages: [StreamingStage] = []
        /// Per socket index: commits delivered before the socket drops (nil = never drops).
        var dropAfterCommits: [Int: Int] = [:]
        var words: (CaptionRange?, Int) -> [(String, Double, Double)] = { _, _ in [("Hello", 0.5, 0.9), ("there.", 1.0, 1.5)] }
        var translateFailure: ((TranslateRequest) -> StreamingError?)?
        var onCommit: ((MockCaptionSocket, Int) -> Bool)?
        var continueAnswers: [Bool] = []
        var continueAsks: [(Double, String)] = []
        var unresponsive = false

        func deps() -> StreamingDeps {
            var deps = StreamingDeps(
                mint: { [self] _, resume in
                    mints.append(resume)
                    return StreamingToken(token: "t\(mints.count)", sessionId: "S1", wsUrl: "wss://api.elevenlabs.io/rt", query: ["model_id": "m"])
                },
                translate: { [self] request in
                    translateRequests.append(request)
                    if let failure = translateFailure?(request) { throw failure }
                    return StreamingTranslateResponse(
                        lines: request.segments.map { StreamingTranslated(i: $0.i, text: $0.text, translation: "zh " + $0.text) },
                        language: "en", targetLanguage: request.targetLanguage)
                },
                makeSocket: { [self] url in
                    let index = sockets.count
                    var commits = 0
                    let socket = MockCaptionSocket(url: url) { [self] sock, chunk in
                        guard chunk["commit"] as? Bool == true else { return }
                        commits += 1
                        if let limit = dropAfterCommits[index], commits > limit { sock.drop(); return }
                        if unresponsive { return }
                        if let onCommit, onCommit(sock, commits) { return }
                        let spoken = words(nil, commits)
                        sock.committed(text: spoken.map(\.0).joined(separator: " "), words: spoken)
                    }
                    sockets.append(socket)
                    return socket
                })
            deps.sleep = { _ in try await Task.sleep(nanoseconds: 200_000) }
            deps.resumeBackoff = [0, 0, 0]
            deps.onProgress = { [self] p in percents.append(p.percent); stages.append(p.stage) }
            deps.confirmContinue = { [self] at, reason in
                continueAsks.append((at, reason))
                return continueAnswers.isEmpty ? false : continueAnswers.removeFirst()
            }
            return deps
        }
    }

    func testStreamsHalfSecondChunksAndCommitsOnPlannedBoundaries() async throws {
        let h = Harness()
        let pcm = noisy(seconds: 61, quiet: [24.9...25.1, 49.9...50.1])
        let engine = StreamingCaptionsEngine(deps: h.deps())
        let result = try await engine.run(pcm: pcm, targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertEqual(h.sockets.count, 1)
        XCTAssertEqual(h.mints.count, 1)
        XCTAssertEqual(h.mints.first ?? "x", nil, "first token has no resume id")
        let chunks = h.sockets[0].chunks
        XCTAssertEqual(h.sockets[0].audioBytes, pcm.count * 2, "all of the audio, 16-bit")
        XCTAssertTrue(chunks.allSatisfy { ($0["message_type"] as? String) == "input_audio_chunk" && ($0["sample_rate"] as? Int) == 16000 })
        XCTAssertTrue(chunks.allSatisfy { (Data(base64Encoded: $0["audio_base_64"] as! String)?.count ?? 0) <= 16_000 })
        XCTAssertFalse(chunks.contains { $0["keepalive_interval_ms"] != nil })
        let commitIndexes = chunks.enumerated().filter { $0.element["commit"] as? Bool == true }.map(\.offset)
        XCTAssertEqual(commitIndexes.count, 3, "two planned commits plus the last chunk")
        XCTAssertEqual(commitIndexes.last, chunks.count - 1, "the last chunk commits")
        XCTAssertEqual(h.sockets[0].url.query?.contains("token=t1"), true)
        XCTAssertEqual(result.lines.count, 3)
        XCTAssertEqual(result.language, "en")
        XCTAssertEqual(result.sessionId, "S1")
        // Percent: 5 first, monotonic, capped at 99, stages in order.
        XCTAssertEqual(h.percents.first, 5)
        XCTAssertEqual(h.percents, h.percents.sorted())
        XCTAssertLessThanOrEqual(h.percents.max() ?? 0, 99)
        XCTAssertEqual(h.percents.last, 99)
        XCTAssertEqual(h.stages.first, .connecting)
        XCTAssertTrue(h.stages.contains(.listening))
    }

    func testTranslateBatchesInOrderWithContextAndSessionId() async throws {
        let h = Harness()
        // 45 ten-character CJK words in one 28 s range: one line each (18-character limit).
        h.words = { _, _ in (0..<45).map { k in ("字\(k % 10)字字字字字字字字字", Double(k) * 0.6, Double(k) * 0.6 + 0.5) } }
        let engine = StreamingCaptionsEngine(deps: h.deps())
        let result = try await engine.run(pcm: noisy(seconds: 28), targetLanguage: "en", sourceLanguage: "zh")
        XCTAssertEqual(h.translateRequests.map { $0.segments.count }, [20, 20, 5], "ordered batches of at most 20 lines")
        for request in h.translateRequests {
            XCTAssertLessThanOrEqual(request.segments.count, 40)
            XCTAssertLessThanOrEqual(request.segments.reduce(0) { $0 + $1.text.count }, 8000)
            XCTAssertTrue(request.segments.allSatisfy { $0.text.count <= 400 })
            XCTAssertEqual(request.segments.map(\.i), Array(0..<request.segments.count))
            XCTAssertEqual(request.sessionId, "S1")
            XCTAssertEqual(request.targetLanguage, "en")
            XCTAssertEqual(request.sourceLanguage, "zh")
        }
        XCTAssertEqual(h.translateRequests[0].context, [])
        XCTAssertEqual(h.translateRequests[1].context, h.translateRequests[0].segments.suffix(4).map(\.text), "up to 4 previous source lines")
        XCTAssertEqual(result.lines.count, 45)
        XCTAssertEqual(result.lines.map(\.start), result.lines.map(\.start).sorted())
        XCTAssertEqual(result.translatedCount, 45)
    }

    func testTranslationRunsWhileLaterAudioIsStillStreaming() async throws {
        let h = Harness()
        var translatedBeforeLastChunk = 0
        let base = h.deps()
        var deps = base
        let original = base.translate
        deps.translate = { request in
            translatedBeforeLastChunk += (h.sockets.first.map { $0.audioBytes < 61 * 32_000 } ?? false) ? 1 : 0
            return try await original(request)
        }
        deps.pace = 0.5  // slow enough that the first range is translated before the audio ends
        deps.sleep = { _ in try await Task.sleep(nanoseconds: 3_000_000) }
        let engine = StreamingCaptionsEngine(deps: deps)
        _ = try await engine.run(pcm: noisy(seconds: 61, quiet: [24.9...25.1, 49.9...50.1]), targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertGreaterThan(translatedBeforeLastChunk, 0)
    }

    func testRetriesTranslationOnceOn502ThenKeepsGoing() async throws {
        let h = Harness()
        var calls = 0
        h.translateFailure = { _ in
            calls += 1
            return calls == 1 ? StreamingError(code: "translation_failed", status: 502, retryable: true) : nil
        }
        let engine = StreamingCaptionsEngine(deps: h.deps())
        let result = try await engine.run(pcm: noisy(seconds: 10), targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(result.translatedCount, result.lines.count)

        // A paywall answer is never retried and ends the flow with the paywall.
        let paywalled = Harness()
        paywalled.translateFailure = { _ in StreamingError(code: "paywall") }
        do {
            _ = try await StreamingCaptionsEngine(deps: paywalled.deps()).run(pcm: noisy(seconds: 10), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected paywall")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "paywall")
        }
    }

    func testDroppedSocketResumesFromTheFirstUnfinishedRangeWithTheSameSession() async throws {
        let h = Harness()
        h.dropAfterCommits = [0: 1]   // the first socket delivers range 0, then drops on the next commit
        let pcm = noisy(seconds: 61, quiet: [24.9...25.1, 49.9...50.1])
        let result = try await StreamingCaptionsEngine(deps: h.deps()).run(pcm: pcm, targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertEqual(h.sockets.count, 2)
        XCTAssertEqual(h.mints.count, 2)
        XCTAssertEqual(h.mints[1], "S1", "the resumed token carries the session id")
        let planned = CommitPlanner.points(pcm)
        XCTAssertEqual(h.sockets[1].audioBytes, (pcm.count - planned[0]) * 2, "streams only from the start of the first unfinished range")
        XCTAssertEqual(result.lines.count, 3)
        XCTAssertEqual(result.lines.map(\.start), result.lines.map(\.start).sorted())
        // The resumed socket's timestamps are relative to its start (second ~25) and are offset by it.
        XCTAssertGreaterThan(result.lines[1].start, 25 - 0.2)
        XCTAssertEqual(h.continueAsks.count, 0)
    }

    func testAutoResumeBudgetThenContinueOrCancel() async throws {
        func makeHarness() -> Harness {
            let h = Harness()
            h.dropAfterCommits = [0: 1]
            // Every later socket drops on its first commit.
            for k in 1...40 { h.dropAfterCommits[k] = 0 }
            return h
        }
        let pcm = noisy(seconds: 61, quiet: [24.9...25.1, 49.9...50.1])

        // Cancel at the prompt: finished captions are kept (counted), the error explains.
        let declined = makeHarness()
        do {
            _ = try await StreamingCaptionsEngine(deps: declined.deps()).run(pcm: pcm, targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected declined_continue")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "declined_continue")
            XCTAssertEqual(error.keptLineCount, 1)
            XCTAssertTrue(error.message?.hasPrefix("The connection dropped at 0:2") == true, error.message ?? "")
            XCTAssertTrue(error.message?.hasSuffix("Captions up to there are kept.") == true)
        }
        XCTAssertEqual(declined.sockets.count, 1 + 3, "one socket plus 3 automatic resumes before asking")
        XCTAssertEqual(declined.continueAsks.count, 1)

        // Continue grants a fresh budget of 3, then asks again.
        let continued = makeHarness()
        continued.continueAnswers = [true, false]
        do {
            _ = try await StreamingCaptionsEngine(deps: continued.deps()).run(pcm: pcm, targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected declined_continue")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "declined_continue")
        }
        XCTAssertEqual(continued.continueAsks.count, 2)
        XCTAssertEqual(continued.sockets.count, (1 + 3) + (1 + 3), "each budget: the resumed socket plus 3 automatic resumes")
    }

    func testSessionErrorsMapToTheRightOutcome() async throws {
        // quota_exceeded → unavailable
        let quota = Harness()
        quota.onCommit = { sock, _ in sock.push(["message_type": "quota_exceeded", "error": "raw"]); return true }
        do {
            _ = try await StreamingCaptionsEngine(deps: quota.deps()).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected unavailable")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "unavailable")
            XCTAssertEqual(StreamingCopy.friendly(error), LyricCaptionsCopy.unavailable)
        }
        // rate_limited → retried once after a pause, then busy
        let busy = Harness()
        busy.onCommit = { sock, _ in sock.push(["message_type": "rate_limited"]); return true }
        do {
            _ = try await StreamingCaptionsEngine(deps: busy.deps()).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected busy")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "busy")
            XCTAssertEqual(StreamingCopy.friendly(error), "The transcription service is busy. Try again in a moment.")
        }
        XCTAssertEqual(busy.sockets.count, 2)
        // auth_error → one silent retry with a fresh token
        let auth = Harness()
        auth.onCommit = { sock, n in
            if auth.sockets.count == 1 { sock.push(["message_type": "auth_error"]); return true }
            return false
        }
        let ok = try await StreamingCaptionsEngine(deps: auth.deps()).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertEqual(auth.mints.count, 2)
        XCTAssertEqual(ok.lines.count, 1)
        // insufficient_audio_activity is an empty segment, not an error
        let quiet = Harness()
        quiet.onCommit = { sock, _ in sock.push(["message_type": "insufficient_audio_activity"]); return true }
        do {
            _ = try await StreamingCaptionsEngine(deps: quiet.deps()).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected no_speech")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "no_speech")
        }
        XCTAssertEqual(quiet.sockets.count, 1, "no retry for an empty segment")
        XCTAssertEqual(quiet.translateRequests.count, 0)
    }

    func testTokenErrorsStopBeforeAnySocketOpens() async throws {
        let h = Harness()
        var deps = h.deps()
        deps.mint = { _, _ in throw StreamingError(code: "streaming_captions_unavailable", status: 503) }
        do {
            _ = try await StreamingCaptionsEngine(deps: deps).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected an error")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "streaming_captions_unavailable")
        }
        XCTAssertEqual(h.sockets.count, 0)
        // Transient token errors are retried once.
        var attempts = 0
        deps.mint = { _, _ in
            attempts += 1
            if attempts == 1 { throw StreamingError(code: "network") }
            return StreamingToken(token: "t", sessionId: "S", wsUrl: "wss://x/y", query: [:])
        }
        _ = try await StreamingCaptionsEngine(deps: deps).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
        XCTAssertEqual(attempts, 2)
    }

    func testLongAudioAndSilentClipsAreRefusedBeforeConnecting() async throws {
        let h = Harness()
        let tooLong = [Int16](repeating: 0, count: 16000 * 601)
        do {
            _ = try await StreamingCaptionsEngine(deps: h.deps()).run(pcm: tooLong, targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected audio_too_long")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "audio_too_long")
            XCTAssertEqual(StreamingCopy.friendly(error), LyricCaptionsCopy.tooLong)
        }
        do {
            _ = try await StreamingCaptionsEngine(deps: h.deps()).run(pcm: [], targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected no_audio")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "no_audio")
        }
        XCTAssertEqual(h.mints.count, 0)
        XCTAssertEqual(h.sockets.count, 0)
    }

    func testCancelClosesTheSocketAndStopsTranslateCalls() async throws {
        let h = Harness()
        var deps = h.deps()
        deps.pace = 0.5
        deps.sleep = { _ in try await Task.sleep(nanoseconds: 2_000_000) }
        let engine = StreamingCaptionsEngine(deps: deps)
        let task = Task { try await engine.run(pcm: self.noisy(seconds: 61, quiet: [24.9...25.1, 49.9...50.1]), targetLanguage: "zh-Hans", sourceLanguage: nil) }
        while h.sockets.first.map({ $0.chunks.count < 5 }) ?? true { try await Task.sleep(nanoseconds: 2_000_000) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch is CancellationError {}
        XCTAssertEqual(h.sockets.first?.closed, true, "the socket is closed")
        let sent = h.sockets[0].chunks.count
        let calls = h.translateRequests.count
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(h.sockets[0].chunks.count, sent, "no more audio after cancel")
        XCTAssertEqual(h.translateRequests.count, calls, "no more translate calls after cancel")
        XCTAssertEqual(h.sockets.count, 1, "no resume after cancel")
    }

    func testStallWatchdogTreatsASilentSocketAsADropAndResumes() async throws {
        let h = Harness()
        h.unresponsive = true
        var deps = h.deps()
        deps.stallSeconds = 0.3
        deps.autoResumes = 1
        let started = Date()
        do {
            _ = try await StreamingCaptionsEngine(deps: deps).run(pcm: noisy(seconds: 8), targetLanguage: "zh-Hans", sourceLanguage: nil)
            XCTFail("expected a failure")
        } catch let error as StreamingError {
            XCTAssertEqual(error.code, "ranges_failed")
        }
        XCTAssertGreaterThan(h.sockets.count, 1, "the stalled socket was replaced (resume with a fresh token)")
        XCTAssertLessThan(Date().timeIntervalSince(started), 15)
    }
}
