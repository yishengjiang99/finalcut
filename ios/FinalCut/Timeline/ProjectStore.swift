import AVFoundation
import CryptoKit
import Foundation

/// Durable project storage:
///
///   Application Support/Projects/<project-id>/project.json
///   Application Support/Projects/<project-id>/Media/<asset-id>.<ext>
///
/// Project JSON is written atomically; media is copied atomically (temp file + move) with
/// a free-space check first. A saved project never points at the system temporary
/// directory, so iOS cannot delete its media from under it.
enum ProjectStore {
    enum StoreError: Error, Equatable {
        case insufficientSpace(needed: Int64, free: Int64)
        case unreadableProject
        case copyFailed
    }

    /// Injectable for tests; production uses Application Support.
    static var baseDirectoryOverride: URL?

    static var projectsRoot: URL {
        if let baseDirectoryOverride { return baseDirectoryOverride.appendingPathComponent("Projects", isDirectory: true) }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Projects", isDirectory: true)
    }

    static func projectDirectory(_ projectID: UUID) -> URL {
        projectsRoot.appendingPathComponent(projectID.uuidString, isDirectory: true)
    }

    static func mediaDirectory(_ projectID: UUID) -> URL {
        projectDirectory(projectID).appendingPathComponent("Media", isDirectory: true)
    }

    static func projectFileURL(_ projectID: UUID) -> URL {
        projectDirectory(projectID).appendingPathComponent("project.json")
    }

    static func resolve(_ asset: MediaAsset, in project: EditorProject) -> URL {
        projectDirectory(project.id).appendingPathComponent(asset.relativePath)
    }

    static func ensureDirectories(_ projectID: UUID) throws {
        try FileManager.default.createDirectory(at: mediaDirectory(projectID), withIntermediateDirectories: true)
    }

    // MARK: Save / load

    static func save(_ project: EditorProject) throws {
        try ensureDirectories(project.id)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        let data = try encoder.encode(project)
        // `.atomic` writes a sibling temp file and renames — a crash mid-save keeps the
        // previous good project.json.
        try data.write(to: projectFileURL(project.id), options: [.atomic])
    }

    static func load(_ projectID: UUID) throws -> EditorProject {
        let data = try Data(contentsOf: projectFileURL(projectID))
        let project = try JSONDecoder().decode(EditorProject.self, from: data)
        guard project.schemaVersion <= EditorProject.currentSchemaVersion else {
            throw StoreError.unreadableProject
        }
        return project
    }

    /// All saved projects, newest file first; corrupt entries are skipped, not fatal.
    static func loadAll() -> [EditorProject] {
        guard let dirs = try? FileManager.default.contentsOfDirectory(at: projectsRoot, includingPropertiesForKeys: nil) else { return [] }
        return dirs.compactMap { dir -> EditorProject? in
            guard let id = UUID(uuidString: dir.lastPathComponent) else { return nil }
            return try? load(id)
        }
    }

    /// Assets whose files are gone (deleted outside the app, incomplete restore, …).
    /// The UI surfaces these by name instead of failing the whole project open.
    static func missingAssets(_ project: EditorProject) -> [MediaAsset] {
        project.assets.filter { asset in
            !FileManager.default.fileExists(atPath: resolve(asset, in: project).path)
        }
    }

    // MARK: Import

    /// Copies `source` into the project's Media directory under the asset's stable ID and
    /// returns the relative path to store on the `MediaAsset`. Re-importing the same file
    /// for the same asset ID reuses the existing copy. An interrupted import leaves only a
    /// `.partial` file, which is never referenced by a saved project.
    @discardableResult
    static func copyIntoProject(source: URL, projectID: UUID, assetID: UUID) throws -> String {
        try ensureDirectories(projectID)
        let ext = source.pathExtension.isEmpty ? "dat" : source.pathExtension.lowercased()
        let relativePath = "Media/\(assetID.uuidString).\(ext)"
        let destination = projectDirectory(projectID).appendingPathComponent(relativePath)

        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }

        let sourceSize = (try? FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value ?? 0
        if FileManager.default.fileExists(atPath: destination.path),
           let destSize = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value,
           destSize == sourceSize, sourceSize > 0 {
            return relativePath
        }

        // Free-space guard: file size + 64 MB headroom for the project JSON and thumbnails.
        if let values = try? projectsRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let free = values.volumeAvailableCapacityForImportantUsage, sourceSize > 0 {
            let needed = sourceSize + 64 * 1024 * 1024
            if free < needed { throw StoreError.insufficientSpace(needed: needed, free: free) }
        }

        let partial = destination.appendingPathExtension("partial")
        try? FileManager.default.removeItem(at: partial)
        do {
            try FileManager.default.copyItem(at: source, to: partial)
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: partial, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: partial)
            throw StoreError.copyFailed
        }
        return relativePath
    }

    /// Streaming SHA-256 (1 MB chunks — never loads a whole video into memory). Used to
    /// recognise a duplicate import of the same file under a different name.
    static func contentHash(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Finds an existing asset in `project` with the same size and content hash as `url`,
    /// so importing the same file twice reuses one stored copy (the asset can still be
    /// placed on the timeline more than once via separate clips).
    static func existingDuplicate(of url: URL, in project: EditorProject) async -> MediaAsset? {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value else { return nil }
        let candidates = project.assets.filter { asset in
            let file = resolve(asset, in: project)
            let assetSize = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
            return assetSize == size
        }
        guard !candidates.isEmpty, let hash = try? contentHash(of: url) else { return nil }
        for candidate in candidates {
            if let candidateHash = try? contentHash(of: resolve(candidate, in: project)), candidateHash == hash {
                return candidate
            }
        }
        return nil
    }

    // MARK: Cleanup

    /// Deletes media files no asset in `project` references. Assets referenced only by
    /// undo history still live in `project.assets`, so they are safe; files belonging to
    /// other projects live in other directories and are never touched.
    static func cleanupUnusedMedia(_ project: EditorProject) {
        let referenced = Set(project.assets.map { ($0.relativePath as NSString).lastPathComponent })
        guard let files = try? FileManager.default.contentsOfDirectory(at: mediaDirectory(project.id), includingPropertiesForKeys: nil) else { return }
        for file in files where !referenced.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }
}

/// Probes a media file into a `MediaAsset` (async track loads; no full-file reads).
enum MediaProbe {
    enum ProbeError: Error { case noTracks, unreadableImage }

    static func probe(url: URL, relativePath: String, id: UUID = UUID(), name: String? = nil) async throws -> MediaAsset {
        let displayName = name ?? url.lastPathComponent
        if MediaMIME.isImage(url: url) {
            guard let size = PhotoTranscoder.orientedPixelSize(of: url) else { throw ProbeError.unreadableImage }
            return MediaAsset(id: id, relativePath: relativePath, name: displayName, mediaType: .image,
                              duration: .zero, naturalSize: CodableSize(width: Double(size.width), height: Double(size.height)),
                              preferredTransform: .identity, nominalFrameRate: 0, hasAudio: false)
        }
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        if let video = videoTracks.first {
            let (naturalSize, transform, fps) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate)
            return MediaAsset(id: id, relativePath: relativePath, name: displayName, mediaType: .video,
                              duration: CodableTime(duration), naturalSize: CodableSize(naturalSize),
                              preferredTransform: CodableTransform(transform), nominalFrameRate: fps,
                              hasAudio: !audioTracks.isEmpty)
        }
        if !audioTracks.isEmpty {
            return MediaAsset(id: id, relativePath: relativePath, name: displayName, mediaType: .audio,
                              duration: CodableTime(duration), naturalSize: CodableSize(width: 0, height: 0),
                              preferredTransform: .identity, nominalFrameRate: 0, hasAudio: true)
        }
        throw ProbeError.noTracks
    }

    /// Canvas for a freshly created project: the first video asset's oriented size,
    /// even-rounded, falling back to 1080p landscape for audio-only projects.
    static func defaultCanvas(for assets: [MediaAsset]) -> ProjectCanvas {
        guard let video = assets.first(where: { $0.mediaType == .video }) else { return .hd1080Landscape }
        let rect = CGRect(origin: .zero, size: video.naturalSize.cgSize).applying(video.preferredTransform.cgTransform)
        let size = FrameRenderer.evenSize(CGSize(width: abs(rect.width), height: abs(rect.height)))
        guard size.width >= 2, size.height >= 2 else { return .hd1080Landscape }
        return ProjectCanvas(width: Int(size.width), height: Int(size.height))
    }
}
