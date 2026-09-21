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
        let request = client.makeRequest(url: client.chatURL, method: "POST", auth: .bearerPreferred)
        #if DEBUG
        XCTAssertEqual(request.value(forHTTPHeaderField: "sample-access-token"), "demo-token")
        #else
        XCTAssertNil(request.value(forHTTPHeaderField: "sample-access-token"))
        #endif
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
    }

    func testEditorStateCases() {
        let all = EditorState.allCases.map(\.rawValue)
        XCTAssertEqual(all, ["empty", "uploading", "ready", "processing", "failed"])
    }
}
