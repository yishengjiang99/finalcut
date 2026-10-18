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

/// Fixed copy for lyric captions (Design).
enum LyricCaptionsCopy {
    static let uploadingAudio = "Uploading audio…"
    static let listening = "Listening to the song…"
    static let findingLyrics = "Finding lyrics and translating…"
    static let checkingWords = "Checking the words and translating…"
    static let addingCaptions = "Adding captions…"

    static let cloudOffTitle = "Lyric captions use the cloud"
    static let cloudOffBody = "To caption a song, FinalCap uploads this video's audio to transcribe and translate it. Turn on Cloud processing to use lyric captions."
    static let speechCloudOffTitle = "Translated captions use the cloud"
    static let openSettings = "Open Settings"
    static let notNow = "Not now"
    static let uploadTitle = "Upload the audio?"
    static let uploadAudio = "Upload audio"
    static let lyricsUploadBody = "FinalCap will upload this video's audio, but not the picture, to transcribe it, look up the song's lyrics, and translate them. The audio is deleted after transcription."

    static let serverCaptionsMessage = "Captions need to upload this video's audio to transcribe it. Upload and continue?"
    static let serverCaptionsTitle = "Upload this video's audio?"
    static let upload = "Upload"

    // Friendly failure copy (nothing applied). Never raw server text.
    static let unavailable = "Translated captions aren't available right now. Try again later."
    static let noSpeech = "No speech found in this video."
    static let tooLong = "This video's audio is too long for translated captions. Try a clip under 10 minutes."
    static let couldntFinish = "Captions couldn't finish. Nothing was changed. Try again."
    static let noAudio = "This video has no sound to caption."
    /// Kept for older call sites: same as `couldntFinish`.
    static let modelError = couldntFinish
    static let generic = couldntFinish

    static func speechUploadBody(target: String) -> String {
        "FinalCap will upload this video's audio, but not the picture, to transcribe it and translate it into \(target). The audio is deleted after transcription."
    }

    static func speechCloudOffBody(target: String) -> String {
        speechUploadBody(target: target) + " Turn on Cloud processing to use translated captions."
    }

    /// Cloud processing is off: nothing is sent.
    static func cloudOffPrompt(mode: LyricMode, targetLanguage: String) -> CloudPrompt {
        if mode == .speech {
            return CloudPrompt(kind: .openSettings, title: speechCloudOffTitle,
                               message: speechCloudOffBody(target: targetName(targetLanguage)),
                               primary: openSettings, secondary: notNow)
        }
        return CloudPrompt(kind: .openSettings, title: cloudOffTitle, message: cloudOffBody,
                           primary: openSettings, secondary: notNow)
    }

    /// Cloud processing is on: asked every time.
    static func uploadPrompt(mode: LyricMode, targetLanguage: String) -> CloudPrompt {
        let body = mode == .speech ? speechUploadBody(target: targetName(targetLanguage)) : lyricsUploadBody
        return CloudPrompt(kind: .upload, title: uploadTitle, message: body, primary: uploadAudio, secondary: notNow)
    }

    /// Server `generate_captions` / translate on the Cloud-ON path.
    static var serverCaptionsPrompt: CloudPrompt {
        CloudPrompt(kind: .upload, title: serverCaptionsTitle, message: serverCaptionsMessage, primary: upload, secondary: notNow)
    }

    /// Job `progress` (0.2 decoded → 0.5 transcribed → 0.9 corrected → 1).
    static func progressText(progress: Double?, mode: LyricMode, uploadFinished: Bool) -> String {
        guard uploadFinished else { return uploadingAudio }
        if (progress ?? 0) < 0.5 { return listening }
        return mode == .speech ? checkingWords : findingLyrics
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

    /// Chat copy for an error `code` (HTTP body or failed job) and/or HTTP status.
    static func failureCopy(code: String?, status: Int? = nil) -> String {
        switch code?.lowercased() {
        case "lyric_captions_unavailable": return unavailable
        case "no_speech": return noSpeech
        case "audio_too_long", "audio_too_large": return tooLong
        case "no_audio": return noAudio
        default:
            if status == 503 { return unavailable }
            if status == 413 { return tooLong }
            if status == 422 { return noSpeech }
            // Job not found, poll/network failure, model error, unknown error.
            return couldntFinish
        }
    }
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
