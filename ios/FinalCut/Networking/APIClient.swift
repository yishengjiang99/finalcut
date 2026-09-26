import Foundation

/// HTTP client for FinalCut backend.
///
/// Auth uses an opaque Bearer session minted for a Keychain-backed install:
/// 1. **DEBUG / demo E2E (prod grepawk.com):** `GET /api/sample-access-token`, then send header
///    `sample-access-token: <token>` on jobs enqueue, poll, and result downloads.
///    Never `Authorization: Bearer <sample-token>`.
/// 2. Apple transactions are verified by the server before the Bearer user is marked premium.
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
    var mobileDeviceAuthURL: URL { url(for: APIEndpoints.mobileDeviceAuth) }
    var mobileAppleIAPURL: URL { url(for: APIEndpoints.mobileAppleIAP) }
    var chatURL: URL { url(for: APIEndpoints.chat) }
    var processVideoURL: URL { url(for: APIEndpoints.processVideo) }
    var jobsProcessVideoURL: URL { url(for: APIEndpoints.jobsProcessVideo) }
    func jobStatusURL(id: String) -> URL { url(for: APIEndpoints.jobStatus(id)) }
    func jobResultURL(id: String) -> URL { url(for: APIEndpoints.jobResult(id)) }
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

        // Prod E2E / DEBUG demo: GET /api/sample-access-token then send
        // `sample-access-token: <token>` on every authenticated call (jobs enqueue,
        // poll, and result download). Never put the sample token in Authorization.
        #if DEBUG
        if config.sampleModeEnabled, let sampleAccessToken, !sampleAccessToken.isEmpty {
            request.setValue(sampleAccessToken, forHTTPHeaderField: "sample-access-token")
            // Sample mode is sufficient for requireAuthenticatedUser / subscription
            // on grepawk.com — skip Bearer so we never send Authorization: Bearer <sample>.
            return
        }
        #endif

        if let accessToken, !accessToken.isEmpty {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
    }

    // MARK: - Auth

    func fetchAuthStatus() async throws -> AuthStatus {
        let request = makeRequest(url: authStatusURL, method: "GET", auth: .bearerPreferred)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return try decoder.decode(AuthStatus.self, from: data)
    }

    /// Unused in this scaffold (Google Sign-In deferred). Kept for a future auth phase.
    /// POST /api/auth/mobile/google `{ idToken }` → `{ accessToken, expiresIn, tokenType, user }`.
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

    @discardableResult
    func registerDevice() async throws -> MobileDeviceAuthResponse {
        let body = try encoder.encode(MobileDeviceAuthRequest(deviceInstallId: DeviceIdentity.installID))
        let request = makeRequest(url: mobileDeviceAuthURL, method: "POST", auth: .none, body: body)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        let result = try decoder.decode(MobileDeviceAuthResponse.self, from: data)
        accessToken = result.accessToken
        accessTokenExpiresAt = Date().addingTimeInterval(TimeInterval(result.expiresIn) / 1000.0)
        return result
    }

    func ensureDeviceSession() async throws {
        if let accessToken, !accessToken.isEmpty,
           let expiresAt = accessTokenExpiresAt,
           expiresAt.timeIntervalSinceNow > 60 {
            return
        }
        _ = try await registerDevice()
    }

    @discardableResult
    func syncAppleTransaction(jwsRepresentation: String) async throws -> AuthStatus {
        try await ensureDeviceSession()
        let body = try encoder.encode(MobileAppleIAPRequest(signedTransactionJws: jwsRepresentation))
        let data = try await postAuthorized(url: mobileAppleIAPURL, body: body)
        return try decoder.decode(AuthStatus.self, from: data)
    }

    func fetchSampleAccessToken() async throws -> SampleAccessTokenResponse {
        // No auth on this route — issues a short-lived token for the `sample-access-token` header.
        let request = makeRequest(url: sampleAccessTokenURL, method: "GET", auth: .none)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        let result = try decoder.decode(SampleAccessTokenResponse.self, from: data)
        sampleAccessToken = result.token
        return result
    }

    /// Ensures a live sample token is stored for the `sample-access-token` header (DEBUG / demo).
    /// Call before jobs enqueue/poll/result against https://grepawk.com.
    @discardableResult
    func ensureSampleAccessToken() async throws -> String {
        if let sampleAccessToken, !sampleAccessToken.isEmpty {
            return sampleAccessToken
        }
        return try await fetchSampleAccessToken().token
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
                        // Collect the (small) JSON error body so 402 / quota errors map to `.paywallRequired`.
                        var errorBody = Data()
                        for try await byte in bytes {
                            errorBody.append(byte)
                            if errorBody.count >= 16_384 { break }
                        }
                        continuation.finish(throwing: Self.error(forStatus: http.statusCode, data: errorBody))
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


    // MARK: - Async jobs (prefer over sync process-video on iOS)

    /// Multipart enqueue: POST /api/jobs/process-video → 202 { jobId, status, pollUrl? }
    /// Fields: `video` (file), `operation` (string), `args` (optional JSON string).
    func submitProcessVideoJob(
        videoData: Data,
        fileName: String = "video.mp4",
        mimeType: String = "video/mp4",
        operation: String,
        args: [String: Any] = [:]
    ) async throws -> JobEnqueueResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        let crlf = "\r\n"

        func append(_ string: String) {
            body.append(Data(string.utf8))
        }

        func appendField(name: String, value: String) {
            append("--\(boundary)\(crlf)")
            append("Content-Disposition: form-data; name=\"\(name)\"\(crlf)\(crlf)")
            append("\(value)\(crlf)")
        }

        appendField(name: "operation", value: operation)
        if !args.isEmpty {
            let argsData = try JSONSerialization.data(withJSONObject: args, options: [])
            let argsString = String(data: argsData, encoding: .utf8) ?? "{}"
            appendField(name: "args", value: argsString)
        }

        append("--\(boundary)\(crlf)")
        append("Content-Disposition: form-data; name=\"video\"; filename=\"\(fileName)\"\(crlf)")
        append("Content-Type: \(mimeType)\(crlf)\(crlf)")
        body.append(videoData)
        append(crlf)
        append("--\(boundary)--\(crlf)")

        let request = makeRequest(
            url: jobsProcessVideoURL,
            method: "POST",
            auth: .bearerPreferred,
            body: body,
            contentType: "multipart/form-data; boundary=\(boundary)"
        )
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        do {
            return try decoder.decode(JobEnqueueResponse.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    /// Single poll: GET /api/jobs/:id
    func fetchJobStatus(id: String) async throws -> JobPollResponse {
        let request = makeRequest(url: jobStatusURL(id: id), method: "GET", auth: .bearerPreferred)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        do {
            return try decoder.decode(JobPollResponse.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    /// Poll with exponential backoff until terminal status (`succeeded` | `failed`).
    /// Calls `onUpdate` after each successful poll (including the first).
    func pollJob(
        id: String,
        initialInterval: TimeInterval = 0.5,
        maxInterval: TimeInterval = 5.0,
        maxAttempts: Int = 60,
        onUpdate: ((JobPollResponse) -> Void)? = nil
    ) async throws -> JobPollResponse {
        var interval = initialInterval
        var last: JobPollResponse?
        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                interval = min(interval * 2, maxInterval)
            }
            let status = try await fetchJobStatus(id: id)
            last = status
            onUpdate?(status)
            if status.status.isTerminal {
                return status
            }
        }
        if let last {
            return last
        }
        throw APIError.message("Job poll timed out for \(id)")
    }

    /// Download job result bytes. Auth: same `sample-access-token` header (or Bearer) as poll.
    /// Prefer `resultUrl` from the poll body when absolute (APP_BASE_URL = https://grepawk.com).
    func downloadJobResult(id: String, resultUrl: String? = nil) async throws -> Data {
        let url: URL
        if let resultUrl, let absolute = URL(string: resultUrl), absolute.scheme != nil {
            url = absolute
        } else {
            url = jobResultURL(id: id)
        }
        let request = makeRequest(url: url, method: "GET", auth: .bearerPreferred)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfNeeded(response: response, data: data)
        return data
    }

    // MARK: - Video / captions

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

    /// POST /api/generate-captions — raw video body + optional `X-Args` JSON (`language`).
    /// Returns soft `{ srt, vtt }`. 422 = no speech (do not invent VTT).
    func generateCaptions(
        videoData: Data,
        mimeType: String = "video/mp4",
        language: String = "auto"
    ) async throws -> CaptionsResponse {
        var request = makeRequest(
            url: generateCaptionsURL,
            method: "POST",
            auth: .bearerPreferred,
            body: videoData,
            contentType: mimeType
        )
        let argsData = try JSONSerialization.data(withJSONObject: ["language": language], options: [])
        if let argsString = String(data: argsData, encoding: .utf8) {
            request.setValue(argsString, forHTTPHeaderField: "X-Args")
        }
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 422 {
            throw APIError.noSpeechDetected
        }
        try Self.throwIfNeeded(response: response, data: data)
        do {
            return try decoder.decode(CaptionsResponse.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    func generateCaptionsDiarized(body: Data, contentType: String) async throws -> Data {
        try await postAuthorized(url: generateCaptionsDiarizedURL, body: body, contentType: contentType)
    }

    /// POST /api/translate-captions — JSON `{ srtContent, targetLanguage }` → `{ srt, vtt, targetLanguage }`.
    func translateCaptions(srtContent: String, targetLanguage: String) async throws -> TranslateCaptionsResponse {
        let payload = TranslateCaptionsRequest(srtContent: srtContent, targetLanguage: targetLanguage)
        let body = try encoder.encode(payload)
        let data = try await postAuthorized(url: translateCaptionsURL, body: body)
        do {
            return try decoder.decode(TranslateCaptionsResponse.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    /// Burn-in MUST be sync multipart `POST /api/process-video` with `operation=burn_subtitles`.
    /// Do **not** use `/api/jobs/process-video` — jobs/ffmpegOps rejects `burn_subtitles` / `add_audio_track`.
    /// Multipart fields: `video`, `operation`, `args` JSON (`srtContent`, optional `translatedSrtContent`).
    /// Response body is burned `video/mp4` bytes.
    func burnSubtitles(
        videoData: Data,
        fileName: String = "video.mp4",
        mimeType: String = "video/mp4",
        srtContent: String,
        translatedSrtContent: String? = nil,
        style: String = "default",
        position: String = "bottom"
    ) async throws -> Data {
        var args: [String: Any] = [
            "srtContent": srtContent,
            "style": style,
            "position": position,
        ]
        if let translatedSrtContent, !translatedSrtContent.isEmpty {
            args["translatedSrtContent"] = translatedSrtContent
        }
        let multipart = try Self.makeMultipartProcessVideoBody(
            videoData: videoData,
            fileName: fileName,
            mimeType: mimeType,
            operation: "burn_subtitles",
            args: args
        )
        return try await processVideo(
            body: multipart.data,
            contentType: "multipart/form-data; boundary=\(multipart.boundary)"
        )
    }

    /// Shared multipart builder for sync process-video (`burn_subtitles` / `add_audio_track`).
    static func makeMultipartProcessVideoBody(
        videoData: Data,
        fileName: String,
        mimeType: String,
        operation: String,
        args: [String: Any]
    ) throws -> (data: Data, boundary: String) {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        let crlf = "\r\n"

        func append(_ string: String) {
            body.append(Data(string.utf8))
        }

        func appendField(name: String, value: String) {
            append("--\(boundary)\(crlf)")
            append("Content-Disposition: form-data; name=\"\(name)\"\(crlf)\(crlf)")
            append("\(value)\(crlf)")
        }

        appendField(name: "operation", value: operation)
        if !args.isEmpty {
            let argsData = try JSONSerialization.data(withJSONObject: args, options: [])
            let argsString = String(data: argsData, encoding: .utf8) ?? "{}"
            appendField(name: "args", value: argsString)
        }

        append("--\(boundary)\(crlf)")
        append("Content-Disposition: form-data; name=\"video\"; filename=\"\(fileName)\"\(crlf)")
        append("Content-Type: \(mimeType)\(crlf)\(crlf)")
        body.append(videoData)
        append(crlf)
        append("--\(boundary)--\(crlf)")
        return (body, boundary)
    }

    /// Server Stripe helper — unused by iOS Paywall (StoreKit only). Kept for API path completeness.
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
            throw error(forStatus: http.statusCode, data: data)
        }
    }

    /// Maps a non-2xx response to a typed error. Usage-limit / paywall responses become
    /// `.paywallRequired` so the Editor presents the Paywall sheet instead of a generic failure:
    /// - HTTP 402 (any body; backend contract `{ code: "paywall" }`)
    /// - any status with JSON `code == "paywall"`
    /// - HTTP 429 with JSON `code == "daily_limit_reached"` (current `requireInferenceAccess`)
    /// - HTTP 403 `{ error: "Active subscription required" }`
    static func error(forStatus statusCode: Int, data: Data) -> APIError {
        let payload = (try? JSONDecoder().decode(APIErrorPayload.self, from: data))
        let code = payload?.code?.lowercased()
        let serverMessage = payload?.error ?? payload?.message
        if statusCode == 402 || code == "paywall" || code == "daily_limit_reached" {
            return .paywallRequired(serverMessage)
        }
        if statusCode == 403,
           let serverMessage,
           serverMessage.localizedCaseInsensitiveContains("subscription required") {
            return .paywallRequired(serverMessage)
        }
        return .httpStatus(statusCode, String(data: data, encoding: .utf8))
    }
}

/// Generic JSON error body from the backend (`{ error, code, message, ... }`).
struct APIErrorPayload: Decodable, Equatable {
    var error: String?
    var code: String?
    var message: String?
}

enum APIError: Error, LocalizedError, Equatable {
    case httpStatus(Int, String?)
    case decoding
    case message(String)
    /// 422 from /api/generate-captions — no speech in clip.
    case noSpeechDetected
    /// Free usage limit hit (HTTP 402 `code: "paywall"`, or 429 `daily_limit_reached`) — show Paywall.
    case paywallRequired(String?)

    var errorDescription: String? {
        switch self {
        case .httpStatus(let code, let body):
            return "HTTP \(code)" + (body.map { ": \($0)" } ?? "")
        case .decoding:
            return "Failed to decode response"
        case .message(let text):
            return text
        case .noSpeechDetected:
            return "no speech"
        case .paywallRequired(let message):
            return message ?? "Free limit reached — upgrade to keep editing"
        }
    }

    /// True when the server says the free limit is used up (present Paywall, not a failure).
    var isPaywall: Bool {
        if case .paywallRequired = self { return true }
        return false
    }

    /// Inline chat copy for caption failures (Design UX).
    var captionsChatMessage: String {
        switch self {
        case .noSpeechDetected:
            return "Couldn't generate captions — no speech"
        default:
            return "Couldn't generate captions — try again"
        }
    }
}
