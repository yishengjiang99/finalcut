import Foundation

// Lyric / translated captions (`lyric_captions`, docs/api/LYRIC_CAPTIONS.md).
// Pure model + copy + style math: no UIKit here so it stays easy to test.

enum LyricMode: String, Equatable, Sendable {
    case auto, lyrics, speech
}

/// Validated arguments of a `lyric_captions` tool call.
struct LyricCaptionRequest: Equatable, Sendable {
    var targetLanguage: String
    /// nil = `auto`.
    var sourceLanguage: String?
    var mode: LyricMode
    var positionFromBottomPct: Double?
    var fontSize: Int?
}

struct LyricLine: Equatable, Sendable, Codable {
    var start: Double
    var end: Double
    var text: String
    var translation: String

    init(start: Double, end: Double, text: String, translation: String = "") {
        self.start = start
        self.end = end
        self.text = text
        self.translation = translation
    }

    enum CodingKeys: String, CodingKey { case start, end, text, translation }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        start = try c.decode(Double.self, forKey: .start)
        end = try c.decode(Double.self, forKey: .end)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        translation = (try? c.decodeIfPresent(String.self, forKey: .translation)) ?? ""
    }

    /// What is drawn: the original line, then the translation under it. An empty
    /// translation, or one that only repeats the original, is never drawn twice.
    var displayText: String {
        let original = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let translated = translation.trimmingCharacters(in: .whitespacesAndNewlines)
        if translated.isEmpty || translated.caseInsensitiveCompare(original) == .orderedSame { return original }
        if original.isEmpty { return translated }
        return original + "\n" + translated
    }
}

struct LyricSong: Equatable, Sendable, Codable {
    var title: String?
    var artist: String?
    var url: String?
    var confidence: String?
}

/// The result JSON served at the job's `resultUrl` (lyric text stays on the device).
struct LyricCaptionResult: Equatable, Sendable, Decodable {
    var song: LyricSong?
    var mode: String?
    var language: String?
    var targetLanguage: String?
    var lines: [LyricLine]

    enum CodingKeys: String, CodingKey { case song, mode, language, targetLanguage, lines }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        song = try? c.decodeIfPresent(LyricSong.self, forKey: .song)
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        language = try? c.decodeIfPresent(String.self, forKey: .language)
        targetLanguage = try? c.decodeIfPresent(String.self, forKey: .targetLanguage)
        lines = (try? c.decodeIfPresent([LyricLine].self, forKey: .lines)) ?? []
    }

    init(song: LyricSong? = nil, mode: String? = nil, language: String? = nil, targetLanguage: String? = nil, lines: [LyricLine]) {
        self.song = song
        self.mode = mode
        self.language = language
        self.targetLanguage = targetLanguage
        self.lines = lines
    }
}

/// The captions on the edit stack (`NativeOp.lyricCaptions`), timed on the timeline at the
/// moment they were made. Later trims / speed changes remap them like normal captions.
struct LyricCaptionTrack: Equatable, Sendable {
    var lines: [LyricLine]
    var positionFromBottomPct: Double = LyricCaptionStyle.defaultPositionPct
    /// Explicit size in video pixels; nil = 48/1280 of the video height.
    var fontSize: Int? = nil

    func lineIndex(at time: Double) -> Int? {
        lines.firstIndex { time >= $0.start && time < $0.end }
    }

    func trimmed(start: Double, end: Double) -> LyricCaptionTrack {
        var copy = self
        copy.lines = lines.compactMap { line in
            let s = max(line.start, start), e = min(line.end, end)
            guard e - s > 0.05 else { return nil }
            return LyricLine(start: s - start, end: e - start, text: line.text, translation: line.translation)
        }
        return copy
    }

    func sped(factor: Double) -> LyricCaptionTrack {
        guard factor > 0 else { return self }
        var copy = self
        copy.lines = lines.map { LyricLine(start: $0.start / factor, end: $0.end / factor, text: $0.text, translation: $0.translation) }
        return copy
    }
}

/// Caption style from the doc, defined at 720x1280 and scaled proportionally to the video.
enum LyricCaptionStyle {
    static let referenceWidth = 720.0
    static let referenceHeight = 1280.0
    static let referenceFontSize = 48.0
    static let referenceOutline = 3.0
    static let referenceShadow = 1.0
    static let referenceMarginLR = 48.0
    static let defaultPositionPct = 20.0
    static let primaryFontName = "NotoSansCJKsc-Bold"
    static let fallbackFontName = "PingFangSC-Semibold"

    private static func scale(_ value: Double, height: Double) -> Double {
        value * height / referenceHeight
    }

    /// 48/1280 × height unless the request gave a size (video pixels).
    static func fontSize(canvasHeight: Double, override: Int? = nil) -> Double {
        if let override { return Double(override) }
        return scale(referenceFontSize, height: canvasHeight)
    }

    static func outlineWidth(canvasHeight: Double) -> Double { scale(referenceOutline, height: canvasHeight) }
    static func shadowOffset(canvasHeight: Double) -> Double { scale(referenceShadow, height: canvasHeight) }
    static func horizontalMargin(canvasWidth: Double) -> Double { referenceMarginLR * canvasWidth / referenceWidth }

    /// Bottom edge of the caption block above the video's bottom edge, in pixels.
    static func bottomOffset(canvasHeight: Double, pct: Double) -> Double {
        canvasHeight * min(max(pct, 0), 45) / 100
    }
}

/// Fixed copy for translated captions (Design; the privacy wording follows the streaming transport).
enum LyricCaptionsCopy {
    static let addingCaptions = StreamingCopy.addingCaptions

    static let openSettings = "Open Settings"
    static let notNow = "Not now"

    static let serverCaptionsMessage = "Captions need to upload this video's audio to transcribe it. Upload and continue?"
    static let serverCaptionsTitle = "Upload this video's audio?"
    static let upload = "Upload"

    // Friendly failure copy (nothing applied). Never raw server text.
    static let unavailable = StreamingCopy.unavailable
    static let noSpeech = StreamingCopy.noSpeech
    static let tooLong = StreamingCopy.tooLong
    static let couldntFinish = StreamingCopy.couldntFinish
    static let noAudio = StreamingCopy.noAudio
    static let generic = couldntFinish

    /// Shown (not blocking) when translated captions start: the audio, not the video, goes to
    /// ElevenLabs to be transcribed and the text to FinalCap to be translated. It does not claim
    /// the audio is deleted.
    static func audioNote(target: String) -> String {
        "Sending this video's audio (not the video) to ElevenLabs to transcribe it. The text goes to FinalCap to be translated into \(target)."
    }

    /// The connection dropped after the automatic resumes: Continue picks up from the first
    /// unfinished range with a fresh token.
    static func continuePrompt(message: String) -> CloudPrompt {
        CloudPrompt(kind: .upload, title: StreamingCopy.continueTitle, message: message,
                    primary: StreamingCopy.continueButton, secondary: StreamingCopy.cancelButton)
    }

    /// Server `generate_captions` / translate on the Cloud-ON path.
    static var serverCaptionsPrompt: CloudPrompt {
        CloudPrompt(kind: .upload, title: serverCaptionsTitle, message: serverCaptionsMessage, primary: upload, secondary: notNow)
    }

    private static let codePattern = try! NSRegularExpression(pattern: "^[A-Za-z]{2,3}([-_][A-Za-z0-9]+)*$")

    /// "zh-Hans" → "Chinese", "de" → "German"; a plain name ("Japanese") is kept, capitalised.
    /// nil for empty / `auto`.
    static func languageName(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
              trimmed.lowercased() != "auto" else { return nil }
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        if codePattern.firstMatch(in: trimmed, range: range) != nil {
            let primary = String(trimmed.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "").lowercased()
            if let name = Locale(identifier: "en_US").localizedString(forLanguageCode: primary),
               name.lowercased() != primary {
                return name
            }
        }
        return trimmed.prefix(1).uppercased() + trimmed.dropFirst()
    }

    static func targetName(_ raw: String) -> String {
        languageName(raw) ?? raw
    }

    /// Applied card label.
    /// - song identified: `Lyrics · German + Chinese`
    /// - otherwise: `Captions · English → Chinese`, or `Captions · Speech + Chinese` when the
    ///   source language is unknown.
    static func appliedLabel(song: LyricSong?, language: String?, targetLanguage: String) -> String {
        let target = targetName(targetLanguage)
        let source = languageName(language)
        if song != nil {
            if let source { return "Lyrics · \(source) + \(target)" }
            return "Lyrics · \(target)"
        }
        if let source { return "Captions · \(source) → \(target)" }
        return "Captions · Speech + \(target)"
    }

    /// Chat copy for a streaming failure.
    static func failureCopy(_ error: StreamingError) -> String { StreamingCopy.friendly(error) }
}

/// A two-button confirmation shown by the editor (`.alert`).
struct CloudPrompt: Equatable, Identifiable {
    enum Kind: Equatable { case upload, openSettings }
    var kind: Kind
    var title: String
    var message: String
    var primary: String
    var secondary: String
    var id: String { title + "|" + message }
}
