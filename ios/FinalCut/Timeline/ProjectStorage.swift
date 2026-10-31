import Foundation

/// One project's on-disk footprint (#125 Phase 4).
struct ProjectStorageEntry: Equatable, Identifiable {
    var id: UUID
    var title: String
    /// Everything in the project directory, media included.
    var totalBytes: Int64
    /// Regenerable cached thumbnails (the library cover) inside that total.
    var thumbnailBytes: Int64
    var isArchived: Bool
}

/// Storage as a feature (#125 Phase 4): sizes, a size-sorted cleanup list,
/// thumbnail-only cache clearing, full-copy duplicate, the "not opened in a
/// while" archive nudge, and project backup export. All on-device.
enum ProjectStorage {
    // MARK: Sizes

    /// Cached files that can be deleted and rebuilt; never project data.
    static let thumbnailCacheFilenames: Set<String> = [ProjectLibrary.coverFilename]

    static func entries(rows: [ProjectIndexRow] = ProjectLibrary.loadRows()) -> [ProjectStorageEntry] {
        sortedBySize(rows.map { row in
            ProjectStorageEntry(
                id: row.id, title: row.title,
                totalBytes: ProjectLibrary.directorySize(row.id),
                thumbnailBytes: thumbnailBytes(row.id),
                isArchived: row.isArchived)
        })
    }

    /// Largest first; ties by title so the order is stable.
    static func sortedBySize(_ entries: [ProjectStorageEntry]) -> [ProjectStorageEntry] {
        entries.sorted {
            $0.totalBytes != $1.totalBytes
                ? $0.totalBytes > $1.totalBytes
                : $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }

    static func totalBytes(_ entries: [ProjectStorageEntry]) -> Int64 {
        entries.reduce(0) { $0 + $1.totalBytes }
    }

    static func thumbnailBytes(_ projectID: UUID) -> Int64 {
        thumbnailCacheFilenames.reduce(Int64(0)) { sum, name in
            let url = ProjectStore.projectDirectory(projectID).appendingPathComponent(name)
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber
            return sum + (size?.int64Value ?? 0)
        }
    }

    // MARK: Thumbnail cache

    /// Deletes cached thumbnails (covers) for every project, and nothing else:
    /// only the known cache filenames at the top of each project directory are
    /// touched. Covers regenerate lazily when the library is shown. Returns
    /// the bytes freed.
    @discardableResult
    static func clearThumbnailCache() -> Int64 {
        guard let dirs = try? FileManager.default.contentsOfDirectory(
            at: ProjectStore.projectsRoot, includingPropertiesForKeys: nil) else { return 0 }
        var freed: Int64 = 0
        for dir in dirs {
            guard let id = UUID(uuidString: dir.lastPathComponent) else { continue }
            for name in thumbnailCacheFilenames {
                let url = ProjectStore.projectDirectory(id).appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
                if (try? FileManager.default.removeItem(at: url)) != nil { freed += size }
            }
        }
        _ = ProjectLibrary.loadRows() // drop stale cover references from the index
        return freed
    }

    // MARK: Duplicate (owner decision: full media copy, no shared pool)

    /// Copies the whole project directory (project.json, Media, transcript,
    /// wire turns) to a new id and title. The copy shares no files with the
    /// original. Pin/archive state is not carried over.
    @discardableResult
    static func duplicate(projectID: UUID, now: Date = Date()) throws -> UUID {
        var project = try ProjectStore.load(projectID)
        let source = ProjectStore.projectDirectory(projectID)
        let newID = UUID()
        let destination = ProjectStore.projectDirectory(newID)
        let needed = ProjectLibrary.directorySize(projectID)
        if let free = availableBytes(), free < needed {
            throw ProjectStore.StoreError.insufficientSpace(needed: needed, free: free)
        }
        try FileManager.default.copyItem(at: source, to: destination)
        // Media paths are project-relative, so they resolve in the copy as-is;
        // an absolute path into the old directory is re-pointed at the copy.
        let oldPrefix = source.standardizedFileURL.path + "/"
        for index in project.assets.indices where project.assets[index].relativePath.hasPrefix(oldPrefix) {
            project.assets[index].relativePath = String(project.assets[index].relativePath.dropFirst(oldPrefix.count))
        }
        project.id = newID
        project.name = duplicateTitle(project.name)
        project.isPinned = nil
        project.isArchived = nil
        do {
            try ProjectStore.save(project)
            // Fresh "last edited" time so the copy sorts at the top.
            try? FileManager.default.setAttributes([.modificationDate: now],
                                                   ofItemAtPath: ProjectStore.projectFileURL(newID).path)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        _ = ProjectLibrary.loadRows()
        return newID
    }

    static func duplicateTitle(_ title: String) -> String { "\(title) copy" }

    static func availableBytes() -> Int64? {
        let values = try? ProjectStore.projectsRoot.deletingLastPathComponent()
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    // MARK: Archive nudge (owner decision: suggest, never auto-archive)

    /// A project counts as stale when it hasn't been opened or edited for this long.
    static let staleThreshold: TimeInterval = 30 * 86_400
    /// After "Not now", the nudge stays away this long.
    static let nudgeSnooze: TimeInterval = 30 * 86_400
    private static let nudgeDismissedKey = "projectStorage.archiveNudgeDismissedAt"

    /// Non-archived projects not opened or edited within `staleThreshold`,
    /// least recently used first.
    static func staleProjects(_ rows: [ProjectIndexRow], now: Date = Date()) -> [ProjectIndexRow] {
        func lastUsed(_ row: ProjectIndexRow) -> Date { max(row.lastOpenedAt ?? row.updatedAt, row.updatedAt) }
        return rows
            .filter { !$0.isArchived && now.timeIntervalSince(lastUsed($0)) >= staleThreshold }
            .sorted { lastUsed($0) < lastUsed($1) }
    }

    /// Whether to show the nudge: stale projects exist and it wasn't
    /// dismissed within `nudgeSnooze`.
    static func shouldShowArchiveNudge(_ rows: [ProjectIndexRow], now: Date = Date(),
                                       dismissedAt: Date? = nudgeDismissedAt()) -> Bool {
        if let dismissedAt, now.timeIntervalSince(dismissedAt) < nudgeSnooze { return false }
        return !staleProjects(rows, now: now).isEmpty
    }

    static func nudgeDismissedAt(defaults: UserDefaults = .standard) -> Date? {
        defaults.object(forKey: nudgeDismissedKey) as? Date
    }

    static func dismissArchiveNudge(at date: Date = Date(), defaults: UserDefaults = .standard) {
        defaults.set(date, forKey: nudgeDismissedKey)
    }

    // MARK: Backup export

    /// Builds `<title>.finalcap/` in `directory`: the project's files (project.json,
    /// Media, transcript.json, wire-turns.json) without cached thumbnails, plus a
    /// small manifest.json. Returns the bundle folder.
    static func stageBackup(projectID: UUID, in directory: URL, now: Date = Date()) throws -> URL {
        let project = try ProjectStore.load(projectID)
        let bundle = directory.appendingPathComponent("\(safeFilename(project.name)).finalcap", isDirectory: true)
        if FileManager.default.fileExists(atPath: bundle.path) { try FileManager.default.removeItem(at: bundle) }
        try FileManager.default.copyItem(at: ProjectStore.projectDirectory(projectID), to: bundle)
        for name in thumbnailCacheFilenames {
            try? FileManager.default.removeItem(at: bundle.appendingPathComponent(name))
        }
        let manifest: [String: String] = [
            "format": "finalcap-project-backup",
            "version": "1",
            "projectID": projectID.uuidString,
            "title": project.name,
            "exportedAt": ISO8601DateFormatter().string(from: now),
        ]
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: bundle.appendingPathComponent("manifest.json"), options: [.atomic])
        return bundle
    }

    /// Zips a staged backup for the share sheet / Files (system zip via
    /// NSFileCoordinator's `.forUploading`). Returns `<title>.finalcap.zip`.
    static func makeBackupArchive(projectID: UUID) throws -> URL {
        let work = FileManager.default.temporaryDirectory
            .appendingPathComponent("finalcap-backup-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let bundle = try stageBackup(projectID: projectID, in: work)
        let destination = work.appendingPathComponent(bundle.lastPathComponent + ".zip")
        var coordinatorError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: bundle, options: [.forUploading], error: &coordinatorError) { zipURL in
            do { try FileManager.default.copyItem(at: zipURL, to: destination) } catch { copyError = error }
        }
        if let error = coordinatorError ?? copyError { throw error }
        try? FileManager.default.removeItem(at: bundle)
        return destination
    }

    static func safeFilename(_ title: String) -> String {
        let cleaned = title.components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>")).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Project" : String(cleaned.prefix(60))
    }
}
