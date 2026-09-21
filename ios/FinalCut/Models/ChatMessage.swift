import Foundation

struct CaptionDownloadChip: Identifiable, Equatable, Codable {
    var id: UUID
    /// Button label shown under the assistant bubble (e.g. "SRT", "VTT", "ES SRT").
    var label: String
    var filename: String
    /// Caption text content for share / export (soft chips — not burned video).
    var content: String

    init(
        id: UUID = UUID(),
        label: String,
        filename: String,
        content: String
    ) {
        self.id = id
        self.label = label
        self.filename = filename
        self.content = content
    }
}

struct ChatMessage: Identifiable, Equatable, Codable {
    enum Role: String, Codable {
        case user
        case assistant
        case system
        case tool
    }

    var id: UUID
    var role: Role
    var content: String
    /// Optional local thumbnails for inline result previews.
    var resultThumbnailURLs: [URL]
    /// Soft VTT/SRT download chips under assistant bubbles (captions flow).
    var downloadChips: [CaptionDownloadChip]

    init(
        id: UUID = UUID(),
        role: Role,
        content: String,
        resultThumbnailURLs: [URL] = [],
        downloadChips: [CaptionDownloadChip] = []
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.resultThumbnailURLs = resultThumbnailURLs
        self.downloadChips = downloadChips
    }
}
