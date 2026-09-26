import Foundation

/// Editor lifecycle states (Design).
/// `importing` = loading from Photos/Files/camera into the app (on device). `uploading` is
/// only ever used by the opt-in Cloud processing path; with it off nothing is uploaded and the
/// word never appears.
enum EditorState: String, Codable, CaseIterable, Equatable {
    case empty
    case importing
    case uploading
    case ready
    case processing
    case failed

    /// Import, cloud upload or an edit turn is running.
    var isBusy: Bool { self == .importing || self == .uploading || self == .processing }

    /// Preview/status copy while media moves (nil otherwise).
    var transferMessage: String? {
        switch self {
        case .importing: return UXCopy.importing
        case .uploading: return UXCopy.cloudUploading
        default: return nil
        }
    }
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
            return UXCopy.applyingEdit
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
