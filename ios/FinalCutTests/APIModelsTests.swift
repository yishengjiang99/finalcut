import XCTest
@testable import FinalCut

final class APIModelsTests: XCTestCase {
    func testDefaultBaseURL() {
        XCTAssertEqual(APIConfig.defaultBaseURL.absoluteString, "https://grepawk.com")
    }

    func testEndpointURLConstruction() {
        let client = APIClient(config: APIConfig(baseURL: APIConfig.defaultBaseURL))
        XCTAssertEqual(client.authStatusURL.absoluteString, "https://grepawk.com/api/auth/status")
        XCTAssertEqual(client.chatURL.absoluteString, "https://grepawk.com/api/chat")
        XCTAssertEqual(client.processVideoURL.absoluteString, "https://grepawk.com/api/process-video")
        XCTAssertEqual(client.jobsProcessVideoURL.absoluteString, "https://grepawk.com/api/jobs/process-video")
        XCTAssertEqual(
            client.jobStatusURL(id: "abc-123").absoluteString,
            "https://grepawk.com/api/jobs/abc-123"
        )
        XCTAssertEqual(
            client.jobResultURL(id: "abc-123").absoluteString,
            "https://grepawk.com/api/jobs/abc-123/result"
        )
        XCTAssertEqual(client.transitionVideosURL.absoluteString, "https://grepawk.com/api/transition-videos")
        XCTAssertEqual(client.generateCaptionsURL.absoluteString, "https://grepawk.com/api/generate-captions")
        XCTAssertEqual(client.generateCaptionsDiarizedURL.absoluteString, "https://grepawk.com/api/generate-captions-diarized")
        XCTAssertEqual(client.translateCaptionsURL.absoluteString, "https://grepawk.com/api/translate-captions")
        XCTAssertEqual(client.createCheckoutSessionURL.absoluteString, "https://grepawk.com/api/create-checkout-session")
        XCTAssertEqual(client.verifyCheckoutSessionURL.absoluteString, "https://grepawk.com/api/verify-checkout-session")
        XCTAssertEqual(client.sampleAccessTokenURL.absoluteString, "https://grepawk.com/api/sample-access-token")
        XCTAssertEqual(client.mobileGoogleAuthURL.absoluteString, "https://grepawk.com/api/auth/mobile/google")
        XCTAssertEqual(client.authGoogleURL.absoluteString, "https://grepawk.com/auth/google")
        XCTAssertEqual(client.authLogoutURL.absoluteString, "https://grepawk.com/auth/logout")
    }

    func testPathConstants() {
        XCTAssertEqual(APIEndpoints.authStatus, "/api/auth/status")
        XCTAssertEqual(APIEndpoints.chat, "/api/chat")
        XCTAssertEqual(APIEndpoints.mobileGoogleAuth, "/api/auth/mobile/google")
        XCTAssertEqual(APIEndpoints.sampleAccessToken, "/api/sample-access-token")
        XCTAssertEqual(APIEndpoints.jobsProcessVideo, "/api/jobs/process-video")
        XCTAssertEqual(APIEndpoints.jobStatus("job-1"), "/api/jobs/job-1")
        XCTAssertEqual(APIEndpoints.jobResult("job-1"), "/api/jobs/job-1/result")
    }

    func testAuthStatusDecodeWithBearerMethod() throws {
        let json = """
        {"authenticated":true,"authMethod":"bearer","user":{"email":"a@b.com","name":"Ada"}}
        """.data(using: .utf8)!
        let status = try JSONDecoder().decode(AuthStatus.self, from: json)
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.authMethod, "bearer")
        XCTAssertEqual(status.user?.email, "a@b.com")
        XCTAssertEqual(status.user?.id, "a@b.com")
    }

    func testSampleAccessTokenDecode() throws {
        let json = """
        {"token":"sample-xyz","expiresInMs":3600000}
        """.data(using: .utf8)!
        let token = try JSONDecoder().decode(SampleAccessTokenResponse.self, from: json)
        XCTAssertEqual(token.token, "sample-xyz")
        XCTAssertEqual(token.expiresInMs, 3_600_000)
    }

    /// Decodes unused mobile Google response shape (future auth; not wired to SignIn).
    func testMobileGoogleAuthDecode() throws {
        let json = """
        {"accessToken":"tok-abc","expiresIn":2592000000,"tokenType":"Bearer","user":{"email":"x@y.z","name":"Pat","hasSubscription":false}}
        """.data(using: .utf8)!
        let auth = try JSONDecoder().decode(MobileGoogleAuthResponse.self, from: json)
        XCTAssertEqual(auth.accessToken, "tok-abc")
        XCTAssertEqual(auth.expiresIn, 2_592_000_000)
        XCTAssertEqual(auth.tokenType, "Bearer")
        XCTAssertEqual(auth.user.email, "x@y.z")
        XCTAssertEqual(auth.user.hasSubscription, false)
    }

    func testBearerHeaderAttached() {
        let client = APIClient(config: APIConfig())
        client.accessToken = "tok-123"
        let request = client.makeRequest(url: client.chatURL, method: "POST", auth: .bearerPreferred)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")
        XCTAssertNil(request.value(forHTTPHeaderField: "sample-access-token"))
    }

    func testSampleHeaderOnlyWhenSampleModeDebug() {
        var config = APIConfig()
        config.sampleModeEnabled = true
        let client = APIClient(config: config)
        client.sampleAccessToken = "demo-token"
        // Even if a Bearer token were present, sample mode must use the dedicated header only.
        client.accessToken = "should-not-appear-as-bearer-in-sample-mode"
        let request = client.makeRequest(url: client.chatURL, method: "POST", auth: .bearerPreferred)
        #if DEBUG
        XCTAssertEqual(request.value(forHTTPHeaderField: "sample-access-token"), "demo-token")
        XCTAssertNil(
            request.value(forHTTPHeaderField: "Authorization"),
            "Sample token must not be sent as Authorization: Bearer"
        )
        #else
        XCTAssertNil(request.value(forHTTPHeaderField: "sample-access-token"))
        #endif
    }

    func testJobsResultRequestUsesSameSampleHeader() {
        var config = APIConfig(baseURL: APIConfig.defaultBaseURL)
        config.sampleModeEnabled = true
        let client = APIClient(config: config)
        client.sampleAccessToken = "demo-token"
        let absolute = URL(string: "https://grepawk.com/api/jobs/uuid/result")!
        let request = client.makeRequest(url: absolute, method: "GET", auth: .bearerPreferred)
        #if DEBUG
        XCTAssertEqual(request.value(forHTTPHeaderField: "sample-access-token"), "demo-token")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        #endif
        XCTAssertEqual(client.jobResultURL(id: "uuid").absoluteString, "https://grepawk.com/api/jobs/uuid/result")
    }

    func testSSEParseBasic() {
        let raw = """
        event: message
        data: {"delta":"hi"}

        data: bye

        """
        let events = APIClient.parseSSELines(raw)
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].event, "message")
        XCTAssertEqual(events[0].data, "{\"delta\":\"hi\"}")
        XCTAssertEqual(events[1].data, "bye")
    }

    func testJobStatusCases() {
        let all = JobStatus.allCases.map(\.rawValue)
        XCTAssertEqual(all, ["queued", "running", "succeeded", "failed"])
        XCTAssertFalse(JobStatus.queued.isTerminal)
        XCTAssertFalse(JobStatus.running.isTerminal)
        XCTAssertTrue(JobStatus.succeeded.isTerminal)
        XCTAssertTrue(JobStatus.failed.isTerminal)
        XCTAssertEqual(JobStatus.queued.editorState, .processing)
        XCTAssertEqual(JobStatus.running.editorState, .processing)
        XCTAssertEqual(JobStatus.succeeded.editorState, .ready)
        XCTAssertEqual(JobStatus.failed.editorState, .failed)
    }

    func testJobEnqueueResponseDecode() throws {
        let json = """
        {"jobId":"uuid-1","status":"queued","pollUrl":"https://grepawk.com/api/jobs/uuid-1"}
        """.data(using: .utf8)!
        let enqueue = try JSONDecoder().decode(JobEnqueueResponse.self, from: json)
        XCTAssertEqual(enqueue.jobId, "uuid-1")
        XCTAssertEqual(enqueue.status, .queued)
        XCTAssertEqual(enqueue.pollUrl, "https://grepawk.com/api/jobs/uuid-1")
    }

    func testJobPollResponseDecodeSucceeded() throws {
        let json = """
        {"jobId":"uuid","status":"succeeded","progress":1,"resultUrl":"https://grepawk.com/api/jobs/uuid/result","contentType":"video/mp4","operation":"trim_video","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:01.000Z"}
        """.data(using: .utf8)!
        let poll = try JSONDecoder().decode(JobPollResponse.self, from: json)
        XCTAssertEqual(poll.jobId, "uuid")
        XCTAssertEqual(poll.status, .succeeded)
        XCTAssertEqual(poll.progress, 1)
        XCTAssertEqual(poll.resultUrl, "https://grepawk.com/api/jobs/uuid/result")
        XCTAssertEqual(poll.contentType, "video/mp4")
        XCTAssertEqual(poll.operation, "trim_video")
        XCTAssertNil(poll.error)
        XCTAssertTrue(poll.status.isTerminal)
        XCTAssertEqual(poll.status.editorState, .ready)
    }

    func testJobPollResponseDecodeFailed() throws {
        let json = """
        {"jobId":"bad","status":"failed","progress":0,"error":"Processing failed","operation":"trim_video"}
        """.data(using: .utf8)!
        let poll = try JSONDecoder().decode(JobPollResponse.self, from: json)
        XCTAssertEqual(poll.status, .failed)
        XCTAssertEqual(poll.error, "Processing failed")
        XCTAssertEqual(poll.status.editorState, .failed)
    }

    func testJobPollResponseDecodeRunning() throws {
        let json = """
        {"jobId":"r1","status":"running","progress":0.25,"operation":"trim_video"}
        """.data(using: .utf8)!
        let poll = try JSONDecoder().decode(JobPollResponse.self, from: json)
        XCTAssertEqual(poll.status, .running)
        XCTAssertEqual(poll.progress, 0.25)
        XCTAssertFalse(poll.status.isTerminal)
        XCTAssertEqual(poll.status.editorState, .processing)
    }

    func testEditorStateCases() {
        let all = EditorState.allCases.map(\.rawValue)
        XCTAssertEqual(all, ["empty", "importing", "uploading", "ready", "processing", "failed"])
    }

    func testCaptionsResponseDecode() throws {
        let json = """
        {"srt":"1\\n00:00:00,000 --> 00:00:01,000\\nHello\\n","vtt":"WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nHello\\n","language":"en"}
        """.data(using: .utf8)!
        let captions = try JSONDecoder().decode(CaptionsResponse.self, from: json)
        XCTAssertTrue(captions.srt.contains("Hello"))
        XCTAssertTrue(captions.vtt.contains("WEBVTT"))
        XCTAssertEqual(captions.language, "en")
    }

    func testTranslateCaptionsResponseDecode() throws {
        let json = """
        {"srt":"1\\n00:00:00,000 --> 00:00:01,000\\nHola\\n","vtt":"WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nHola\\n","targetLanguage":"Spanish"}
        """.data(using: .utf8)!
        let translated = try JSONDecoder().decode(TranslateCaptionsResponse.self, from: json)
        XCTAssertTrue(translated.srt.contains("Hola"))
        XCTAssertEqual(translated.targetLanguage, "Spanish")
    }

    func testTranslateCaptionsRequestEncode() throws {
        let req = TranslateCaptionsRequest(srtContent: "1\nHi\n", targetLanguage: "Spanish")
        let data = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["srtContent"] as? String, "1\nHi\n")
        XCTAssertEqual(obj?["targetLanguage"] as? String, "Spanish")
    }

    func testCaptionEndpointURLs() {
        let client = APIClient(config: APIConfig(baseURL: APIConfig.defaultBaseURL))
        XCTAssertEqual(client.generateCaptionsURL.absoluteString, "https://grepawk.com/api/generate-captions")
        XCTAssertEqual(client.translateCaptionsURL.absoluteString, "https://grepawk.com/api/translate-captions")
        XCTAssertEqual(client.processVideoURL.absoluteString, "https://grepawk.com/api/process-video")
        XCTAssertEqual(APIEndpoints.generateCaptions, "/api/generate-captions")
        XCTAssertEqual(APIEndpoints.translateCaptions, "/api/translate-captions")
        XCTAssertEqual(APIEndpoints.processVideo, "/api/process-video")
    }

    func testProcessingOverlayCopy() {
        XCTAssertEqual(ProcessingOverlayKind.generatingCaptions.message, "Generating captions…")
        XCTAssertEqual(ProcessingOverlayKind.translating.message, "Translating…")
        XCTAssertEqual(ProcessingOverlayKind.burningSubtitles.message, "Burning subtitles…")
        XCTAssertNotEqual(ProcessingOverlayKind.burningSubtitles.message, "Editing…")
    }

    @MainActor
    func testCaptionIntentDetection() {
        XCTAssertEqual(EditorViewModel.detectCaptionIntent("Generate captions"), .generate)
        XCTAssertEqual(EditorViewModel.detectCaptionIntent("Add captions"), .generate)
        XCTAssertEqual(EditorViewModel.detectCaptionIntent("Translate to Spanish"), .translate(language: "Spanish"))
        XCTAssertEqual(EditorViewModel.detectCaptionIntent("Burn in"), .burnIn)
        XCTAssertEqual(EditorViewModel.detectCaptionIntent("Trim silence"), .otherEdit)
    }

    @MainActor
    func testAppModelPaywallPresentationAndQuota() {
        let appModel = AppModel()
        XCTAssertFalse(appModel.isPaywallPresented)

        appModel.apply(AuthStatus(authenticated: true, user: AuthUser(id: "1", hasSubscription: false), dailyLimit: 3, dailyUsed: 1, dailyRemaining: 2))
        XCTAssertEqual(appModel.dailyLimit, 3)
        XCTAssertEqual(appModel.dailyRemaining, 2)
        XCTAssertFalse(appModel.hasSubscription)

        appModel.presentPaywall()
        XCTAssertTrue(appModel.isPaywallPresented)
        XCTAssertEqual(appModel.paywallReason, .upgradeTapped)
        XCTAssertEqual(appModel.dailyRemaining, 2)

        appModel.isPaywallPresented = false
        appModel.presentPaywall(reason: .usageLimitReached)
        XCTAssertTrue(appModel.isPaywallPresented)
        XCTAssertEqual(appModel.paywallReason, .usageLimitReached)
        XCTAssertEqual(appModel.dailyRemaining, 0)

        appModel.subscriptionActivated()
        XCTAssertFalse(appModel.isPaywallPresented)
        XCTAssertTrue(appModel.hasSubscription)
        XCTAssertNil(appModel.dailyRemaining)
    }

    func testPaywallErrorMapping() {
        let paywall402 = APIClient.error(forStatus: 402, data: Data(#"{"error":"Upgrade required","code":"paywall"}"#.utf8))
        XCTAssertEqual(paywall402, .paywallRequired("Upgrade required"))
        XCTAssertTrue(paywall402.isPaywall)

        XCTAssertTrue(APIClient.error(forStatus: 402, data: Data()).isPaywall)
        XCTAssertTrue(APIClient.error(forStatus: 429, data: Data(#"{"error":"Daily free inference limit reached","code":"daily_limit_reached","dailyLimit":1}"#.utf8)).isPaywall)
        XCTAssertTrue(APIClient.error(forStatus: 403, data: Data(#"{"error":"Active subscription required"}"#.utf8)).isPaywall)

        // Plain rate limiting / other errors are not paywall signals.
        XCTAssertFalse(APIClient.error(forStatus: 429, data: Data("Too many requests".utf8)).isPaywall)
        XCTAssertFalse(APIClient.error(forStatus: 500, data: Data(#"{"error":"boom"}"#.utf8)).isPaywall)
        XCTAssertEqual(APIClient.error(forStatus: 401, data: Data()), .httpStatus(401, ""))
    }

    @MainActor
    func testEditorPaywallErrorPresentsPaywallInsteadOfFailing() {
        let model = EditorViewModel()
        var paywallCount = 0
        model.onPaywallRequired = { paywallCount += 1 }
        model.localVideoURL = URL(fileURLWithPath: "/clip.mp4")
        model.state = .processing

        XCTAssertTrue(model.handlePaywallIfNeeded(APIError.paywallRequired(nil)))
        XCTAssertEqual(paywallCount, 1)
        XCTAssertEqual(model.state, .ready)
        XCTAssertNil(model.lastError)

        XCTAssertFalse(model.handlePaywallIfNeeded(APIError.httpStatus(500, nil)))
        XCTAssertEqual(paywallCount, 1)
    }

    @MainActor
    func testLoadSampleClipFromEmptyState() {
        let model = EditorViewModel()
        XCTAssertEqual(model.state, .empty)
        model.loadSampleClip()
        XCTAssertEqual(model.state, .ready)
        XCTAssertTrue(["sample-lake.mp4", "finalcap-test-video.mp4"].contains(model.localVideoURL?.lastPathComponent ?? ""))
    }

    func testAPIErrorCaptionsChatCopy() {
        XCTAssertEqual(APIError.noSpeechDetected.captionsChatMessage, "Couldn't generate captions — no speech")
        XCTAssertEqual(APIError.decoding.captionsChatMessage, "Couldn't generate captions — try again")
    }

    func testMultipartBurnBodyContainsOperationAndSrt() throws {
        let video = Data("fake-video".utf8)
        let multipart = try APIClient.makeMultipartProcessVideoBody(
            videoData: video,
            fileName: "clip.mp4",
            mimeType: "video/mp4",
            operation: "burn_subtitles",
            args: ["srtContent": "1\nHi\n", "style": "default", "position": "bottom"]
        )
        let body = String(data: multipart.data, encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("name=\"operation\""))
        XCTAssertTrue(body.contains("burn_subtitles"))
        XCTAssertTrue(body.contains("srtContent"))
        XCTAssertTrue(body.contains("name=\"video\""))
        XCTAssertTrue(body.contains("fake-video"))
    }

    // MARK: - Tool progress (add_soundtrack SSE)

    func testProgressEventParserReadsStagesHeartbeatsResultAndIgnoresUnknown() {
        var parser = ProgressEventParser()
        let lines = [
            "event: progress", #"data: {"type":"progress","stage":"rendering","label":"Rendering audio…"}"#,
            ": keepalive",
            "event: heartbeat", #"data: {"type":"heartbeat","elapsed":8}"#,
            "event: future_event", #"data: {"type":"future_event"}"#,
            "event: result", #"data: {"type":"result","audioBase64":"UklGRg=="}"#,
        ]
        let events = lines.compactMap { parser.feed($0) }
        XCTAssertEqual(events, [.progress("Rendering audio…"), .heartbeat(8), .unknown("future_event"), .result(Data("RIFF".utf8))])
    }

    func testProgressEventParserMapsStreamedErrorToStatus() {
        var parser = ProgressEventParser()
        _ = parser.feed("event: error")
        let payload = #"data: {"type":"error","error":"Limit","code":"soundtrack_limit","status":429}"#
        guard case .failure(let status, let data)? = parser.feed(payload) else { return XCTFail("expected failure") }
        XCTAssertEqual(status, 429)
        XCTAssertEqual(APIClient.error(forStatus: status, data: data).serverCode, "soundtrack_limit")
    }

    func testToolProgressTextShowsElapsedSeconds() {
        let start = Date(timeIntervalSince1970: 100)
        let progress = ToolProgress(label: "Rendering audio…", startedAt: start)
        XCTAssertEqual(progress.text(at: start.addingTimeInterval(0.4)), "Rendering audio…")
        XCTAssertEqual(progress.text(at: start.addingTimeInterval(12.7)), "Rendering audio… 12s")
    }

    @MainActor
    func testGenerateSoundtrackStreamsStagesThenAudio() async throws {
        SoundtrackStreamStub.response = ("text/event-stream",
            "event: progress\ndata: {\"label\":\"Composing track…\"}\n\nevent: heartbeat\ndata: {\"elapsed\":4}\n\nevent: result\ndata: {\"audioBase64\":\"UklGRg==\"}\n\n")
        let client = APIClient(config: APIConfig(baseURL: URL(string: "https://example.test")!), session: SoundtrackStreamStub.session())
        var stages: [String] = []
        let audio = try await client.generateSoundtrack(arguments: ["prompt": .string("calm")]) { stages.append($0) }
        XCTAssertEqual(audio, Data("RIFF".utf8))
        XCTAssertEqual(stages, ["Composing track…"])
        XCTAssertEqual(SoundtrackStreamStub.lastAccept, "text/event-stream, audio/wav")
    }

    func testGenerateSoundtrackAcceptsRawWavFromOlderServer() async throws {
        SoundtrackStreamStub.response = ("audio/wav", "RIFF")
        let client = APIClient(config: APIConfig(baseURL: URL(string: "https://example.test")!), session: SoundtrackStreamStub.session())
        let audio = try await client.generateSoundtrack(arguments: ["prompt": .string("calm")])
        XCTAssertEqual(audio, Data("RIFF".utf8))
    }
}

final class SoundtrackStreamStub: URLProtocol {
    nonisolated(unsafe) static var response: (String, String) = ("audio/wav", "")
    nonisolated(unsafe) static var lastAccept: String?

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SoundtrackStreamStub.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastAccept = request.value(forHTTPHeaderField: "Accept")
        let (type, body) = Self.response
        let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
