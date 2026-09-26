import Foundation

/// Decides when a dictated request is finished (Design #96). Pure and clock-injected so it
/// can be unit-tested: feed it partial transcripts and ticks with explicit times.
///
/// - 0.4 s after a transcript that ends in `.`, `?` or `!`
/// - 1.0 s of no transcript change otherwise
/// - a final result sends immediately
/// - trailing punctuation/whitespace is stripped; empty text is never sent
/// - 30 s with no speech stops listening
struct DictationEndpointer: Equatable {
    static let punctuationDelay: TimeInterval = 0.4
    static let silenceDelay: TimeInterval = 1.0
    static let noSpeechTimeout: TimeInterval = 30

    enum Action: Equatable {
        case none
        case send(String)
        case stop
    }

    private(set) var transcript = ""
    private var lastChange: TimeInterval
    private var lastSpeech: TimeInterval

    init(now: TimeInterval) {
        lastChange = now
        lastSpeech = now
    }

    /// Starts a fresh utterance (after a send). The 30 s window restarts too.
    mutating func reset(now: TimeInterval) {
        transcript = ""
        lastChange = now
        lastSpeech = now
    }

    mutating func partial(_ text: String, isFinal: Bool, now: TimeInterval) -> Action {
        if text != transcript {
            transcript = text
            lastChange = now
        }
        if !Self.clean(text).isEmpty { lastSpeech = now }
        if isFinal {
            return send(now: now)
        }
        return .none
    }

    mutating func tick(now: TimeInterval) -> Action {
        let cleaned = Self.clean(transcript)
        if cleaned.isEmpty {
            return now - lastSpeech >= Self.noSpeechTimeout ? .stop : .none
        }
        let delay = Self.endsSentence(transcript) ? Self.punctuationDelay : Self.silenceDelay
        return now - lastChange >= delay ? send(now: now) : .none
    }

    private mutating func send(now: TimeInterval) -> Action {
        let cleaned = Self.clean(transcript)
        guard !cleaned.isEmpty else { return .none }
        reset(now: now)
        return .send(cleaned)
    }

    static func endsSentence(_ text: String) -> Bool {
        guard let last = text.trimmingCharacters(in: .whitespacesAndNewlines).last else { return false }
        return ".?!".contains(last)
    }

    /// Strips trailing sentence punctuation and whitespace ("Make it black and white." → "Make it black and white").
    static func clean(_ text: String) -> String {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = s.last, ".?!,;:…".contains(last) || last.isWhitespace {
            s.removeLast()
        }
        return s
    }
}
