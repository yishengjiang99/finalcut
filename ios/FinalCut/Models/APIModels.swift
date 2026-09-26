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

// MARK: - Async jobs (POST /api/jobs/process-video, GET /api/jobs/:id)

/// 202 response from enqueueing a process-video job.
struct JobEnqueueResponse: Codable, Equatable {
    var jobId: String
    var status: JobStatus
    var pollUrl: String?
}

/// Poll body from GET /api/jobs/:id (matches server `publicJob`).
struct JobPollResponse: Codable, Equatable {
    var jobId: String
    var status: JobStatus
    var progress: Double?
    var error: String?
    var resultUrl: String?
    var contentType: String?
    /// "image" for photos, "video" otherwise (Backend #82).
    var mediaType: String?
    var operation: String?
    var createdAt: String?
    var updatedAt: String?
}


// MARK: - Captions (POST /api/generate-captions, /api/translate-captions)

/// Soft caption payloads from generate / translate (JSON `{ srt, vtt }`).
struct CaptionsResponse: Codable, Equatable {
    var srt: String
    var vtt: String
    var language: String?
}

struct TranslateCaptionsRequest: Codable, Equatable {
    var srtContent: String
    var targetLanguage: String
}

struct TranslateCaptionsResponse: Codable, Equatable {
    var srt: String
    var vtt: String
    var targetLanguage: String
}
