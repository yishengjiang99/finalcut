import XCTest
@testable import FinalCut

/// Records every request and answers /api/chat with a scripted client-mode conversation.
final class RecordingURLProtocol: URLProtocol {
    static let lock = NSLock()
    static var requests: [URLRequest] = []
    static var chatReplies: [String] = []

    static func reset(chatReplies: [String]) {
        lock.lock(); defer { lock.unlock() }
        requests = []
        self.chatReplies = chatReplies
    }

    static var recorded: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let path = request.url?.path ?? ""
        var body: String?
        if path == "/api/chat", !Self.chatReplies.isEmpty { body = Self.chatReplies.removeFirst() }
        Self.lock.unlock()

        let status = body == nil ? 500 : 200
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"error":"stub"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class NoUploadAndHeadersTests: XCTestCase {
    private func stubSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: config)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: NativeSettings.cloudProcessingKey)
        super.tearDown()
    }

    /// Default settings: a model edit runs on the device and nothing but chat/auth is requested.
    @MainActor
    func testModelEditRunsOnDeviceWithoutUploading() async throws {
        UserDefaults.standard.set(false, forKey: NativeSettings.cloudProcessingKey)
        RecordingURLProtocol.reset(chatReplies: [
            #"{"schemaVersion":"1","status":"tool_calls","toolCalls":[{"id":"call_1","name":"apply_color_filter","arguments":{"filter":"red","intensity":1}}],"messages":[{"role":"user","content":"make it red"}],"round":1,"maxRounds":6}"#,
            #"{"schemaVersion":"1","status":"final","message":"Made it red."}"#,
        ])
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        model.apiClient = APIClient(config: APIConfig(baseURL: URL(string: "https://stub.finalcap.test")!), session: stubSession())
        model.state = .processing

        await model.runChatTurn(prompt: "make it red")

        let paths = RecordingURLProtocol.recorded.compactMap { $0.url?.path }
        XCTAssertEqual(paths.filter { $0 == "/api/chat" }.count, 2, "\(paths)")
        for path in paths {
            XCTAssertTrue(path == "/api/chat" || path.hasPrefix("/api/auth/"), "unexpected request \(path)")
            XCTAssertFalse(path.contains("jobs") || path.contains("process-video") || path.contains("caption"), path)
        }
        XCTAssertEqual(model.editStack?.entries.map(\.op), [.colorFilter(filter: "red", intensity: 1)])
        XCTAssertTrue(model.messages.contains { $0.content.contains(UXCopy.onDevice) })
        XCTAssertEqual(model.messages.last?.content, "Made it red.")
        for request in RecordingURLProtocol.recorded {
            XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), APIClient.userAgent)
        }
    }

    /// A tool with no device version shows "Not available on iPhone yet" and uploads nothing.
    @MainActor
    func testGapToolIsUnavailableWithoutUploading() async throws {
        UserDefaults.standard.set(false, forKey: NativeSettings.cloudProcessingKey)
        RecordingURLProtocol.reset(chatReplies: [])
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        model.apiClient = APIClient(config: APIConfig(baseURL: URL(string: "https://stub.finalcap.test")!), session: stubSession())
        let result = await model.executeToolCall(ClientToolCall(id: "c1", name: "audio_chorus", arguments: [:]))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "unsupported_on_device")
        XCTAssertEqual(model.messages.last?.failureCard?.kind, .unavailable)
        XCTAssertTrue(RecordingURLProtocol.recorded.isEmpty)
    }

    func testUnsupportedOnDeviceToolResultShape() {
        let result = ClientToolResult.failure("unsupported_on_device", on: .device)
        XCTAssertEqual(result.content, .object([
            "ok": .bool(false),
            "error": .string("unsupported_on_device"),
            "code": .string("unsupported_on_device"),
            "executedOn": .string("device"),
        ]))
    }

    func testUserAgentCarriesBuildNumber() throws {
        let build = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
        // The server allowlist gives builds < 10 zero tools.
        XCTAssertGreaterThanOrEqual(Int(build) ?? 0, 10)
        XCTAssertEqual(APIClient.userAgent, "FinalCap-iOS/\(build)")
        let client = APIClient()
        let request = client.makeRequest(url: client.chatURL, method: "POST", body: Data("{}".utf8))
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "FinalCap-iOS/\(build)")
    }

    // MARK: - Unlimited period

    func testAuthStatusUnlimitedDefaultsToFalse() throws {
        let plain = try JSONDecoder().decode(AuthStatus.self, from: Data(#"{"authenticated":true,"dailyLimit":10,"dailyRemaining":3}"#.utf8))
        XCTAssertFalse(plain.isUnlimited)
        let unlimited = try JSONDecoder().decode(AuthStatus.self, from: Data(#"{"authenticated":true,"unlimited":true,"dailyLimit":10,"dailyRemaining":3}"#.utf8))
        XCTAssertTrue(unlimited.isUnlimited)
    }

    func testAuthStatusDecodesNullLimits() throws {
        let json = #"{"authenticated":true,"unlimited":true,"dailyLimit":null,"dailyRemaining":null,"dailyUsed":4}"#
        let status = try JSONDecoder().decode(AuthStatus.self, from: Data(json.utf8))
        XCTAssertTrue(status.isUnlimited)
        XCTAssertNil(status.dailyLimit)
        XCTAssertNil(status.dailyRemaining)
        XCTAssertEqual(status.dailyUsed, 4)
    }

    @MainActor
    func testNullRemainingHidesCounter() {
        let app = AppModel()
        app.apply(AuthStatus(authenticated: true, dailyLimit: nil, dailyUsed: 2, dailyRemaining: nil))
        XCTAssertNil(app.dailyRemaining)
        XCTAssertNil(TopBarView.visibleFreeRemaining(unlimited: false, remaining: nil))
        XCTAssertNil(TopBarView.visibleFreeRemaining(unlimited: true, remaining: 3))
        XCTAssertEqual(TopBarView.visibleFreeRemaining(unlimited: false, remaining: 3), 3)
    }

    @MainActor
    func testUnlimitedHidesCounterAndNeverAutoOpensPaywall() {
        let app = AppModel()
        app.apply(AuthStatus(authenticated: true, dailyLimit: 10, dailyRemaining: 3, unlimited: true))
        XCTAssertTrue(app.isUnlimited)
        XCTAssertNil(app.dailyRemaining)
        app.presentPaywall(reason: .usageLimitReached)
        XCTAssertFalse(app.isPaywallPresented)
        app.presentPaywall(reason: .upgradeTapped)
        XCTAssertTrue(app.isPaywallPresented)

        let limited = AppModel()
        limited.apply(AuthStatus(authenticated: true, dailyLimit: 10, dailyRemaining: 3))
        XCTAssertFalse(limited.isUnlimited)
        XCTAssertEqual(limited.dailyRemaining, 3)
        limited.presentPaywall(reason: .usageLimitReached)
        XCTAssertTrue(limited.isPaywallPresented)
    }
}
