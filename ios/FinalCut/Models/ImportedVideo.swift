import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A video or photo owned by the app, independent of the picker/provider's temporary access.
/// Photos are normalised on import (HEIC/HEIF → upright JPEG, see `PhotoTranscoder`) so the
/// preview, chat metadata and every upload use a format the server can read.
struct ImportedVideo: Transferable, Sendable {
    let url: URL

    var isPhoto: Bool { MediaMIME.isImage(url: url) }

    /// Real MIME type of the imported file (derived from its extension, which is kept
    /// consistent with the transferred content type).
    var mimeType: String { MediaMIME.mimeType(for: url) }

    static var transferRepresentation: some TransferRepresentation {
        // Most specific first so the saved extension matches the real container.
        FileRepresentation(importedContentType: .quickTimeMovie) { received in
            try copy(from: received.file, contentType: .quickTimeMovie)
        }
        FileRepresentation(importedContentType: .mpeg4Movie) { received in
            try copy(from: received.file, contentType: .mpeg4Movie)
        }
        FileRepresentation(importedContentType: .movie) { received in
            // Photos only guarantees this file exists during the transfer closure.
            try copy(from: received.file, contentType: .movie)
        }
        // Photos: keep the real type (heic/jpeg/png/…), then normalise below.
        FileRepresentation(importedContentType: .image) { received in
            let type = UTType(filenameExtension: received.file.pathExtension.lowercased()) ?? .image
            return try copy(from: received.file, contentType: type.conforms(to: .image) ? type : .image)
        }
    }

    static func copy(from source: URL, contentType: UTType? = nil) throws -> ImportedVideo {
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }

        // Preserve the filename/container type without collisions between imports.
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ImportedVideos", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = contentType.map { MediaMIME.filename(for: source, contentType: $0) } ?? source.lastPathComponent
        let destination = directory.appendingPathComponent(name)
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            if MediaMIME.isImage(url: destination) || (contentType?.conforms(to: .image) ?? false) {
                // Never keep (or later upload) HEIC; bake orientation into the pixels.
                return ImportedVideo(url: try PhotoTranscoder.normalizedPhoto(at: destination))
            }
            return ImportedVideo(url: destination)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }
}
