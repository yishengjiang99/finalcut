import Foundation

/// Editor lifecycle states (Design).
enum EditorState: String, Codable, CaseIterable, Equatable {
    case empty
    case uploading
    case ready
    case processing
    case failed
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
