import AVFoundation
import XCTest
@testable import FinalCut

/// Scripted network for the lyric captions flow; records every request (with its body).
final class LyricStubProtocol: URLProtocol {
    struct Recorded { var method: String; var path: String; var headers: [String: String]; var body: Data }
    static let lock = NSLock()
    static var recorded: [Recorded] = []
    /// path → (status, body). Missing paths answer 500.
    static var routes: [String: (Int, String)] = [:]

    static func reset(routes: [String: (Int, String)] = [:]) {
        lock.lock(); defer { lock.unlock() }
        recorded = []
        self.routes = routes
    }

    static var paths: [String] {
        lock.lock(); defer { lock.unlock() }
        return recorded.map(\.path)
    }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LyricStubProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let path = request.url?.path ?? ""
        Self.lock.lock()
        Self.recorded.append(Recorded(method: request.httpMethod ?? "GET", path: path,
                                      headers: request.allHTTPHeaderFields ?? [:], body: body))
        let route = Self.routes[path]
        Self.lock.unlock()
        let (status, text) = route ?? (500, #"{"error":"stub"}"#)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private struct StubCaptioner: CaptionTranscribing {
    func transcribe(_ composed: ComposedVideo, language: String?) async throws -> CaptionTranscript {
        CaptionTranscript(words: [TimedWord(text: "Hello", start: 0.2, duration: 0.4)], language: language ?? "en-US")
    }
}

final class LyricCaptionsTests: XCTestCase {
    private let base = URL(string: "https://stub.finalcap.test")!

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: NativeSettings.cloudProcessingKey)
        super.tearDown()
    }

    // MARK: - Pure logic

    func testProgressTextMapping() {
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: nil, mode: .auto, uploadFinished: false), "Uploading audio…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.9, mode: .lyrics, uploadFinished: false), "Uploading audio…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0, mode: .auto, uploadFinished: true), "Listening to the song…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.2, mode: .lyrics, uploadFinished: true), "Listening to the song…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.49, mode: .speech, uploadFinished: true), "Listening to the song…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.5, mode: .lyrics, uploadFinished: true), "Finding lyrics and translating…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.9, mode: .auto, uploadFinished: true), "Finding lyrics and translating…")
        XCTAssertEqual(LyricCaptionsCopy.progressText(progress: 0.5, mode: .speech, uploadFinished: true), "Checking the words and translating…")
        XCTAssertEqual(LyricCaptionsCopy.addingCaptions, "Adding captions…")
    }

    func testFontSizeScalesWithVideoHeight() {
        XCTAssertEqual(LyricCaptionStyle.fontSize(canvasHeight: 1280), 48, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.fontSize(canvasHeight: 1920), 72, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.fontSize(canvasHeight: 1080), 40.5, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.fontSize(canvasHeight: 720), 27, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.fontSize(canvasHeight: 1920, override: 60), 60, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.outlineWidth(canvasHeight: 1280), 3, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.outlineWidth(canvasHeight: 1920), 4.5, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.shadowOffset(canvasHeight: 2560), 2, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.horizontalMargin(canvasWidth: 720), 48, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.horizontalMargin(canvasWidth: 1080), 72, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.bottomOffset(canvasHeight: 1280, pct: 20), 256, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.bottomOffset(canvasHeight: 1920, pct: 20), 384, accuracy: 0.001)
        XCTAssertEqual(LyricCaptionStyle.bottomOffset(canvasHeight: 1000, pct: 80), 450, accuracy: 0.001)
    }

    func testAppliedCardLabels() {
        let song = LyricSong(title: "Song", artist: "Artist", url: nil, confidence: "high")
        XCTAssertEqual(LyricCaptionsCopy.appliedLabel(song: song, language: "de", targetLanguage: "zh-Hans"), "Lyrics · German + Chinese")
        XCTAssertEqual(LyricCaptionsCopy.appliedLabel(song: nil, language: "en", targetLanguage: "zh-Hans"), "Captions · English → Chinese")
        XCTAssertEqual(LyricCaptionsCopy.appliedLabel(song: nil, language: nil, targetLanguage: "zh-Hans"), "Captions · Speech + Chinese")
        XCTAssertEqual(LyricCaptionsCopy.appliedLabel(song: nil, language: "auto", targetLanguage: "es"), "Captions · Speech + Spanish")
        XCTAssertEqual(LyricCaptionsCopy.appliedLabel(song: nil, language: "ko", targetLanguage: "Japanese"), "Captions · Korean → Japanese")
        XCTAssertEqual(LyricCaptionsCopy.languageName("zh-Hant"), "Chinese")
        XCTAssertNil(LyricCaptionsCopy.languageName(" "))
    }

    func testPromptWording() {
        let off = LyricCaptionsCopy.cloudOffPrompt(mode: .lyrics, targetLanguage: "zh-Hans")
        XCTAssertEqual(off.title, "Lyric captions use the cloud")
        XCTAssertEqual(off.message, "To caption a song, FinalCap uploads this video's audio to transcribe and translate it. Turn on Cloud processing to use lyric captions.")
        XCTAssertEqual([off.primary, off.secondary], ["Open Settings", "Not now"])
        XCTAssertEqual(LyricCaptionsCopy.cloudOffPrompt(mode: .auto, targetLanguage: "es"), LyricCaptionsCopy.cloudOffPrompt(mode: .lyrics, targetLanguage: "es"))

        let speechOff = LyricCaptionsCopy.cloudOffPrompt(mode: .speech, targetLanguage: "zh-Hans")
        XCTAssertEqual(speechOff.title, "Translated captions use the cloud")
        XCTAssertEqual(speechOff.message, "FinalCap will upload this video's audio, but not the picture, to transcribe it and translate it into Chinese. The audio is deleted after transcription. Turn on Cloud processing to use translated captions.")
        XCTAssertEqual([speechOff.primary, speechOff.secondary], ["Open Settings", "Not now"])

        let lyrics = LyricCaptionsCopy.uploadPrompt(mode: .lyrics, targetLanguage: "zh-Hans")
        XCTAssertEqual(lyrics.title, "Upload the audio?")
        XCTAssertEqual(lyrics.message, "FinalCap will upload this video's audio, but not the picture, to transcribe it, look up the song's lyrics, and translate them. The audio is deleted after transcription.")
        XCTAssertEqual([lyrics.primary, lyrics.secondary], ["Upload audio", "Not now"])
        XCTAssertEqual(LyricCaptionsCopy.uploadPrompt(mode: .auto, targetLanguage: "es").message, lyrics.message)

        let speech = LyricCaptionsCopy.uploadPrompt(mode: .speech, targetLanguage: "zh-Hans")
        XCTAssertEqual(speech.title, "Upload the audio?")
        XCTAssertEqual(speech.message, "FinalCap will upload this video's audio, but not the picture, to transcribe it and translate it into Chinese. The audio is deleted after transcription.")

        let server = LyricCaptionsCopy.serverCaptionsPrompt
        XCTAssertEqual(server.message, "Captions need to upload this video's audio to transcribe it. Upload and continue?")
        XCTAssertEqual([server.primary, server.secondary], ["Upload", "Not now"])
    }

    func testFailureCopyByCode() {
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: "lyric_captions_unavailable"), LyricCaptionsCopy.unavailable)
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: nil, status: 503), LyricCaptionsCopy.unavailable)
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: "no_speech"), LyricCaptionsCopy.noSpeech)
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: "lyric_captions_model_error"), LyricCaptionsCopy.modelError)
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: "audio_too_long"), LyricCaptionsCopy.tooLong)
        XCTAssertEqual(LyricCaptionsCopy.failureCopy(code: "boom"), LyricCaptionsCopy.generic)
    }

    func testToolPlanValidation() {
        let video = NativeCanvas(width: 720, height: 1280, duration: 12, isPhoto: false, hasAudio: true)
        let photo = NativeCanvas(width: 4032, height: 3024, duration: 0, isPhoto: true, hasAudio: false)
        let silent = NativeCanvas(width: 720, height: 1280, duration: 12, isPhoto: false, hasAudio: false)
        let plan = NativeToolParser.plan(tool: "lyric_captions", arguments: ["target_language": .string("zh-Hans")], canvas: video)
        XCTAssertEqual(plan, .success(.lyricCaptions(LyricCaptionRequest(
            targetLanguage: "zh-Hans", sourceLanguage: nil, mode: .auto, positionFromBottomPct: nil, fontSize: nil))))
        let full = NativeToolParser.plan(tool: "lyric_captions", arguments: [
            "target_language": .string("es"), "source_language": .string("de"), "mode": .string("speech"),
            "position_from_bottom_pct": .number(30), "font_size": .number(60),
        ], canvas: video)
        XCTAssertEqual(full, .success(.lyricCaptions(LyricCaptionRequest(
            targetLanguage: "es", sourceLanguage: "de", mode: .speech, positionFromBottomPct: 30, fontSize: 60))))
        XCTAssertEqual(NativeToolParser.plan(tool: "lyric_captions", arguments: ["target_language": .string("es"), "source_language": .string("auto")],
                                             canvas: video),
                       .success(.lyricCaptions(LyricCaptionRequest(targetLanguage: "es", sourceLanguage: nil, mode: .auto,
                                                                   positionFromBottomPct: nil, fontSize: nil))))
        XCTAssertEqual(NativeToolParser.plan(tool: "lyric_captions", arguments: ["target_language": .string("es")], canvas: photo),
                       .failure(.unsupportedForPhoto))
        XCTAssertEqual(NativeToolParser.plan(tool: "lyric_captions", arguments: ["target_language": .string("es")], canvas: silent),
                       .failure(.invalidArguments("no audio track")))
        for bad: [String: JSONValue] in [
            [:], ["target_language": .string(" ")], ["target_language": .string("es"), "mode": .string("karaoke")],
            ["target_language": .string("es"), "position_from_bottom_pct": .number(60)],
            ["target_language": .string("es"), "font_size": .number(2)],
        ] {
            guard case .failure(.invalidArguments) = NativeToolParser.plan(tool: "lyric_captions", arguments: bad, canvas: video) else {
                return XCTFail("expected invalid: \(bad)")
            }
        }
    }

    func testRequestFields() {
        let request = LyricCaptionRequest(targetLanguage: "zh-Hans", sourceLanguage: "de", mode: .lyrics, positionFromBottomPct: 25, fontSize: 54)
        let fields = APIClient.lyricCaptionsFields(request, width: 720, height: 1280)
        XCTAssertEqual(fields.map(\.name), ["target_language", "source_language", "mode", "position_from_bottom_pct", "font_size", "width", "height"])
        XCTAssertEqual(fields.map(\.value), ["zh-Hans", "de", "lyrics", "25.0", "54", "720", "1280"])
        let minimal = APIClient.lyricCaptionsFields(LyricCaptionRequest(targetLanguage: "es", sourceLanguage: nil, mode: .auto,
                                                                        positionFromBottomPct: nil, fontSize: nil), width: nil, height: nil)
        XCTAssertEqual(minimal.map(\.name), ["target_language", "mode"])
    }

    func testResultDecodingAndDisplayText() throws {
        let json = #"""
        {"song":null,"mode":"speech","language":"en","targetLanguage":"zh-Hans","webSearch":false,
         "lines":[{"start":1.2,"end":3.0,"text":"Hello there","translation":"你好","words":[{"w":"Hello","start":1.2,"end":1.5}]},
                  {"start":3.1,"end":4,"text":"Same","translation":"same"},
                  {"start":4.1,"end":5,"text":"Only original","translation":""}]}
        """#
        let result = try JSONDecoder().decode(LyricCaptionResult.self, from: Data(json.utf8))
        XCTAssertNil(result.song)
        XCTAssertEqual(result.lines.count, 3)
        XCTAssertEqual(result.lines.map(\.displayText), ["Hello there\n你好", "Same", "Only original"])
    }

    func testLyricCaptionsFollowLaterTrimAndSpeedAndReplaceEarlierCaptions() throws {
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        var stack = EditStack(base: clip, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "generate_captions", op: .captions([CaptionCue(start: 0, end: 1, text: "plain")])))
        XCTAssertEqual(stack.captionCues.count, 1)
        XCTAssertNil(stack.lyricTrack)
        stack.push(EditEntry(tool: "lyric_captions", op: .lyricCaptions(LyricCaptionTrack(lines: [
            LyricLine(start: 0.5, end: 1.5, text: "one", translation: "一"),
            LyricLine(start: 3, end: 4, text: "two", translation: "二"),
        ]))))
        XCTAssertTrue(stack.captionCues.isEmpty, "latest captions win")
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 2, end: 6)))
        stack.push(EditEntry(tool: "adjust_speed", op: .speed(2)))
        XCTAssertEqual(stack.lyricTrack?.lines, [LyricLine(start: 0.5, end: 1, text: "two", translation: "二")])
        XCTAssertTrue(stack.undo())
        XCTAssertTrue(stack.undo())
        XCTAssertTrue(stack.undo())
        XCTAssertEqual(stack.captionCues.count, 1, "undo brings the earlier captions back")
        XCTAssertTrue(stack.redo())
        XCTAssertNotNil(stack.lyricTrack)
    }

    // MARK: - Rendering

    @MainActor
    func testBundledFontIsRegistered() {
        XCTAssertEqual(LyricCaptionFont.resolvedName, LyricCaptionStyle.primaryFontName)
    }

    func testBurnedInLyricCaptionsSitAboveTheBottomFifthWhileActive() async throws {
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        var stack = EditStack(base: clip, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "lyric_captions", op: .lyricCaptions(LyricCaptionTrack(lines: [
            LyricLine(start: 0, end: 3, text: "HELLO FINALCAP", translation: "你好，终极剪辑"),
        ]))))
        let composed = try await NativeComposer.compose(stack)
        let generator = composed.makeImageGenerator()
        let during = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
        let after = try await generator.image(at: CMTime(seconds: 4.5, preferredTimescale: 600)).image
        // 720 px tall: the bottom 20% is rows 576..<720; the block grows upward from there.
        XCTAssertTrue(hasWhite(during, rows: 440..<576), "caption text just above the 20% line")
        XCTAssertFalse(hasWhite(during, rows: 600..<720), "nothing in the bottom 20%")
        XCTAssertFalse(hasWhite(during, rows: 0..<300), "nothing in the top half")
        XCTAssertFalse(hasWhite(after, rows: 440..<576), "no caption after the line ends")
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

    // MARK: - Cloud processing off: nothing reaches the network

    @MainActor
    private func makeModel(cloud: Bool, routes: [String: (Int, String)] = [:]) throws -> EditorViewModel {
        UserDefaults.standard.set(cloud, forKey: NativeSettings.cloudProcessingKey)
        LyricStubProtocol.reset(routes: routes)
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        let client = APIClient(config: APIConfig(baseURL: base), session: LyricStubProtocol.session())
        client.sampleModeEnabled = false
        client.accessToken = "tok"
        client.accessTokenExpiresAt = Date().addingTimeInterval(3600)
        model.apiClient = client
        model.captioner = StubCaptioner()
        model.state = .processing
        return model
    }

    private func lyricCall(_ extra: [String: JSONValue] = [:]) -> ClientToolCall {
        var args: [String: JSONValue] = ["target_language": .string("zh-Hans")]
        for (k, v) in extra { args[k] = v }
        return ClientToolCall(id: "ly1", name: "lyric_captions", arguments: args)
    }

    @MainActor
    func testCloudOffLyricCaptionsSendsNothingAndOffersSettings() async throws {
        let model = try makeModel(cloud: false)
        var prompts: [CloudPrompt] = []
        var openedSettings = 0
        model.promptHandler = { prompts.append($0); return true }   // user taps "Open Settings"
        model.onOpenSettings = { openedSettings += 1 }
        let result = await model.executeToolCall(lyricCall())
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "skipped_by_user")
        XCTAssertEqual(prompts.map(\.title), ["Lyric captions use the cloud"])
        XCTAssertEqual(prompts.first?.primary, "Open Settings")
        XCTAssertEqual(openedSettings, 1)
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0, "zero requests with Cloud processing off")
        XCTAssertEqual(model.editStack?.entries.count, 0)

        // Not now: same, but Settings stays closed.
        model.promptHandler = { prompts.append($0); return false }
        let again = await model.executeToolCall(lyricCall(["mode": .string("speech")]))
        XCTAssertEqual(again.error, "skipped_by_user")
        XCTAssertEqual(prompts.last?.title, "Translated captions use the cloud")
        XCTAssertEqual(openedSettings, 1)
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0)
    }

    @MainActor
    func testCloudOffModelTurnSendsOnlyChatRequests() async throws {
        let model = try makeModel(cloud: false)
        RecordingURLProtocol.reset(chatReplies: [
            #"{"schemaVersion":"1","status":"tool_calls","toolCalls":[{"id":"call_1","name":"lyric_captions","arguments":{"target_language":"zh-Hans","mode":"speech"}}],"messages":[{"role":"user","content":"add Chinese captions"}],"round":1,"maxRounds":6}"#,
            #"{"schemaVersion":"1","status":"final","message":"Turn on Cloud processing to translate captions."}"#,
        ])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingURLProtocol.self]
        model.apiClient = APIClient(config: APIConfig(baseURL: base), session: URLSession(configuration: config))
        var prompts: [CloudPrompt] = []
        model.promptHandler = { prompts.append($0); return false }
        await model.runChatTurn(prompt: "add Chinese captions")
        let paths = RecordingURLProtocol.recorded.compactMap { $0.url?.path }
        XCTAssertEqual(paths.filter { $0 == "/api/chat" }.count, 2, "\(paths)")
        for path in paths {
            XCTAssertTrue(path == "/api/chat" || path.hasPrefix("/api/auth/"), "unexpected request \(path)")
        }
        XCTAssertEqual(prompts.map(\.title), ["Translated captions use the cloud"])
        XCTAssertEqual(model.editStack?.entries.count, 0)
    }

    @MainActor
    func testCloudOffCaptionsStayOnDevice() async throws {
        let model = try makeModel(cloud: false)
        var asked = 0
        model.promptHandler = { _ in asked += 1; return true }
        let result = await model.executeToolCall(ClientToolCall(id: "c1", name: "generate_captions", arguments: [:]))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.executedOn, .device)
        XCTAssertEqual(asked, 0, "on-device captions never ask to upload")
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0)
        // The server caption path refuses to run with Cloud processing off, even if called.
        await model.runGenerateCaptions()
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0)
    }

    // MARK: - Cloud processing on

    @MainActor
    func testCloudOnPromptsEveryTimeAndNotNowSendsNothing() async throws {
        let model = try makeModel(cloud: true)
        var prompts: [CloudPrompt] = []
        model.promptHandler = { prompts.append($0); return false }
        for _ in 0..<2 {
            let result = await model.executeToolCall(lyricCall())
            XCTAssertEqual(result.error, "skipped_by_user")
        }
        XCTAssertEqual(prompts.count, 2, "asked every time")
        XCTAssertEqual(prompts.first?.title, "Upload the audio?")
        XCTAssertEqual(prompts.first?.primary, "Upload audio")
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0)
        XCTAssertEqual(model.editStack?.entries.count, 0)
    }

    @MainActor
    func testServerCaptionsAskToUploadWhenCloudIsOn() async throws {
        let model = try makeModel(cloud: true)
        var prompts: [CloudPrompt] = []
        model.promptHandler = { prompts.append($0); return false }
        await model.runGenerateCaptions()
        XCTAssertEqual(prompts.map(\.message), ["Captions need to upload this video's audio to transcribe it. Upload and continue?"])
        XCTAssertEqual(LyricStubProtocol.recorded.count, 0, "Not now sends nothing")

        model.promptHandler = { prompts.append($0); return true }
        await model.runGenerateCaptions()
        XCTAssertTrue(LyricStubProtocol.paths.contains("/api/generate-captions"), "Upload proceeds to the server")
    }

    private let resultURL = "https://stub.finalcap.test/api/jobs/j1/result"

    private func successRoutes(resultJSON: String) -> [String: (Int, String)] {
        [
            "/api/lyric-captions": (202, #"{"jobId":"j1","status":"queued","operation":"lyric_captions","durationSec":4,"pollUrl":"/api/jobs/j1","resultUrl":"\#(resultURL)"}"#),
            "/api/jobs/j1": (200, #"{"jobId":"j1","status":"succeeded","progress":1,"operation":"lyric_captions","resultUrl":"\#(resultURL)"}"#),
            "/api/jobs/j1/result": (200, resultJSON),
        ]
    }

    @MainActor
    func testCloudOnUploadsAudioOnlyAndAppliesCaptions() async throws {
        let json = #"""
        {"song":{"title":"Lied","artist":"Band","url":"https://example.com","confidence":"high"},"mode":"lyrics","language":"de","targetLanguage":"zh-Hans",
         "lines":[{"start":0.5,"end":2.0,"text":"Hallo Welt","translation":"你好世界"},{"start":2.5,"end":4,"text":"Zweite Zeile","translation":"第二行"}]}
        """#
        let model = try makeModel(cloud: true, routes: successRoutes(resultJSON: json))
        var prompts: [CloudPrompt] = []
        model.promptHandler = { prompts.append($0); return true }
        let result = await model.executeToolCall(lyricCall(["mode": .string("lyrics")]))
        XCTAssertTrue(result.ok, "\(String(describing: result.error)) \(LyricStubProtocol.paths)")
        XCTAssertEqual(result.executedOn, .server)
        XCTAssertEqual(result.output?["lineCount"], .number(2))
        XCTAssertEqual(result.output?["language"], .string("de"))
        XCTAssertEqual(result.output?["targetLanguage"], .string("zh-Hans"))
        XCTAssertNotNil(result.output?["song"])
        XCTAssertFalse(result.content.jsonString().contains("Hallo Welt"), "lyric text never goes back to the model")
        XCTAssertEqual(prompts.first?.message, LyricCaptionsCopy.lyricsUploadBody)

        let upload = try XCTUnwrap(LyricStubProtocol.recorded.first { $0.path == "/api/lyric-captions" })
        XCTAssertEqual(upload.method, "POST")
        XCTAssertEqual(upload.headers["Authorization"], "Bearer tok")
        XCTAssertTrue((upload.headers["Content-Type"] ?? "").hasPrefix("multipart/form-data; boundary="))
        let body = String(decoding: upload.body, as: UTF8.self)
        XCTAssertTrue(body.contains("name=\"audio\"; filename=\"audio.m4a\""))
        XCTAssertTrue(body.contains("Content-Type: audio/mp4"))
        for (name, value) in [("target_language", "zh-Hans"), ("mode", "lyrics"), ("width", "1280"), ("height", "720")] {
            XCTAssertTrue(body.contains("name=\"\(name)\"\r\n\r\n\(value)\r\n"), "\(name)=\(value)")
        }
        XCTAssertFalse(body.contains("name=\"video\""), "never the picture")
        XCTAssertGreaterThan(upload.body.count, 4000, "real audio went up")
        XCTAssertNil(upload.headers["X-Turn-Token"], "no chat turn, no turn token")
        XCTAssertEqual(result.output?["width"], .number(1280))

        guard case .lyricCaptions(let track)? = model.editStack?.entries.last?.op else { return XCTFail("lyric captions entry") }
        XCTAssertEqual(track.lines.count, 2)
        XCTAssertEqual(model.messages.last?.content, "Lyrics · German + Chinese")
        XCTAssertEqual(model.editStack?.canUndo, true)
        XCTAssertNil(model.lyricStatus)
        model.undoLastEdit(registering: false)
        XCTAssertEqual(model.editStack?.entries.count, 0)
        model.redoLastEdit(registering: false)
        XCTAssertEqual(model.editStack?.entries.count, 1)
    }

    @MainActor
    func testSpeechResultShowsSourceArrowTarget() async throws {
        let json = #"{"song":null,"mode":"speech","language":"en","targetLanguage":"zh-Hans","lines":[{"start":0.5,"end":2.0,"text":"Hello","translation":"你好"}]}"#
        let model = try makeModel(cloud: true, routes: successRoutes(resultJSON: json))
        model.promptHandler = { _ in true }
        model.currentTurnToken = "tt_1"
        let result = await model.executeToolCall(lyricCall(["mode": .string("speech")]))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(model.messages.last?.content, "Captions · English → Chinese")
        let upload = try XCTUnwrap(LyricStubProtocol.recorded.first { $0.path == "/api/lyric-captions" })
        XCTAssertEqual(upload.headers["X-Turn-Token"], "tt_1")
        XCTAssertEqual(upload.headers["X-Tool-Call-Id"], "ly1")
        XCTAssertFalse(String(decoding: upload.body, as: UTF8.self).contains("name=\"source_language\""), "source language left to the server")
    }

    @MainActor
    func testServerErrorsShowFriendlyCardAndApplyNothing() async throws {
        // 503 on submit.
        var model = try makeModel(cloud: true, routes: [
            "/api/lyric-captions": (503, #"{"error":"missing OPENAI_API_KEY","code":"lyric_captions_unavailable","operation":"lyric_captions"}"#),
        ])
        model.promptHandler = { _ in true }
        var result = await model.executeToolCall(lyricCall())
        XCTAssertEqual(result.error, "lyric_captions_unavailable")
        XCTAssertEqual(model.messages.last?.content, LyricCaptionsCopy.unavailable)
        XCTAssertFalse(model.messages.last?.content.contains("OPENAI") ?? true)
        XCTAssertEqual(model.editStack?.entries.count, 0)

        // Failed jobs carry the code on the poll body.
        for (code, copy) in [("no_speech", LyricCaptionsCopy.noSpeech), ("lyric_captions_model_error", LyricCaptionsCopy.modelError), ("weird", LyricCaptionsCopy.generic)] {
            model = try makeModel(cloud: true, routes: [
                "/api/lyric-captions": (202, #"{"jobId":"j1","status":"queued","pollUrl":"/api/jobs/j1"}"#),
                "/api/jobs/j1": (200, #"{"jobId":"j1","status":"failed","error":"raw server text","code":"\#(code)"}"#),
            ])
            model.promptHandler = { _ in true }
            result = await model.executeToolCall(lyricCall())
            XCTAssertFalse(result.ok)
            XCTAssertEqual(model.messages.last?.content, copy, code)
            XCTAssertEqual(model.editStack?.entries.count, 0)
        }

        // 429 daily limit → paywall, not a failure card.
        model = try makeModel(cloud: true, routes: [
            "/api/lyric-captions": (429, #"{"error":"limit","code":"daily_limit_reached"}"#),
        ])
        model.promptHandler = { _ in true }
        var paywalls = 0
        model.onPaywallRequired = { paywalls += 1 }
        result = await model.executeToolCall(lyricCall())
        XCTAssertEqual(result.error, "paywall")
        XCTAssertEqual(paywalls, 1)
    }
}

/// Opt-in (iOS Screenshots workflow, job `lyric`): renders one frame of Chinese captions on a
/// vertical 1080x1920 video through the real compose path, for Design's 20% safe-area check.
final class LyricCaptionsShotTests: XCTestCase {
    func testCaptureChineseCaptionsOnVerticalVideo() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let outPath = env["FC_LYRIC_SHOT_OUT"] else {
            throw XCTSkip("opt-in: TEST_RUNNER_FC_LYRIC_SHOT_OUT=<dir>")
        }
        let out = URL(fileURLWithPath: outPath, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let clip = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        var stack = EditStack(base: clip, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
        // Centre 9:16 crop, scaled to a vertical 1080x1920 canvas.
        stack.push(EditEntry(tool: "crop_video", op: .crop(x: 437, y: 0, width: 406, height: 720)))
        stack.push(EditEntry(tool: "resize_video", op: .resize(width: 1080, height: 1920)))
        stack.push(EditEntry(tool: "lyric_captions", op: .lyricCaptions(LyricCaptionTrack(lines: [
            LyricLine(start: 0, end: 5, text: "Hello, this is a test of the caption position", translation: "你好，这是字幕位置的测试，字幕应该显示在画面下方两成的位置"),
        ]))))
        let composed = try await NativeComposer.compose(stack)
        let generator = composed.makeImageGenerator()
        let frame = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
        XCTAssertEqual(frame.width, 1080)
        XCTAssertEqual(frame.height, 1920)
        let plain = UIImage(cgImage: frame)
        try XCTUnwrap(plain.pngData()).write(to: out.appendingPathComponent("chinese-captions-1080x1920.png"))
        // Same frame with the bottom 20% shaded and its top edge marked.
        let size = CGSize(width: frame.width, height: frame.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let annotated = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            plain.draw(at: .zero)
            UIColor.red.withAlphaComponent(0.25).setFill()
            ctx.fill(CGRect(x: 0, y: size.height * 0.8, width: size.width, height: size.height * 0.2))
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: size.height * 0.8 - 2, width: size.width, height: 4))
        }
        try XCTUnwrap(annotated.pngData()).write(to: out.appendingPathComponent("chinese-captions-1080x1920-20pct-guide.png"))
        print("[lyric-shot] font=\(LyricCaptionFont.resolvedName) size=\(Int(size.width))x\(Int(size.height))")
    }
}
