import Foundation

/// HTTP client for FinalCut backend.
///
/// Auth priority (mobile):
/// 1. `Authorization: Bearer <accessToken>` on chat / process-video / transition / captions / auth/status
/// 2. Sample mode: `sample-access-token` header — **DEBUG / demo flag only**
/// 3. Cookie jar via `HTTPCookieStorage` is optional/temporary; do not rely on it as primary
final class APIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    var config: APIConfig
    /// Opaque access token from POST /api/auth/mobile/google (or future providers).
    var accessToken: String?
    /// Absolute expiry derived from `expiresIn` (ms) when the token was issued.
    var accessTokenExpiresAt: Date?
    /// Token from GET /api/sample-access-token (sample/demo only).
    var sampleAccessToken: String?

    /// Mirrors config for convenience from AppModel.
    var sampleModeEnabled: Bool {
        get { config.sampleModeEnabled }
        set { config.sampleModeEnabled = newValue }
    }

    init(
        config: APIConfig = .shared,
        session: URLSession? = nil
    ) {
        self.config = config
        let configuration = URLSessionConfiguration.default
        // Cookie jar kept optional/temporary for web-parity experiments; Bearer is primary.
        configuration.httpCookieAcceptPolicy = .onlyFromMainDocumentDomain
        configuration.httpShouldSetCookies = true
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        self.session = session ?? URLSession(configuration: configuration)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - URL builders

    func url(for path: String, query: [URLQueryItem] = []) -> URL {
        APIEndpoints.makeURL(base: config.baseURL, path: path, query: query)
    }

    var authStatusURL: URL { url(for: APIEndpoints.authStatus) }
    var sampleAccessTokenURL: URL { url(for: APIEndpoints.sampleAccessToken) }
    var mobileGoogleAuthURL: URL { url(for: APIEndpoints.mobileGoogleAuth) }
    var chatURL: URL { url(for: APIEndpoints.chat) }
    var processVideoURL: URL { url(for: APIEndpoints.processVideo) }
    var transitionVideosURL: URL { url(for: APIEndpoints.transitionVideos) }
    var generateCaptionsURL: URL { url(for: APIEndpoints.generateCaptions) }
    var generateCaptionsDiarizedURL: URL { url(for: APIEndpoints.generateCaptionsDiarized) }
    var translateCaptionsURL: URL { url(for: APIEndpoints.translateCaptions) }
    var createCheckoutSessionURL: URL { url(for: APIEndpoints.createCheckoutSession) }
    var verifyCheckoutSessionURL: URL { url(for: APIEndpoints.verifyCheckoutSession) }
    var authGoogleURL: URL { url(for: APIEndpoints.authGoogle) }
    var authLogoutURL: URL { url(for: APIEndpoints.authLogout) }

    // MARK: - Request helpers

    enum AuthAttachment {
        case bearerPreferred
        case none
    }

    func makeRequest(
        url: URL,
        method: String = "GET",
        auth: AuthAttachment = .bearerPreferred,
        body: Data? = nil,
        contentType: String? = "application/json"
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let contentType, body != nil {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if let body {
            request.httpBody = body
        }
        attachAuth(to: &request, mode: auth)
        return request
    }

    private func attachAuth(to request: inout URLRequest, mode: AuthAttachment) {
        guard mode == .bearerPreferred else { return }

        if let accessToken, !accessToken.isEmpty {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        // sample-access-token: DEBUG / demo builds only — never primary auth.
        #if DEBUG
        if config.sampleModeEnabled, let sampleAccessToken, !sampleAccessToken.isEmpty {
            request.setValue(sampleAccessToken, forHTTPHeaderField: "sample-access-token")
        }
        #endif
    }

    // MARK: - Auth

    func fetchAuthStatus() async throws -> AuthStatus {
        let request = makeRequest(url: authStatusURL, method: "GET", auth: .bearerPreferred)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return try decoder.decode(AuthStatus.self, from: data)
    }

    /// Stub: POST /api/auth/mobile/google `{ idToken }` → `{ accessToken, expiresIn, user }`.
    /// Endpoint may not exist on server yet; client is ready.
    func authenticateWithGoogle(idToken: String) async throws -> MobileGoogleAuthResponse {
        let payload = MobileGoogleAuthRequest(idToken: idToken)
        let body = try encoder.encode(payload)
        let request = makeRequest(
            url: mobileGoogleAuthURL,
            method: "POST",
            auth: .none,
            body: body
        )
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        let result = try decoder.decode(MobileGoogleAuthResponse.self, from: data)
        accessToken = result.accessToken
        // Backend returns expiresIn in milliseconds (PR #46).
        accessTokenExpiresAt = Date().addingTimeInterval(TimeInterval(result.expiresIn) / 1000.0)
        return result
    }

    func fetchSampleAccessToken() async throws -> SampleAccessTokenResponse {
        let request = makeRequest(url: sampleAccessTokenURL, method: "GET", auth: .none)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        let result = try decoder.decode(SampleAccessTokenResponse.self, from: data)
        sampleAccessToken = result.token
        return result
    }

    // MARK: - Chat (SSE stub)

    /// Basic SSE line parser — splits `event:` / `data:` frames.
    static func parseSSELines(_ text: String) -> [SSEEvent] {
        var events: [SSEEvent] = []
        var currentEvent: String?
        var dataLines: [String] = []

        func flush() {
            guard !dataLines.isEmpty else {
                currentEvent = nil
                return
            }
            events.append(SSEEvent(event: currentEvent, data: dataLines.joined(separator: "\n")))
            currentEvent = nil
            dataLines = []
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine).trimmingCharacters(in: .init(charactersIn: "\r"))
            if line.isEmpty {
                flush()
                continue
            }
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                currentEvent = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
            }
        }
        flush()
        return events
    }

    /// Streams chat via POST /api/chat. Collects SSE chunks into a single string for the stub.
    func streamChat(body: ChatRequestBody) async throws -> AsyncThrowingStream<SSEEvent, Error> {
        let data = try encoder.encode(body)
        var request = makeRequest(url: chatURL, method: "POST", auth: .bearerPreferred, body: data)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        continuation.finish(throwing: APIError.httpStatus(http.statusCode, nil))
                        return
                    }
                    var buffer = ""
                    for try await byte in bytes {
                        buffer.append(Character(UnicodeScalar(byte)))
                        if buffer.contains("\n\n") {
                            let parts = buffer.components(separatedBy: "\n\n")
                            buffer = parts.last ?? ""
                            for part in parts.dropLast() {
                                for event in Self.parseSSELines(part + "\n\n") {
                                    continuation.yield(event)
                                }
                            }
                        }
                    }
                    if !buffer.isEmpty {
                        for event in Self.parseSSELines(buffer) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Video / captions (Bearer)

    func processVideo(body: Data, contentType: String, operationHeader: String? = nil) async throws -> Data {
        var request = makeRequest(
            url: processVideoURL,
            method: "POST",
            auth: .bearerPreferred,
            body: body,
            contentType: contentType
        )
        if let operationHeader {
            request.setValue(operationHeader, forHTTPHeaderField: "X-Operation")
        }
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return data
    }

    func transitionVideos(body: Data, contentType: String = "application/json") async throws -> Data {
        let request = makeRequest(
            url: transitionVideosURL,
            method: "POST",
            auth: .bearerPreferred,
            body: body,
            contentType: contentType
        )
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return data
    }

    func generateCaptions(body: Data, contentType: String = "application/json") async throws -> Data {
        try await postAuthorized(url: generateCaptionsURL, body: body, contentType: contentType)
    }

    func generateCaptionsDiarized(body: Data, contentType: String = "application/json") async throws -> Data {
        try await postAuthorized(url: generateCaptionsDiarizedURL, body: body, contentType: contentType)
    }

    func translateCaptions(body: Data, contentType: String = "application/json") async throws -> Data {
        try await postAuthorized(url: translateCaptionsURL, body: body, contentType: contentType)
    }

    func createCheckoutSession(body: Data = Data("{}".utf8)) async throws -> CreateCheckoutSessionResponse {
        let data = try await postAuthorized(url: createCheckoutSessionURL, body: body)
        return try decoder.decode(CreateCheckoutSessionResponse.self, from: data)
    }

    func verifyCheckoutSession(body: Data) async throws -> VerifyCheckoutSessionResponse {
        let data = try await postAuthorized(url: verifyCheckoutSessionURL, body: body)
        return try decoder.decode(VerifyCheckoutSessionResponse.self, from: data)
    }

    private func postAuthorized(url: URL, body: Data, contentType: String = "application/json") async throws -> Data {
        let request = makeRequest(url: url, method: "POST", auth: .bearerPreferred, body: body, contentType: contentType)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return data
    }

    static func throwIfNeeded(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8)
            throw APIError.httpStatus(http.statusCode, message)
        }
    }
}

enum APIError: Error, LocalizedError, Equatable {
    case httpStatus(Int, String?)
    case decoding
    case message(String)

    var errorDescription: String? {
        switch self {
        case .httpStatus(let code, let body):
            return "HTTP \(code)" + (body.map { ": \($0)" } ?? "")
        case .decoding:
            return "Failed to decode response"
        case .message(let text):
            return text
        }
    }
}
