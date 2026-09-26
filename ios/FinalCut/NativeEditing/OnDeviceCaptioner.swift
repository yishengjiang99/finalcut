import AVFoundation
import Foundation
import Speech

/// Transcribes the edited clip's audio into timed words. Swappable for tests.
protocol CaptionTranscribing: Sendable {
    func transcribe(_ composed: ComposedVideo, language: String?) async throws -> CaptionTranscript
}

struct CaptionTranscript: Equatable, Sendable {
    var words: [TimedWord]
    /// BCP-47 identifier of the recognizer locale.
    var language: String
}

/// On-device captions for `generate_captions`: SpeechAnalyzer on iOS 26+, otherwise
/// SFSpeechRecognizer with `requiresOnDeviceRecognition`. Audio never leaves the iPhone
/// and there is no server fallback.
struct OnDeviceCaptioner: CaptionTranscribing {
    enum Failure: Error, Equatable {
        case notAuthorized
        case unavailable
        case failed
    }

    func transcribe(_ composed: ComposedVideo, language: String?) async throws -> CaptionTranscript {
        let audio = try await Self.exportAudio(composed)
        defer { try? FileManager.default.removeItem(at: audio) }
        let locale = Self.locale(for: language)

        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            if let transcript = try? await SpeechAnalyzerCaptioner.transcribe(url: audio, locale: locale) {
                return transcript
            }
        }
        #endif
        return try await Self.recognizerTranscribe(url: audio, locale: locale)
    }

    /// `language` from the tool call ("es", "Spanish", "en-US"); nil → the device language.
    static func locale(for language: String?) -> Locale {
        guard let raw = language?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return .current }
        let names: [String: String] = [
            "english": "en-US", "spanish": "es-ES", "french": "fr-FR", "german": "de-DE", "italian": "it-IT",
            "portuguese": "pt-BR", "japanese": "ja-JP", "korean": "ko-KR", "chinese": "zh-CN", "mandarin": "zh-CN",
        ]
        return Locale(identifier: names[raw.lowercased()] ?? raw.replacingOccurrences(of: "_", with: "-"))
    }

    /// The edited timeline's audio (trims, speed, volume, fades) as an m4a file.
    static func exportAudio(_ composed: ComposedVideo) async throws -> URL {
        guard let session = AVAssetExportSession(asset: composed.asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw Failure.failed
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("captions-\(UUID().uuidString).m4a")
        session.outputURL = url
        session.outputFileType = .m4a
        session.audioMix = composed.audioMix
        session.audioTimePitchAlgorithm = .spectral
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        guard session.status == .completed else { throw Failure.failed }
        return url
    }

    // MARK: - SFSpeechRecognizer (iOS 17–25, and fallback)

    static func recognizerTranscribe(url: URL, locale: Locale) async throws -> CaptionTranscript {
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw Failure.notAuthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            throw Failure.unavailable
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.taskHint = .dictation

        let holder = RecognitionHolder()
        let words: [TimedWord] = try await withCheckedThrowingContinuation { continuation in
            holder.continuation = continuation
            holder.task = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    let words = result.bestTranscription.segments.map {
                        TimedWord(text: $0.substring, start: $0.timestamp, duration: $0.duration)
                    }
                    holder.finish(.success(words))
                } else if let error {
                    // "No speech detected" is an empty transcript, not a failure.
                    let ns = error as NSError
                    if ns.code == 1110 || ns.code == 203 {
                        holder.finish(.success([]))
                    } else {
                        holder.finish(.failure(Failure.failed))
                    }
                }
            }
        }
        return CaptionTranscript(words: words, language: recognizer.locale.identifier)
    }
}

/// Resumes the continuation exactly once and keeps the task alive until then.
private final class RecognitionHolder: @unchecked Sendable {
    private let lock = NSLock()
    var continuation: CheckedContinuation<[TimedWord], Error>?
    var task: SFSpeechRecognitionTask?

    func finish(_ result: Result<[TimedWord], Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
        task = nil
    }
}

#if compiler(>=6.2)
/// iOS 26 SpeechAnalyzer + SpeechTranscriber (on-device models; downloads the locale's
/// model on first use). Returns nil when the locale isn't supported so the caller can
/// fall back to SFSpeechRecognizer.
@available(iOS 26.0, *)
enum SpeechAnalyzerCaptioner {
    static func transcribe(url: URL, locale: Locale) async throws -> CaptionTranscript? {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { return nil }
        let transcriber = SpeechTranscriber(
            locale: supported,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange]
        )
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await install.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let file = try AVAudioFile(forReading: url)

        let collector = Task { () throws -> [TimedWord] in
            var words: [TimedWord] = []
            for try await result in transcriber.results {
                let text = result.text
                for run in text.runs {
                    guard let range = run.audioTimeRange else { continue }
                    let piece = String(text[run.range].characters)
                    words.append(contentsOf: split(piece, start: range.start.seconds, duration: range.duration.seconds))
                }
            }
            return words
        }
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let words = try await collector.value
        return CaptionTranscript(words: words, language: supported.identifier)
    }

    /// A timed run can hold several words: spread its time across them.
    static func split(_ piece: String, start: Double, duration: Double) -> [TimedWord] {
        let tokens = piece.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !tokens.isEmpty, start.isFinite else { return [] }
        let each = (duration.isFinite ? duration : 0) / Double(tokens.count)
        return tokens.enumerated().map { TimedWord(text: $1, start: start + each * Double($0), duration: each) }
    }
}
#endif
