import Foundation

// The streaming captions flow (docs/api/STREAMING_CAPTIONS.md), a port of the web client's
// src/streamingCaptions.js: plan commit points → mint a token → stream 0.5 s chunks over one
// WebSocket (several, resumed, if it drops) → turn each committed segment into caption lines →
// translate the lines in ordered batches while later audio is still streaming.
// Foundation only: the socket and both HTTP calls come in through `StreamingDeps`, so the whole
// flow runs against stubs in tests.

/// The WebSocket to ElevenLabs. `receive()` throws when the socket is closed or drops.
protocol CaptionSocket: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

struct TranslateRequest: Equatable {
    var targetLanguage: String
    var sourceLanguage: String
    var segments: [StreamingSegment]
    var context: [String]
    var sessionId: String?
}

struct StreamingDeps {
    var mint: (_ sourceLanguage: String?, _ resumeSessionId: String?) async throws -> StreamingToken
    var translate: (_ request: TranslateRequest) async throws -> StreamingTranslateResponse
    var makeSocket: (_ url: URL) -> CaptionSocket
    var sleep: (_ seconds: Double) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000_000)) }
    /// Audio seconds sent per wall-clock second; 4 by default, clamped to 0.5…4.
    var pace = StreamingConstants.defaultPace
    var stallSeconds = StreamingConstants.stallSeconds
    var idleTimeoutSeconds = StreamingConstants.idleTimeoutSeconds
    var connectTimeoutSeconds = StreamingConstants.connectTimeoutSeconds
    var autoResumes = StreamingConstants.autoResumes
    var resumeBackoff = StreamingConstants.resumeBackoff
    var rangeAttempts = 2
    var maxSessions = 20
    /// Asked when the connection drops after the auto-resumes are spent: resume from the first
    /// unfinished range with a fresh token (true) or stop and keep what is finished (false).
    var confirmContinue: (_ atSec: Double, _ reason: String) async -> Bool = { _, _ in false }
    var onProgress: (StreamingProgress) -> Void = { _ in }
}

struct StreamingResult: Equatable {
    var lines: [StreamingLine]
    var language: String?
    var targetLanguage: String
    var audioSeconds: Double
    var sessionId: String?
    var translatedCount: Int
}

// MARK: - One range (the audio between two commits)

enum RangeStatus: Equatable { case pending, running, transcribed, done, failed }

final class CaptionRange {
    let index: Int
    let startSample: Int
    let endSample: Int
    var status: RangeStatus = .pending
    var attempts = 0
    var lines: [StreamingLine] = []
    /// Transcribed but not yet translated lines: a retry only translates again.
    var raw: [StreamingLine]?
    var error: StreamingError?

    init(index: Int, startSample: Int, endSample: Int) {
        self.index = index; self.startSample = startSample; self.endSample = endSample
    }

    var start: Double { Double(startSample) / Double(StreamingConstants.sampleRate) }
    var end: Double { Double(endSample) / Double(StreamingConstants.sampleRate) }
}

// MARK: - One socket

/// ElevenLabs error events that end the session, with what they mean for the flow.
enum StreamingSessionError {
    static let kinds: [String: String] = [
        "rate_limited": "busy", "queue_overflow": "busy", "resource_exhausted": "busy", "commit_throttled": "busy",
        "quota_exceeded": "unavailable", "auth_error": "auth", "unaccepted_terms": "unavailable",
        "session_time_limit_exceeded": "time_limit",
        "transcriber_error": "failed", "input_error": "failed", "invalid_request": "failed",
        "chunk_size_exceeded": "failed", "error": "failed",
    ]

    static func looksLikeError(_ type: String) -> Bool {
        kinds[type] != nil || ["error", "exceeded", "throttled", "rate_limited", "overflow", "exhausted", "terms"].contains { type.contains($0) }
    }
}

enum StreamEnd: Equatable {
    case done, dropped, cancelled
    case error(kind: String, message: String)
}

struct StreamOutcome: Equatable {
    var end: StreamEnd
    var nextExpected: Int
}

@MainActor
final class CaptionStreamSession {
    struct Segment {
        var range: CaptionRange
        var text: String
        var words: [ElevenWord]
        var languageCode: String?
        var sessionStartSec: Double
    }

    private let socket: CaptionSocket
    private let pcm: [Int16]
    private let ranges: [CaptionRange]
    private let sleep: (Double) async throws -> Void
    private let pace: Double
    private let idleTimeout: Double
    private let connectTimeout: Double
    private let created = Date()
    private let sessionStartSec: Double
    private let fromSample: Int
    private let toSample: Int

    var onSegment: (Segment) -> Void = { _ in }
    var onSent: (_ sample: Int) -> Void = { _ in }
    var onOpen: () -> Void = {}
    var onActivity: () -> Void = {}

    private(set) var outcome: StreamOutcome?
    private var waiters: [CheckedContinuation<StreamOutcome, Never>] = []
    private var opened = false
    private var sendingDone = false
    private var nextExpected = 0
    private var lastMessage = Date()
    private var tasks: [Task<Void, Never>] = []

    init(pcm: [Int16], ranges: [CaptionRange], socket: CaptionSocket, pace: Double, idleTimeout: Double, connectTimeout: Double, sleep: @escaping (Double) async throws -> Void) {
        self.pcm = pcm; self.ranges = ranges; self.socket = socket
        self.pace = max(StreamingConstants.paceRange.lowerBound, min(StreamingConstants.paceRange.upperBound, pace))
        self.idleTimeout = idleTimeout; self.connectTimeout = connectTimeout; self.sleep = sleep
        fromSample = ranges[0].startSample
        toSample = ranges[ranges.count - 1].endSample
        sessionStartSec = Double(fromSample) / Double(StreamingConstants.sampleRate)
    }

    /// Streams the ranges and resolves with how it ended; never throws.
    func run() async -> StreamOutcome {
        await withTaskCancellationHandler {
            start()
            return await wait()
        } onCancel: {
            Task { @MainActor in self.finish(.cancelled) }
        }
    }

    /// The stall watchdog or the app coming back found the socket dead: end as a drop (it resumes).
    func kick() { finish(.dropped) }

    private func start() {
        guard outcome == nil else { return }
        tasks.append(Task { [self] in await receiveLoop() })
        tasks.append(Task { [self] in await monitorLoop() })
    }

    private func wait() async -> StreamOutcome {
        if let outcome { return outcome }
        return await withCheckedContinuation { waiters.append($0) }
    }

    private func finish(_ end: StreamEnd) {
        guard outcome == nil else { return }
        let value = StreamOutcome(end: end, nextExpected: nextExpected)
        outcome = value
        tasks.forEach { $0.cancel() }
        socket.close()
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume(returning: value) }
    }

    private var allCommitted: Bool { sendingDone && nextExpected >= ranges.count }

    private func receiveLoop() async {
        while outcome == nil {
            do {
                let text = try await socket.receive()
                handle(text)
            } catch {
                if outcome == nil {
                    if allCommitted { finish(.done) } else if opened { finish(.dropped) } else { finish(.error(kind: "connect", message: "Could not connect")) }
                }
                return
            }
        }
    }

    private func monitorLoop() async {
        while outcome == nil {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if outcome != nil { return }
            let now = Date()
            if !opened {
                if now.timeIntervalSince(created) > connectTimeout { finish(.error(kind: "timeout", message: "No answer from the transcription service")) }
            } else if now.timeIntervalSince(lastMessage) > idleTimeout {
                finish(.error(kind: "timeout", message: "No answer from the transcription service"))
            }
        }
    }

    private func handle(_ text: String) {
        lastMessage = Date()
        onActivity()
        guard let data = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = msg["message_type"] as? String else { return }
        switch type {
        case "session_started":
            opened = true
            onOpen()
            tasks.append(Task { [self] in await pump() })
        case "committed_transcript_with_timestamps":
            guard nextExpected < ranges.count else { return }
            let range = ranges[nextExpected]
            nextExpected += 1
            let words = (msg["words"] as? [[String: Any]] ?? []).compactMap { w -> ElevenWord? in
                guard let t = w["text"] as? String, let s = (w["start"] as? NSNumber)?.doubleValue, let e = (w["end"] as? NSNumber)?.doubleValue else { return nil }
                return ElevenWord(text: t, start: s, end: e, type: w["type"] as? String)
            }
            onSegment(Segment(range: range, text: msg["text"] as? String ?? "", words: words, languageCode: msg["language_code"] as? String, sessionStartSec: sessionStartSec))
            if allCommitted { finish(.done) }
        case "insufficient_audio_activity":
            // A commit over silence: an empty segment, not a failure.
            guard nextExpected < ranges.count else { return }
            let range = ranges[nextExpected]
            nextExpected += 1
            onSegment(Segment(range: range, text: "", words: [], languageCode: nil, sessionStartSec: sessionStartSec))
            if allCommitted { finish(.done) }
        case "partial_transcript", "committed_transcript", "warning":
            return
        default:
            if StreamingSessionError.looksLikeError(type) {
                finish(.error(kind: type, message: msg["error"] as? String ?? type))
            }
        }
    }

    /// One `input_audio_chunk` per 0.5 s (cut at every planned commit), paced at `pace`× real time.
    private func pump() async {
        let commits = Set(ranges.map(\.endSample))
        var pos = fromSample
        while pos < toSample {
            if outcome != nil { return }
            var next = min(pos + StreamingConstants.chunkSamples, toSample)
            for point in commits where point > pos && point < next { next = min(next, point) }
            let chunk = Array(pcm[pos..<next])
            let b64 = chunk.withUnsafeBufferPointer { Data(buffer: $0).base64EncodedString() }
            let payload: [String: Any] = ["message_type": "input_audio_chunk", "audio_base_64": b64, "commit": commits.contains(next), "sample_rate": StreamingConstants.sampleRate]
            guard let json = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: json, encoding: .utf8) else { finish(.dropped); return }
            do { try await socket.send(text) } catch {
                if outcome == nil { finish(.dropped) }
                return
            }
            if outcome != nil { return }
            pos = next
            onSent(pos)
            do { try await sleep(Double(chunk.count) / Double(StreamingConstants.sampleRate) / pace) } catch { return }
        }
        sendingDone = true
        if nextExpected >= ranges.count { finish(.done) } else { lastMessage = Date() }
    }
}

// MARK: - The whole flow

@MainActor
final class StreamingCaptionsEngine {
    private let deps: StreamingDeps
    private var ranges: [CaptionRange] = []
    private var totalSec = 0.0
    private var sentSecAbs = 0.0
    private var sessionOpen = false
    private var percentFloor = StreamingConstants.prepPercent
    private var sessionId: String?
    private var language: String?
    private var lastTexts: [String] = []
    private var translateChain: Task<Void, Never> = Task {}
    private var translateTasks: [Task<Void, Never>] = []
    private var active: CaptionStreamSession?
    private var lastProgress = Date()
    private var paused = false
    private var cancelled = false

    init(deps: StreamingDeps) { self.deps = deps }

    private func touch() { lastProgress = Date() }

    /// Transcribe (streamed to ElevenLabs), translate and return the final lines. Cancelling the
    /// calling task closes the socket and stops the translate calls. Throws `StreamingError`
    /// (finished lines are counted in `keptLineCount`) or `CancellationError`.
    func run(pcm: [Int16], targetLanguage: String, sourceLanguage: String?) async throws -> StreamingResult {
        let watchdog = Task { [self] in await watch() }
        defer { watchdog.cancel() }
        return try await withTaskCancellationHandler {
            try await core(pcm: pcm, targetLanguage: targetLanguage, sourceLanguage: sourceLanguage ?? "auto")
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    private func cancel() {
        cancelled = true
        active?.kick()
        translateTasks.forEach { $0.cancel() }
    }

    /// A 20 s stall (no audio sent, no socket message, no translate answer) is a drop: resume.
    private func watch() async {
        let interval = max(0.01, min(1.0, deps.stallSeconds / 4))
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            if paused || cancelled { continue }
            if Date().timeIntervalSince(lastProgress) > deps.stallSeconds {
                lastProgress = Date()
                active?.kick()
            }
        }
    }

    // MARK: percent

    private func doneSec() -> Double { ranges.filter { $0.status == .done }.reduce(0) { $0 + ($1.end - $1.start) } }
    private func allLines() -> [StreamingLine] { ranges.filter { $0.status == .done }.flatMap(\.lines) }
    private func coveredEnd() -> Double {
        var end = 0.0
        for r in ranges { if r.status != .done { break }; end = r.end }
        return end
    }
    private func stageNow() -> StreamingStage {
        if !sessionOpen { return .connecting }
        return sentSecAbs >= totalSec - 0.05 && ranges.contains { $0.status == .transcribed } ? .translating : .listening
    }
    private func computePercent() -> Int { StreamingPercent.value(sentSec: sentSecAbs, doneSec: doneSec(), totalSec: totalSec) }

    private func report() {
        touch()
        let stage = stageNow()
        percentFloor = max(percentFloor, computePercent())
        deps.onProgress(StreamingProgress(percent: percentFloor, stage: stage, text: StreamingPercent.text(stage: stage, percent: percentFloor), coveredEnd: coveredEnd(), lineCount: allLines().count))
    }

    // MARK: translate

    private func shouldRetry(_ error: StreamingError) -> Bool {
        if error.code == "paywall" { return false }
        return error.code == "network" || error.retryable || [429, 500, 502, 503, 504].contains(error.status ?? 0)
    }

    private func translateBatch(_ lines: [StreamingLine], targetLanguage: String, sourceLanguage: String) async throws -> [StreamingTranslated] {
        let request = TranslateRequest(
            targetLanguage: targetLanguage, sourceLanguage: sourceLanguage,
            segments: lines.enumerated().map { StreamingSegment(i: $0.offset, start: $0.element.start, end: $0.element.end, text: $0.element.text) },
            context: Array(lastTexts.suffix(StreamingConstants.contextLines)), sessionId: sessionId)
        var lastError = StreamingError(code: "translation_failed")
        for attempt in 1...2 {
            if cancelled { throw CancellationError() }
            do {
                let response = try await deps.translate(request)
                if language == nil, let l = response.language, !l.isEmpty { language = l }
                return response.lines
            } catch let error as StreamingError {
                if cancelled { throw CancellationError() }
                lastError = error
                if !shouldRetry(error) { throw error }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if cancelled { throw CancellationError() }
                lastError = StreamingError(code: "network")
            }
            if attempt < 2 { try await deps.sleep(0.5) }
        }
        throw lastError
    }

    /// Translate finished ranges one at a time, in order, while later audio is still streaming.
    private func enqueueTranslation(_ range: CaptionRange, _ lines: [StreamingLine], targetLanguage: String, sourceLanguage: String) {
        let previous = translateChain
        let task = Task { [self] in
            await previous.value
            if cancelled { return }
            do {
                var out: [StreamingLine] = []
                var at = 0
                while at < lines.count {
                    let batch = Array(lines[at..<min(lines.count, at + StreamingConstants.translateBatch)])
                    touch()
                    let translated = try await translateBatch(batch, targetLanguage: targetLanguage, sourceLanguage: sourceLanguage)
                    touch()
                    let byIndex = Dictionary(translated.map { ($0.i, $0) }, uniquingKeysWith: { a, _ in a })
                    var batchTexts: [String] = []
                    for (k, l) in batch.enumerated() {
                        let t = byIndex[k]
                        let text = (t?.text).flatMap { $0.isEmpty ? nil : $0 } ?? l.text
                        out.append(StreamingLine(start: l.start, end: l.end, text: text, translation: t?.translation ?? ""))
                        batchTexts.append(text)
                    }
                    // The next batch (even of the same range) sees these as context.
                    lastTexts.append(contentsOf: batchTexts)
                    at += StreamingConstants.translateBatch
                }
                range.lines = out
                range.raw = nil
                range.status = .done
            } catch {
                if cancelled || error is CancellationError { return }
                range.status = .failed
                range.error = (error as? StreamingError) ?? StreamingError(code: "network")
                range.raw = lines
            }
            report()
        }
        translateChain = task
        translateTasks.append(task)
    }

    private func onSegment(_ seg: CaptionStreamSession.Segment, targetLanguage: String, sourceLanguage: String) {
        let range = seg.range
        if detected == nil, let code = seg.languageCode, !code.isEmpty { detected = code }
        let mapped = StreamingLines.offsetWords(seg.words, sessionStartSec: seg.sessionStartSec, rangeStartInSession: range.start - seg.sessionStartSec, rangeStartAbs: range.start)
        let clean = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var built: [(start: Double, end: Double, text: String)] = []
        if let first = mapped.first, let last = mapped.last {
            built = StreamingLines.build(text: clean.isEmpty ? mapped.map(\.w).joined(separator: " ") : clean, start: first.start, end: last.end, words: mapped)
        } else if !clean.isEmpty {
            built = StreamingLines.build(text: clean, start: range.start, end: range.end, words: [])
        }
        let lines = built.filter { !$0.text.isEmpty }.map {
            StreamingLine(start: max(0, $0.start), end: min(totalSec, max($0.end, $0.start + 0.05)), text: $0.text, translation: "")
        }
        if lines.isEmpty { range.status = .done; range.lines = []; report(); return }
        range.status = .transcribed
        report()
        enqueueTranslation(range, lines, targetLanguage: targetLanguage, sourceLanguage: sourceLanguage)
    }

    private var detected: String?

    // MARK: core

    private func core(pcm: [Int16], targetLanguage: String, sourceLanguage: String) async throws -> StreamingResult {
        guard !pcm.isEmpty else { throw StreamingError(code: "no_audio") }
        totalSec = Double(pcm.count) / Double(StreamingConstants.sampleRate)
        if totalSec > StreamingConstants.maxAudioSeconds { throw StreamingError(code: "audio_too_long", status: 413) }
        let points = CommitPlanner.points(pcm)
        ranges = points.enumerated().map { CaptionRange(index: $0.offset, startSample: $0.offset == 0 ? 0 : points[$0.offset - 1], endSample: $0.element) }
        report()

        var sessions = 0
        var resumesUsed = 0
        loop: while true {
            if cancelled || Task.isCancelled { throw CancellationError() }
            let todo = ranges.filter { $0.status != .done }
            if todo.isEmpty { break }

            // A range that was transcribed but not translated only needs its translation again.
            let retryTranslate = todo.filter { $0.raw != nil && $0.attempts < deps.rangeAttempts }
            if !retryTranslate.isEmpty {
                for r in retryTranslate {
                    r.attempts += 1; r.status = .transcribed
                    enqueueTranslation(r, r.raw ?? [], targetLanguage: targetLanguage, sourceLanguage: sourceLanguage)
                }
                await translateChain.value
                continue
            }
            let streamable = todo.filter { $0.raw == nil }
            if streamable.isEmpty { break }
            var run: [CaptionRange] = []
            for r in streamable {
                if let last = run.last, r.index != last.index + 1 { break }
                run.append(r)
            }
            if run.contains(where: { $0.attempts >= deps.rangeAttempts }) { break }
            sessions += 1
            if sessions > deps.maxSessions { break }
            for r in run { r.attempts += 1; r.status = .pending; r.error = nil }

            let connection = try await mintToken(sourceLanguage: sourceLanguage)
            sessionId = connection.sessionId ?? sessionId
            guard let url = connection.socketURL else { throw StreamingError(code: "streaming_failed") }
            for r in run { r.status = .running }
            sessionOpen = false
            report()

            let session = CaptionStreamSession(pcm: pcm, ranges: run, socket: deps.makeSocket(url), pace: deps.pace,
                                               idleTimeout: deps.idleTimeoutSeconds, connectTimeout: deps.connectTimeoutSeconds, sleep: deps.sleep)
            session.onOpen = { [self] in sessionOpen = true; report() }
            session.onActivity = { [self] in touch() }
            session.onSent = { [self] pos in
                touch()
                sentSecAbs = max(sentSecAbs, Double(pos) / Double(StreamingConstants.sampleRate))
                if computePercent() > percentFloor { report() }
            }
            session.onSegment = { [self] seg in onSegment(seg, targetLanguage: targetLanguage, sourceLanguage: sourceLanguage) }
            active = session
            let result = await session.run()
            active = nil
            // Whatever the socket delivered is translated before deciding what happens next.
            await translateChain.value
            if cancelled || Task.isCancelled || result.end == .cancelled { throw CancellationError() }
            var failureKind: String?
            if case let .error(kind, _) = result.end { failureKind = kind }
            for r in run where r.status == .running || r.status == .pending {
                r.status = .failed
                r.error = failureKind.map { StreamingError(code: $0) }
            }

            let cause: String?
            switch result.end {
            case .dropped: cause = "dropped"
            case .error(let kind, _):
                cause = StreamingSessionError.kinds[kind] ?? ((kind == "timeout" || kind == "connect") ? "dropped" : "failed")
            default: cause = nil
            }
            let failed = ranges.filter { $0.status == .failed && $0.raw == nil }
            func unfinished() { for r in failed { r.status = .pending; r.attempts = max(0, r.attempts - 1) } } // a resume is not a per-range retry

            if (cause == "dropped" || cause == "time_limit"), !failed.isEmpty {
                if resumesUsed < deps.autoResumes {
                    // The budget belongs to the session (the whole job), not to a range: a few quiet reconnects first.
                    try await deps.sleep(deps.resumeBackoff[min(resumesUsed, deps.resumeBackoff.count - 1)])
                    resumesUsed += 1
                    if cancelled || Task.isCancelled { throw CancellationError() }
                    unfinished()
                    continue loop
                }
                if ranges.contains(where: { $0.status == .done || $0.status == .transcribed }) {
                    let atSec = coveredEnd()
                    paused = true
                    let resume = await deps.confirmContinue(atSec, cause ?? "dropped")
                    paused = false
                    touch()
                    if cancelled || Task.isCancelled { throw CancellationError() }
                    if !resume {
                        throw StreamingError(code: "declined_continue", message: cause == "time_limit" ? StreamingCopy.timeLimit(at: atSec) : StreamingCopy.connectionDropped(at: atSec), keptLineCount: allLines().count, atSec: atSec)
                    }
                    resumesUsed = 0 // Continue grants a fresh budget
                    unfinished()
                    continue loop
                }
            }
            if cause == "auth", !failed.isEmpty {
                // A token that expired or was already used: one silent retry with a fresh one.
                for r in failed { r.status = .pending; r.attempts = max(0, r.attempts - 1) }
                if sessions >= deps.maxSessions { break }
                continue loop
            }
            if cause == "unavailable" { throw StreamingError(code: "unavailable", keptLineCount: allLines().count) }
            if cause == "busy", !failed.isEmpty {
                if failed.allSatisfy({ $0.attempts < deps.rangeAttempts }) {
                    try await deps.sleep(2)
                    for r in failed { r.status = .pending }
                    continue loop
                }
                throw StreamingError(code: "busy", keptLineCount: allLines().count)
            }
            // Any other failure: each range retries once in a new session (per-range retry).
            for r in failed where r.attempts < deps.rangeAttempts { r.status = .pending }
        }

        await translateChain.value
        if cancelled || Task.isCancelled { throw CancellationError() }
        let unfinished = ranges.filter { $0.status != .done }
        if !unfinished.isEmpty {
            let coded = unfinished.first { ($0.error?.code).map { $0 != "network" } ?? false }?.error
            if let paywall = unfinished.compactMap(\.error).first(where: { $0.code == "paywall" }) { throw paywall }
            throw StreamingError(code: coded?.code ?? "ranges_failed", status: coded?.status, keptLineCount: allLines().count)
        }
        let lines = allLines().sorted { $0.start < $1.start }
        if lines.isEmpty { throw StreamingError(code: "no_speech") }
        report()
        return StreamingResult(lines: lines, language: language ?? detected, targetLanguage: targetLanguage, audioSeconds: totalSec,
                               sessionId: sessionId, translatedCount: lines.filter { !$0.translation.isEmpty }.count)
    }

    /// Mint a single-use token just before connecting; a resumed session passes the same session id.
    private func mintToken(sourceLanguage: String) async throws -> StreamingToken {
        for tries in 1... {
            touch()
            do {
                let token = try await deps.mint(sourceLanguage == "auto" ? nil : sourceLanguage, sessionId)
                touch()
                return token
            } catch let error as StreamingError {
                if cancelled || Task.isCancelled { throw CancellationError() }
                let transient = error.code == "network" || error.code == "streaming_captions_busy" || error.status == 502
                if tries >= 2 || !transient {
                    var e = error; e.keptLineCount = allLines().count
                    throw e
                }
            } catch is CancellationError {
                throw CancellationError()
            }
            try await deps.sleep(0.8)
        }
        throw StreamingError(code: "streaming_failed")
    }
}
