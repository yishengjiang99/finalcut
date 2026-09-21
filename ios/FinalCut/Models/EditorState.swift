import Foundation

/// Editor lifecycle states (Design).
enum EditorState: String, Codable, CaseIterable, Equatable {
    case empty
    case uploading
    case ready
    case processing
    case failed
}

/// Future poll API job status (Backend).
enum JobStatus: String, Codable, CaseIterable, Equatable {
    case queued
    case running
    case succeeded
    case failed
}
