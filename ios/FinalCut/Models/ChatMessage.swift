import Foundation

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

    init(
        id: UUID = UUID(),
        role: Role,
        content: String,
        resultThumbnailURLs: [URL] = []
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.resultThumbnailURLs = resultThumbnailURLs
    }
}
