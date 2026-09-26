import Foundation

/// One caption line on the edited timeline (seconds).
struct CaptionCue: Equatable, Sendable, Codable {
    var start: Double
    var end: Double
    var text: String
}

/// A recognised word with its time on the audio that was transcribed.
struct TimedWord: Equatable, Sendable {
    var text: String
    var start: Double
    var duration: Double
    var end: Double { start + duration }
}

/// Groups words into readable cues and writes SRT / WebVTT.
enum CaptionFormatter {
    static let maxCharacters = 42
    static let maxCueDuration = 5.0
    /// A pause this long starts a new cue.
    static let pauseBreak = 0.8
    static let minCueDuration = 0.7

    static func cues(from words: [TimedWord]) -> [CaptionCue] {
        var cues: [CaptionCue] = []
        var current: [TimedWord] = []

        func flush() {
            guard let first = current.first, let last = current.last else { return }
            let text = current.map(\.text).joined(separator: " ")
                .replacingOccurrences(of: " ,", with: ",")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                cues.append(CaptionCue(start: first.start, end: max(last.end, first.start + minCueDuration), text: text))
            }
            current = []
        }

        for word in words {
            let token = word.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty else { continue }
            let clean = TimedWord(text: token, start: word.start, duration: max(0, word.duration))
            if let first = current.first, let last = current.last {
                let length = current.map(\.text.count).reduce(0, +) + current.count + token.count
                let pause = clean.start - last.end
                let sentenceEnded = last.text.last.map { ".?!".contains($0) } ?? false
                if length > maxCharacters || clean.end - first.start > maxCueDuration || pause >= pauseBreak || sentenceEnded {
                    flush()
                }
            }
            current.append(clean)
        }
        flush()

        // Never overlap: a cue ends when the next one starts.
        for i in cues.indices.dropLast() where cues[i].end > cues[i + 1].start {
            cues[i].end = max(cues[i].start + 0.05, cues[i + 1].start)
        }
        return cues
    }

    static func srt(_ cues: [CaptionCue]) -> String {
        cues.enumerated().map { index, cue in
            "\(index + 1)\n\(timestamp(cue.start, separator: ",")) --> \(timestamp(cue.end, separator: ","))\n\(cue.text)\n"
        }.joined(separator: "\n")
    }

    static func vtt(_ cues: [CaptionCue]) -> String {
        let body = cues.map { cue in
            "\(timestamp(cue.start, separator: ".")) --> \(timestamp(cue.end, separator: "."))\n\(cue.text)\n"
        }.joined(separator: "\n")
        return "WEBVTT\n\n" + body
    }

    /// `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
    static func timestamp(_ seconds: Double, separator: String) -> String {
        let totalMs = Int((max(0, seconds) * 1000).rounded())
        let ms = totalMs % 1000
        let s = (totalMs / 1000) % 60
        let m = (totalMs / 60_000) % 60
        let h = totalMs / 3_600_000
        return String(format: "%02d:%02d:%02d%@%03d", h, m, s, separator, ms)
    }

    /// Cue active at `time`, if any.
    static func cue(at time: Double, in cues: [CaptionCue]) -> Int? {
        cues.firstIndex { time >= $0.start && time < $0.end }
    }

    /// Cues after a later trim (shift + drop outside the range) on the edited timeline.
    static func trimmed(_ cues: [CaptionCue], start: Double, end: Double) -> [CaptionCue] {
        cues.compactMap { cue in
            let s = max(cue.start, start), e = min(cue.end, end)
            guard e - s > 0.05 else { return nil }
            return CaptionCue(start: s - start, end: e - start, text: cue.text)
        }
    }

    /// Cues after a later speed change.
    static func sped(_ cues: [CaptionCue], factor: Double) -> [CaptionCue] {
        guard factor > 0 else { return cues }
        return cues.map { CaptionCue(start: $0.start / factor, end: $0.end / factor, text: $0.text) }
    }
}
