import Foundation

/// Editor lifecycle states (Design).
enum EditorState: String, Codable, CaseIterable, Equatable {
    case empty
    case uploading
    case ready
    case processing
    case failed
}

/// Dimmer copy during `processing` (Design UX — captions three-step flow).
enum ProcessingOverlayKind: String, Codable, CaseIterable, Equatable {
    case editing
    case generatingCaptions
    case translating
    case burningSubtitles

    /// User-visible overlay string. Burn-in uses a specific label (not generic “Editing”).
    var message: String {
        switch self {
        case .editing:
            return "Editing…"
        case .generatingCaptions:
            return "Generating captions…"
        case .translating:
            return "Translating…"
        case .burningSubtitles:
            return "Burning subtitles…"
        }
    }
}

/// Soft caption artifacts retained for share/export chips and burn-in args.
struct CaptionArtifacts: Equatable, Codable {
    var srt: String?
    var vtt: String?
    var language: String?
    var translatedSrt: String?
    var translatedVtt: String?
    var targetLanguage: String?

    var hasSource: Bool { srt?.isEmpty == false }
    var hasTranslation: Bool { translatedSrt?.isEmpty == false }
}

/// Async jobs poll API status (Backend #47).
/// Editor stays `.processing` for `queued` | `running`; flips only on terminal.
enum JobStatus: String, Codable, CaseIterable, Equatable {
    case queued
    case running
    case succeeded
    case failed

    var isTerminal: Bool {
        switch self {
        case .succeeded, .failed: return true
        case .queued, .running: return false
        }
    }

    /// Maps job poll status → editor UI state. Non-terminal keeps the dimmer.
    var editorState: EditorState {
        switch self {
        case .queued, .running: return .processing
        case .succeeded: return .ready
        case .failed: return .failed
        }
    }
}
