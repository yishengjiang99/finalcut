import Foundation
import UniformTypeIdentifiers

/// MIME type ↔ file extension helpers for uploads and job results.
/// Uploads must carry the real type of the picked item (never a blanket `video/mp4`),
/// and results are saved with the extension the server's content type implies.
enum MediaMIME {
    private static let mimeByExtension: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png",
        "heic": "image/heic", "heif": "image/heif",
        "webp": "image/webp", "gif": "image/gif",
        "mov": "video/quicktime", "qt": "video/quicktime",
        "mp4": "video/mp4", "m4v": "video/x-m4v",
        "webm": "video/webm", "mkv": "video/x-matroska", "avi": "video/x-msvideo",
        "flv": "video/x-flv", "ogv": "video/ogg",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac",
        "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac",
    ]

    private static let extensionByMIME: [String: String] = [
        "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
        "image/png": "png",
        "image/heic": "heic", "image/heif": "heif",
        "image/webp": "webp", "image/gif": "gif",
        "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v",
        "video/webm": "webm", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
        "video/x-flv": "flv", "video/ogg": "ogv",
        "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
        "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/ogg": "ogg", "audio/flac": "flac", "audio/x-ms-wma": "wma",
    ]

    /// MIME type for a file extension (case-insensitive). Unknown → UTType lookup → octet-stream.
    static func mimeType(forExtension ext: String) -> String {
        let lower = ext.lowercased()
        if let known = mimeByExtension[lower] { return known }
        if let type = UTType(filenameExtension: lower), let mime = type.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }

    static func mimeType(for url: URL) -> String {
        mimeType(forExtension: url.pathExtension)
    }

    /// MIME type for a picked item's content type (e.g. from PhotosPicker / Transferable).
    static func mimeType(for contentType: UTType) -> String {
        if let ext = contentType.preferredFilenameExtension, let known = mimeByExtension[ext.lowercased()] {
            return known
        }
        return contentType.preferredMIMEType ?? "application/octet-stream"
    }

    /// File extension for a result, from `Content-Type` (params ignored) or job `mediaType`.
    /// Falls back to `jpg` for `mediaType == "image"` and `mp4` otherwise.
    static func fileExtension(forContentType contentType: String?, mediaType: String? = nil) -> String {
        if let contentType {
            let bare = contentType.split(separator: ";").first.map {
                $0.trimmingCharacters(in: .whitespaces).lowercased()
            } ?? ""
            if let known = extensionByMIME[bare] { return known }
            if !bare.isEmpty, bare != "application/octet-stream",
               let type = UTType(mimeType: bare), let ext = type.preferredFilenameExtension {
                return ext.lowercased()
            }
        }
        if mediaType?.lowercased() == "image" { return "jpg" }
        if mediaType?.lowercased() == "audio" { return "m4a" }
        return "mp4"
    }

    static func isImage(url: URL) -> Bool {
        isImage(extension: url.pathExtension)
    }

    static func isImage(extension ext: String) -> Bool {
        mimeType(forExtension: ext).hasPrefix("image/")
    }

    /// Keeps `source`'s filename when its extension already matches `contentType`;
    /// otherwise swaps in the content type's preferred extension so name and MIME agree.
    static func filename(for source: URL, contentType: UTType) -> String {
        let ext = source.pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext.lowercased()), type.conforms(to: contentType) {
            return source.lastPathComponent
        }
        let base = source.deletingPathExtension().lastPathComponent
        let newExt = contentType.preferredFilenameExtension ?? (contentType.conforms(to: .image) ? "jpg" : "mov")
        return "\(base.isEmpty ? "media" : base).\(newExt)"
    }
}
