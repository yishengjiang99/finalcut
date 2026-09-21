import Foundation

enum APIEndpoints {
    static let authStatus = "/api/auth/status"
    static let sampleAccessToken = "/api/sample-access-token"
    static let mobileGoogleAuth = "/api/auth/mobile/google"
    static let chat = "/api/chat"
    static let processVideo = "/api/process-video"
    static let transitionVideos = "/api/transition-videos"
    static let generateCaptions = "/api/generate-captions"
    static let generateCaptionsDiarized = "/api/generate-captions-diarized"
    static let translateCaptions = "/api/translate-captions"
    static let createCheckoutSession = "/api/create-checkout-session"
    static let verifyCheckoutSession = "/api/verify-checkout-session"
    static let authGoogle = "/auth/google"
    static let authLogout = "/auth/logout"

    static func url(base: URL, path: String) -> URL {
        var normalized = path
        if !normalized.hasPrefix("/") {
            normalized = "/" + normalized
        }
        return base.appendingPathComponent(String(normalized.dropFirst()))
    }

    /// Prefer URLComponents so query items stay clean.
    static func makeURL(base: URL, path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if basePath.isEmpty {
            components.path = "/" + rel
        } else {
            components.path = "/" + basePath + "/" + rel
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        return components.url ?? url(base: base, path: path)
    }
}
