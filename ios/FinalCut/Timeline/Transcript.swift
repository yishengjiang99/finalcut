import Foundation

// Phase 2 (#125): the visible chat transcript, persisted per project to
// `Projects/<project-id>/transcript.json` (next to project.json and
// wire-turns.json). Display-only: the model context lives in wire-turns.json.

/// One saved display message. `ChatMessage` stores absolute thumbnail URLs,
/// which break after a tmp purge or a container-path change, so thumbnails are
/// stored project-relative (ones outside the project directory are dropped).
struct StoredChatMessage: Codable, Equatable {
    var id: UUID
    var role: ChatMessage.Role
    var content: String
    var thumbnailPaths: [String] = []
    var downloadChips: [CaptionDownloadChip] = []
    var failureCard: EditFailureCard?
}

/// On-disk form of `transcript.json`.
struct TranscriptFile: Codable, Equatable {
    static let currentVersion = 1
    var version: Int
    var messages: [StoredChatMessage]
}

/// Persistence for a project's display transcript. Like `WireTurnStore`, saving
/// is best-effort and a missing, corrupt, or newer-version file loads as nil,
/// so projects saved before this existed simply reopen with an empty chat.
enum TranscriptStore {
    static let fileName = "transcript.json"

    static func fileURL(_ projectID: UUID) -> URL {
        ProjectStore.projectDirectory(projectID).appendingPathComponent(fileName)
    }

    /// Messages worth keeping: session status lines (`.system`, e.g. "Opened …",
    /// "New project …") are regenerated per session and never saved.
    static func persistable(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter { $0.role != .system }
    }

    static func stored(_ messages: [ChatMessage], projectDirectory: URL) -> [StoredChatMessage] {
        let root = projectDirectory.standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return persistable(messages).map { message in
            let paths = message.resultThumbnailURLs.compactMap { url -> String? in
                let path = url.standardizedFileURL.path
                return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
            }
            return StoredChatMessage(id: message.id, role: message.role, content: message.content,
                                     thumbnailPaths: paths, downloadChips: message.downloadChips,
                                     failureCard: message.failureCard)
        }
    }

    static func chatMessages(_ stored: [StoredChatMessage], projectDirectory: URL) -> [ChatMessage] {
        stored.map { item in
            ChatMessage(id: item.id, role: item.role, content: item.content,
                        resultThumbnailURLs: item.thumbnailPaths.map { projectDirectory.appendingPathComponent($0) },
                        downloadChips: item.downloadChips, failureCard: item.failureCard)
        }
    }

    /// Writes the transcript only when the project directory already exists, so
    /// a late save can never resurrect a deleted project's folder.
    static func save(_ messages: [ChatMessage], projectID: UUID) {
        let dir = ProjectStore.projectDirectory(projectID)
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        let file = TranscriptFile(version: TranscriptFile.currentVersion,
                                  messages: stored(messages, projectDirectory: dir))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        guard let data = try? encoder.encode(file) else { return }
        try? data.write(to: fileURL(projectID), options: [.atomic])
    }

    static func load(projectID: UUID) -> [ChatMessage]? {
        guard let data = try? Data(contentsOf: fileURL(projectID)),
              let file = try? JSONDecoder().decode(TranscriptFile.self, from: data),
              file.version <= TranscriptFile.currentVersion else { return nil }
        return chatMessages(file.messages, projectDirectory: ProjectStore.projectDirectory(projectID))
    }
}
