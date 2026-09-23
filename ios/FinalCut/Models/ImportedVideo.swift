import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A video owned by the app, independent of the picker/provider's temporary access.
struct ImportedVideo: Transferable, Sendable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            // Photos only guarantees this file exists during the transfer closure.
            try copy(from: received.file)
        }
    }

    static func copy(from source: URL) throws -> ImportedVideo {
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }

        // Preserve the filename/container type without collisions between imports.
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ImportedVideos", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(source.lastPathComponent)
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            return ImportedVideo(url: destination)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }
}
