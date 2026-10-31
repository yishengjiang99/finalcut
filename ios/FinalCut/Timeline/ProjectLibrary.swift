import AVFoundation
import Foundation
import UIKit

/// One denormalized library row — everything the project-history list renders,
/// cached in `index.json` at the Projects root (issue #125, Phase 1). Content
/// fields (title, duration, clip counts, pin/archive) are derived from
/// `project.json`, which stays the source of truth; `lastOpenedAt` lives only
/// here and survives row rebuilds.
struct ProjectIndexRow: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var lastOpenedAt: Date?
    var durationSeconds: Double
    var clipCount: Int
    var audioClipCount: Int
    /// Display-transcript message count. Always 0 in Phase 1 — transcripts are
    /// persisted in Phase 2, which will start filling this in.
    var messageCount: Int = 0
    /// Cover image filename inside the project directory ("cover.jpg"), when one
    /// has been generated.
    var coverFilename: String?
    /// Mirrors `EditorProject.isPinned` / `isArchived` (Phase 3).
    var isPinned: Bool = false
    var isArchived: Bool = false
    /// Modification time of `project.json` when this row was built. The
    /// precedence rule: if the project file is newer than this, the row is stale
    /// and is rebuilt on the spot (the two files are written separately and can
    /// disagree after a crash).
    var projectFileModifiedAt: Date
}

/// The library list's buckets (#125 Phase 3), each newest edit first:
/// pinned and unpinned non-archived projects, and archived projects.
struct ProjectLibraryBuckets: Equatable {
    var pinned: [ProjectIndexRow] = []
    var projects: [ProjectIndexRow] = []
    var archived: [ProjectIndexRow] = []
}

/// The across-project library service (issue #125, Phase 1) — the front door over
/// `ProjectStore`. Reads go through a rebuildable `index.json` cache so the list
/// never has to decode every project just to render; a stale row (per the
/// precedence rule above) is rebuilt from its project on the spot. All storage
/// is on-device; nothing here touches the network.
enum ProjectLibrary {
    static let currentIndexSchemaVersion = 1
    static let coverFilename = "cover.jpg"

    private static var indexURL: URL {
        ProjectStore.projectsRoot.appendingPathComponent("index.json")
    }

    // MARK: Index load / rebuild

    /// All library rows, most recently edited first. Rebuilds the index (or any
    /// stale rows) as needed and persists it when anything changed. Archived
    /// rows are included; sectioning decides what the list shows.
    static func loadRows() -> [ProjectIndexRow] {
        let stored = readIndex()
        let storedByID = Dictionary((stored?.rows ?? []).map { ($0.id, $0) },
                                    uniquingKeysWith: { first, _ in first })
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: ProjectStore.projectsRoot, includingPropertiesForKeys: nil) else { return [] }

        var rows: [ProjectIndexRow] = []
        var changed = stored == nil
        for entry in entries {
            guard let id = UUID(uuidString: entry.lastPathComponent) else { continue }
            let fileURL = ProjectStore.projectFileURL(id)
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                  let modified = attrs[.modificationDate] as? Date else { continue }
            let existing = storedByID[id]
            if let existing, existing.projectFileModifiedAt >= modified {
                // Fresh row: reuse it. A cover can appear without project.json
                // changing (generated lazily), so refresh just that field.
                var row = existing
                let cover = coverExists(id) ? coverFilename : nil
                if row.coverFilename != cover {
                    row.coverFilename = cover
                    changed = true
                }
                rows.append(row)
                continue
            }
            // Missing or stale row: rebuild from the project itself. A project
            // that no longer decodes is dropped from the index (its directory is
            // left untouched), matching `ProjectStore.loadAll()`'s behaviour.
            guard let project = try? ProjectStore.load(id) else { changed = true; continue }
            let created = (attrs[.creationDate] as? Date) ?? modified
            rows.append(makeRow(project: project, fileModified: modified,
                                fileCreated: created, existing: existing))
            changed = true
        }
        if Set(rows.map(\.id)) != Set(storedByID.keys) { changed = true }
        rows.sort { $0.updatedAt > $1.updatedAt }
        if changed { writeIndex(rows) }
        return rows
    }

    private static func makeRow(project: EditorProject, fileModified: Date,
                                fileCreated: Date, existing: ProjectIndexRow?) -> ProjectIndexRow {
        ProjectIndexRow(
            id: project.id,
            title: project.name,
            createdAt: existing?.createdAt ?? fileCreated,
            updatedAt: fileModified,
            lastOpenedAt: existing?.lastOpenedAt,
            durationSeconds: project.durationSeconds,
            clipCount: project.videoClips.count,
            audioClipCount: project.audioTracks.reduce(0) { $0 + $1.clips.count },
            messageCount: existing?.messageCount ?? 0,
            coverFilename: coverExists(project.id) ? coverFilename : nil,
            isPinned: project.isPinned == true,
            isArchived: project.isArchived == true,
            projectFileModifiedAt: fileModified)
    }

    private struct IndexFile: Codable {
        var schemaVersion: Int
        var rows: [ProjectIndexRow]
    }

    private static func readIndex() -> IndexFile? {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode(IndexFile.self, from: data),
              index.schemaVersion == currentIndexSchemaVersion else { return nil }
        return index
    }

    private static func writeIndex(_ rows: [ProjectIndexRow]) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        guard let data = try? encoder.encode(IndexFile(schemaVersion: currentIndexSchemaVersion, rows: rows))
        else { return }
        try? FileManager.default.createDirectory(at: ProjectStore.projectsRoot,
                                                 withIntermediateDirectories: true)
        try? data.write(to: indexURL, options: [.atomic])
    }

    // MARK: Mutations

    /// Renames a project: the title lives in `project.json` (the source of
    /// truth), so the rename is written through the store and the index row is
    /// rebuilt from the saved project.
    static func rename(projectID: UUID, to newTitle: String) throws {
        var project = try ProjectStore.load(projectID)
        project.setUserTitle(newTitle)
        try ProjectStore.save(project)
        _ = loadRows()
    }

    /// Pins or unpins a project (stored in project.json). Doesn't count as an
    /// edit: the file's modification time is kept, so the row's "last edited"
    /// order doesn't jump.
    static func setPinned(projectID: UUID, _ pinned: Bool) throws {
        try updateFlags(projectID) { $0.isPinned = pinned ? true : nil }
    }

    /// Archives or unarchives a project (stored in project.json); also not an
    /// edit, so Undo restores the row exactly where it was.
    static func setArchived(projectID: UUID, _ archived: Bool) throws {
        try updateFlags(projectID) { $0.isArchived = archived ? true : nil }
    }

    private static func updateFlags(_ projectID: UUID, _ mutate: (inout EditorProject) -> Void) throws {
        var project = try ProjectStore.load(projectID)
        let fileURL = ProjectStore.projectFileURL(projectID)
        let modified = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.modificationDate] as? Date
        mutate(&project)
        try ProjectStore.save(project)
        if let modified {
            try? FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: fileURL.path)
        }
        // With the mtime kept, the cached row counts as fresh; patch its flags.
        var rows = loadRows()
        if let index = rows.firstIndex(where: { $0.id == projectID }) {
            rows[index].isPinned = project.isPinned == true
            rows[index].isArchived = project.isArchived == true
            writeIndex(rows)
        }
    }

    /// Deletes a project directory permanently and drops its index row.
    /// Returns the number of bytes freed (the project's copied media included).
    @discardableResult
    static func delete(projectID: UUID) throws -> Int64 {
        let freed = directorySize(projectID)
        try FileManager.default.removeItem(at: ProjectStore.projectDirectory(projectID))
        if lastOpenedProjectID() == projectID { setLastOpenedProjectID(nil) }
        writeIndex(loadRows().filter { $0.id != projectID })
        return freed
    }

    /// Total size of a project directory, media included (recursive).
    static func directorySize(_ projectID: UUID) -> Int64 {
        let root = ProjectStore.projectDirectory(projectID)
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            if let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
               values.isRegularFile == true, let size = values.fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    /// Records that a project was opened just now (its index row only; the
    /// relaunch restore reads the id from `lastOpenedProjectID()`).
    static func markOpened(projectID: UUID, at date: Date = Date()) {
        var rows = loadRows()
        guard let index = rows.firstIndex(where: { $0.id == projectID }) else { return }
        rows[index].lastOpenedAt = date
        writeIndex(rows)
    }

    // MARK: Last-opened project (relaunch restore)

    private static let lastOpenedProjectIDKey = "projectLibrary.lastOpenedProjectID"

    static func lastOpenedProjectID() -> UUID? {
        UserDefaults.standard.string(forKey: lastOpenedProjectIDKey).flatMap { UUID(uuidString: $0) }
    }

    static func setLastOpenedProjectID(_ id: UUID?) {
        if let id {
            UserDefaults.standard.set(id.uuidString, forKey: lastOpenedProjectIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: lastOpenedProjectIDKey)
        }
    }

    // MARK: Covers

    static func coverURL(projectID: UUID) -> URL? {
        let url = ProjectStore.projectDirectory(projectID).appendingPathComponent(coverFilename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static func coverExists(_ projectID: UUID) -> Bool {
        coverURL(projectID: projectID) != nil
    }

    /// Generates `cover.jpg` for a project that doesn't have one yet: a
    /// representative frame ~1/3 into its first video clip (the issue's rule of
    /// thumb), or the first clip's image itself for photo-based projects.
    /// Best-effort throughout — a project without a cover just shows the
    /// placeholder tile — and deliberately run when the library is shown rather
    /// than on the save path, so saving is never slowed or failed by it.
    static func generateCoverIfMissing(projectID: UUID) async {
        let coverURL = ProjectStore.projectDirectory(projectID).appendingPathComponent(coverFilename)
        guard !FileManager.default.fileExists(atPath: coverURL.path),
              let project = try? ProjectStore.load(projectID) else { return }
        for clip in project.videoClips {
            guard let asset = project.asset(clip.assetID) else { continue }
            let fileURL = NativeComposer.resolveAssetURL(asset, in: project)
            guard FileManager.default.fileExists(atPath: fileURL.path) else { continue }
            if asset.mediaType == .image {
                if let image = UIImage(contentsOfFile: fileURL.path),
                   let data = image.jpegData(compressionQuality: 0.7) {
                    try? data.write(to: coverURL, options: [.atomic])
                }
                return
            }
            guard asset.mediaType == .video else { continue }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: fileURL))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 640, height: 640)
            generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
            let time = CMTimeAdd(clip.sourceStart.cmTime,
                                 CMTime(seconds: max(0, clip.sourceDuration.seconds) / 3,
                                        preferredTimescale: 600))
            if let cgImage = try? await generator.image(at: time).image,
               let data = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.7) {
                try? data.write(to: coverURL, options: [.atomic])
            }
            return
        }
    }

    // MARK: Sectioning + formatting (pure; the list renders exactly this)

    /// Splits rows into Pinned / Projects / Archived, each sorted by last
    /// edit (newest first), keeping only rows matching `query` (see `matches`).
    static func buckets(from rows: [ProjectIndexRow], query: String = "", now: Date = Date(),
                        calendar: Calendar = .current) -> ProjectLibraryBuckets {
        let matching = rows
            .filter { matches($0, query: query, now: now, calendar: calendar) }
            .sorted { $0.updatedAt > $1.updatedAt }
        return ProjectLibraryBuckets(
            pinned: matching.filter { $0.isPinned && !$0.isArchived },
            projects: matching.filter { !$0.isPinned && !$0.isArchived },
            archived: matching.filter { $0.isArchived })
    }

    /// Title-only search (no chat text, no index): case-insensitive substring
    /// match on the title or on the row's date labels ("Today", "Yesterday",
    /// "October 2026", "Oct 31, 2026"). An empty query matches everything.
    static func matches(_ row: ProjectIndexRow, query: String, now: Date = Date(),
                        calendar: Calendar = .current) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        let haystacks = [row.title] + dateLabels(for: row.updatedAt, now: now, calendar: calendar)
        return haystacks.contains { $0.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    /// The date strings a row can be found by.
    static func dateLabels(for date: Date, now: Date = Date(), calendar: Calendar = .current) -> [String] {
        var labels: [String] = []
        if calendar.isDate(date, inSameDayAs: now) { labels.append("Today") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { labels.append("Yesterday") }
        let month = DateFormatter()
        month.calendar = calendar
        month.timeZone = calendar.timeZone
        month.dateFormat = "MMMM yyyy"
        labels.append(month.string(from: date))
        let medium = DateFormatter()
        medium.calendar = calendar
        medium.timeZone = calendar.timeZone
        medium.dateStyle = .medium
        medium.timeStyle = .none
        labels.append(medium.string(from: date))
        return labels
    }

    /// "Edited 2h ago" — compact relative edit time for a row's trailing edge.
    static func relativeEditDescription(for date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:
            return "Edited just now"
        case ..<3600:
            return "Edited \(Int(seconds / 60))m ago"
        case ..<86400:
            return "Edited \(Int(seconds / 3600))h ago"
        case ..<604_800:
            return "Edited \(Int(seconds / 86400))d ago"
        default:
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            return "Edited \(formatter.string(from: date))"
        }
    }

    /// Row duration: "45s" under a minute, "1:05" above it.
    static func durationDescription(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        guard total >= 60 else { return "\(total)s" }
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }
}
