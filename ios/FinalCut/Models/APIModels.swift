import Foundation

struct ChatRequestBody: Codable, Equatable {
    var model: String?
    var messages: [ChatAPIMessage]
    var tools: [String]?
}

struct ChatAPIMessage: Codable, Equatable {
    var role: String
    var content: String
}

struct CreateCheckoutSessionResponse: Codable, Equatable {
    var url: String?
    var sessionId: String?

    enum CodingKeys: String, CodingKey {
        case url
        case sessionId
        case id
    }

    init(url: String? = nil, sessionId: String? = nil) {
        self.url = url
        self.sessionId = sessionId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
            ?? c.decodeIfPresent(String.self, forKey: .id)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(sessionId, forKey: .sessionId)
    }
}

struct VerifyCheckoutSessionResponse: Codable, Equatable {
    var paid: Bool?
    var status: String?
}

/// Minimal SSE event line parse result.
struct SSEEvent: Equatable {
    var event: String?
    var data: String
}
