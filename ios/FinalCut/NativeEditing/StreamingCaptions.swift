import Foundation

// Streaming captions (docs/api/STREAMING_CAPTIONS.md): the edited clip's audio is decoded on the
// device to 16 kHz mono PCM and streamed straight to ElevenLabs realtime speech-to-text over a
// WebSocket; the committed text goes to FinalCap (`/api/streaming-captions/translate`) to be
// translated. Only audio leaves the device, never the picture. This file is the pure part
// (models, commit planning, line building, percent, copy); the engine drives the flow.

enum StreamingConstants {
    static let sampleRate = 16_000
    static let maxAudioSeconds = 600.0
    /// 0.5 s chunks (16,000 bytes).
    static let chunkSamples = 8_000
    /// Commit points sit on a 0.1 s grid so no chunk is shorter than 0.1 s.
    static let gridSamples = 1_600
    static let commitMinSec = 20.0
    static let commitMaxSec = 30.0
    static let translateBatch = 20
    static let contextLines = 4
    static let percentCap = 99
    /// Percent once the audio is decoded and the commit points are planned.
    static let prepPercent = 5
    static let defaultPace = 4.0
    static let paceRange = 0.5...4.0
    static let stallSeconds = 20.0
    static let idleTimeoutSeconds = 30.0
    static let connectTimeoutSeconds = 15.0
    static let autoResumes = 3
    static let resumeBackoff: [Double] = [0.5, 1.5, 3]
}

// MARK: - Errors

/// A failure of the streaming flow, from the server or the socket. `code` is the stable server
/// code (or one of ours: `network`, `stalled`, `audio_too_long`, `no_audio`, `no_speech`, `busy`,
/// `unavailable`, `paywall`, `ranges_failed`, `declined_continue`).
struct StreamingError: Error, Equatable {
    var code: String
    var status: Int? = nil
    var message: String? = nil
    var retryable = false
    /// What was finished when the flow stopped (kept, not applied).
    var keptLineCount = 0
    var atSec: Double? = nil
}

// MARK: - Models

struct StreamingToken: Decodable, Equatable {
    var token: String
    var sessionId: String?
    var wsUrl: String
    var query: [String: String]
    var sampleRate: Int?
    var maxAudioSeconds: Double?

    /// `wsUrl?<query>&token=<token>`; the token is minted right before connecting.
    var socketURL: URL? {
        guard var components = URLComponents(string: wsUrl) else { return nil }
        var items = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        items.append(URLQueryItem(name: "token", value: token))
        components.queryItems = items
        return components.url
    }
}

struct StreamingSegment: Equatable, Sendable {
    var i: Int
    var start: Double
    var end: Double
    var text: String
}

struct StreamingTranslated: Equatable, Sendable, Decodable {
    var i: Int
    var text: String?
    var translation: String?
}

struct StreamingTranslateResponse: Equatable, Decodable {
    var lines: [StreamingTranslated]
    var language: String?
    var targetLanguage: String?
}

/// One caption line with its translation (timeline seconds).
struct StreamingLine: Equatable, Sendable {
    var start: Double
    var end: Double
    var text: String
    var translation: String
}

struct TimedWordText: Equatable, Sendable {
    var w: String
    var start: Double
    var end: Double
}

struct ElevenWord: Equatable, Sendable {
    var text: String
    var start: Double
    var end: Double
    var type: String?
}

// MARK: - Commit planning

enum CommitPlanner {
    /// Where to commit: about every 20–30 s, at the quietest 50 ms window in that span, on a 0.1 s
    /// grid. Increasing sample indexes; the last one is always the end of the audio.
    static func points(_ pcm: [Int16], minSec: Double = StreamingConstants.commitMinSec,
                       maxSec: Double = StreamingConstants.commitMaxSec,
                       sampleRate: Int = StreamingConstants.sampleRate) -> [Int] {
        let total = pcm.count
        let win = Int((Double(sampleRate) * 0.05).rounded())
        var result: [Int] = []
        var cursor = 0
        while total - cursor > Int((maxSec * Double(sampleRate)).rounded()) {
            let lo = cursor + Int((minSec * Double(sampleRate)).rounded())
            let hi = cursor + Int((maxSec * Double(sampleRate)).rounded())
            var best = Double.infinity
            var windows: [(at: Int, energy: Double)] = []
            var at = lo
            while at + win <= hi {
                var energy = 0.0
                for i in at..<(at + win) { let s = Double(pcm[i]); energy += s * s }
                windows.append((at, energy))
                if energy < best { best = energy }
                at += win
            }
            // The quietest window wins; a run of equally quiet ones (digital silence) is cut in the middle.
            let quiet = windows.filter { $0.energy <= best }.map(\.at)
            let pick = quiet[quiet.count / 2]
            let grid = StreamingConstants.gridSamples
            let snapped = Int(((Double(pick) + Double(win) / 2) / Double(grid)).rounded()) * grid
            let cut = min(hi, snapped)
            result.append(cut)
            cursor = cut
        }
        result.append(total)
        return result
    }
}

// MARK: - Line building (port of src/lyricShared.js buildLines for one segment)

enum StreamingLines {
    static func isCJK(_ s: String) -> Bool {
        s.unicodeScalars.contains { u in
            let v = u.value
            return (0x3040...0x30ff).contains(v) || (0x3400...0x4dbf).contains(v) || (0x4e00...0x9fff).contains(v)
                || (0xac00...0xd7af).contains(v) || (0xf900...0xfaff).contains(v) || (0xff00...0xffef).contains(v)
        }
    }

    private static let sentenceEnd: Set<Character> = [".", "!", "?", "。", "！", "？", "…"]
    private static let clauseEnd: Set<Character> = [".", "!", "?", "。", "！", "？", "…", ",", ";", ":", "，", "；", "：", "、"]
    private static let attachLeft: Set<Character> = [",", ".", "!", "?", ";", ":", "，", "。", "！", "？", "、", "；", "：", ")"]

    static func join(_ words: [TimedWordText]) -> String {
        var out = ""
        for word in words {
            let t = word.w.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = t.first else { continue }
            if let last = out.last, !(isCJK(String(last)) && isCJK(String(first))), !attachLeft.contains(first) { out += " " }
            out += t
        }
        return out
    }

    /// Caption lines from one transcribed segment: split at pauses over 1.2 s, after sentence ends,
    /// and before a line passes ~42 Latin / ~18 CJK characters (preferring the last clause break);
    /// each line is on screen at least 0.8 s without overlapping the next.
    static func build(text: String, start: Double, end: Double, words: [TimedWordText], maxGap: Double = 1.2) -> [(start: Double, end: Double, text: String)] {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen: [TimedWordText] = []
        for w in words where w.start.isFinite && w.end.isFinite && !w.w.trimmingCharacters(in: .whitespaces).isEmpty {
            if let prev = seen.last, prev == w { continue }
            seen.append(w)
        }
        var lines: [(start: Double, end: Double, text: String)] = []
        if seen.isEmpty {
            if !clean.isEmpty { lines.append((start, end, clean)) }
        } else {
            let limit = isCJK(clean) ? 18 : 42
            let minSentence = Int((Double(limit) * 0.3).rounded())
            var groups: [[TimedWordText]] = []
            var cur: [TimedWordText] = []
            for w in seen {
                if let prev = cur.last, w.start - prev.end > maxGap {
                    groups.append(cur); cur = []
                } else if cur.last != nil, join(cur + [w]).count > limit {
                    var k = -1
                    if cur.count >= 2 {
                        for j in stride(from: cur.count - 2, through: 0, by: -1) {
                            if let c = cur[j].w.trimmingCharacters(in: .whitespaces).last, clauseEnd.contains(c) { k = j; break }
                        }
                    }
                    if k >= 0 {
                        groups.append(Array(cur[0...k]))
                        cur = Array(cur[(k + 1)...])
                    } else {
                        groups.append(cur); cur = []
                    }
                }
                cur.append(w)
                if let c = w.w.trimmingCharacters(in: .whitespaces).last, sentenceEnd.contains(c), join(cur).count >= minSentence {
                    groups.append(cur); cur = []
                }
            }
            if !cur.isEmpty { groups.append(cur) }
            for g in groups {
                lines.append((g[0].start, g[g.count - 1].end, groups.count == 1 ? (clean.isEmpty ? join(g) : clean) : join(g)))
            }
        }
        lines.sort { $0.start < $1.start }
        for i in lines.indices {
            var e = max(lines[i].end, lines[i].start + 0.8)
            if i + 1 < lines.count { e = min(e, lines[i + 1].start) }
            lines[i].end = max(e, lines[i].start + 0.05)
        }
        return lines
    }

    /// Map ElevenLabs word timestamps to absolute seconds. In a normal session they are relative to
    /// the whole audio; in a resumed session (a new socket starting at second N) they are relative
    /// to that socket's start, so N is added. Segment-relative times (before the range's own start)
    /// are detected the same way as the web client.
    static func offsetWords(_ words: [ElevenWord], sessionStartSec: Double, rangeStartInSession: Double, rangeStartAbs: Double) -> [TimedWordText] {
        let real = words.filter { ($0.type == nil || $0.type == "word") && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty && $0.start.isFinite && $0.end.isFinite }
        guard let first = real.map(\.start).min() else { return [] }
        let relative = rangeStartInSession > 1 && first < rangeStartInSession - 0.75
        let base = relative ? rangeStartAbs : sessionStartSec
        return real.map { TimedWordText(w: $0.text.trimmingCharacters(in: .whitespaces), start: base + $0.start, end: base + $0.end) }
    }
}

// MARK: - Percent and stages

enum StreamingStage: String, Equatable, Sendable {
    case connecting, listening, translating
}

enum StreamingPercent {
    /// 5 once the audio is decoded; then 5 + floor(94 × (½ × sent/total + ½ × transcribed-and-translated/total)).
    /// Never above 99: 100 is shown only after the overlay is ready.
    static func value(sentSec: Double, doneSec: Double, totalSec: Double) -> Int {
        guard totalSec > 0 else { return StreamingConstants.prepPercent }
        let sent = min(1, max(0, sentSec / totalSec))
        let done = min(1, max(0, doneSec / totalSec))
        let span = Double(100 - StreamingConstants.prepPercent - 1)
        return min(StreamingConstants.percentCap, StreamingConstants.prepPercent + Int((span * (0.5 * sent + 0.5 * done) + 1e-9).rounded(.down)))
    }

    static func text(stage: StreamingStage, percent: Int?) -> String {
        let base: String
        switch stage {
        case .connecting: base = StreamingCopy.connecting
        case .listening: base = StreamingCopy.listening
        case .translating: base = StreamingCopy.translating
        }
        guard let percent else { return base }
        return "\(base) \(min(StreamingConstants.percentCap, max(0, percent)))%"
    }
}

struct StreamingProgress: Equatable {
    var percent: Int
    var stage: StreamingStage
    var text: String
    var coveredEnd: Double
    var lineCount: Int
}

// MARK: - Copy

enum StreamingCopy {
    static let connecting = "Connecting…"
    static let listening = "Listening to the audio…"
    static let translating = "Translating…"
    static let addingCaptions = "Adding captions…"

    static let couldntFinish = "Captions couldn't finish. Nothing was changed. Try again."
    static let stalled = "Captions stopped making progress. Nothing was changed. Try again."
    static let restarted = "Captions couldn't finish because the service restarted. Nothing was changed. Try again."
    static let busy = "The transcription service is busy. Try again in a moment."
    static let tooLong = "This video's audio is too long for translated captions. Try a clip under 10 minutes."
    static let unavailable = "Translated captions aren't available right now. Try again later."
    static let noSpeech = "No speech found in this video."
    static let noAudio = "This video has no sound to caption."
    static let continueTitle = "Connection dropped"
    static let continueButton = "Continue"
    static let cancelButton = "Cancel"

    static func clock(_ sec: Double) -> String {
        let s = max(0, Int(sec.rounded(.down)))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    static func connectionDropped(at sec: Double) -> String {
        "The connection dropped at \(clock(sec)). Captions up to there are kept."
    }

    static func timeLimit(at sec: Double) -> String {
        "The transcription session reached its time limit at \(clock(sec)). Captions up to there are kept."
    }

    /// One short message for any failure of the streaming flow (never raw server text).
    static func friendly(_ error: StreamingError) -> String {
        switch error.code {
        case "declined_continue":
            return error.message ?? couldntFinish
        case "stalled": return stalled
        case "job_lost", "job_expired": return restarted
        case "audio_too_long", "audio_too_large": return tooLong
        case "no_audio": return noAudio
        case "no_speech": return noSpeech
        case "busy", "streaming_captions_busy", "rate_limited": return busy
        case "streaming_captions_unavailable", "lyric_captions_unavailable", "unavailable": return unavailable
        default:
            if error.status == 413, error.code != "batch_too_large" { return tooLong }
            if error.status == 429 { return busy }
            if error.status == 503 { return unavailable }
            return couldntFinish
        }
    }
}
