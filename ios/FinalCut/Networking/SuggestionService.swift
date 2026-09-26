import Foundation

/// One suggestion pill: the pill shows `label`; tapping sends `prompt` as the chat message.
struct SuggestionPill: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var label: String
    var prompt: String
    var icon: String?

    init(id: String, label: String, prompt: String, icon: String? = nil) {
        self.id = id
        self.label = label
        self.prompt = prompt
        self.icon = icon
    }

    private enum CodingKeys: String, CodingKey { case id, label, prompt, icon }

    /// Lenient: a non-string `icon` is ignored; a missing `id` falls back to the label.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        prompt = try c.decode(String.self, forKey: .prompt)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil ?? label
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? nil
    }
}

enum SuggestionMedia: String, Sendable {
    case video
    case photo
}

/// `GET /api/ios/suggestions?build=<CFBundleVersion>&media=video|photo` →
/// `{"suggestions":[{id,label,prompt,icon?}],"ttl":<seconds>}`.
/// The last good response per media type is cached with its fetch time and used while within
/// `ttl`. Any failure (offline, non-200, 404 before the endpoint ships, bad JSON, empty list)
/// falls back to the cache, then to the bundled defaults, so the row is never empty.
final class SuggestionService: @unchecked Sendable {
    static let defaultTTL: TimeInterval = 3600

    struct CacheEntry: Codable, Equatable {
        var fetchedAt: Date
        var ttl: TimeInterval
        var suggestions: [SuggestionPill]
    }

    private struct Response: Decodable {
        var suggestions: [SuggestionPill]
        var ttl: TimeInterval?

        private enum CodingKeys: String, CodingKey { case suggestions, ttl }
        private struct Lossy: Decodable {
            var pill: SuggestionPill?
            init(from decoder: Decoder) throws { pill = try? SuggestionPill(from: decoder) }
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            suggestions = try c.decode([Lossy].self, forKey: .suggestions).compactMap(\.pill)
            ttl = (try? c.decodeIfPresent(TimeInterval.self, forKey: .ttl)) ?? nil
        }
    }

    private let session: URLSession
    private let defaults: UserDefaults
    private let baseURL: URL
    private let build: String
    private let userAgent: String
    private let now: () -> Date

    init(
        session: URLSession? = nil,
        defaults: UserDefaults = .standard,
        baseURL: URL = APIConfig.defaultBaseURL,
        bundle: Bundle = .main,
        now: @escaping () -> Date = Date.init
    ) {
        self.userAgent = APIClient.userAgent(bundle: bundle)
        self.build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 10
            configuration.httpAdditionalHeaders = ["User-Agent": userAgent]
            self.session = URLSession(configuration: configuration)
        }
        self.defaults = defaults
        self.baseURL = baseURL
        self.now = now
    }

    func requestURL(for media: SuggestionMedia) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/ios/suggestions"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "build", value: build),
            URLQueryItem(name: "media", value: media.rawValue),
        ]
        return components.url!
    }

    /// What to show right away (fresh or stale cache, else bundled) — no network.
    func immediate(for media: SuggestionMedia) -> [SuggestionPill] {
        cached(media)?.suggestions ?? Self.bundled(media)
    }

    /// Fresh cache, else the server, else stale cache, else bundled. Never empty.
    func suggestions(for media: SuggestionMedia) async -> [SuggestionPill] {
        let cache = cached(media)
        if let cache, now().timeIntervalSince(cache.fetchedAt) < cache.ttl {
            return cache.suggestions
        }
        if let fetched = await fetch(media) {
            return fetched
        }
        return cache?.suggestions ?? Self.bundled(media)
    }

    private func fetch(_ media: SuggestionMedia) async -> [SuggestionPill]? {
        var request = URLRequest(url: requestURL(for: media))
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let decoded = try? JSONDecoder().decode(Response.self, from: data) else { return nil }
        let pills = decoded.suggestions.filter {
            !$0.label.trimmingCharacters(in: .whitespaces).isEmpty && !$0.prompt.trimmingCharacters(in: .whitespaces).isEmpty
        }
        guard !pills.isEmpty else { return nil }
        let ttl = decoded.ttl.flatMap { $0 > 0 ? $0 : nil } ?? Self.defaultTTL
        store(CacheEntry(fetchedAt: now(), ttl: ttl, suggestions: pills), for: media)
        return pills
    }

    // MARK: Cache

    static func cacheKey(_ media: SuggestionMedia) -> String { "suggestions.cache.\(media.rawValue)" }

    func cached(_ media: SuggestionMedia) -> CacheEntry? {
        guard let data = defaults.data(forKey: Self.cacheKey(media)),
              let entry = try? JSONDecoder().decode(CacheEntry.self, from: data),
              !entry.suggestions.isEmpty else { return nil }
        return entry
    }

    func store(_ entry: CacheEntry, for media: SuggestionMedia) {
        guard let data = try? JSONEncoder().encode(entry) else { return }
        defaults.set(data, forKey: Self.cacheKey(media))
    }

    // MARK: Bundled defaults (Design's final set; all doable on device in build 12)

    static func bundled(_ media: SuggestionMedia) -> [SuggestionPill] {
        media == .photo ? bundledPhoto : bundledVideo
    }

    static let bundledVideo: [SuggestionPill] = [
        SuggestionPill(id: "v-captions", label: "Captions",
                       prompt: "Add captions from what's said in the video.", icon: "captions.bubble"),
        SuggestionPill(id: "v-trim-15", label: "Trim to 15s",
                       prompt: "Trim the video to the first 15 seconds.", icon: "scissors"),
        SuggestionPill(id: "v-title", label: "Add a title",
                       prompt: "Add a title at the top of the video in large white text. Ask me what it should say first.", icon: "textformat"),
        SuggestionPill(id: "v-vertical", label: "Make it vertical",
                       prompt: "Make the video vertical (9:16) for Reels and TikTok.", icon: "rectangle.portrait"),
        SuggestionPill(id: "v-slowmo", label: "Slow motion",
                       prompt: "Play the video at half speed.", icon: "tortoise"),
        SuggestionPill(id: "v-speed-2x", label: "Speed up 2×",
                       prompt: "Play the video at 2× speed.", icon: "hare"),
        SuggestionPill(id: "v-warm", label: "Warmer look",
                       prompt: "Give the video warmer tones.", icon: "thermometer.sun"),
        SuggestionPill(id: "v-mute", label: "Mute audio",
                       prompt: "Mute the audio.", icon: "speaker.slash"),
    ]

    static let bundledPhoto: [SuggestionPill] = [
        SuggestionPill(id: "p-bw", label: "Black and white",
                       prompt: "Make the photo black and white.", icon: "circle.lefthalf.filled"),
        SuggestionPill(id: "p-brighten", label: "Brighten",
                       prompt: "Make the photo a little brighter.", icon: "sun.max"),
        SuggestionPill(id: "p-vivid", label: "More vivid",
                       prompt: "Make the colors a little more vivid.", icon: "paintpalette"),
        SuggestionPill(id: "p-warm", label: "Warmer look",
                       prompt: "Give the photo warmer tones.", icon: "thermometer.sun"),
        SuggestionPill(id: "p-square", label: "Square 1:1",
                       prompt: "Make the photo square (1:1) for Instagram.", icon: "square"),
        SuggestionPill(id: "p-text", label: "Add text",
                       prompt: "Add text to the photo. Ask me what it should say first.", icon: "textformat"),
    ]
}
